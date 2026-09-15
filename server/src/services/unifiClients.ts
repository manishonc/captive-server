/**
 * Live "who is connected right now" for a venue.
 *
 * ── THE ISOLATION BOUNDARY ───────────────────────────────────────────────────
 * Every tenant shares ONE UniFi site (`default`) — see docs/unifi-multi-tenancy-decision.md.
 * `stat/sta` therefore returns EVERY tenant's clients on every call. The only thing
 * separating one venue's guests from another's is the allowlist filter in
 * `filterToVenue()`: a station is kept if and only if its `ap_mac` canonically matches
 * an access point registered to this venue.
 *
 * That filter is an ALLOWLIST and must never be rewritten as a denylist. A station whose
 * `ap_mac` is missing, unparseable, or simply unknown to us is dropped, because we cannot
 * prove whose it is. Wired stations report `sw_mac`/`sw_port` rather than `ap_mac`, and we
 * keep no per-venue switch registry, so they are dropped for the same reason — surfacing
 * them would mean showing one tenant another tenant's hardware.
 *
 * Identity attachment has a SECOND, independent guard: a registry entry is only allowed to
 * name a person when its `tenantUserId` matches the venue's owner. A phone that signed in
 * at tenant A's cafe and later associates with tenant B's AP legitimately appears in B's
 * list — as an anonymous MAC, never as A's named guest.
 *
 * This module is deliberately separate from ./unifiWlan, which is a mutation orchestrator
 * built around a per-venue lock because AP-group writes are read-modify-overwrite. Nothing
 * here mutates or takes a lock; these are cached reads.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { UnifiConfig } from '../types/captive';
import {
  canonMac,
  getClients,
  getGuestAuthorizations,
  invalidateClientCache,
  kickClient,
  unauthorizeGuest,
  UnifiClient,
  UnifiGuestAuth,
} from './unifi';
import { getVenueUnifiAps, resolveVenueController, VenueUnifiAp } from './unifiWlan';
import { DeviceRegistryDocument, lookupDevices } from './deviceRegistry';
import {
  ActiveClientRow,
  apIndex,
  buildRow,
  filterToVenue,
  groupGuests,
  LiveGuestGroup,
  scopedDevices,
} from './liveClientScope';

export type { ActiveClientGuest, ActiveClientRow, LiveGuestGroup } from './liveClientScope';

const VENUE_COLLECTION = 'CaptivePortal_Venues';
const SESSION_COLLECTION = 'CaptivePortal_Sessions';
const DEVICE_ACTION_COLLECTION = 'CaptivePortal_DeviceActions';

export interface VenueActiveClients {
  venueId: string;
  venueName: string | null;
  total: number;
  identified: number;
  unidentified: number;
  perAp: Record<string, { apId: string; apName: string | null; mac: string; count: number }>;
  guests: LiveGuestGroup[];
  clients: ActiveClientRow[];
  activeGuestIds: string[];
  fetchedAt: string;
  /**
   * False when the controller could not be reached. Callers MUST render this differently
   * from `total: 0` — "nobody is connected" and "we cannot tell" are entirely different
   * answers to a venue owner, and collapsing them reads as an outage that isn't happening.
   */
  controllerOk: boolean;
  /**
   * False for venues with no UniFi APs (e.g. Aruba hardware), where a live view is
   * impossible rather than empty.
   */
  vendorSupported: boolean;
}

function emptyVenue(venueId: string, venueName: string | null, over: Partial<VenueActiveClients> = {}): VenueActiveClients {
  return {
    venueId,
    venueName,
    total: 0,
    identified: 0,
    unidentified: 0,
    perAp: {},
    guests: [],
    clients: [],
    activeGuestIds: [],
    fetchedAt: new Date().toISOString(),
    controllerOk: true,
    vendorSupported: true,
    ...over,
  };
}

interface VenueDoc {
  venue_name?: string;
  tenantUserId?: string;
  wifiSsid?: string;
}

async function loadVenue(venueId: string): Promise<VenueDoc | null> {
  const snap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
  return snap.exists ? (snap.data() as VenueDoc) : null;
}

export interface VenueActiveOptions {
  includeClients?: boolean;
  includeIdentity?: boolean;
}

