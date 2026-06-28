import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../firebase';
import { serializeAP } from '../status/serializeAP';

interface LeanAccessPoint {
  id: string;
  name: unknown;
  mac: unknown;
  venueId: unknown;
  venueName: unknown;
  vendor: unknown;
  status: unknown;
  lastSeen: unknown;
}

/**
 * Register the `list_access_points` tool — the first MCP capability.
 *
 * Reads CaptivePortal_AccessPoints directly from Firestore, scoped to the
 * tenantUserId resolved from the OAuth access token (extra.authInfo.extra.tenantUserId).
 * Mirrors the dashboard's own query (cms/app/api/captive-portal/access-points/route.js).
 */
export function registerListAccessPoints(server: McpServer): void {
  server.tool(
    'list_access_points',
    'List the WiFi access points for the authenticated tenant account. Returns how many there are (count) and the list — each with id, name, MAC address, venue, vendor, live online/offline/unknown status, and the last-seen timestamp.',
    async (extra) => {
      const authExtra = extra?.authInfo?.extra as Record<string, unknown> | undefined;
      const tenantUserId = authExtra?.tenantUserId as string | undefined;

      if (!tenantUserId) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'No tenant account is bound to this MCP session.' }],
        };
      }

      const snapshot = await db
        .collection('CaptivePortal_AccessPoints')
        .where('tenantUserId', '==', tenantUserId)
        .get();

      const accessPoints: LeanAccessPoint[] = snapshot.docs.map((doc) => {
        const s = serializeAP(doc.id, doc.data() as Record<string, unknown>);
        return {
          id: s.id,
          name: s.name,
          mac: s.mac,
          venueId: s.venueId,
          venueName: s.venueName,
          vendor: s.vendor,
          status: s.status,
          lastSeen: s.lastSeen,
        };
      });

      const content = [
        {
          type: 'text' as const,
          text: JSON.stringify({ count: accessPoints.length, accessPoints }, null, 2),
        },
      ];

      return { isError: false, content };
    },
  );
}
