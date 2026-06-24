/**
 * Venue-scoped UniFi WiFi orchestration (Firestore + controller).
 *
 * A venue's guest WiFi is one WLAN (the SSID guests connect to) bound to a per-venue
 * AP group that holds all the venue's UniFi access points — the unit that stays
 * correct under mesh. The controller linkage (`unifiApGroupId`, `unifiWlanId`,
 * `wifiSsid`) is stored on the venue document. Controller credentials come from the
 * APs' stored `unifiConfig` (UNIFI_* env only as a fallback).
 *
 * All controller HTTP lives in ./unifi; this module adds the Firestore glue. It is
 * the captive-server counterpart of the CMS's former _lib/unifi/venue-wifi.ts, now
 * reached by the CMS via the secret-guarded /internal/unifi/* endpoints.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { UnifiConfig } from '../types/captive';
import {
  normalizeMac,
  mapDeviceState,
  effectiveControllerUrl,
  getDevices,
  getApGroups,
  rawSiteGet,
  siteRequestV2,
  findGuestWlanTemplate,
  ensureApGroup,
  ensureWlan,
  removeMacFromApGroup,
  deleteApGroup,
  deleteWlan,
} from './unifi';

const AP_COLLECTION = 'CaptivePortal_AccessPoints';
const VENUE_COLLECTION = 'CaptivePortal_Venues';

interface StoredUnifiConfig {
  controllerType?: string;
  controllerUrl?: string;
  site?: string;
  username?: string;
  password?: string;
}

interface VenueUnifiAp {
  id: string;
  mac: string;
  venueId?: string;
  unifiConfig?: StoredUnifiConfig | null;
}

/** Build a controller config from a stored AP unifiConfig, with UNIFI_* env fallback per field. */
function resolveConfig(stored?: StoredUnifiConfig | null): UnifiConfig {
  const ct = stored?.controllerType || process.env.UNIFI_CONTROLLER_TYPE || 'classic';
  const controllerType = ct === 'udm' ? 'udm' : 'classic';
  // Internal address (UNIFI_CONTROLLER_URL env) wins over the AP's stored public URL.
  const controllerUrl = effectiveControllerUrl(stored?.controllerUrl);
  const site = (String(stored?.site || process.env.UNIFI_SITE || 'default').trim()) || 'default';
  const username = String(stored?.username || process.env.UNIFI_USERNAME || '').trim();
  const password = String(stored?.password || process.env.UNIFI_PASSWORD || '');
  if (!controllerUrl || !username || !password) {
    throw new Error('UniFi controller credentials are not configured.');
  }
  return { controllerType, controllerUrl, site, username, password };
}

async function getVenueUnifiAps(venueId: string): Promise<VenueUnifiAp[]> {
  const snap = await db.collection(AP_COLLECTION).where('venueId', '==', venueId).get();
  const aps: VenueUnifiAp[] = [];
  snap.forEach((doc) => {
    const d = doc.data() as any;
    if (String(d.vendor || '').toLowerCase() !== 'unifi') return;
    aps.push({ id: doc.id, mac: normalizeMac(d.mac), venueId, unifiConfig: d.unifiConfig || null });
  });
  return aps;
}

function resolveVenueController(aps: VenueUnifiAp[]): UnifiConfig {
  const withCfg = aps.find((a) => a.unifiConfig?.password);
  return resolveConfig(withCfg?.unifiConfig || undefined);
}

export function validateSsid(ssid: unknown): string {
  const s = String(ssid ?? '').trim();
  if (s.length < 1 || s.length > 32) throw new Error('WiFi name must be 1–32 characters.');
  return s;
}

export interface VenueWifiResult {
  wifiSsid: string;
  unifiApGroupId: string;
  unifiWlanId: string;
}

