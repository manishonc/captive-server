/**
 * Marketing template tools: browse the global + tenant library, read one in
 * full (incl. block designs), save a new tenant-private template.
 *
 * Sources: Firestore CaptivePortal_MarketingTemplates (admin-curated globals
 * with tenantUserId null + the tenant's own), plus a static manifest of the
 * CMS's built-in code templates (cms/lib/email-templates.ts) so the AI can
 * name-drop them — their designs are fetched by id via the CMS gallery.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom, tsToIso } from '../shared';
import { validateEmailDesign } from '../../emailBlocks/schema';
import { renderEmailBlocks } from '../../emailBlocks/render';

const COLLECTION = 'CaptivePortal_MarketingTemplates';
const CHANNELS = ['email', 'sms', 'whatsapp'];
const SCOPES = ['venue', 'campaign_manager', 'both'];

type Raw = Record<string, unknown>;

/**
 * Static manifest of the CMS built-in email templates (kept in sync with
 * cms/lib/email-templates.ts EMAIL_TEMPLATES ids). These have block-design
 * equivalents in the CMS gallery; the AI should use them as INSPIRATION for
 * its own block designs rather than fetching their HTML.
 */
const BUILT_IN_EMAIL_TEMPLATES = [
  { id: 'welcome-wifi', name: 'Welcome — Thanks for connecting', category: 'welcome', hasBlocks: true },
  { id: 'review-request', name: 'Review request', category: 'review', hasBlocks: true },
  { id: 'special-offer', name: 'Special offer / discount', category: 'promo', hasBlocks: true },
  { id: 'event-announcement', name: 'Event announcement', category: 'event', hasBlocks: false },
  { id: 'newsletter', name: 'Newsletter / What’s new', category: 'newsletter', hasBlocks: false },
  { id: 'restaurant-special', name: 'Today’s special', category: 'promo', hasBlocks: false },
  { id: 'win-back', name: 'Win-back — we miss you', category: 'promo', hasBlocks: true },
  { id: 'local-guide', name: 'Things to do nearby', category: 'welcome', hasBlocks: false },
  { id: 'feedback-survey', name: 'Feedback survey', category: 'review', hasBlocks: false },
  { id: 'seasonal-greeting', name: 'Seasonal greeting', category: 'seasonal', hasBlocks: false },
];

function leanTemplate(id: string, d: Raw) {
  const messages = Array.isArray(d.messages) ? (d.messages as Raw[]) : [];
  return {
    id,
    name: d.name ?? '',
    description: d.description ?? '',
    channel: d.channel ?? null,
    scope: d.scope ?? 'both',
    global: !d.tenantUserId,
    messageCount: messages.length,
    createdAt: tsToIso(d.createdAt),
  };
}

