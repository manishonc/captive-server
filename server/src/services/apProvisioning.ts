/**
 * Self-serve access point provisioning — creating the AP document, adopting the device, and
 * bringing up the venue's WiFi, all from an account code rather than a logged-in CMS session.
 *
 * This is the FIRST place in captive-server that creates a CaptivePortal_AccessPoints
 * document; every other path only reads or updates. It therefore has to reproduce what the
 * CMS's POST /api/captive-portal/access-points does — the same field shape, the same global
 * MAC uniqueness, the same plan and subscription gates — or self-serve becomes a way to walk
 * around all of them. Where the two differ, the difference is noted inline.
 *
 * TWO FACTORS, NOT ONE. `claimAccessPoint` requires the MAC to be genuinely pending (or
 * already adopted) on our controller. The account code alone is not enough: the caller must
 * also be on the device's LAN with SSH access to have made it inform us in the first place.
 * That is what keeps a leaked code from being remotely exploitable, and it stops a mistyped
 * or guessed MAC from permanently squatting hardware under global MAC uniqueness.
 *
 * WIFI IS NOT APPLIED HERE. `ensureApGroup` blind-writes `device_macs` with no adoption
 * check, and against a not-yet-adopted MAC the controller may store it, silently drop it, or
 * reject the call. The silent-drop case is the dangerous one: a venue's first access point
 * would leave an empty AP group with a WLAN bound to it, so the venue has `wifiSsid` set and
 * an SSID broadcasting nowhere, with nothing logged. So the WiFi step waits until the device
 * reports connected, driven from `adoptionStatus()` and backstopped by `reconcilePendingWifi()`
 * on the 5-minute cron for when the installer closes their laptop mid-provision.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { UnifiConfig } from '../types/captive';
import type { UnifiDevice } from './unifi';
import {
  DEFAULT_OFFLINE_THRESHOLD_MINUTES,
  DEFAULT_SESSION_TIMEOUT,
  defaultApEvents,
} from '../config/apDefaults';
import {
  canonMac,
  getDevices,
  getPendingDevices,
  normalizeMac,
  setDeviceName,
  validateSsid,
} from './unifi';
import { applyVenueWifi, resolveAnyController } from './unifiWlan';
import { adoptRegisteredPendingDevices } from './unifiAdoption';
import {
  AdoptionPhase,
  AdoptionProgressEntry,
  AdoptionStallReason,
  classifyAdoption,
  classifyAdoptionPhase,
  controllerDeviceName,
  isAdoptionDone,
  retryAfterSeconds,
  summarizeAdoptionProgress,
} from './adoptionStatus';
import { getEntitlements, isLapsedForSending } from './entitlements';

const AP_COLLECTION = 'CaptivePortal_AccessPoints';
const VENUE_COLLECTION = 'CaptivePortal_Venues';
const EVENTS_COLLECTION = 'CaptivePortal_AdoptionEvents';

export type ClaimFailure =
  | 'venue_not_found'
  | 'venue_forbidden'
  | 'invalid_ssid'
  | 'ssid_conflict_existing'
  | 'device_not_pending'
  | 'mac_registered_elsewhere'
  | 'plan_limit_access_points'
  | 'subscription_lapsed'
  | 'controller_unreachable';

export interface ClaimResult {
  ok: boolean;
  failure?: ClaimFailure;
  message?: string;
  apId?: string;
  apName?: string;
  venueId?: string;
  venueName?: string;
  ssid?: string;
  phase?: AdoptionPhase;
  wifiApplied?: boolean;
  retryAfterSeconds?: number;
  done?: boolean;
  deviceState?: number | null;
  reason?: AdoptionStallReason | null;
}

export interface ClaimArgs {
  tenantUserId: string;
  venueId: string;
  mac: string;
  ssid: string;
  apName?: string;
  model?: string;
  firmware?: string;
  /** Set by the client when the installer explicitly confirmed renaming a live network. */
  confirmRename?: boolean;
}

// ── MAC uniqueness ────────────────────────────────────────────────────────────

