import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVenueTools } from './tools/venues';
import { registerAccessPointTools } from './tools/accessPoints';
import { registerActiveClientTools } from './tools/activeClients';
import { registerGuestTools } from './tools/guests';
import { registerCampaignTools } from './tools/campaigns';
import { registerAnalyticsTools } from './tools/analytics';
import { registerGuestEngagementTools } from './tools/guestEngagement';
import { registerVenueConfigTools } from './tools/venueConfig';
import { registerCampaignWriteTools } from './tools/campaignWrites';
import { registerSplashConfigTools } from './tools/splashConfig';
import { registerTemplateTools } from './tools/templates';
import { registerBrandingTools } from './tools/branding';
import { registerAudienceTools } from './tools/audience';
import { registerUsageTools } from './tools/usage';
import { registerPlaybookTools } from './tools/playbooks';

/**
 * Build a fresh McpServer with all tools registered.
 *
 * The stateless streamable-HTTP transport creates a new server + transport per
 * request, so tool registration must be cheap and idempotent — it is.
 *
 * Tier 1 read tools (all tenant-scoped via the OAuth token's tenantUserId):
 *   venues:        list_venues, get_venue
 *   access points: list_access_points (venue-scoped), get_access_point
 *   live clients:  list_active_clients (who is connected right now, guests grouped
 *                  with all of their devices), get_venue_live_count, get_live_counts —
 *                  read straight from the WiFi controller. All read-only: there is
 *                  deliberately no disconnect tool, see tools/activeClients.ts for why.
 *   guests:        list_guests (filterable by guest language), get_guest,
 *                  search_guests — all carry the splash language the guest
 *                  chose, or 'unknown' when none was recorded
 *   campaigns:     list_campaigns, get_campaign
 *   analytics:     get_capture_stats, get_campaign_stats
 *   engagement:    get_guest_engagement + list_guests_who_clicked/_opened/
 *                  _visited/_rated, list_guests_messaged — the individual guests
 *                  behind any venue-automation analytics number (proxies the CMS
 *                  internal drill-down, which owns the aggregation rules)
 *   config:        get_venue_marketing_config, get_splash_config
 *
 * Tier 2 write/utility tools (the campaign capability layer for the CMS AI
 * and external MCP clients):
 *   campaigns:     create_campaign, update_campaign, send_campaign,
 *                  pause/resume/cancel_campaign, activate/deactivate_campaign,
 *                  archive/restore_campaign, test_send_campaign
 *   templates:     list_templates, get_template, create_template
 *   audience:      preview_audience (per-channel opted-in counts + a per-language
 *                  breakdown, so the spread is visible before targeting one)
 *   branding:      get_branding
 *   plan/usage:    get_usage
 *   splash:        start_splash_setup, list_splash_templates, list_venue_logos,
 *                  preview_splash_config, apply_splash_config, copy_splash_config
 *                  (writes proxy to the CMS internal API, which owns the validator;
 *                   apply is gated on a confirmToken from the preview)
 *   adaptive:      list_playbooks, get_playbook, list_playbook_setups — read-only
 *                  Adaptive Campaigns playbooks and each venue's setup (proxies
 *                  captive-server /internal/adaptive/*, which owns the rules)
 *   languages:     no dedicated tool — a venue's guest languages and the
 *                  per-language splash copy live in the `languages` block of the
 *                  splash config, so they go through the same preview/apply pair.
 *                  Campaign copy is translated per message via `translations`;
 *                  `segment.language` targets one language when the content
 *                  genuinely differs rather than just being translated.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'heidifi-captive-portal',
    version: '1.0.0',
    title: 'HeidiFi Captive Portal',
  });

  registerVenueTools(server);
  registerAccessPointTools(server);
  registerActiveClientTools(server);
  registerGuestTools(server);
  registerCampaignTools(server);
  registerAnalyticsTools(server);
  registerGuestEngagementTools(server);
  registerVenueConfigTools(server);
  registerCampaignWriteTools(server);
  registerSplashConfigTools(server);
  registerTemplateTools(server);
  registerBrandingTools(server);
  registerAudienceTools(server);
  registerUsageTools(server);
  registerPlaybookTools(server);

  return server;
}
