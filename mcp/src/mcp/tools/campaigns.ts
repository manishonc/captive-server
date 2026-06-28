import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom, tsToIso } from '../shared';

/** Default per-campaign engagement counters (denormalized by captive-server). */
function statsOf(d: Record<string, unknown>) {
  const s = (d.stats as Record<string, unknown>) ?? {};
  return {
    sent: (s.sent as number) ?? 0,
    delivered: (s.delivered as number) ?? 0,
    opened: (s.opened as number) ?? 0,
    clicked: (s.clicked as number) ?? 0,
    bounced: (s.bounced as number) ?? 0,
    converted: (s.converted as number) ?? 0,
  };
}

/** Compact campaign projection for list views (omits full message bodies). */
function leanCampaign(id: string, d: Record<string, unknown>) {
  const messages = Array.isArray(d.messages) ? (d.messages as Record<string, unknown>[]) : [];
  return {
    id,
    name: (d.name as string) ?? null,
    type: (d.type as string) ?? null,
    status: (d.status as string) ?? null,
    channels: (d.channels as string[]) ?? [],
    messageCount: messages.length,
    segment: (d.segment as Record<string, unknown>) ?? null,
    stats: statsOf(d),
    audienceCount: (d.audienceCount as number) ?? null,
    createdAt: tsToIso(d.createdAt),
    updatedAt: tsToIso(d.updatedAt),
  };
}

/** Register campaign read tools: `list_campaigns`, `get_campaign`. */
export function registerCampaignTools(server: McpServer): void {
  addTool<{ type?: 'broadcast' | 'automation'; status?: string }>(
    server,
    'list_campaigns',
    'List marketing campaigns owned by the authenticated tenant (broadcasts and automations). Returns each campaign with status, channels, audience segment, and engagement stats. Optional filters: type (broadcast|automation), status.',
    {
      type: z.enum(['broadcast', 'automation']).optional().describe('Filter by campaign type.'),
      status: z.string().optional().describe('Filter by status (draft, scheduled, sending, sent, active, paused, archived).'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db
        .collection('CaptivePortal_Campaigns')
        .where('tenantUserId', '==', tenantUserId)
        .get();

      let campaigns = snap.docs.map((doc) => ({ id: doc.id, d: doc.data() as Record<string, unknown> }));
      if (args.type) campaigns = campaigns.filter((c) => c.d.type === args.type);
      if (args.status) campaigns = campaigns.filter((c) => c.d.status === args.status);

      return jsonResult({
        count: campaigns.length,
        campaigns: campaigns.map((c) => leanCampaign(c.id, c.d)),
      });
    },
  );

  addTool<{ campaignId: string }>(
    server,
    'get_campaign',
    'Get a single marketing campaign owned by the authenticated tenant, including its full message sequence, trigger/schedule, audience segment, and engagement stats. Discover ids via list_campaigns.',
    { campaignId: z.string().describe('The campaign id (from list_campaigns).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection('CaptivePortal_Campaigns').doc(args.campaignId).get();
      if (!snap.exists) return errorResult('Campaign not found.');
      const d = snap.data() as Record<string, unknown>;
      if (d.tenantUserId !== tenantUserId) {
        return errorResult('Campaign not found or not owned by this account.');
      }

      return jsonResult({
        campaign: {
          ...leanCampaign(snap.id, d),
          description: (d.description as string) ?? null,
          messages: Array.isArray(d.messages) ? d.messages : [],
          trigger: (d.trigger as Record<string, unknown>) ?? null,
          schedule: (d.schedule as Record<string, unknown>) ?? null,
          audienceSnapshotAt: tsToIso(d.audienceSnapshotAt),
        },
      });
    },
  );
}
