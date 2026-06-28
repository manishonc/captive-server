import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVenueTools } from './tools/venues';
import { registerAccessPointTools } from './tools/accessPoints';
import { registerGuestTools } from './tools/guests';
import { registerCampaignTools } from './tools/campaigns';
import { registerAnalyticsTools } from './tools/analytics';
import { registerVenueConfigTools } from './tools/venueConfig';

/**
 * Build a fresh McpServer with all tools registered.
 *
 * The stateless streamable-HTTP transport creates a new server + transport per
 * request, so tool registration must be cheap and idempotent — it is.
 *
 * Tier 1 read tools (all tenant-scoped via the OAuth token's tenantUserId):
 *   venues:        list_venues, get_venue
 *   access points: list_access_points (venue-scoped), get_access_point
 *   guests:        list_guests, get_guest, search_guests
 *   campaigns:     list_campaigns, get_campaign
 *   analytics:     get_capture_stats, get_campaign_stats
 *   config:        get_venue_marketing_config, get_splash_config
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'heidifi-captive-portal',
    version: '1.0.0',
    title: 'HeidiFi Captive Portal',
  });

  registerVenueTools(server);
  registerAccessPointTools(server);
  registerGuestTools(server);
  registerCampaignTools(server);
  registerAnalyticsTools(server);
  registerVenueConfigTools(server);

  return server;
}
