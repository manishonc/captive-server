/**
 * Campaign WRITE tools (Tier 2): create/update drafts, lifecycle actions,
 * test sends. Together with the Tier-1 read tools these make the MCP server
 * the full campaign capability layer for the CMS AI and external clients.
 *
 * Validation mirrors the CMS (`_lib/campaigns.js` port in ../../validation);
 * status-transition guards mirror the CMS `campaigns/[id]/*` routes.
 * Send/pause/resume/cancel proxy the main server's `/internal/campaigns/*`
 * routes — dispatch logic is never duplicated here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom, tsToIso } from '../shared';
import { callServerInternal } from '../../serverClient';
import {
  COLLECTION,
  EDITABLE_STATUSES,
  validateCampaignInput,
} from '../../validation/campaigns';

type Raw = Record<string, unknown>;

function serialize(id: string, d: Raw) {
  return {
    id,
    name: d.name ?? '',
    description: d.description ?? '',
    type: d.type ?? 'broadcast',
    status: d.status ?? 'draft',
    channels: Array.isArray(d.channels) ? d.channels : [],
    segment: d.segment ?? { venueIds: [], optInRequired: true, engagement: 'any' },
    trigger: d.trigger ?? null,
    schedule: d.schedule ?? null,
    messages: Array.isArray(d.messages) ? d.messages : [],
    stats: d.stats ?? { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, converted: 0 },
    audienceCount: typeof d.audienceCount === 'number' ? d.audienceCount : null,
    createdAt: tsToIso(d.createdAt),
    updatedAt: tsToIso(d.updatedAt),
  };
}

/** Load a campaign and verify tenant ownership. */
async function loadOwned(tenantUserId: string, campaignId: string) {
  const ref = db.collection(COLLECTION).doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false as const, error: 'Campaign not found.' };
  const data = snap.data() as Raw;
  if (data.tenantUserId !== tenantUserId) {
    return { ok: false as const, error: 'Campaign not found or not owned by this account.' };
  }
  return { ok: true as const, ref, data };
}

const messageShape = z
  .object({
    id: z.string().optional(),
    channel: z.enum(['email', 'sms', 'whatsapp']),
    delayMinutes: z.number().min(0).max(43200).describe('Minutes after the previous step (0 = immediately).'),
    subject: z.string().optional().describe('Email subject.'),
    body: z.string().optional().describe('Email HTML body (only for bodyFormat html/text).'),
    bodyFormat: z
      .enum(['html', 'text', 'blocks'])
      .optional()
      .describe('Use "blocks" with designJson (EmailDesignV1) for new emails — the body is rendered server-side.'),
    designJson: z.unknown().optional().describe('EmailDesignV1 block design (required when bodyFormat is "blocks").'),
    content: z.string().optional().describe('SMS text / WhatsApp preview text.'),
    templateName: z.string().optional().describe('Approved Meta template name (WhatsApp).'),
    languageCode: z.string().optional().describe('WhatsApp template language, e.g. en_US.'),
    variables: z.array(z.unknown()).optional(),
  })
  .passthrough();

const segmentShape = z
  .object({
    venueIds: z.array(z.string()).optional().describe('Empty = all the tenant’s venues.'),
    signedUpAfter: z.string().optional(),
    signedUpBefore: z.string().optional(),
    engagement: z.enum(['any', 'opened', 'clicked']).optional(),
  })
  .passthrough();

