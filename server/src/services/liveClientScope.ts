/**
 * Pure scoping and grouping logic for the live-clients view.
 *
 * Split out of ./unifiClients deliberately: that module imports ../firebase, whose
 * import-time initialization needs real credentials, so anything living there cannot be
 * unit tested. Everything here touches neither Firestore nor the controller, which matters
 * because `filterToVenue` IS the multi-tenant isolation boundary — every tenant shares one
 * UniFi site, so a bug here leaks one venue's guests to another. It deserves tests that
 * run with no credentials, the same way services/unifi.ts is kept testable.
 */

import { canonMac, UnifiClient, UnifiGuestAuth } from './unifi';

/** Treat an implausible uptime as unknown rather than rendering a 4-year session. */
export const MAX_PLAUSIBLE_UPTIME_SEC = 30 * 24 * 60 * 60;

/** The subset of an access point document this module needs. */
export interface ScopedAp {
  id: string;
  mac: string;
  name?: string | null;
}

/** The subset of a device-registry document this module needs. */
export interface ScopedDevice {
  wifiGuestId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  tenantUserId?: string | null;
}

export interface ActiveClientGuest {
  wifiGuestId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  source: 'registry' | 'unknown';
}

export interface ActiveClientRow {
  mac: string;
  canon: string;
  apId: string | null;
  apName: string | null;
  apMac: string | null;
  venueId: string;
  hostname: string | null;
  ip: string | null;
  ssid: string | null;
  /**
   * Whether the station is on the SSID we provisioned. Informational only: SSIDs are NOT
   * unique across tenants on the shared site, so this must never be used for isolation.
   */
  ssidMatch: boolean;
  authorized: boolean;
  isGuest: boolean;
  connectedSince: string | null;
  connectedSeconds: number | null;
  authorizedUntil: string | null;
  rxBytes: number;
  txBytes: number;
  signal: number | null;
  oui: string | null;
  guest: ActiveClientGuest;
}

/** One person and every device they currently have on this venue's WiFi. */
export interface LiveGuestGroup {
  /** Grouping key: lowercased email, or `guest:<wifiGuestId>` when no email was captured. */
  key: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /**
   * Every guest document this person owns. Plural by necessity: guests are keyed on
   * `email + accessPointId`, so one human who signed in at two APs of the same venue has
   * two documents. The CMS joins its "online" dot on these ids.
   */
  wifiGuestIds: string[];
  deviceCount: number;
  macs: string[];
  connectedSeconds: number | null;
}

/** Canonical AP MAC -> the AP, i.e. the allowlist the whole feature rests on. */
export function apIndex(aps: ScopedAp[]): Map<string, ScopedAp> {
  const m = new Map<string, ScopedAp>();
  for (const ap of aps) {
    const c = canonMac(ap.mac);
    if (c) m.set(c, ap);
  }
  return m;
}

/**
 * Keep only stations provably on one of this venue's access points.
 *
 * This is an ALLOWLIST and must never be rewritten as a denylist. A station whose `ap_mac`
 * is missing, unparseable, or simply unknown to us is dropped, because we cannot prove
 * whose it is. Wired stations report `sw_mac`/`sw_port` instead of `ap_mac`, and we keep no
 * per-venue switch registry, so they are dropped for the same reason — including them would
 * show one tenant another tenant's hardware.
 */
export function filterToVenue(clients: UnifiClient[], byCanon: Map<string, ScopedAp>): UnifiClient[] {
  return clients.filter((c) => !c.isWired && c.apCanon !== null && byCanon.has(c.apCanon));
}

/**
 * Attach identity only where the registry's tenant matches the venue's owner.
 *
 * A second guard, independent of the AP allowlist: the allowlist governs PRESENCE, this
 * governs PII. A phone that signed in at tenant A's cafe and is now physically in tenant B's
 * bar legitimately appears in B's list — as an anonymous MAC, never as A's named guest.
 */
