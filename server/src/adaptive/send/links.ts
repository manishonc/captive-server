/**
 * Real links for a live send (plan §3.7, §4.2). Minted only after the gate said
 * yes — a deferred send re-runs the gate many times and must not leave a trail
 * of links — through the existing services/shortlinks.ts (unchanged), with the
 * journey fields the CMS resolver ignores today:
 *
 *   sendKind 'journey', sendKey, instanceId, contactId, variantId, journeyLink
 *   marketingDocId = sendKey  → today's Marketing lookups find nothing (by design)
 *
 * Offer and info-page links carry their own code in the target (`?s=<code>`), so
 * they are created with a safe placeholder target and then pointed at the page.
 * The rating link uses the resolver's built-in `venue-rate` route.
 */

import { db } from '../../firebase';
import { createShortLink, VISITOR_BASE_URL, type ShortLinkData } from '../../services/shortlinks';
import { buildUnsubscribeUrl, type UnsubscribePayload } from '../../services/unsubscribe';
import { placeholderLink, shortLinkUrl } from './compose';

export type JourneyLinkKind = 'offer' | 'rating' | 'hub' | 'booking';
const KINDS: JourneyLinkKind[] = ['offer', 'rating', 'hub', 'booking'];
const SHORT_LINKS = 'CaptivePortal_ShortLinks';

export { VISITOR_BASE_URL };

/** Which journey links the rendered wording actually uses. */
export function linkKindsUsed(fieldsUsed: string[]): JourneyLinkKind[] {
  return KINDS.filter((k) => fieldsUsed.includes(`link.${k}`));
}

/** The owner's booking site, only if it is an absolute http(s) URL (the resolver 500s on anything else). */
export function validBookingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Same-length stand-ins for pricing and the gate (nothing is created). */
export function pricingLinks(kinds: JourneyLinkKind[]): Partial<Record<JourneyLinkKind, string>> {
  const link = placeholderLink(VISITOR_BASE_URL);
  return Object.fromEntries(kinds.map((k) => [k, link]));
}

export interface MintContext {
  venueId: string;
  sendKey: string;
  instanceId: string | null;
  contactId: string;
  variantId: string | null;
  channel: 'sms' | 'email';
  /** A guest doc of this person (the resolver's context field). */
  guestId: string;
  bookingUrl: string | null;
}

type JourneyLinkData = ShortLinkData & {
  sendKind: 'journey';
  sendKey: string;
  instanceId: string | null;
  contactId: string;
  variantId: string | null;
  journeyLink: JourneyLinkKind;
};

function pageUrl(venueId: string, page: 'offer' | 'info', code: string): string {
  return `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/${page}?s=${code}`;
}

/** Creates the short links; returns their URLs by kind and the codes (stored on the send). */
export async function mintLinks(kinds: JourneyLinkKind[], ctx: MintContext): Promise<{ urls: Partial<Record<JourneyLinkKind, string>>; codes: string[] }> {
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      const base = {
        venueId: ctx.venueId,
        marketingDocId: ctx.sendKey,
        wifiGuestId: ctx.guestId,
        channel: ctx.channel,
        sendKind: 'journey' as const,
        sendKey: ctx.sendKey,
        instanceId: ctx.instanceId,
        contactId: ctx.contactId,
        variantId: ctx.variantId,
        journeyLink: kind,
      };
      let data: JourneyLinkData;
      if (kind === 'rating') data = { ...base, targetType: 'venue-rate', targetUrl: `${VISITOR_BASE_URL}/${encodeURIComponent(ctx.venueId)}/rate` };
      else if (kind === 'booking') {
        if (!ctx.bookingUrl) throw new Error('booking link without a valid booking URL');
        data = { ...base, targetType: 'custom', targetUrl: ctx.bookingUrl };
      } else data = { ...base, targetType: 'custom', targetUrl: `${VISITOR_BASE_URL}/` };
      const code = await createShortLink(data);
      if (kind === 'offer' || kind === 'hub') {
        await db.collection(SHORT_LINKS).doc(code).update({ targetUrl: pageUrl(ctx.venueId, kind === 'offer' ? 'offer' : 'info', code) });
      }
      return [kind, code] as const;
    }),
  );
  return {
    urls: Object.fromEntries(entries.map(([k, code]) => [k, shortLinkUrl(VISITOR_BASE_URL, code)])),
    codes: entries.map(([, code]) => code),
  };
}

/**
 * The unsubscribe link for a marketing email: the existing signed `/u` link. `g`
 * names a guest doc of this person at this venue (so today's page flags it like
 * any other unsubscribe), `c` carries the sendKey so the Adaptive hook finds the
 * send directly. '' when unsubscribe isn't configured (the send is then blocked).
 */
export function unsubscribeUrlFor(guestId: string | null, venueId: string, sendKey: string): string {
  const payload: UnsubscribePayload = { g: guestId || sendKey, v: venueId, c: sendKey };
  return buildUnsubscribeUrl(payload);
}
