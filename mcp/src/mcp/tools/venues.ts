import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom, tsToIso } from '../shared';

/**
 * Serialize a venue for MCP clients. Whitelists safe fields — the raw venue document
 * carries a `unifiConfig` with controller credentials, which is never exposed.
 */
function serializeVenue(id: string, d: Record<string, unknown>) {
  const wifiNetworks = Array.isArray(d.wifiNetworks)
    ? (d.wifiNetworks as Record<string, unknown>[]).map((n) => ({ ssid: (n.ssid as string) ?? null }))
    : [];
  return {
    id,
    venueName: (d.venue_name as string) ?? null,
    venueType: (d.venue_type as string) ?? null,
    address: (d.address as string) ?? null,
    timezone: (d.timezone as string) ?? null,
    locale: (d.locale as string) ?? null,
    externalSource: (d.externalSource as string) ?? null,
    wifiNetworks,
    createdAt: tsToIso(d.createdAt),
    updatedAt: tsToIso(d.updatedAt),
  };
}

/** Register venue read tools: `list_venues`, `get_venue`. */
export function registerVenueTools(server: McpServer): void {
  server.tool(
    'list_venues',
    'List the venues (properties) owned by the authenticated tenant account — e.g. Airbnb listings, restaurants, cafes. Returns the count and each venue with id, name, type, address, locale, configured WiFi SSIDs, and timestamps. Use a venue id from here to scope other tools (access points, guests, campaigns, configs).',
    async (extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db
        .collection('CaptivePortal_Venues')
        .where('tenantUserId', '==', tenantUserId)
        .get();

      const venues = snap.docs.map((doc) => serializeVenue(doc.id, doc.data() as Record<string, unknown>));
      return jsonResult({ count: venues.length, venues });
    },
  );

  addTool<{ venueId: string }>(
    server,
    'get_venue',
    'Get a single venue owned by the authenticated tenant, including its configured WiFi SSIDs. Call list_venues first to discover venue ids.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const data = await getOwnedVenue(tenantUserId, args.venueId);
      if (!data) return errorResult('Venue not found or not owned by this account.');

      return jsonResult({ venue: serializeVenue(args.venueId, data) });
    },
  );
}