/**
 * Every spelling of a MAC that might be stored on an existing document.
 *
 * Mirrors the CMS's _lib/access-point-helpers.js `findMacConflict`: the Firestore query is an
 * exact string match, but legacy rows were written hyphenated, bare-hex, or upper case, so a
 * single-spelling query would miss a real conflict and let the same physical device be
 * registered twice. Canonical comparison below is still the source of truth.
 */
export function macSpellings(mac: string): string[] {
  const canon = canonMac(mac);
  const pairs = canon.match(/.{2}/g) || [];
  return [
    ...new Set(
      [
        normalizeMac(mac),
        canon,
        canon.toUpperCase(),
        pairs.join(':'),
        pairs.join(':').toUpperCase(),
        pairs.join('-'),
        pairs.join('-').toUpperCase(),
      ].filter(Boolean),
    ),
  ];
}

export interface RegisteredApRow {
  id: string;
  canon: string;
  name?: string;
  venueId?: string;
  venueName?: string;
  tenantUserId?: string;
}

/**
 * Look up AP documents for a set of MACs.
 *
 * Chunked `in` queries rather than scanning every UniFi AP in the fleet, because this runs on
 * a public endpoint: `loadRegisteredUnifiAps` reads the whole collection, which is fine on a
 * 5-minute cron and wasteful on something a caller can hit sixty times in ten minutes.
 * Firestore caps `in` at 30 values, and each MAC expands to up to seven spellings.
 */
export async function findApDocsByMacs(macs: string[]): Promise<Map<string, RegisteredApRow>> {
  const wanted = new Set(macs.map(canonMac).filter((m) => m.length === 12));
  const spellings = [...new Set([...wanted].flatMap((m) => macSpellings(m)))];
  const found = new Map<string, RegisteredApRow>();

  for (let i = 0; i < spellings.length; i += 30) {
    const chunk = spellings.slice(i, i + 30);
    const snap = await db.collection(AP_COLLECTION).where('mac', 'in', chunk).get();
    for (const doc of snap.docs) {
      const d = doc.data() as RegisteredApRow & { mac?: string };
      const canon = canonMac(String(d.mac || ''));
      // The query matches strings; canonical comparison is still the source of truth.
      if (!wanted.has(canon) || found.has(canon)) continue;
      found.set(canon, {
        id: doc.id,
        canon,
        name: d.name,
        venueId: d.venueId,
        venueName: d.venueName,
        tenantUserId: d.tenantUserId,
      });
    }
  }
  return found;
}

// ── Controller config stamped onto new AP documents ───────────────────────────

interface StoredUnifiConfig {
  controllerType?: string;
  controllerUrl?: string;
  site?: string;
  username?: string;
  password?: string;
}

/**
 * Build the `unifiConfig` snapshot for a new AP document.
 *
 * Env first: those credentials are the live ones and rotate in a single place, whereas a
 * sibling AP's stored copy is a snapshot taken whenever that AP was created and may already
 * be stale (which is the entire reason services/unifiCredentialCheck.ts exists). A sibling is
 * the fallback for deployments that never set the env.
 *
 * UNIFI_PUBLIC_CONTROLLER_URL exists only so the stored URL matches what the CMS displays;
 * nothing dials it. captive-server always overrides via `effectiveControllerUrl`, and the CMS
 * never contacts the controller at all — it proxies everything through /internal/unifi/*.
 */
async function resolveStampConfig(venueId: string, tenantUserId: string): Promise<StoredUnifiConfig> {
  const fromEnv: StoredUnifiConfig = {
    controllerType: process.env.UNIFI_CONTROLLER_TYPE === 'udm' ? 'udm' : 'classic',
    controllerUrl:
      process.env.UNIFI_PUBLIC_CONTROLLER_URL || process.env.UNIFI_CONTROLLER_URL || '',
    site: process.env.UNIFI_SITE || 'default',
    username: process.env.UNIFI_USERNAME || '',
    password: process.env.UNIFI_PASSWORD || '',
  };
  if (fromEnv.username && fromEnv.password && fromEnv.controllerUrl) return fromEnv;

  // Fall back to a sibling: the venue's own APs first, then any of this tenant's.
  for (const query of [
    db.collection(AP_COLLECTION).where('venueId', '==', venueId).limit(10),
    db.collection(AP_COLLECTION).where('tenantUserId', '==', tenantUserId).limit(10),
  ]) {
    const snap = await query.get();
    for (const doc of snap.docs) {
      const cfg = (doc.data() as { unifiConfig?: StoredUnifiConfig }).unifiConfig;
      if (cfg?.password && cfg?.username) return cfg;
    }
  }

  // Better a clean failure than an AP document with no credentials — those accumulate and
  // are exactly what can starve resolveAnyController's fallback scan.
  throw new Error('UniFi controller credentials are not configured.');
}

