/**
 * UniFi pending-device visibility + auto-adoption (Firestore + controller).
 *
 * New APs on the shared controller sit in "pending" until adopted — the tenant's
 * Adoption Helper app sends the set-inform, but nothing accepted the device until
 * now. This module lists pending devices annotated against the registered
 * `CaptivePortal_AccessPoints` docs, and auto-adopts the ones a tenant has already
 * registered (fired on AP create via /internal/unifi/adopt-if-pending and from the
 * 5-minute apMonitor cron).
 *
 * SECURITY INVARIANT: automatic adoption only ever targets MACs that match a
 * registered vendor:'unifi' AP doc. An unknown device broadcasting on the
 * controller's network must never be pulled in just because it is pending —
 * unregistered devices are surfaced in the admin panel for an explicit manual adopt.
 */

import { db } from '../firebase';
import { UnifiConfig } from '../types/captive';
import { canonMac, normalizeMac, getPendingDevices, adoptDevice, UnifiPendingDevice } from './unifi';
import { resolveAnyController } from './unifiWlan';

const AP_COLLECTION = 'CaptivePortal_AccessPoints';
const VENUE_COLLECTION = 'CaptivePortal_Venues';

export { canonMac };

export interface RegisteredUnifiAp {
  apId: string;
  apName: string;
  mac: string;
  venueId: string;
}

/** Registered UniFi APs keyed by canonical MAC — the auto-adopt allowlist. */
export async function loadRegisteredUnifiAps(): Promise<Map<string, RegisteredUnifiAp>> {
  const snap = await db.collection(AP_COLLECTION).where('vendor', '==', 'unifi').get();
  const byMac = new Map<string, RegisteredUnifiAp>();
  snap.forEach((doc) => {
    const d = doc.data() as { name?: string; mac?: string; venueId?: string };
    const key = canonMac(String(d.mac || ''));
    if (!key) return;
    byMac.set(key, {
      apId: doc.id,
      apName: String(d.name || ''),
      mac: normalizeMac(String(d.mac || '')),
      venueId: String(d.venueId || ''),
    });
  });
  return byMac;
}

export interface AnnotatedPendingDevice extends UnifiPendingDevice {
  registered: boolean;
  apId?: string;
  apName?: string;
  venueId?: string;
  venueName?: string;
}

export interface PendingDeviceReport {
  checkedAt: string;
  controller: { url: string; site: string };
  devices: AnnotatedPendingDevice[];
}

/** Pending devices annotated with the registered AP they match. Throws on controller failure. */
export async function listPendingDevices(): Promise<PendingDeviceReport> {
  const config = await resolveAnyController();
  const pending = await getPendingDevices(config);
  const registered = await loadRegisteredUnifiAps();

  const devices: AnnotatedPendingDevice[] = pending.map((d) => {
    const ap = registered.get(canonMac(d.mac));
    return ap
      ? { ...d, registered: true, apId: ap.apId, apName: ap.apName, venueId: ap.venueId }
      : { ...d, registered: false };
  });

  const venueIds = [...new Set(devices.map((d) => d.venueId).filter(Boolean))] as string[];
  const venueNames = new Map<string, string>();
  await Promise.all(
    venueIds.map(async (venueId) => {
      try {
        const snap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
        venueNames.set(venueId, String(snap.data()?.venue_name || ''));
      } catch {
        venueNames.set(venueId, '');
      }
    }),
  );
  for (const d of devices) {
    if (d.venueId) d.venueName = venueNames.get(d.venueId) || '';
  }

  return {
    checkedAt: new Date().toISOString(),
    controller: { url: config.controllerUrl, site: config.site },
    devices,
  };
}

export interface AdoptionSweepResult {
  skipped?: 'no_unifi_aps' | 'controller_unreachable';
  pendingCount: number;
  matchedCount: number;
  adopted: { mac: string; apId: string; apName: string; venueId: string }[];
  failed: { mac: string; error: string }[];
}

/**
 * Adopt every pending device whose canonical MAC matches a registered UniFi AP
 * (optionally narrowed to `onlyMacs`). Never throws — the cron and the on-create
 * hook call this fire-and-forget, and a controller outage must not break them.
 */
export async function adoptRegisteredPendingDevices(opts?: { onlyMacs?: string[] }): Promise<AdoptionSweepResult> {
  const result: AdoptionSweepResult = { pendingCount: 0, matchedCount: 0, adopted: [], failed: [] };

  let registered: Map<string, RegisteredUnifiAp>;
  let config: UnifiConfig;
  let pending: UnifiPendingDevice[];
  try {
    registered = await loadRegisteredUnifiAps();
    if (registered.size === 0) {
      // No registered UniFi APs — nothing could ever match, so don't dial the controller.
      result.skipped = 'no_unifi_aps';
      return result;
    }
    config = await resolveAnyController();
    pending = await getPendingDevices(config);
  } catch (err) {
    console.error('[AP ADOPT] Controller unreachable:', err instanceof Error ? err.message : err);
    result.skipped = 'controller_unreachable';
    return result;
  }

  const only = opts?.onlyMacs?.map(canonMac).filter(Boolean);
  const candidates = pending.filter((d) => {
    const key = canonMac(d.mac);
    if (!registered.has(key)) return false; // SECURITY INVARIANT: registered MACs only
    return !only || only.includes(key);
  });
  result.pendingCount = pending.length;
  result.matchedCount = candidates.length;

  for (const device of candidates) {
    const ap = registered.get(canonMac(device.mac))!;
    try {
      await adoptDevice(config, device.mac);
      result.adopted.push({ mac: device.mac, apId: ap.apId, apName: ap.apName, venueId: ap.venueId });
      console.log('[AP ADOPT] Adopted', device.mac, 'as', ap.apName || ap.apId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ mac: device.mac, error: message });
      console.error('[AP ADOPT] Adopt failed for', device.mac, '-', message);
    }
  }

  return result;
}
