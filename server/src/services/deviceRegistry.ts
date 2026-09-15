/**
 * Device -> guest registry: which person a MAC address belongs to.
 *
 * WHY THIS EXISTS
 * Guest documents are keyed on `email + captivePortalAccessPointId`, and their `mac`
 * field is written once when the guest first signs in and never updated on reconnect.
 * So a guest doc holds at most ONE device's MAC — the first one ever seen — and a guest
 * with a phone and a laptop is invisible as such. Worse, because the key includes the
 * access point and a venue has many APs, the same person signing in at two APs of one
 * venue produces TWO guest docs.
 *
 * `CaptivePortal_Sessions` does record a MAC per connect event, but it is an append-only
 * log: answering "who owns this MAC" means an ordered query per MAC whose cost grows with
 * history rather than with how many people are currently connected. Its `mac` field is
 * also not consistently normalized — the UniFi path writes a colon-lowercase MAC while
 * the generic/Aruba path writes whatever the AP put in the query string.
 *
 * This collection is the answer to that question and nothing else. The document id IS
 * the canonical MAC, so resolving N connected devices is a single `getAll` — no index,
 * no `in`-clause chunking at 30, no ordering.
 *
 * WHAT IT IS NOT
 * MAC randomization (private Wi-Fi addresses on iOS/Android) means a returning guest can
 * present a new MAC on every join. Misses are permanent and expected, not a backfill gap.
 * Never use this registry for anything billing-, quota-, or entitlement-shaped.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { canonMac, normalizeMac } from './unifi';

export const DEVICE_COLLECTION = 'CaptivePortal_Devices';

export interface DeviceRegistryDocument {
  /** Canonical MAC (lowercase, separators stripped). Equals the document id. */
  canonMac: string;
  /** Last-seen colon-separated spelling, for display. */
  mac: string;
  wifiGuestId: string;
  /**
   * Denormalized so the live view can group a person's devices without a second read,
   * and so the duplicate-guest-doc case still collapses to one person: two guest docs
   * for the same human share an email even when their doc ids differ.
   */
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  accessPointId: string;
  venueId: string | null;
  /**
   * The PII guard. A device that signed in at tenant A's cafe and later associates with
   * tenant B's AP must show to B as an anonymous MAC, never as a named person — so
   * identity is only ever attached when this matches the venue's owner.
   */
  tenantUserId: string | null;
  vendor: string;
  hostname: string | null;
  firstSeenAt: Timestamp | FieldValue;
  lastSeenAt: Timestamp | FieldValue;
  authCount: number | FieldValue;
}

export interface RecordDeviceIdentityInput {
  mac: string;
  wifiGuestId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  accessPointId: string;
  venueId?: string | null;
  tenantUserId?: string | null;
  vendor?: string;
  hostname?: string | null;
}

/**
 * Upsert the owner of a MAC.
 *
 * `create()` first, falling back to a merge on ALREADY_EXISTS, rather than a plain
 * merging `set`: that costs two round trips only on a device's very first sighting and
 * one thereafter, while guaranteeing `firstSeenAt` is never clobbered — which a merging
 * `set` cannot do without a transaction.
 *
 * Callers invoke this fire-and-forget. By the time it runs the controller has already
 * authorized the guest, so a registry failure must never fail the request.
 */
export async function recordDeviceIdentity(input: RecordDeviceIdentityInput): Promise<void> {
  const canon = canonMac(input.mac);
  if (!canon || !input.wifiGuestId || !input.accessPointId) return;

  const ref = db.collection(DEVICE_COLLECTION).doc(canon);
  const now = FieldValue.serverTimestamp();

  const base = {
    canonMac: canon,
    mac: normalizeMac(input.mac),
    wifiGuestId: input.wifiGuestId,
    email: (input.email || '').trim().toLowerCase(),
    firstName: input.firstName || '',
    lastName: input.lastName || '',
    phone: input.phone || '',
    accessPointId: input.accessPointId,
    venueId: input.venueId ?? null,
    tenantUserId: input.tenantUserId ?? null,
    vendor: input.vendor || 'unifi',
    hostname: input.hostname ?? null,
    lastSeenAt: now,
  };

  try {
    await ref.create({ ...base, firstSeenAt: now, authCount: 1 });
  } catch (err) {
    // ALREADY_EXISTS (gRPC 6) is the steady-state path, not an error.
    if ((err as { code?: number }).code !== 6) throw err;
    await ref.set({ ...base, authCount: FieldValue.increment(1) }, { merge: true });
  }
}

/**
 * Resolve many MACs to their owners in one round trip.
 *
 * Batched at 300 purely defensively — a venue's live client count is typically well
 * under 100. Returns a map keyed by canonical MAC; absent keys are devices nobody has
 * ever signed in on, which is a normal and permanent state (see MAC randomization).
 */
export async function lookupDevices(canons: string[]): Promise<Map<string, DeviceRegistryDocument>> {
  const out = new Map<string, DeviceRegistryDocument>();
  const unique = Array.from(new Set(canons.filter(Boolean)));
  if (unique.length === 0) return out;

  const BATCH = 300;
  for (let i = 0; i < unique.length; i += BATCH) {
    const refs = unique.slice(i, i + BATCH).map((c) => db.collection(DEVICE_COLLECTION).doc(c));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) out.set(snap.id, snap.data() as DeviceRegistryDocument);
    }
  }
  return out;
}