// ── Gates ─────────────────────────────────────────────────────────────────────

/**
 * Access point capacity, mirroring the CMS's plan-gates.js `requirePlanCapacity`. The limit
 * has been declared on the plan and enforced only in the CMS until now; a public endpoint
 * that skipped it would be a straightforward billing bypass.
 *
 * Counted fresh every call. `getEntitlements` is cached for five minutes, but the count is
 * not, so a burst of claims cannot slip several past one stale read.
 */
async function overApCapacity(tenantUserId: string, venueId: string): Promise<boolean> {
  try {
    const { limits } = await getEntitlements(tenantUserId);
    const limit = Number(limits?.maxAccessPointsPerVenue);
    if (!Number.isInteger(limit) || limit === -1) return false; // unlimited
    const count = await db.collection(AP_COLLECTION).where('venueId', '==', venueId).count().get();
    return count.data().count + 1 > limit;
  } catch (error) {
    // Fail open, same as the CMS: a Firestore blip must not read as "your plan is full" to
    // someone standing in a venue with a ladder.
    console.error('[AP CLAIM] Capacity check failed; allowing:', error);
    return false;
  }
}

// ── Claim ─────────────────────────────────────────────────────────────────────

function fail(failure: ClaimFailure, message: string): ClaimResult {
  return { ok: false, failure, message };
}

