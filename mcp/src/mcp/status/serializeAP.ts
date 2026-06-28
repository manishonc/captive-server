/**
 * Live status + serialization for CaptivePortal_AccessPoints documents.
 *
 * Ported verbatim from the CMS (cms/lib/captive-portal-status.js) so the MCP server
 * returns the exact same shape as the dashboard API, including the computed
 * online/offline/unknown status and ISO-string timestamps. The UniFi password is
 * stripped — it is never exposed to MCP clients.
 */

/** Minimal subset of a Firestore AccessPoint document we read for status math. */
interface AccessPointRaw {
  lastSeen?: { toMillis(): number; toDate?(): Date } | null;
  offlineThresholdMinutes?: number | null;
  status?: string | null;
  createdAt?: { toDate?(): Date } | null;
  updatedAt?: { toDate?(): Date } | null;
  lastOfflineAt?: { toDate?(): Date } | null;
  unifiConfig?: { password?: string; [k: string]: unknown } | null;
  [k: string]: unknown;
}

export interface SerializedAccessPoint {
  id: string;
  status: 'online' | 'offline' | 'unknown';
  createdAt: string | null;
  updatedAt: string | null;
  lastSeen: string | null;
  lastOfflineAt: string | null;
  [k: string]: unknown;
}

type LiveStatus = 'online' | 'offline' | 'unknown';

/**
 * - 'unknown' when the AP has never reported in (no `lastSeen`)
 * - 'offline' when `lastSeen` is older than `offlineThresholdMinutes` (default 60)
 * - 'online' otherwise
 */
export function computeLiveStatus(data: AccessPointRaw): LiveStatus {
  if (!data.lastSeen) return (data.status as LiveStatus) ?? 'unknown';
  const age = Date.now() - data.lastSeen.toMillis();
  const thresholdMs = (data.offlineThresholdMinutes ?? 60) * 60_000;
  return age > thresholdMs ? 'offline' : 'online';
}

/** Serialize an access-point Firestore document for MCP/API responses. */
export function serializeAP(id: string, data: AccessPointRaw): SerializedAccessPoint {
  const result: SerializedAccessPoint = {
    id,
    ...data,
    status: computeLiveStatus(data),
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
    lastSeen: data.lastSeen?.toDate?.()?.toISOString() || null,
    lastOfflineAt: data.lastOfflineAt?.toDate?.()?.toISOString() || null,
  };
  if (result.unifiConfig) {
    const { password: _stripped, ...safeConfig } = result.unifiConfig as Record<string, unknown>;
    result.unifiConfig = safeConfig;
  }
  return result;
}
