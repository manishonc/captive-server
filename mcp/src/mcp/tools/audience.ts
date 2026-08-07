/**
 * Audience preview tool — who a campaign segment would reach, per channel.
 * Mirrors the CMS audience-preview route: venues → access points → guests,
 * then channel-aware consent filtering (email unsubscribe vs SMS STOP vs
 * WhatsApp opt-out are independent suppressions).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NO_TENANT,
  addTool,
  errorResult,
  getGuestsForApIds,
  getTenantAccessPoints,
  jsonResult,
  tenantFrom,
} from '../shared';

type Raw = Record<string, unknown>;

/** Base marketing consent (mirrors server/src/services/campaigns.ts isOptedIn). */
function hasMarketingConsent(u: Raw): boolean {
  if (u.status === 'archived') return false;
  const consent = u.marketingConsent as Raw | undefined;
  if (consent && consent.given === false) return false;
  return u.marketingOptIn === true || (consent ? consent.given === true : false);
}

/** Channel-aware opt-in: email unsubscribe ≠ SMS STOP ≠ WhatsApp opt-out. */
export function isOptedInFor(u: Raw, channel: 'email' | 'sms' | 'whatsapp'): boolean {
  if (!hasMarketingConsent(u)) return false;
  if (channel === 'email' && u.unsubscribed === true) return false;
  if (channel === 'sms' && u.smsOptOut === true) return false;
  if (channel === 'whatsapp' && u.whatsappOptOut === true) return false;
  return true;
}

function guestDate(u: Raw): number | null {
  const created = u.createdAt as { toDate?: () => Date } | string | undefined;
  if (!created) return null;
  if (typeof created === 'string') {
    const t = new Date(created).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return created.toDate?.()?.getTime() ?? null;
}

/**
 * The guest's splash language, or 'unknown'.
 *
 * Unknown covers both "captured before the venue offered a choice" and a code
 * we no longer support — either way the guest is unreachable by a
 * language-targeted send, which is what the bucket has to mean.
 */
function guestLanguage(data: Record<string, unknown>): string {
  const raw = data.language;
  if (typeof raw !== 'string') return 'unknown';
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return ['en', 'de', 'it', 'fr'].includes(base) ? base : 'unknown';
}

export function registerAudienceTools(server: McpServer): void {
  addTool<{
    venueIds?: string[];
    signedUpAfter?: string;
    signedUpBefore?: string;
    language?: string;
  }>(
    server,
    'preview_audience',
    'Preview how many opted-in guests a campaign segment reaches, broken down per channel (email needs an address + no unsubscribe; SMS a phone + no STOP; WhatsApp a phone + no opt-out) and per guest language. Always show these numbers to the user before sending.',
    {
      venueIds: z.array(z.string()).optional().describe('Restrict to these venues; empty/omitted = all venues.'),
      signedUpAfter: z.string().optional().describe('ISO date — only guests who signed up after this.'),
      signedUpBefore: z.string().optional().describe('ISO date — only guests who signed up before this.'),
      language: z
        .enum(['en', 'de', 'it', 'fr', 'unknown'])
        .optional()
        .describe(
          'Count only guests who chose this language on the splash screen. "unknown" = captured '
          + 'before the venue offered a choice. Omit to count everyone — byLanguage is returned '
          + 'either way, so you can see the spread before deciding to target.',
        ),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const accessPoints = await getTenantAccessPoints(tenantUserId);
      const venueFilter = (args.venueIds ?? []).filter(Boolean);
      const apIds = accessPoints
        .filter((ap) => venueFilter.length === 0 || venueFilter.includes(ap.venueId))
        .map((ap) => ap.id);

      if (apIds.length === 0) {
        return jsonResult({ total: 0, perChannel: { email: 0, sms: 0, whatsapp: 0 }, note: 'No access points match this segment.' });
      }

      const after = args.signedUpAfter ? new Date(args.signedUpAfter).getTime() : null;
      const before = args.signedUpBefore ? new Date(args.signedUpBefore).getTime() : null;

      const wantLanguage = args.language ?? null;

      const guests = (await getGuestsForApIds(apIds)).filter(({ data }) => {
        const t = guestDate(data);
        if (after !== null && (t === null || t < after)) return false;
        if (before !== null && (t === null || t > before)) return false;
        if (wantLanguage && guestLanguage(data) !== wantLanguage) return false;
        return true;
      });

      let total = 0;
      const perChannel = { email: 0, sms: 0, whatsapp: 0 };
      // Always computed: deciding whether language targeting is worth setting up
      // needs the spread, not just the filtered total.
      const byLanguage: Record<string, number> = {};
      for (const { data } of guests) {
        byLanguage[guestLanguage(data)] = (byLanguage[guestLanguage(data)] ?? 0) + 1;
        const email = typeof data.email === 'string' && data.email.includes('@');
        const phone = typeof data.phone === 'string' && String(data.phone).replace(/\D/g, '').length >= 8;
        const anyChannel =
          (email && isOptedInFor(data, 'email')) ||
          (phone && (isOptedInFor(data, 'sms') || isOptedInFor(data, 'whatsapp')));
        if (anyChannel) total += 1;
        if (email && isOptedInFor(data, 'email')) perChannel.email += 1;
        if (phone && isOptedInFor(data, 'sms')) perChannel.sms += 1;
        if (phone && isOptedInFor(data, 'whatsapp')) perChannel.whatsapp += 1;
      }

      return jsonResult({ total, perChannel, byLanguage });
    },
  );
}