export async function claimAccessPoint(args: ClaimArgs): Promise<ClaimResult> {
  const mac = normalizeMac(args.mac);
  const canon = canonMac(mac);
  if (!canon || canon.length !== 12) {
    return fail('device_not_pending', 'That does not look like a valid device address.');
  }

  let ssid: string;
  try {
    ssid = validateSsid(args.ssid);
  } catch (err) {
    return fail('invalid_ssid', (err as Error).message);
  }

  // 1. Venue + ownership. Authorization reads Venue.tenantUserId, never the AP document's
  //    denormalized copy of it, which can be stale on older or reassigned access points.
  const venueSnap = await db.collection(VENUE_COLLECTION).doc(args.venueId).get();
  if (!venueSnap.exists) return fail('venue_not_found', 'That location no longer exists.');
  const venue = venueSnap.data() as { tenantUserId?: string; venue_name?: string; wifiSsid?: string };
  if (!venue.tenantUserId || venue.tenantUserId !== args.tenantUserId) {
    return fail('venue_forbidden', 'That location belongs to a different account.');
  }

  // 2. Renaming a venue's live SSID drops every currently connected guest, and is reachable
  //    from nothing but the code — so it takes an explicit confirmation from the client.
  if (venue.wifiSsid && venue.wifiSsid !== ssid && !args.confirmRename) {
    return {
      ...fail('ssid_conflict_existing', `This location already uses the WiFi name "${venue.wifiSsid}".`),
      ssid: venue.wifiSsid,
    };
  }

  // 3. Billing gates, charged against the VENUE's owner rather than whoever holds the code.
  //    Identical today because of the ownership check above, but written this way so it stays
  //    correct if that rule is ever relaxed.
  const owner = venue.tenantUserId;
  if (await isLapsedForSending(owner)) {
    return fail('subscription_lapsed', 'This account’s subscription has ended.');
  }
  if (await overApCapacity(owner, args.venueId)) {
    return fail('plan_limit_access_points', 'This account’s plan has no room for another access point here.');
  }

  // 4. Proof of possession: the device must actually be talking to our controller. This is
  //    the second factor — without it the account code alone would be enough to register
  //    arbitrary hardware, including a MAC guessed or copied off someone else's device.
  let config: UnifiConfig;
  let alreadyAdopted = false;
  try {
    config = await resolveAnyController();
    const pending = await getPendingDevices(config);
    const isPending = pending.some((d) => canonMac(d.mac) === canon);
    if (!isPending) {
      const devices = await getDevices(config);
      alreadyAdopted = devices.some((d) => canonMac(d.mac) === canon);
      if (!alreadyAdopted) {
        return fail(
          'device_not_pending',
          'We can’t see that access point yet. Leave it plugged in and try again in a moment.',
        );
      }
    }
  } catch (error) {
    console.error('[AP CLAIM] Controller unreachable:', error);
    return fail('controller_unreachable', 'We couldn’t reach the management server. Try again shortly.');
  }

  // 5. Create the document, transactionally.
  const stampConfig = await resolveStampConfig(args.venueId, owner).catch((err) => {
    console.error('[AP CLAIM] No controller credentials to stamp:', err);
    return null;
  });
  if (!stampConfig) {
    return fail('controller_unreachable', 'The management server is not configured. Contact support.');
  }

  const venueName = String(venue.venue_name || '');
  const apName = String(args.apName || '').trim() || defaultApName(args.model, canon);

  let apId: string;
  try {
    apId = await createApDocument({
      mac,
      canon,
      venueId: args.venueId,
      venueName,
      tenantUserId: owner,
      apName,
      ssid,
      unifiConfig: stampConfig,
    });
  } catch (err) {
    if ((err as Error).message === 'MAC_CONFLICT') {
      return fail(
        'mac_registered_elsewhere',
        'That access point is already registered to another account.',
      );
    }
    throw err;
  }

  // 6. Adopt. Non-throwing by contract, and the 5-minute cron retries anyway, so a failure
  //    here is not a failed claim — the document exists and the device will be picked up.
  const sweep = await adoptRegisteredPendingDevices({ onlyMacs: [mac] });
  const adoptRequested = sweep.adopted.length > 0 || alreadyAdopted;
  await db
    .collection(AP_COLLECTION)
    .doc(apId)
    .update({
      adoptionState: adoptRequested ? 'adopt_requested' : 'registered',
      adoptionRequestedAt: adoptRequested ? FieldValue.serverTimestamp() : null,
    });

  await recordAdoptionEvent({ tenantUserId: owner, venueId: args.venueId, mac, apId, outcome: 'claimed' });

  // 7. Report where the device is now. WiFi comes later — see the module header.
  const status = await adoptionStatus({ tenantUserId: owner, mac, ssid });
  return {
    ok: true,
    apId,
    apName,
    venueId: args.venueId,
    venueName,
    ssid,
    phase: status.phase,
    wifiApplied: status.wifiApplied,
    retryAfterSeconds: status.retryAfterSeconds,
    done: status.done,
    deviceState: status.deviceState,
    reason: status.reason,
  };
}

/** "U6-Pro (AB:CD)" — recognisable on a shelf, and editable in the CMS afterwards. */
function defaultApName(model: string | undefined, canon: string): string {
  const suffix = canon.slice(-4).toUpperCase();
  const tail = `${suffix.slice(0, 2)}:${suffix.slice(2)}`;
  const base = String(model || '').trim() || 'Access point';
  return `${base} (${tail})`.slice(0, 64);
}

/**
 * Create the AP document, failing on a MAC already registered anywhere.
 *
 * The conflict query runs INSIDE the transaction. Outside it, two concurrent claims for the
 * same device both see no conflict and both create a document — and duplicates are not a
 * cosmetic problem: `resolveApContext` and the portal's venue lookup both take `.limit(1)`,
 * so which venue a guest lands in becomes nondeterministic.
 *
 * Same-tenant, same-venue hits resume forward rather than failing, so a retried claim after a
 * dropped connection is idempotent instead of telling the installer their own device belongs
 * to someone else.
 */
