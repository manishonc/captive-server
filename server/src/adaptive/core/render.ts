/**
 * Fill `{{ … }}` blanks for "See what guests get" (PRD JS-5).
 *
 * Preview only: sample guest "Anna", placeholder short links, no secrets. The
 * engine will render real sends with the same merge-field names.
 */

import { canonicalField, parseMergeExpressions } from './registry';
import { pickLang, type I18n, type Offer, type SlotValue } from './schemas';
import type { Lang } from './constants';

export type RenderValues = Record<string, string | undefined>;

export interface RenderResult {
  text: string;
  /** Blanks that had no value and no default — shown raw so the admin notices. */
  unknown: string[];
}

export function renderText(text: string, values: RenderValues): RenderResult {
  const unknown: string[] = [];
  let out = text;
  for (const expr of parseMergeExpressions(text)) {
    const field = canonicalField(expr.name);
    let value = values[field];
    for (const filter of expr.filters) {
      if (filter.name === 'default' && (value === undefined || value === '')) value = filter.arg ?? '';
      else if (filter.name === 'date' && value) value = formatDate(value, filter.arg ?? 'd.M.');
    }
    if (value === undefined) {
      unknown.push(field);
      continue;
    }
    out = out.split(expr.raw).join(value);
  }
  return { text: out, unknown };
}

/** Tiny date formatter for `| date:"d.M."` — tokens d, dd, M, MM, yyyy. */
export function formatDate(iso: string, pattern: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace('yyyy', String(d.getUTCFullYear()))
    .replace('dd', pad(d.getUTCDate()))
    .replace('MM', pad(d.getUTCMonth() + 1))
    .replace(/d/, String(d.getUTCDate()))
    .replace(/M/, String(d.getUTCMonth() + 1));
}

export interface SampleContext {
  lang: Lang;
  venueName: string;
  slots: Record<string, SlotValue>;
  offers: Offer[];
  now?: Date;
}

const SAMPLE_LINKS: RenderValues = {
  'link.offer': 'hdf.to/x7k2',
  'link.rating': 'hdf.to/r4t8',
  'link.hub': 'hdf.to/h1b2',
  'link.unsubscribe': 'hdf.to/u9z3',
  'link.booking': 'hdf.to/b5k1',
};

/** Values for the example guest, filled from the owner's blanks. */
export function sampleValues(ctx: SampleContext): RenderValues {
  const now = ctx.now ?? new Date();
  const values: RenderValues = {
    'contact.firstName': 'Anna',
    'contact.lastName': 'Meier',
    'venue.name': ctx.venueName,
    ...SAMPLE_LINKS,
    'stay.checkInDate': isoDaysFrom(now, 0),
    'stay.checkOutDate': isoDaysFrom(now, 4),
    'stay.nights': '4',
    'guestinfo.wifiName': `${ctx.venueName} Guest`,
    'guestinfo.checkInTime': '15:00',
    'guestinfo.checkOutTime': '11:00',
    'guestinfo.houseRules': 'No smoking inside, quiet after 22:00.',
    'guestinfo.hostContactUrl': 'hdf.to/c3n4',
    'guestinfo.openingHours': '11:30–22:00',
    'guestinfo.menuUrl': 'hdf.to/m6n7',
    'guestinfo.secret.wifiPassword': '••••••••',
    'guestinfo.secret.doorCode': '••••',
    'guestinfo.secret.keyInstructions': 'The key box is next to the door.',
  };

  for (const [key, value] of Object.entries(ctx.slots)) {
    values[`slot.${key}`] = slotToText(value, ctx.lang, ctx.offers);
  }

  // The offer a journey gives comes from its offer blank.
  const offerKey = Object.values(ctx.slots).find((v) => typeof v === 'string' && ctx.offers.some((o) => o.offerKey === v));
  const offer = ctx.offers.find((o) => o.offerKey === offerKey) ?? ctx.offers[0];
  const days = Number(ctx.slots.offer_days ?? offer?.expiryDays ?? 14);
  if (offer) {
    values['offer.label'] = pickLang(offer.label, ctx.lang);
    values['offer.days'] = String(days);
    values['offer.expiryDate'] = isoDaysFrom(now, days);
  }
  return values;
}

function slotToText(value: SlotValue, lang: Lang, offers: Offer[]): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return pickLang(value as I18n, lang);
  if (typeof value === 'string') {
    const offer = offers.find((o) => o.offerKey === value);
    return offer ? pickLang(offer.label, lang) : value;
  }
  return String(value);
}

function isoDaysFrom(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