export function registerTemplateTools(server: McpServer): void {
  addTool<{ channel?: 'email' | 'sms' | 'whatsapp' }>(
    server,
    'list_templates',
    'List reusable marketing message templates: admin-curated globals, the tenant’s own saved templates, and the built-in email template library. Prefer adapting one of these over writing a campaign from scratch.',
    {
      channel: z.enum(['email', 'sms', 'whatsapp']).optional().describe('Filter by channel.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection(COLLECTION).get();
      let templates = snap.docs
        .map((doc) => ({ id: doc.id, d: doc.data() as Raw }))
        .filter(
          (t) =>
            t.d.status === 'active' &&
            (!t.d.tenantUserId || t.d.tenantUserId === tenantUserId),
        );
      if (args.channel) templates = templates.filter((t) => t.d.channel === args.channel);

      const builtIns =
        !args.channel || args.channel === 'email'
          ? BUILT_IN_EMAIL_TEMPLATES.map((t) => ({ ...t, builtin: true, channel: 'email' }))
          : [];

      return jsonResult({
        templates: [
          ...templates.map((t) => leanTemplate(t.id, t.d)),
          ...builtIns,
        ],
      });
    },
  );

  addTool<{ templateId: string }>(
    server,
    'get_template',
    'Get one saved marketing template in full (all messages incl. any block designJson). Not for built-in ids — those are inspiration entries from list_templates.',
    { templateId: z.string() },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection(COLLECTION).doc(args.templateId).get();
      if (!snap.exists) return errorResult('Template not found.');
      const d = snap.data() as Raw;
      if (d.tenantUserId && d.tenantUserId !== tenantUserId) {
        return errorResult('Template not found or not accessible to this account.');
      }

      return jsonResult({
        template: {
          ...leanTemplate(snap.id, d),
          messages: Array.isArray(d.messages) ? d.messages : [],
          settings: d.settings ?? {},
        },
      });
    },
  );

  addTool<{
    name: string;
    channel: 'email' | 'sms' | 'whatsapp';
    description?: string;
    messages: Raw[];
  }>(
    server,
    'create_template',
    'Save a reusable tenant-private marketing template (scope campaign_manager). Email messages should use bodyFormat "blocks" with an EmailDesignV1 designJson.',
    {
      name: z.string().min(1).max(150),
      channel: z.enum(['email', 'sms', 'whatsapp']),
      description: z.string().max(1000).optional(),
      messages: z
        .array(
          z
            .object({
              subject: z.string().optional(),
              body: z.string().optional(),
              bodyFormat: z.enum(['html', 'text', 'blocks']).optional(),
              designJson: z.unknown().optional(),
              content: z.string().optional(),
              templateName: z.string().optional(),
              languageCode: z.string().optional(),
              delayMinutes: z.number().min(0).max(43200).default(0),
            })
            .passthrough(),
        )
        .min(1)
        .max(20),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      // Normalize + validate messages; blocks designs are re-rendered so the
      // stored body always matches the design.
      const messages: Raw[] = [];
      for (let i = 0; i < args.messages.length; i++) {
        const raw = args.messages[i];
        const entry: Raw = { delayMinutes: raw.delayMinutes ?? 0 };
        if (args.channel === 'email') {
          entry.subject = String(raw.subject ?? '').slice(0, 200);
          entry.bodyFormat = raw.bodyFormat ?? 'html';
          if (entry.bodyFormat === 'blocks') {
            const design = validateEmailDesign(raw.designJson);
            if (!design.ok) return errorResult(`messages[${i}]: invalid email design: ${design.error}`);
            entry.body = renderEmailBlocks(design.design);
            entry.designJson = raw.designJson;
          } else {
            entry.body = String(raw.body ?? '').slice(0, 200000);
            if (!/\{\{\s*unsubscribeUrl\s*\}\}/i.test(entry.body as string)) {
              return errorResult(
                `messages[${i}]: email templates must include an unsubscribe link ({{unsubscribeUrl}}) or use bodyFormat "blocks".`,
              );
            }
            if (raw.designJson !== undefined) entry.designJson = raw.designJson;
          }
        } else if (args.channel === 'whatsapp') {
          entry.templateName = String(raw.templateName ?? '').trim();
          entry.languageCode = String(raw.languageCode ?? 'en_US').trim();
          entry.content = String(raw.content ?? '').slice(0, 4096);
          if (!entry.templateName) return errorResult(`messages[${i}]: WhatsApp requires templateName.`);
        } else {
          entry.content = String(raw.content ?? '').slice(0, 1600);
        }
        messages.push(entry);
      }

      const now = new Date();
      const doc = {
        name: args.name.trim().slice(0, 150),
        description: String(args.description ?? '').slice(0, 1000),
        channel: args.channel,
        scope: 'campaign_manager',
        tenantUserId,
        messages,
        settings: {},
        status: 'active',
        createdAt: now,
        updatedAt: now,
        createdBy: `mcp:${tenantUserId}`,
      };
      const ref = await db.collection(COLLECTION).add(doc);
      return jsonResult({ template: leanTemplate(ref.id, doc as unknown as Raw) });
    },
  );
}