async function createApDocument(args: {
  mac: string;
  canon: string;
  venueId: string;
  venueName: string;
  tenantUserId: string;
  apName: string;
  ssid: string;
  unifiConfig: StoredUnifiConfig;
}): Promise<string> {
  const ref = db.collection(AP_COLLECTION).doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(
      db.collection(AP_COLLECTION).where('mac', 'in', macSpellings(args.mac)),
    );

    for (const doc of snap.docs) {
      const data = doc.data() as { mac?: string; venueId?: string; tenantUserId?: string };
      if (canonMac(String(data.mac || '')) !== args.canon) continue; // spelling false positive
      if (data.venueId === args.venueId && data.tenantUserId === args.tenantUserId) {
        return doc.id; // already ours, at this venue — idempotent retry
      }
      throw new Error('MAC_CONFLICT');
    }

    tx.create(ref, {
      name: args.apName,
      mac: args.mac,
      venueId: args.venueId,
      venueName: args.venueName,
      tenantUserId: args.tenantUserId,
      vendor: 'unifi',
      sessionTimeout: DEFAULT_SESSION_TIMEOUT,
      events: defaultApEvents(),
      status: 'unknown',
      lastSeen: null,
      lastOfflineAt: null,
      lastAlertSentAt: null,
      alertsEnabled: true,
      offlineThresholdMinutes: DEFAULT_OFFLINE_THRESHOLD_MINUTES,
      unifiConfig: args.unifiConfig,
      // captive-server only — the CMS create path does not set these.
      adoptionState: 'registered',
      adoptionSource: 'self_serve',
      // The SSID the installer typed, kept because the WiFi is applied LATER — from a poll
      // or from the cron — and neither of those carries it. Without this a venue's FIRST
      // access point can never have its WiFi applied automatically: the venue has no
      // wifiSsid yet, so there is nothing to fall back to and the apply silently no-ops.
      pendingSsid: args.ssid,
      adoptionRequestedAt: null,
      wifiAppliedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  });
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface AdoptionStatusResult {
  phase: AdoptionPhase;
  wifiApplied: boolean;
  retryAfterSeconds: number;
  /** The one condition clients should stop polling on: connected AND WiFi applied. */
  done: boolean;
  /** Raw controller `state`, or null when the device has no row / the controller is down. */
  deviceState: number | null;
  reason: AdoptionStallReason | null;
  apName?: string;
  venueName?: string;
  ssid?: string;
}

/**
 * Where the device is, and — once it is connected — the point at which the venue's WiFi is
 * actually applied. Idempotent: `applyVenueWifi` is find-or-update throughout, so calling it
 * again on a later poll is harmless.
 */
export async function adoptionStatus(args: {
  tenantUserId: string;
  mac: string;
  ssid?: string;
}): Promise<AdoptionStatusResult> {
  const canon = canonMac(args.mac);
  const apSnap = await db
    .collection(AP_COLLECTION)
    .where('mac', 'in', macSpellings(args.mac))
    .get();

  const doc = apSnap.docs.find((d) => canonMac(String(d.data().mac || '')) === canon);
  if (!doc) {
    return {
      phase: 'waiting_for_device',
      wifiApplied: false,
      retryAfterSeconds: 3,
      done: false,
      deviceState: null,
      reason: 'not_registered',
    };
  }
  const ap = doc.data() as {
    name?: string;
    venueId?: string;
    venueName?: string;
    tenantUserId?: string;
    wifiAppliedAt?: Timestamp | null;
    adoptionRequestedAt?: Timestamp | null;
    adoptionLastError?: string;
  };
  if (ap.tenantUserId && ap.tenantUserId !== args.tenantUserId) {
    // Not this caller's device. Report the neutral phase rather than anything identifying —
    // including no reason code, which would confirm the MAC exists.
    return {
      phase: 'waiting_for_device',
      wifiApplied: false,
      retryAfterSeconds: 10,
      done: false,
      deviceState: null,
      reason: null,
    };
  }

  const requestedAt = ap.adoptionRequestedAt?.toMillis?.() ?? null;
  const since = requestedAt ? Date.now() - requestedAt : 0;

  let phase: AdoptionPhase = 'waiting_for_device';
  let reason: AdoptionStallReason | null = null;
  let deviceState: number | null = null;
  let statusConfig: UnifiConfig;
  let statusDevices: UnifiDevice[] = [];
  try {
    statusConfig = await resolveAnyController();
    statusDevices = await getDevices(statusConfig);
    let row = statusDevices.find((d) => canonMac(d.mac) === canon) || null;
    if (!row) {
      // Some controller versions only surface not-yet-adopted devices in stat/device-basic,
      // which getPendingDevices probes — without this the whole pending phase reads as
      // "waiting for device" on those controllers. Only on a miss, so the steady state
      // stays at one (cached) controller call.
      const pending = await getPendingDevices(statusConfig);
      row = pending.find((d) => canonMac(d.mac) === canon) || null;
    }
    const cls = classifyAdoption(row, requestedAt);
    phase = cls.phase;
    reason = cls.reason;
    deviceState = cls.deviceState;
  } catch (error) {
    console.error('[AP STATUS] Controller unreachable:', error);
    return {
      phase: 'waiting_for_device',
      wifiApplied: Boolean(ap.wifiAppliedAt),
      retryAfterSeconds: 10,
      done: false,
      deviceState: null,
      reason: 'controller_unreachable',
      apName: ap.name,
      venueName: ap.venueName,
    };
  }

  let wifiApplied = Boolean(ap.wifiAppliedAt);
  if (phase === 'connected' && ap.venueId) {
    // Naming runs whether or not the WiFi still needs applying: a device adopted before this
    // shipped, or one whose WiFi already went on, should still stop showing as "U6 Pro".
    await nameDeviceOnController({
      config: statusConfig,
      canon,
      venueId: ap.venueId,
      venueName: ap.venueName,
      apName: ap.name,
      devices: statusDevices,
    });
    if (!wifiApplied) {
      wifiApplied = await applyWifiForAp(doc.id, ap.venueId, args.ssid);
      // Connected but the WiFi step keeps failing is the one stall the classifier cannot
      // see; without a reason the client shows an infinite "setting up your WiFi" spinner.
      if (!wifiApplied) reason = 'wifi_apply_failed';
    }
  }

  return {
    phase,
    wifiApplied,
    retryAfterSeconds: retryAfterSeconds(since),
    done: isAdoptionDone(phase, wifiApplied),
    deviceState,
    reason,
    apName: ap.name,
    venueName: ap.venueName,
    ssid: args.ssid,
  };
}

// ── Dashboard progress ────────────────────────────────────────────────────────

export interface AdoptionProgressResult {
  accessPoints: AdoptionProgressEntry[];
  retryAfterSeconds: number;
  /** True when the controller could not be reached — phases are placeholders. */
  degraded?: boolean;
}

/**
 * A tenant's recent self-serve adoptions, classified against the controller. The dashboard's
 * counterpart to `adoptionStatus()`: keyed by tenant (and optionally venue) rather than MAC,
 * because the dashboard has no MAC until the helper registers the device.
 *
 * Runs the same connected-phase side effects as `adoptionStatus()` — naming and the WiFi
 * apply — so a dashboard left open finishes the job even if the helper was closed early.
 * Both are idempotent, and the two pollers share the 5-second device cache, so running
 * side by side costs one controller round trip per cache window.
 */
export async function adoptionProgress(args: {
  tenantUserId: string;
  venueId?: string;
  sinceMs?: number;
}): Promise<AdoptionProgressResult> {
  const now = Date.now();
  // Default to the last day — what the person is plausibly still watching — and clamp the
  // caller's own window so this cannot become a full history scan.
  const floor = now - 7 * 24 * 60 * 60_000;
  const since = Math.max(args.sinceMs ?? now - 24 * 60 * 60_000, floor);

  // Equality-only filters: served by Firestore's merged single-field indexes, no composite
  // index required. The `since` cut happens in memory — venue AP counts are capacity-capped.
  let query = db
    .collection(AP_COLLECTION)
    .where('tenantUserId', '==', args.tenantUserId)
    .where('adoptionSource', '==', 'self_serve');
  if (args.venueId) query = query.where('venueId', '==', args.venueId);
  const snap = await query.limit(25).get();

  type ApRow = {
    mac?: string;
    name?: string;
    venueId?: string;
    venueName?: string;
    adoptionState?: string;
    adoptionRequestedAt?: Timestamp | null;
    createdAt?: Timestamp | null;
    wifiAppliedAt?: Timestamp | null;
    adoptionLastError?: string;
  };
  const docs = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as ApRow }))
    // Fresh by creation OR by re-adoption: re-running the helper on an existing AP resets
    // adoptionRequestedAt but not createdAt, and that sitting deserves live status too.
    .filter(
      (d) =>
        Math.max(
          d.data.createdAt?.toMillis?.() ?? 0,
          d.data.adoptionRequestedAt?.toMillis?.() ?? 0,
        ) >= since,
    );

  const inputs = docs.map((d) => ({
    apId: d.id,
    apName: d.data.name,
    venueId: d.data.venueId,
    mac: canonMac(String(d.data.mac || '')),
    adoptionState: d.data.adoptionState,
    adoptionRequestedAt: d.data.adoptionRequestedAt?.toMillis?.() ?? null,
    createdAt: d.data.createdAt?.toMillis?.() ?? null,
    wifiApplied: Boolean(d.data.wifiAppliedAt),
    lastError: d.data.adoptionLastError ?? null,
  }));

  let config: UnifiConfig | null = null;
  let devices: UnifiDevice[] = [];
  let degraded = false;
  try {
    config = await resolveAnyController();
    devices = await getDevices(config);
  } catch (error) {
    console.error('[AP PROGRESS] Controller unreachable:', error);
    degraded = true;
  }
  const byMac = new Map(devices.map((d) => [canonMac(d.mac), d as { state?: unknown; adopted?: unknown }]));

  const entries = summarizeAdoptionProgress(inputs, byMac, now);

  if (config) {
    for (const entry of entries) {
      if (entry.phase !== 'connected' || !entry.venueId) continue;
      const source = docs.find((d) => d.id === entry.apId);
      await nameDeviceOnController({
        config,
        canon: entry.mac,
        venueId: entry.venueId,
        venueName: source?.data.venueName,
        apName: entry.apName ?? undefined,
        devices,
      });
      if (!entry.wifiApplied) {
        if (await applyWifiForAp(entry.apId, entry.venueId)) {
          entry.wifiApplied = true;
          entry.done = true;
          entry.reason = null;
        } else {
          entry.reason = 'wifi_apply_failed';
        }
      }
    }
  }

  // Poll cadence follows the youngest unfinished adoption; with nothing in flight the
  // dashboard can idle at the slow rate.
  const inFlight = entries.filter((e) => !e.done);
  const newest = inFlight
    .map((e) => e.adoptionRequestedAt ?? e.createdAt)
    .filter((iso): iso is string => Boolean(iso))
    .sort()
    .pop();
  const retry = degraded || !newest ? 10 : retryAfterSeconds(now - Date.parse(newest));

  return { accessPoints: entries, retryAfterSeconds: retry, ...(degraded ? { degraded } : {}) };
}