export function registerCampaignWriteTools(server: McpServer): void {
  addTool<{
    name: string;
    type: 'broadcast' | 'automation';
    channels: string[];
    description?: string;
    segment?: Raw;
    messages?: Raw[];
    trigger?: Raw;
    schedule?: Raw;
  }>(
    server,
    'create_campaign',
    'Create a marketing campaign DRAFT for the authenticated tenant. Broadcasts send once to a segment; automations fire on Wi-Fi events. Email messages should use bodyFormat "blocks" with an EmailDesignV1 designJson. The campaign is NOT sent — call send_campaign/activate_campaign after the user confirms.',
    {
      name: z.string().min(1).max(150),
      type: z.enum(['broadcast', 'automation']),
      channels: z.array(z.enum(['email', 'sms', 'whatsapp'])).min(1),
      description: z.string().max(1000).optional(),
      segment: segmentShape.optional(),
      messages: z.array(messageShape).optional(),
      trigger: z
        .object({
          kind: z.enum(['wifiEvent', 'dateRelative']),
          wifiEvent: z.enum(['onConnect', 'onReconnect', 'onDisconnect']).optional(),
          dateRelative: z
            .object({ anchor: z.enum(['firstSignIn', 'lastSession']), offsetDays: z.number() })
            .optional(),
        })
        .optional()
        .describe('Required for automations.'),
      schedule: z
        .object({ mode: z.enum(['now', 'scheduled']), sendAt: z.string().optional() })
        .optional()
        .describe('Broadcasts: when to send once launched.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const result = validateCampaignInput(args, { isCreate: true });
      if ('error' in result) {
        return errorResult(`${result.error} (field: ${result.field ?? '-'}, code: ${result.code})`);
      }

      const now = new Date();
      const doc = {
        ...result.campaign,
        status: 'draft',
        tenantUserId,
        stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, converted: 0 },
        createdBy: `mcp:${tenantUserId}`,
        createdAt: now,
        updatedAt: now,
      };
      const ref = await db.collection(COLLECTION).add(doc);
      const created = await ref.get();
      return jsonResult({ campaign: serialize(ref.id, created.data() as Raw) });
    },
  );

  addTool<{ campaignId: string; patch: Raw }>(
    server,
    'update_campaign',
    'Update a DRAFT or PAUSED campaign owned by the tenant. Only include the fields you want to change (name, description, channels, segment, messages, trigger, schedule). Messages replace the whole list — read the campaign first and send the full updated array.',
    {
      campaignId: z.string(),
      patch: z
        .object({
          name: z.string().min(1).max(150).optional(),
          description: z.string().max(1000).optional(),
          channels: z.array(z.enum(['email', 'sms', 'whatsapp'])).optional(),
          segment: segmentShape.optional(),
          messages: z.array(messageShape).optional(),
          trigger: z.object({}).passthrough().optional(),
          schedule: z.object({}).passthrough().optional(),
        })
        .passthrough(),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);
      if (!EDITABLE_STATUSES.includes(loaded.data.status as string)) {
        return errorResult(
          `Campaign can only be edited while draft or paused (status is "${loaded.data.status}").`,
        );
      }

      // Validate the patch against the MERGED doc so channel/message coupling
      // and type-specific rules see the full picture (mirrors CMS PUT).
      const merged = { ...loaded.data, ...args.patch, type: loaded.data.type };
      const result = validateCampaignInput(merged, { isCreate: true });
      if ('error' in result) {
        return errorResult(`${result.error} (field: ${result.field ?? '-'}, code: ${result.code})`);
      }

      await loaded.ref.update({ ...result.campaign, updatedAt: new Date() });
      const updated = await loaded.ref.get();
      return jsonResult({ campaign: serialize(args.campaignId, updated.data() as Raw) });
    },
  );

  // ── Lifecycle: proxied to server/ internal routes (dispatch stays there) ──

  addTool<{ campaignId: string; scheduleAt?: string }>(
    server,
    'send_campaign',
    'Launch a BROADCAST campaign. DESTRUCTIVE: messages go to real guests — only call after the user explicitly confirmed a summary (audience count, messages, timing). Optional scheduleAt (ISO datetime) parks it as scheduled instead of sending now.',
    {
      campaignId: z.string(),
      scheduleAt: z.string().optional().describe('ISO datetime to schedule instead of sending immediately.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);

      if (args.scheduleAt) {
        const d = new Date(args.scheduleAt);
        if (Number.isNaN(d.getTime())) return errorResult('scheduleAt must be a valid ISO datetime.');
        if (loaded.data.type !== 'broadcast') return errorResult('Only broadcasts can be scheduled.');
        if (!EDITABLE_STATUSES.includes(loaded.data.status as string)) {
          return errorResult(`Cannot schedule from status "${loaded.data.status}".`);
        }
        await loaded.ref.update({
          schedule: { mode: 'scheduled', sendAt: d.toISOString() },
          updatedAt: new Date(),
        });
      }

      const { status, data } = await callServerInternal('/internal/campaigns/send', {
        campaignId: args.campaignId,
        tenantUserId,
      });
      if (status >= 400 || data.ok === false) {
        return errorResult(String(data.error ?? `send failed (${status})`));
      }
      return jsonResult({ ok: true, status: data.status ?? null, scheduledFor: data.scheduledFor ?? null });
    },
  );

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    addTool<{ campaignId: string }>(
      server,
      `${action}_campaign`,
      action === 'pause'
        ? 'Pause a scheduled broadcast or an active automation.'
        : action === 'resume'
          ? 'Resume a paused scheduled broadcast.'
          : 'Cancel a scheduled broadcast (returns it to draft).',
      { campaignId: z.string() },
      async (args, extra) => {
        const tenantUserId = tenantFrom(extra);
        if (!tenantUserId) return errorResult(NO_TENANT);

        const loaded = await loadOwned(tenantUserId, args.campaignId);
        if (!loaded.ok) return errorResult(loaded.error);

        // Active automations pause via a direct status flip (mirrors the CMS,
        // where /internal/campaigns/pause covers scheduled broadcasts).
        if (action === 'pause' && loaded.data.type === 'automation') {
          if (loaded.data.status !== 'active') {
            return errorResult(`Cannot pause automation from "${loaded.data.status}".`);
          }
          await loaded.ref.update({ status: 'paused', updatedAt: new Date() });
          const updated = await loaded.ref.get();
          return jsonResult({ ok: true, campaign: serialize(args.campaignId, updated.data() as Raw) });
        }

        const { status, data } = await callServerInternal(`/internal/campaigns/${action}`, {
          campaignId: args.campaignId,
          tenantUserId,
        });
        if (status >= 400 || data.ok === false) {
          return errorResult(String(data.error ?? `${action} failed (${status})`));
        }
        return jsonResult({ ok: true, status: data.status ?? null });
      },
    );
  }

  // ── Status flips handled directly (mirrors CMS route guards) ──

  addTool<{ campaignId: string }>(
    server,
    'activate_campaign',
    'Turn an AUTOMATION campaign on so it fires for matching Wi-Fi events. DESTRUCTIVE: real guests get messaged — only after explicit user confirmation. Requires a Wi-Fi event trigger and at least one message on an enabled channel.',
    { campaignId: z.string() },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);
      const c = loaded.data;

      if (c.type !== 'automation') {
        return errorResult('Only automation campaigns can be activated. Broadcasts use send_campaign.');
      }
      if (!['draft', 'paused'].includes(c.status as string)) {
        return errorResult(`Cannot activate from "${c.status}".`);
      }
      const trigger = (c.trigger ?? {}) as Raw;
      if (trigger.kind !== 'wifiEvent' || !trigger.wifiEvent) {
        return errorResult('Set a Wi-Fi event trigger before activating.');
      }
      const channels = Array.isArray(c.channels) ? (c.channels as string[]) : [];
      const messages = Array.isArray(c.messages) ? (c.messages as Raw[]) : [];
      if (!messages.some((m) => channels.includes(m.channel as string))) {
        return errorResult('Add a message on an enabled channel before activating.');
      }

      await loaded.ref.update({ status: 'active', updatedAt: new Date() });
      const updated = await loaded.ref.get();
      return jsonResult({ ok: true, campaign: serialize(args.campaignId, updated.data() as Raw) });
    },
  );

  addTool<{ campaignId: string }>(
    server,
    'deactivate_campaign',
    'Turn an active automation off (status becomes paused).',
    { campaignId: z.string() },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);
      if (loaded.data.status !== 'active') {
        return errorResult(`Cannot deactivate from "${loaded.data.status}".`);
      }
      await loaded.ref.update({ status: 'paused', updatedAt: new Date() });
      const updated = await loaded.ref.get();
      return jsonResult({ ok: true, campaign: serialize(args.campaignId, updated.data() as Raw) });
    },
  );

  addTool<{ campaignId: string }>(
    server,
    'archive_campaign',
    'Archive a campaign (stops active automations). Blocked while a broadcast is mid-send.',
    { campaignId: z.string() },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);
      if (loaded.data.status === 'archived') return errorResult('Campaign is already archived.');
      if (loaded.data.status === 'sending') {
        return errorResult("This broadcast is still sending and can't be archived yet.");
      }
      await loaded.ref.update({
        status: 'archived',
        previousStatus: loaded.data.status,
        updatedAt: new Date(),
      });
      const updated = await loaded.ref.get();
      return jsonResult({ ok: true, campaign: serialize(args.campaignId, updated.data() as Raw) });
    },
  );

  addTool<{ campaignId: string }>(
    server,
    'restore_campaign',
    'Restore an archived campaign back to draft.',
    { campaignId: z.string() },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);
      if (loaded.data.status !== 'archived') {
        return errorResult(`Only archived campaigns can be restored (status is "${loaded.data.status}").`);
      }
      await loaded.ref.update({ status: 'draft', previousStatus: null, updatedAt: new Date() });
      const updated = await loaded.ref.get();
      return jsonResult({ ok: true, campaign: serialize(args.campaignId, updated.data() as Raw) });
    },
  );

  addTool<{ campaignId: string; channel: 'email' | 'sms' | 'whatsapp'; recipient: string; messageId?: string }>(
    server,
    'test_send_campaign',
    'Send ONE of the campaign’s messages to a single test recipient (email address or phone number) so the user can preview it. No audience, no analytics.',
    {
      campaignId: z.string(),
      channel: z.enum(['email', 'sms', 'whatsapp']),
      recipient: z.string().describe('Email address or E.164 phone number.'),
      messageId: z.string().optional().describe('Which message to test; defaults to the first on that channel.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const loaded = await loadOwned(tenantUserId, args.campaignId);
      if (!loaded.ok) return errorResult(loaded.error);

      const messages = Array.isArray(loaded.data.messages) ? (loaded.data.messages as Raw[]) : [];
      const message = args.messageId
        ? messages.find((m) => m.id === args.messageId && m.channel === args.channel)
        : messages.find((m) => m.channel === args.channel);
      if (!message) return errorResult(`No ${args.channel} message found on this campaign.`);

      const segment = (loaded.data.segment ?? {}) as Raw;
      const venueIds = Array.isArray(segment.venueIds) ? (segment.venueIds as string[]) : [];

      const { status, data } = await callServerInternal('/internal/test-send', {
        venueId: venueIds[0] ?? undefined,
        channel: args.channel,
        recipient: args.recipient,
        message: {
          subject: message.subject,
          body: message.body,
          content: message.content,
          templateName: message.templateName,
          languageCode: message.languageCode,
        },
      });
      if (status >= 400 || data.ok === false) {
        return errorResult(String(data.error ?? `test send failed (${status})`));
      }
      return jsonResult({ ok: true, id: data.id ?? null });
    },
  );
}
