/**
 * Rendering a real message: the guest's name, the venue, the offer on the
 * journey, the owner's blanks, Guest info and links. Uses the same `renderText`
 * as the CMS preview (core/render.ts, unchanged); dates are passed as noon UTC of
 * the local day so its UTC date filter prints the right day.
 *
 * Unknown values are reported, never sent raw: a Wi-Fi card without Guest info
 * is blocked, not sent with "{{guestinfo.wifiName}}" in it.
 */

import { renderText, type RenderValues } from '../core/render';
import { canonicalField, parseMergeExpressions } from '../core/registry';
import { isI18n, pickLang, type ChannelContent, type I18n, type Offer, type SlotValue } from '../core/schemas';
import type { Channel, Lang } from '../core/constants';
import type { ContactDoc } from '../store/engineTypes';
import type { VariantDoc } from '../store/types';
import { localDateForRender } from '../core/runtime/time';

export type LinkKind = 'offer' | 'rating' | 'hub' | 'booking' | 'unsubscribe';

export interface RenderInputs {
  lang: Lang;
  tz: string;
  contact: Pick<ContactDoc, 'firstName' | 'lastName'>;
  venueName: string;
  vars: Record<string, unknown>;
  slots: Record<string, SlotValue>;
  offers: Offer[];
  guestInfo: Record<string, any> | null;
  links: Partial<Record<LinkKind, string>>;
}

const GUEST_INFO_FIELDS = [
  'wifiName',
  'wifiPassword',
  'doorCode',
  'keyInstructions',
  'checkInTime',
  'checkOutTime',
  'houseRules',
  'hostContactUrl',
  'openingHours',
  'menuUrl',
  'localTips',
  'directBookingUrl',
];

function slotText(value: SlotValue, lang: Lang, offers: Offer[]): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return pickLang(value as I18n, lang);
  if (typeof value === 'string') {
    const offer = offers.find((o) => o.offerKey === value);
    return offer ? pickLang(offer.label, lang) : value;
  }
  return String(value);
}

export function renderValues(i: RenderInputs): RenderValues {
  const values: RenderValues = {
    'contact.firstName': i.contact.firstName ?? '',
    'contact.lastName': i.contact.lastName ?? '',
    'venue.name': i.venueName,
  };
  for (const [kind, url] of Object.entries(i.links)) if (url) values[`link.${kind}`] = url;

  const label = i.vars.offerLabel;
  if (label && isI18n(label)) values['offer.label'] = pickLang(label, i.lang);
  if (typeof i.vars.offerDays === 'number') values['offer.days'] = String(i.vars.offerDays);
  if (typeof i.vars.offerExpiresAt === 'number') values['offer.expiryDate'] = localDateForRender(new Date(i.vars.offerExpiresAt), i.tz);

  for (const [key, value] of Object.entries(i.slots)) values[`slot.${key}`] = slotText(value, i.lang, i.offers);

  const info = i.guestInfo?.locales?.[i.lang] ?? i.guestInfo?.locales?.en ?? null;
  if (info) {
    for (const f of GUEST_INFO_FIELDS) {
      const v = info[f];
      if (typeof v === 'string' && v.trim()) {
        values[`guestinfo.${f}`] = v.trim();
        values[`guestinfo.secret.${f}`] = v.trim();
      }
    }
  }
  return values;
}

/** The wording for one channel in the guest's language (English fallback). */
export function variantContent(
  variant: Pick<VariantDoc, 'channels' | 'locales'>,
  channel: Channel,
  lang: Lang,
): { content: NonNullable<ChannelContent[Channel]>; locale: Lang; fallback: boolean } | null {
  const own = variant.locales?.[lang]?.[channel];
  if (own) return { content: own as NonNullable<ChannelContent[Channel]>, locale: lang, fallback: false };
  const base = variant.channels?.[channel];
  if (base) return { content: base as NonNullable<ChannelContent[Channel]>, locale: 'en', fallback: lang !== 'en' };
  return null;
}

export interface RenderedMessage {
  subject?: string;
  text: string;
  /** Merge fields with no value — the send is blocked when this isn't empty. */
  missing: string[];
  fieldsUsed: string[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders one channel's content. For email, merge values are HTML-escaped (a name
 * comes from a public form) and subjects are kept to one line.
 */
export function renderMessage(content: any, channel: Channel, values: RenderValues): RenderedMessage {
  const missing = new Set<string>();
  const fields = new Set<string>();
  const fill = (text: string, html: boolean) => {
    for (const e of parseMergeExpressions(text)) fields.add(canonicalField(e.name));
    const safe: RenderValues = html ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? v : escapeHtml(v)])) : values;
    const r = renderText(text, safe);
    r.unknown.forEach((u) => missing.add(u));
    return r.text;
  };
  if (channel === 'sms') return { text: fill(String(content.text ?? ''), false), missing: [...missing], fieldsUsed: [...fields] };
  if (channel === 'email') {
    const subject = fill(String(content.subject ?? ''), false).replace(/[\r\n]+/g, ' ').trim();
    const body = fill(String(content.body ?? ''), content.bodyFormat === 'html');
    return { subject, text: body, missing: [...missing], fieldsUsed: [...fields] };
  }
  return { text: '', missing: ['whatsapp'], fieldsUsed: [] };
}

/** Why a missing value blocks a send, in the gate's words. */
export function missingReason(missing: string[]): string {
  if (missing.some((m) => m.startsWith('guestinfo.'))) return 'guest_info_missing';
  if (missing.includes('link.booking')) return 'booking_link_missing';
  return `missing_value:${missing[0]}`;
}

/** Placeholder links for test runs (nothing is minted, nothing is sent). */
export const DRY_RUN_LINKS: Record<LinkKind, string> = {
  offer: '[offer link]',
  rating: '[rating link]',
  hub: '[info page link]',
  booking: '[booking link]',
  unsubscribe: '[unsubscribe link]',
};