/**
 * Give the device a readable alias on the controller.
 *
 * Purely for whoever is looking at the controller's Devices list — nothing in the product
 * reads it. But on a shared site every access point otherwise shows as its model, so a
 * support question like "whose U6 Pro is this" has no answer without a database lookup.
 *
 * Best-effort and never throws: this is cosmetic, and an adoption must not fail because a
 * rename did. Skipped when the alias is already correct, so the cron sweep does not PUT the
 * same value every five minutes.
 */
async function nameDeviceOnController(args: {
  config: UnifiConfig;
  canon: string;
  venueId: string;
  venueName?: string;
  apName?: string;
  devices?: UnifiDevice[];
}): Promise<void> {
  try {
    const desired = controllerDeviceName({
      venueName: args.venueName,
      apName: args.apName,
      venueId: args.venueId,
    });
    const devices = args.devices ?? (await getDevices(args.config));
    const row = devices.find((d) => canonMac(d.mac) === args.canon);
    if (!row?.id || row.name === desired) return;

    await setDeviceName(args.config, row.id, desired);
    console.log('[AP CLAIM] Named device', args.canon, 'as', desired);
  } catch (error) {
    console.error('[AP CLAIM] Could not name device', args.canon, '-', (error as Error).message);
  }
}

/**
 * Apply the venue's WiFi and stamp the AP document. Returns whether it succeeded.
 *
 * Never throws: this runs both from a poll the installer is watching and from the cron, and
 * in neither case should a controller hiccup surface as a failed adoption — the next poll or
 * the next sweep retries.
 */
