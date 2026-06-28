import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom, tsToIso } from '../shared';

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
    'Get the captive-portal splash page configuration (branding and layout) for a venue: template, title, subtitle, logo, and colors. Returns exists=false if the venue uses defaults.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      const snap = await db.collection('CaptivePortal_SplashScreenConfig').doc(`venue_${args.venueId}`).get();
      if (!snap.exists) {
        return jsonResult({ exists: false, venueId: args.venueId, config: null });
      }
      const d = snap.data() as Record<string, unknown>;
      return jsonResult({
        exists: true,
        venueId: args.venueId,
        config: {
          templateId: (d.templateId as string) ?? null,
          title: (d.title as string) ?? null,
          subtitle: (d.subtitle as string) ?? null,
          logoUrl: (d.logoUrl as string) ?? null,
          showLogo: d.showLogo ?? null,
          primaryColor: (d.primaryColor as string) ?? null,
          backgroundColor: (d.backgroundColor as string) ?? null,
        },
        createdAt: tsToIso(d.createdAt),
        updatedAt: tsToIso(d.updatedAt),
      });
    },
  );
}
