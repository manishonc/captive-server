import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import {
  GuestDoc,
  NO_TENANT,
  addTool,
  errorResult,
  getGuestsForApIds,
  getOwnedVenue,
  getTenantAccessPoints,
  jsonResult,
  tenantFrom,
  tsToIso,
} from '../shared';

/** Round to one decimal place; returns 0 for an empty denominator. */
function rate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** ISO timestamp of a guest for date-range filtering. */
function guestTime(d: Record<string, unknown>): string | null {
  return typeof d.timestamp === 'string' ? d.timestamp : tsToIso(d.timestamp);
}

/** Register analytics tools: `get_capture_stats`, `get_campaign_stats`. */
export function registerAnalyticsTools(server: McpServer): void {
  addTool<{ venueId?: string; signedUpAfter?: string; signedUpBefore?: string }>(
    server,
    'get_capture_stats',
    'Get guest-capture analytics for the authenticated tenant: total captured guests, marketing opt-in count and rate, and a breakdown by access point and by venue. Optionally scope to one venue and/or a signup date range.',
    {
      venueId: z.string().optional().describe('Limit stats to a single venue (from list_venues).'),
      signedUpAfter: z.string().optional().describe('ISO timestamp — only count guests who signed up on/after this.'),
      signedUpBefore: z.string().optional().describe('ISO timestamp — only count guests who signed up on/before this.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const aps = await getTenantAccessPoints(tenantUserId);
      const apMap = new Map(aps.map((ap) => [ap.id, ap]));

      let targetAps = aps;
      if (args.venueId) {
        const venue = await getOwnedVenue(tenantUserId, args.venueId);
        if (!venue) return errorResult('Venue not found or not owned by this account.');
        targetAps = aps.filter((ap) => ap.venueId === args.venueId);
      }

      let guests: GuestDoc[] = await getGuestsForApIds(targetAps.map((ap) => ap.id));
      guests = guests.filter((g) => g.data.status !== 'archived');
      if (args.signedUpAfter) guests = guests.filter((g) => (guestTime(g.data) ?? '') >= args.signedUpAfter!);
      if (args.signedUpBefore) guests = guests.filter((g) => (guestTime(g.data) ?? '') <= args.signedUpBefore!);

      const total = guests.length;
      const optIn = guests.filter((g) => Boolean(g.data.marketingOptIn)).length;

      const byApCount = new Map<string, number>();
      const byVenueCount = new Map<string, number>();
      for (const g of guests) {
        const apId = (g.data.captivePortalAccessPointId as string) ?? '';
        byApCount.set(apId, (byApCount.get(apId) ?? 0) + 1);
        const venueId = apMap.get(apId)?.venueId ?? 'unknown';
        byVenueCount.set(venueId, (byVenueCount.get(venueId) ?? 0) + 1);
      }

      const byAccessPoint = [...byApCount.entries()].map(([id, count]) => ({
        id,
        name: apMap.get(id)?.name ?? null,
        count,
      }));
      const byVenue = [...byVenueCount.entries()].map(([id, count]) => ({
        venueId: id,
        venueName: id === 'unknown' ? null : aps.find((ap) => ap.venueId === id)?.venueName ?? null,
        count,
      }));

      return jsonResult({
        totalGuests: total,
        marketingOptIn: optIn,
        optInRate: rate(optIn, total),
        range: { signedUpAfter: args.signedUpAfter ?? null, signedUpBefore: args.signedUpBefore ?? null },
        byAccessPoint: byAccessPoint.sort((a, b) => b.count - a.count),
        byVenue: byVenue.sort((a, b) => b.count - a.count),
      });
    },
  );

  addTool<{ campaignId: string }>(
    server,
    'get_campaign_stats',
    'Get delivery and engagement metrics for one campaign owned by the authenticated tenant: a funnel (sent, delivered, opened, clicked, bounced, failed) with rates, plus a per-channel breakdown. Aggregated from per-recipient send records and tracked links.',
    { campaignId: z.string().describe('The campaign id (from list_campaigns).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const campSnap = await db.collection('CaptivePortal_Campaigns').doc(args.campaignId).get();
      if (!campSnap.exists) return errorResult('Campaign not found.');
      const camp = campSnap.data() as Record<string, unknown>;
      if (camp.tenantUserId !== tenantUserId) {
        return errorResult('Campaign not found or not owned by this account.');
      }

      const sendsSnap = await db
        .collection('CaptivePortal_CampaignSends')
        .where('campaignId', '==', args.campaignId)
        .get();
      const linksSnap = await db
        .collection('CaptivePortal_ShortLinks')
        .where('marketingDocId', '==', `campaign_${args.campaignId}`)
        .get();

      const DELIVERED = new Set(['delivered', 'opened', 'read', 'clicked']);
      const OPENED = new Set(['opened', 'read']);
      const FAILED = new Set(['failed', 'undelivered']);

      const funnel = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 };
      const byChannel = new Map<string, { sent: number; delivered: number; opened: number; bounced: number; failed: number }>();

      for (const doc of sendsSnap.docs) {
        const s = doc.data() as Record<string, unknown>;
        const status = (s.deliveryStatus as string) ?? '';
        const channel = (s.channel as string) ?? 'unknown';
        const ch = byChannel.get(channel) ?? { sent: 0, delivered: 0, opened: 0, bounced: 0, failed: 0 };

        funnel.sent += 1;
        ch.sent += 1;
        if (s.deliveredCounted || DELIVERED.has(status)) {
          funnel.delivered += 1;
          ch.delivered += 1;
        }
        if (s.openCounted || OPENED.has(status)) {
          funnel.opened += 1;
          ch.opened += 1;
        }
        if (s.bouncedCounted || status === 'bounced') {
          funnel.bounced += 1;
          ch.bounced += 1;
        }
        if (FAILED.has(status)) {
          funnel.failed += 1;
          ch.failed += 1;
        }
        byChannel.set(channel, ch);
      }

      let totalClicks = 0;
      const clickedGuests = new Set<string>();
      for (const doc of linksSnap.docs) {
        const l = doc.data() as Record<string, unknown>;
        totalClicks += (l.clicks as number) ?? 0;
        if (((l.clicks as number) ?? 0) > 0 && l.wifiGuestId) clickedGuests.add(l.wifiGuestId as string);
      }
      funnel.clicked = clickedGuests.size;

      return jsonResult({
        campaignId: args.campaignId,
        name: (camp.name as string) ?? null,
        status: (camp.status as string) ?? null,
        funnel: {
          ...funnel,
          totalClicks,
          deliveredRate: rate(funnel.delivered, funnel.sent),
          openRate: rate(funnel.opened, funnel.delivered),
          clickRate: rate(funnel.clicked, funnel.delivered),
          bounceRate: rate(funnel.bounced, funnel.sent),
        },
        byChannel: [...byChannel.entries()].map(([channel, c]) => ({ channel, ...c })),
        // The clicker identities are already computed above; returning them costs
        // nothing and saves a follow-up call. Capped so a large campaign doesn't
        // blow up the tool result — `funnel.clicked` remains the true count.
        clickedGuestIds: [...clickedGuests].slice(0, 200),
      });
    },
  );
}