/** Live client snapshot for one venue. Never throws for an expected condition. */
export async function getVenueActiveClients(
  venueId: string,
  opts: VenueActiveOptions = {},
): Promise<VenueActiveClients> {
  const includeClients = opts.includeClients !== false;
  const includeIdentity = opts.includeIdentity !== false;

  const [venue, aps] = await Promise.all([loadVenue(venueId), getVenueUnifiAps(venueId)]);
  const venueName = venue?.venue_name ?? null;

  // No UniFi APs: Aruba hardware or an unprovisioned venue. Not an error, and emphatically
  // not "0 connected" — a live view is impossible here, not empty.
  if (aps.length === 0) return emptyVenue(venueId, venueName, { vendorSupported: false });

  let config: UnifiConfig;
  try {
    config = resolveVenueController(aps);
  } catch (err) {
    console.error('[ACTIVE CLIENTS] No controller config for venue', venueId, err);
    return emptyVenue(venueId, venueName, { controllerOk: false });
  }

  let clients: UnifiClient[];
  let auths: UnifiGuestAuth[] = [];
  try {
    // The authorization window is a nice-to-have on a much slower clock; it must never
    // take the headcount down with it.
    const [clientsRes, authsRes] = await Promise.allSettled([
      getClients(config),
      getGuestAuthorizations(config),
    ]);
    if (clientsRes.status === 'rejected') throw clientsRes.reason;
    clients = clientsRes.value;
    if (authsRes.status === 'fulfilled') auths = authsRes.value;
  } catch (err) {
    console.error('[ACTIVE CLIENTS] Controller unreachable for venue', venueId, err);
    return emptyVenue(venueId, venueName, { controllerOk: false });
  }

  const byCanon = apIndex(aps);
  const mine = filterToVenue(clients, byCanon);

  const devices = includeIdentity
    ? scopedDevices(await lookupDevices(mine.map((c) => c.canon)), venue?.tenantUserId ?? null)
    : new Map<string, DeviceRegistryDocument>();

  const authByCanon = new Map(auths.map((a) => [a.canon, a]));
  const rows = mine.map((c) =>
    buildRow(c, byCanon.get(c.apCanon as string), venueId, venue?.wifiSsid ?? null, devices.get(c.canon), authByCanon.get(c.canon)),
  );

  const perAp: VenueActiveClients['perAp'] = {};
  for (const ap of aps) perAp[ap.id] = { apId: ap.id, apName: ap.name ?? null, mac: ap.mac, count: 0 };
  for (const r of rows) if (r.apId && perAp[r.apId]) perAp[r.apId].count += 1;

  const guests = groupGuests(rows);
  const identified = rows.filter((r) => r.guest.source === 'registry').length;

  return {
    venueId,
    venueName,
    total: rows.length,
    identified,
    unidentified: rows.length - identified,
    perAp,
    guests,
    clients: includeClients ? rows : [],
    activeGuestIds: Array.from(new Set(guests.flatMap((g) => g.wifiGuestIds))),
    fetchedAt: new Date().toISOString(),
    controllerOk: true,
    vendorSupported: true,
  };
}

export interface OrgVenueCount {
  venueId: string;
  venueName: string | null;
  total: number;
  identified: number;
  vendorSupported: boolean;
  controllerOk: boolean;
}

export interface OrgActiveClients {
  total: number;
  byVenue: Record<string, OrgVenueCount>;
  byAccessPoint: Record<string, number>;
  activeGuestIds: string[];
  fetchedAt: string;
  controllerOk: boolean;
}

/**
 * Live counts across many venues from ONE `stat/sta` call, fanned out in memory.
 *
 * The reason is consistency, not speed. Per-venue calls would mostly hit the same cache
 * anyway, but N of them straddling a TTL boundary means venue A's count comes from `t` and
 * venue B's from `t+8s` — so the org total is a sum of two different instants and can
 * visibly disagree with the per-venue numbers the user sees one click later. One call
 * gives one `fetchedAt` and totals that reconcile by construction.
 */
export async function getOrgActiveClients(venueIds: string[]): Promise<OrgActiveClients> {
  const now = new Date().toISOString();
  const ids = Array.from(new Set(venueIds.filter(Boolean)));
  const base: OrgActiveClients = {
    total: 0,
    byVenue: {},
    byAccessPoint: {},
    activeGuestIds: [],
    fetchedAt: now,
    controllerOk: true,
  };
  if (ids.length === 0) return base;

  const venues = await Promise.all(ids.map(async (id) => ({ id, doc: await loadVenue(id) })));
  const apLists = await Promise.all(ids.map((id) => getVenueUnifiAps(id)));

  // One combined allowlist: canonical AP MAC -> which venue owns it.
  const owner = new Map<string, { venueId: string; ap: VenueUnifiAp }>();
  let config: UnifiConfig | null = null;
  ids.forEach((venueId, i) => {
    const aps = apLists[i];
    const venueDoc = venues[i].doc;
    base.byVenue[venueId] = {
      venueId,
      venueName: venueDoc?.venue_name ?? null,
      total: 0,
      identified: 0,
      vendorSupported: aps.length > 0,
      controllerOk: true,
    };
    for (const ap of aps) {
      const c = canonMac(ap.mac);
      if (c) owner.set(c, { venueId, ap });
      base.byAccessPoint[ap.id] = 0;
    }
    if (!config && aps.length) {
      try {
        config = resolveVenueController(aps);
      } catch {
        /* try the next venue's APs */
      }
    }
  });

  if (!config) return base;

  let clients: UnifiClient[];
  try {
    clients = await getClients(config);
  } catch (err) {
    console.error('[ACTIVE CLIENTS] Org rollup: controller unreachable', err);
    base.controllerOk = false;
    for (const v of Object.values(base.byVenue)) v.controllerOk = false;
    return base;
  }

  const mine = clients.filter((c) => !c.isWired && c.apCanon !== null && owner.has(c.apCanon));
  const devices = await lookupDevices(mine.map((c) => c.canon));
  const tenantByVenue = new Map(ids.map((id, i) => [id, venues[i].doc?.tenantUserId ?? null]));
  const guestIds = new Set<string>();

  for (const c of mine) {
    const hit = owner.get(c.apCanon as string)!;
    base.total += 1;
    base.byVenue[hit.venueId].total += 1;
    base.byAccessPoint[hit.ap.id] = (base.byAccessPoint[hit.ap.id] ?? 0) + 1;

    const device = devices.get(c.canon);
    // Same per-tenant PII guard as the venue path.
    if (device && device.tenantUserId && device.tenantUserId === tenantByVenue.get(hit.venueId)) {
      base.byVenue[hit.venueId].identified += 1;
      if (device.wifiGuestId) guestIds.add(device.wifiGuestId);
    }
  }

  base.activeGuestIds = Array.from(guestIds);
  return base;
}

