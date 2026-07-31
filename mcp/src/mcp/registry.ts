import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVenueTools } from './tools/venues';
import { registerAccessPointTools } from './tools/accessPoints';
import { registerGuestTools } from './tools/guests';
import { registerCampaignTools } from './tools/campaigns';
import { registerAnalyticsTools } from './tools/analytics';
import { registerVenueConfigTools } from './tools/venueConfig';
import { registerCampaignWriteTools } from './tools/campaignWrites';
import { registerSplashConfigTools } from './tools/splashConfig';
import { registerTemplateTools } from './tools/templates';
import { registerBrandingTools } from './tools/branding';
import { registerAudienceTools } from './tools/audience';
import { registerUsageTools } from './tools/usage';

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
 *
 * Tier 2 write/utility tools (the campaign capability layer for the CMS AI
 * and external MCP clients):
 *   campaigns:     create_campaign, update_campaign, send_campaign,
 *                  pause/resume/cancel_campaign, activate/deactivate_campaign,
 *                  archive/restore_campaign, test_send_campaign
 *   templates:     list_templates, get_template, create_template
 *   audience:      preview_audience (per-channel opted-in counts)
 *   branding:      get_branding
 *   plan/usage:    get_usage
 *   splash:        start_splash_setup, list_splash_templates, list_venue_logos,
 *                  preview_splash_config, apply_splash_config, copy_splash_config
 *                  (writes proxy to the CMS internal API, which owns the validator;
 *                   apply is gated on a confirmToken from the preview)
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
  registerCampaignWriteTools(server);
  registerSplashConfigTools(server);
  registerTemplateTools(server);
  registerBrandingTools(server);
  registerAudienceTools(server);
  registerUsageTools(server);

  return server;
}