async function applyWifiForAp(apId: string, venueId: string, ssidHint?: string): Promise<boolean> {
  try {
    const [venueSnap, apSnap] = await Promise.all([
      db.collection(VENUE_COLLECTION).doc(venueId).get(),
      db.collection(AP_COLLECTION).doc(apId).get(),
    ]);
    // The venue's existing name wins (a second access point joins what is already there);
    // otherwise the SSID the installer typed, which was stored at claim time precisely
    // because this runs long after the request that carried it.
    const ssid = String(
      venueSnap.data()?.wifiSsid || apSnap.data()?.pendingSsid || ssidHint || '',
    ).trim();
    if (!ssid) {
      console.warn('[AP CLAIM] No SSID to apply for', apId, '— venue and pendingSsid are both empty');
      return false;
    }

    await applyVenueWifi(venueId, ssid);
    await db
      .collection(AP_COLLECTION)
      .doc(apId)
      .update({ wifiAppliedAt: FieldValue.serverTimestamp(), adoptionState: 'wifi_applied' });
    console.log('[AP CLAIM] WiFi applied for', apId, 'at venue', venueId);
    return true;
  } catch (error) {
    const message = (error as Error).message;
    console.error('[AP CLAIM] WiFi apply failed for', apId, '-', message);
    await db
      .collection(AP_COLLECTION)
      .doc(apId)
      .update({ adoptionLastError: message })
      .catch(() => undefined);
    return false;
  }
}