export interface DisconnectResult {
  ok: true;
  mac: string;
  apId: string | null;
  unauthorized: boolean;
  kicked: boolean;
}

export class DisconnectError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

/**
 * Disconnect one device from a venue's WiFi.
 *
 * Nothing is trusted from the caller but `venueId` and `mac` — never an AP id and never a
 * controller config, both of which would let a caller name a target outside their venue.
 * The station's presence on one of THIS venue's APs is re-verified against the controller
 * immediately before acting.
 */
export async function disconnectVenueClient(
  venueId: string,
  mac: string,
  actorId?: string,
): Promise<DisconnectResult> {
  const canon = canonMac(mac);
  if (!canon) throw new DisconnectError('invalid_mac', 400);

  const aps = await getVenueUnifiAps(venueId);
  if (aps.length === 0) throw new DisconnectError('venue_has_no_unifi_aps', 400);

  let config: UnifiConfig;
  try {
    config = resolveVenueController(aps);
  } catch {
    throw new DisconnectError('controller_not_configured', 502);
  }

  // Deliberately bypasses the cache. An 8-second-old snapshot can still show a MAC on this
  // venue's AP after it has roamed to another tenant's, and kicking on stale evidence is
  // precisely the cross-tenant action this module exists to prevent. Kicks are rare and
  // human-initiated; one extra controller round trip is the right trade.
  let clients: UnifiClient[];
  try {
    clients = await getClients(config, { force: true });
  } catch (err) {
    console.error('[DISCONNECT] Controller unreachable', venueId, err);
    throw new DisconnectError('controller_unreachable', 502);
  }

  const row = clients.find((c) => c.canon === canon);
  if (!row) throw new DisconnectError('client_not_connected', 404);

  const byCanon = apIndex(aps);
  if (!row.apCanon || !byCanon.has(row.apCanon)) {
    console.warn('[DISCONNECT] Refused: MAC is not on this venue', { venueId, mac: row.mac, apMac: row.apMac });
    throw new DisconnectError('client_not_on_this_venue', 403);
  }
  const ap = byCanon.get(row.apCanon)!;

  // Order matters. Guest authorization is site-wide, so kicking alone just makes the device
  // reassociate within seconds — without even seeing the splash again. Revoke first so the
  // firewall is closed before the client can react, then kick so the session visibly ends.
  await unauthorizeGuest(config, row.mac);
  await kickClient(config, row.mac);

  // Otherwise the next poll serves the pre-kick snapshot for up to 8s and the action looks
  // like it silently failed.
  invalidateClientCache(config);

  const device = (await lookupDevices([canon])).get(canon);
  const timestamp = new Date().toISOString();

  // First producer of 'onDisconnect'. The event has always existed in the WifiEvent union
  // but nothing has ever written it, so anything that implicitly assumed it never occurs
  // will start seeing it.
  db.collection(SESSION_COLLECTION)
    .add({
      wifiEvent: 'onDisconnect',
      wifiGuestId: device?.wifiGuestId ?? null,
      accessPointId: ap.id,
      mac: row.mac,
      ip: row.ip ?? '',
      timestamp,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.error('[DISCONNECT SESSION LOG ERROR]', err));

  db.collection(DEVICE_ACTION_COLLECTION)
    .add({
      action: 'disconnect',
      mac: row.mac,
      venueId,
      apId: ap.id,
      wifiGuestId: device?.wifiGuestId ?? null,
      actorId: actorId ?? null,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.error('[DISCONNECT AUDIT ERROR]', err));

  console.log('[DISCONNECT] Removed', row.mac, 'from venue', venueId, 'by', actorId ?? 'unknown');
  return { ok: true, mac: row.mac, apId: ap.id, unauthorized: true, kicked: true };
}
