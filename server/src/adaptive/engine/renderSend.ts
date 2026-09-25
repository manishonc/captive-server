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
import { evaluateCondition, factsFrom } from '../core/runtime/conditions';
import type { StayTimes } from '../stays/times';

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
  /** A stay journey's booking (read fresh), with the venue-level check-in/out times (D-C20). */
  stay?: { checkInAt: number; checkOutAt: number; nights: number; times: StayTimes } | null;
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
  if (i.stay) {
    values['stay.checkInDate'] = localDateForRender(new Date(i.stay.checkInAt), i.tz);
    values['stay.checkOutDate'] = localDateForRender(new Date(i.stay.checkOutAt), i.tz);
    values['stay.nights'] = String(i.stay.nights);
    // The times the stay was scheduled with, in every language — or none: the 15:00 / 10:00
    // scheduling fallback is never printed, so a checkout message without a valid time in
    // Guest info is skipped as guest_info_missing (fail closed).
    for (const [field, time] of [['checkInTime', i.stay.times.checkIn], ['checkOutTime', i.stay.times.checkOut]] as const) {
      if (time) {
        values[`guestinfo.${field}`] = time;
        values[`guestinfo.secret.${field}`] = time;
      } else {
        delete values[`guestinfo.${field}`];
        delete values[`guestinfo.secret.${field}`];
      }
    }
  }
  return values;
}

/** Guest info has something on it (any language) — else the info page would be empty (D-C21). */
export function guestInfoHasContent(guestInfo: Record<string, any> | null): boolean {
  const locales = (guestInfo?.locales ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return Object.values(locales).some((l) => GUEST_INFO_FIELDS.some((f) => typeof l?.[f] === 'string' && (l[f] as string).trim().length > 0));
}

/** One Guest info field in the guest's language, else English. */
export function guestInfoField(guestInfo: Record<string, any> | null, lang: Lang, field: string): string | null {
  for (const l of [lang, 'en']) {
    const v = guestInfo?.locales?.[l]?.[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const SLOT_FIELD = /\{\{\s*slot\.([A-Za-z0-9_]+)/g;

/**
 * Wording a guest can get with these owner values (D-C22): its `when` holds (read against
 * `slot.*`), and every `{{slot.X}}` it uses has a value — not 0, not cleared — so a late
 * checkout "for CHF 0" is never sent. Wording without a `when` is judged by the slots alone.
 */
export function variantEligible(v: Pick<VariantDoc, 'channels' | 'locales'> & { when?: VariantDoc['when'] }, slots: Record<string, SlotValue>): boolean {
  if (v.when && !evaluateCondition(v.when, factsFrom({ slot: slots }))) return false;
  const text = JSON.stringify([v.channels ?? {}, v.locales ?? {}]);
  for (const m of text.matchAll(SLOT_FIELD)) {
    const value = slots[m[1]];
    if (value === undefined || value === null || value === '' || value === 0) return false;
  }
  return true;
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
  // The info page link is withheld when Guest info is empty (or has no tips, for Local tips).
  if (missing.some((m) => m.startsWith('guestinfo.') || m === 'link.hub')) return 'guest_info_missing';
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
