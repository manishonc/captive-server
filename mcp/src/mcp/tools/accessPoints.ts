import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { serializeAP } from '../status/serializeAP';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom } from '../shared';

/** Lean projection of a serialized access point for list views. */
function leanAccessPoint(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name ?? null,
    mac: s.mac ?? null,
    venueId: s.venueId ?? null,
    venueName: s.venueName ?? null,
    vendor: s.vendor ?? null,
    status: s.status,
    lastSeen: s.lastSeen,
    lastOfflineAt: s.lastOfflineAt,
  };
}

/** Register access-point read tools: `list_access_points`, `get_access_point`. */
export function registerAccessPointTools(server: McpServer): void {
  addTool<{ venueId: string }>(
    server,
    'list_access_points',
    'List the WiFi access points for a specific venue owned by the authenticated tenant. Requires a venueId — first call list_venues (or ask the user which venue) to choose one. Returns the count and each AP with id, name, MAC, vendor, live online/offline/unknown status, and last-seen/last-offline timestamps.',
    { venueId: z.string().describe('The venue whose access points to list (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      const snap = await db
        .collection('CaptivePortal_AccessPoints')
        .where('venueId', '==', args.venueId)
        .get();

      const accessPoints = snap.docs.map((doc) =>
        leanAccessPoint(serializeAP(doc.id, doc.data() as Record<string, unknown>)),
      );

      return jsonResult({
        venueId: args.venueId,
        venueName: (venue.venue_name as string) ?? null,
        count: accessPoints.length,
        accessPoints,
      });
    },
  );

  addTool<{ accessPointId: string }>(
    server,
    'get_access_point',
    'Get a single WiFi access point owned by the authenticated tenant, including live status, session timeout, alert settings, and whether a UniFi controller is configured (credentials are never exposed). Discover ids via list_access_points.',
    { accessPointId: z.string().describe('The access point id (from list_access_points).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection('CaptivePortal_AccessPoints').doc(args.accessPointId).get();
      if (!snap.exists) return errorResult('Access point not found.');

      const raw = snap.data() as Record<string, unknown>;
      if (raw.tenantUserId !== tenantUserId) {
        return errorResult('Access point not found or not owned by this account.');
      }

      const s = serializeAP(snap.id, raw);
      return jsonResult({
        accessPoint: {
          id: s.id,
          name: s.name ?? null,
          mac: s.mac ?? null,
          venueId: s.venueId ?? null,
          venueName: s.venueName ?? null,
          vendor: s.vendor ?? null,
          status: s.status,
          sessionTimeout: s.sessionTimeout ?? null,
          alertsEnabled: s.alertsEnabled ?? null,
          offlineThresholdMinutes: s.offlineThresholdMinutes ?? null,
          lastSeen: s.lastSeen,
          lastOfflineAt: s.lastOfflineAt,
          lastAlertSentAt: s.lastAlertSentAt ?? null,
          unifiConfigured: Boolean(raw.unifiConfig),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        },
      });
    },
  );
}
