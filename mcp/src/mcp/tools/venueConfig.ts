import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom, tsToIso } from '../shared';
import { callCmsInternal, cmsErrorMessage } from '../../cmsClient';

/**
 * Register per-venue config read tools: `get_venue_marketing_config`, `get_splash_config`.
 * Both verify venue ownership before reading the `venue_<id>` config document.
 */
export function registerVenueConfigTools(server: McpServer): void {
  addTool<{ venueId: string }>(
    server,
    'get_venue_marketing_config',
    'Get the marketing automation rules configured for a venue: the per-event (onConnect / onReconnect) SMS, email, and WhatsApp message sequences that fire when a guest connects. Returns exists=false if none configured yet.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      const snap = await db.collection('CaptivePortal_EntityMarketing').doc(`venue_${args.venueId}`).get();
      if (!snap.exists) {
        return jsonResult({ exists: false, venueId: args.venueId, events: null });
      }
      const d = snap.data() as Record<string, unknown>;
      return jsonResult({
        exists: true,
        venueId: args.venueId,
        events: d.events ?? null,
        createdAt: tsToIso(d.createdAt),
        updatedAt: tsToIso(d.updatedAt),
      });
    },
  );

  addTool<{ venueId: string }>(
    server,
    'get_splash_config',
    'Get the COMPLETE captive-portal splash configuration for a venue: template, title, subtitle, logo and colours, plus the login page (which guest fields are shown and required, custom questions), the consent page, the guest-verification settings, and the connected page. `exists: false` means the venue is still on platform defaults, and `config` shows what those defaults are. To CHANGE any of this, use start_splash_setup — it returns this same config plus the branding, templates and question script needed to do it properly.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      // Read through the CMS rather than projecting the raw document here. It
      // applies the legacy collectName/collectEmail derivation and the
      // verification/login coupling, so what comes back is the EFFECTIVE config —
      // which is what a caller about to write it needs, and what the portal serves.
      const result = await callCmsInternal('/api/captive-portal/internal/splash-config', {
        tenantUserId,
        venueId: args.venueId,
        action: 'read',
      });

      if (result.status < 200 || result.status >= 300) {
        return errorResult(cmsErrorMessage(result));
      }

      return jsonResult({
        exists: result.data.exists,
        venueId: args.venueId,
        config: result.data.config,
        notes: result.data.notes ?? [],
        livePreviewUrls: result.data.livePreviewUrls ?? null,
        createdAt: result.data.createdAt ?? null,
        updatedAt: result.data.updatedAt ?? null,
      });
    },
  );
}