export function scopedDevices<T extends ScopedDevice>(
  found: Map<string, T>,
  tenantUserId: string | null,
): Map<string, T> {
  const out = new Map<string, T>();
  if (!tenantUserId) return out;
  for (const [canon, doc] of found) {
    if (doc.tenantUserId && doc.tenantUserId === tenantUserId) out.set(canon, doc);
  }
  return out;
}

/**
 * Session length from `uptime`, never from `assoc_time`.
 *
 * `assoc_time` is epoch seconds on the CONTROLLER's clock; subtracting it from this
 * process's `Date.now()` mixes two clocks and yields negative or wildly inflated durations
 * whenever they drift. `uptime` is a controller-side counter and is skew-free.
 */
export function connectionAge(uptimeSec: number | null, now = Date.now()): {
  seconds: number | null;
  since: string | null;
} {
  if (uptimeSec === null || uptimeSec < 0 || uptimeSec > MAX_PLAUSIBLE_UPTIME_SEC) {
    return { seconds: null, since: null };
  }
  return { seconds: uptimeSec, since: new Date(now - uptimeSec * 1000).toISOString() };
}

export function buildRow(
  c: UnifiClient,
  ap: ScopedAp | undefined,
  venueId: string,
  venueSsid: string | null,
  device: ScopedDevice | undefined,
  auth: UnifiGuestAuth | undefined,
  now = Date.now(),
): ActiveClientRow {
  const age = connectionAge(c.uptimeSec, now);
  return {
    mac: c.mac,
    canon: c.canon,
    apId: ap?.id ?? null,
    apName: ap?.name ?? null,
    apMac: c.apMac,
    venueId,
    hostname: c.hostname ?? c.name,
    ip: c.ip,
    ssid: c.essid,
    ssidMatch: !!venueSsid && c.essid === venueSsid,
    authorized: c.authorized,
    isGuest: c.isGuest,
    connectedSince: age.since,
    connectedSeconds: age.seconds,
    authorizedUntil: auth?.end ? new Date(auth.end * 1000).toISOString() : null,
    rxBytes: c.rxBytes,
    txBytes: c.txBytes,
    signal: c.signal,
    oui: c.oui,
    guest: device
      ? {
          wifiGuestId: device.wifiGuestId ?? null,
          email: device.email || null,
          firstName: device.firstName || null,
          lastName: device.lastName || null,
          phone: device.phone || null,
          source: 'registry',
        }
      : { wifiGuestId: null, email: null, firstName: null, lastName: null, phone: null, source: 'unknown' },
  };
}

/**
 * Collapse rows into people.
 *
 * Grouped by EMAIL, not by `wifiGuestId`. Because guest documents are keyed on
 * `email + accessPointId` and a venue has many APs, one person who signed in at the bar AP
 * and again at the terrace AP owns two documents — grouping on the document id would show
 * them as two different guests, each holding half their devices.
 */
export function groupGuests(rows: ActiveClientRow[]): LiveGuestGroup[] {
  const groups = new Map<string, LiveGuestGroup>();

  for (const r of rows) {
    const g = r.guest;
    if (g.source !== 'registry') continue;
    const key = g.email || (g.wifiGuestId ? `guest:${g.wifiGuestId}` : '');
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        email: g.email,
        firstName: g.firstName,
        lastName: g.lastName,
        phone: g.phone,
        wifiGuestIds: [],
        deviceCount: 0,
        macs: [],
        connectedSeconds: null,
      };
      groups.set(key, group);
    }

    if (g.wifiGuestId && !group.wifiGuestIds.includes(g.wifiGuestId)) group.wifiGuestIds.push(g.wifiGuestId);
    if (!group.macs.includes(r.mac)) {
      group.macs.push(r.mac);
      group.deviceCount += 1;
    }
    // The longest-running device stands in for "how long has this person been here".
    if (r.connectedSeconds !== null && (group.connectedSeconds === null || r.connectedSeconds > group.connectedSeconds)) {
      group.connectedSeconds = r.connectedSeconds;
    }
  }

  return Array.from(groups.values()).sort((a, b) => b.deviceCount - a.deviceCount);
}