/** Create/update the venue's guest WLAN scoped to a venue AP group; persist ids on the venue. */
export async function applyVenueWifi(venueId: string, ssidInput: string): Promise<VenueWifiResult> {
  const ssid = validateSsid(ssidInput);

  const venueSnap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
  if (!venueSnap.exists) throw new Error('Venue not found');
  const venue = venueSnap.data() as any;

  const aps = await getVenueUnifiAps(venueId);
  if (aps.length === 0) throw new Error('Add a UniFi access point to this venue before setting a WiFi name.');

  const config = resolveVenueController(aps);
  const memberMacs = aps.map((a) => a.mac).filter(Boolean);
  const groupName = String(venue.venue_name || `Venue ${venueId}`).slice(0, 64);
  const templateName = process.env.UNIFI_TEMPLATE_SSID || undefined;

  const template = await findGuestWlanTemplate(config, templateName);
  const apGroupId = await ensureApGroup(config, { groupId: venue.unifiApGroupId || null, name: groupName, memberMacs });
  const wlanId = await ensureWlan(config, { wlanId: venue.unifiWlanId || null, ssid, apGroupId, template });

  await db.collection(VENUE_COLLECTION).doc(venueId).update({
    wifiSsid: ssid,
    unifiApGroupId: apGroupId,
    unifiWlanId: wlanId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { wifiSsid: ssid, unifiApGroupId: apGroupId, unifiWlanId: wlanId };
}

/** Remove one AP's MAC from its venue group; tear down WLAN+group + clear venue fields if last. */
export async function detachApFromVenueWifi(venueId: string, mac: string): Promise<void> {
  const venueSnap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
  if (!venueSnap.exists) return;
  const venue = venueSnap.data() as any;
  const apGroupId: string | undefined = venue.unifiApGroupId;
  const wlanId: string | undefined = venue.unifiWlanId;
  if (!apGroupId) return;

  const aps = await getVenueUnifiAps(venueId);
  const config = resolveVenueController(aps);

  const remaining = await removeMacFromApGroup(config, apGroupId, mac);
  if (remaining === 0) {
    if (wlanId) {
      try {
        await deleteWlan(config, wlanId);
      } catch {
        /* best-effort */
      }
    }
    try {
      await deleteApGroup(config, apGroupId);
    } catch {
      /* best-effort */
    }
    await db.collection(VENUE_COLLECTION).doc(venueId).update({
      unifiApGroupId: null,
      unifiWlanId: null,
      wifiSsid: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

// ── Live device status ────────────────────────────────────────────────────────

export interface ApDeviceStatus {
  deviceState: 'online' | 'offline' | 'unknown';
  uptime?: number;
  lastSeenController?: number;
  model?: string;
  version?: string;
  currentGroup: 'all' | 'venue' | 'other';
  inVenueGroup: boolean;
}

/** Live device status for the given AP ids (already authorized by the caller/CMS). */
export async function getDeviceStatuses(apIds: string[]): Promise<Record<string, ApDeviceStatus>> {
  const out: Record<string, ApDeviceStatus> = {};
  const aps: VenueUnifiAp[] = [];

  for (const id of apIds || []) {
    const snap = await db.collection(AP_COLLECTION).doc(id).get();
    if (!snap.exists) continue;
    const d = snap.data() as any;
    if (String(d.vendor || '').toLowerCase() !== 'unifi') continue;
    aps.push({ id, mac: normalizeMac(d.mac), venueId: d.venueId, unifiConfig: d.unifiConfig || null });
    out[id] = { deviceState: 'unknown', currentGroup: 'all', inVenueGroup: false };
  }

  const venueIds = Array.from(new Set(aps.map((a) => a.venueId).filter(Boolean))) as string[];
  const venueGroupId: Record<string, string | undefined> = {};
  await Promise.all(
    venueIds.map(async (vid) => {
      const v = await db.collection(VENUE_COLLECTION).doc(vid).get();
      venueGroupId[vid] = v.exists ? (v.data() as any).unifiApGroupId : undefined;
    }),
  );

  const groups = new Map<string, { config: UnifiConfig; aps: VenueUnifiAp[] }>();
  for (const ap of aps) {
    let config: UnifiConfig;
    try {
      config = resolveConfig(ap.unifiConfig);
    } catch {
      continue;
    }
    const key = `${config.controllerType}|${config.controllerUrl}|${config.site}`;
    if (!groups.has(key)) groups.set(key, { config, aps: [] });
    groups.get(key)!.aps.push(ap);
  }

  for (const { config, aps: groupAps } of groups.values()) {
    try {
      const [devices, apGroups] = await Promise.all([getDevices(config), getApGroups(config)]);
      const byMac = new Map(devices.map((d) => [d.mac, d]));
      const macGroups: Record<string, string[]> = {};
      for (const g of apGroups) for (const m of g.device_macs || []) (macGroups[normalizeMac(m)] ||= []).push(g._id);

      for (const ap of groupAps) {
        const dev = byMac.get(ap.mac);
        const vGroup = ap.venueId ? venueGroupId[ap.venueId] : undefined;
        const memberOf = macGroups[ap.mac] || [];
        const inVenue = !!(vGroup && memberOf.includes(vGroup));
        out[ap.id] = {
          deviceState: dev ? mapDeviceState(dev.state) : 'unknown',
          uptime: dev?.uptime,
          lastSeenController: dev?.lastSeen,
          model: dev?.model,
          version: dev?.version,
          inVenueGroup: inVenue,
          currentGroup: inVenue ? 'venue' : memberOf.length > 0 ? 'other' : 'all',
        };
      }
    } catch {
      // controller unreachable — APs keep their "unknown" defaults
    }
  }

  return out;
}

// ── Diagnostics (temporary; plan B5) ──────────────────────────────────────────

const SECRET_KEY_RE = /passphrase|password|secret|psk|wpa.*key|_key$|priv/i;
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = SECRET_KEY_RE.test(k) ? '***' : v;
  return out;
}
function redactArray(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((o) => (o && typeof o === 'object' ? redact(o as Record<string, unknown>) : o));
}

/** Resolve a controller config from any UniFi AP doc (env fallback) for a controller-wide dump. */
async function resolveAnyController(): Promise<UnifiConfig> {
  const snap = await db.collection(AP_COLLECTION).where('vendor', '==', 'unifi').limit(10).get();
  let stored: StoredUnifiConfig | undefined;
  snap.forEach((d) => {
    const u = (d.data() as any).unifiConfig;
    if (!stored && u && u.password) stored = u;
  });
  return resolveConfig(stored);
}

/** Resilient per-resource probe so a 400 on one resource doesn't hide the others. */
export async function runDiagnostics(): Promise<Record<string, unknown>> {
  const config = await resolveAnyController();
  const PATHS = ['stat/sysinfo', 'stat/device', 'rest/wlanconf', 'rest/apgroup', 'rest/wlangroup'];
  const sources: Record<string, unknown> = {};

  for (const p of PATHS) {
    try {
      const { status, body } = await rawSiteGet(config, p);
      const data = body?.data;
      const trimmed =
        p === 'stat/device' && Array.isArray(data)
          ? data.map((d: any) => ({ mac: d.mac, state: d.state, name: d.name, model: d.model, version: d.version }))
          : redactArray(data);
      sources[p] = {
        status,
        ok: status >= 200 && status < 300,
        meta: body?.meta ?? null,
        count: Array.isArray(data) ? data.length : undefined,
        data: trimmed,
      };
    } catch (e: any) {
      sources[p] = { error: e?.message || 'request failed' };
    }
  }

  // v2 AP groups — the real AP-group API on Network 7.x+ (v1 rest/apgroup is gone).
  try {
    const res = await siteRequestV2(config, 'GET', 'apgroups');
    const data = Array.isArray(res.body) ? res.body : res.body?.data;
    sources['v2/apgroups'] = {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      count: Array.isArray(data) ? data.length : undefined,
      data: redactArray(data),
    };
  } catch (e: any) {
    sources['v2/apgroups'] = { error: e?.message || 'request failed' };
  }

  return { controller: { url: config.controllerUrl, site: config.site, type: config.controllerType }, sources };
}