/**
 * Cron backstop: finish the WiFi step for access points that got adopted but never had it
 * applied — the installer closed their laptop, the poll was abandoned, the controller was
 * briefly down.
 *
 * This is what makes the deferred WiFi step safe rather than merely optimistic. Without it,
 * walking away mid-provision leaves a venue with an access point that is adopted, in no AP
 * group, and broadcasting nothing.
 *
 * Never throws — the cron calls it alongside the offline-alert sweep.
 */
export async function reconcilePendingWifi(): Promise<{ applied: number; checked: number }> {
  const result = { applied: 0, checked: 0 };
  try {
    const snap = await db
      .collection(AP_COLLECTION)
      .where('adoptionSource', '==', 'self_serve')
      .where('wifiAppliedAt', '==', null)
      .limit(50)
      .get();
    if (snap.empty) return result;

    const config = await resolveAnyController();
    const devices = await getDevices(config);
    const byMac = new Map(devices.map((d) => [canonMac(d.mac), d]));

    for (const doc of snap.docs) {
      const ap = doc.data() as {
        mac?: string;
        name?: string;
        venueId?: string;
        venueName?: string;
        adoptionRequestedAt?: Timestamp | null;
      };
      if (!ap.venueId || !ap.mac) continue;
      result.checked += 1;
      const row = byMac.get(canonMac(ap.mac)) || null;
      const phase = classifyAdoptionPhase(row, ap.adoptionRequestedAt?.toMillis?.() ?? null);
      if (phase !== 'connected') continue;
      await nameDeviceOnController({
        config,
        canon: canonMac(ap.mac),
        venueId: ap.venueId,
        venueName: ap.venueName,
        apName: ap.name,
        devices,
      });
      if (await applyWifiForAp(doc.id, ap.venueId)) result.applied += 1;
    }
  } catch (error) {
    console.error('[AP RECONCILE] sweep failed:', error);
  }
  return result;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

/**
 * Append-only record of every claim. Fire-and-forget: this exists for the first time a tenant
 * says "I never registered that access point", and must never fail the claim itself.
 */
async function recordAdoptionEvent(args: {
  tenantUserId: string;
  venueId: string;
  mac: string;
  apId: string;
  outcome: string;
}): Promise<void> {
  try {
    await db.collection(EVENTS_COLLECTION).add({ ...args, at: FieldValue.serverTimestamp() });
  } catch (error) {
    console.error('[AP CLAIM] Could not record adoption event:', error);
  }
}
