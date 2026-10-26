/**
 * The email design system (Voucher). One entry: a wording's email (plain text or blocks) plus the
 * values the engine filled in → the email's HTML. The slip comes from the journey's own data:
 *
 *  - an offer link (or a booking link on a journey with an offer) → the voucher: the offer's value
 *    (from the offer menu, never from the wording), what it is, valid until, the button;
 *  - the rating link → five stars, each opening the rating page;
 *  - the info page link on a stay or Wi-Fi message → a key card from Guest info (check-in or
 *    check-out time, Wi-Fi network, address — never a password or door code the wording didn't use);
 *  - a Bring-a-friend code line → the code.
 *
 * The design only turns links the wording already has into its button, so every link stays one
 * the engine mints and tracks. Pure.
 */

import type { Lang, OfferKind } from '../../core/constants';
import { renderText, type RenderValues } from '../../core/render';
import { parseBlocksBody } from '../../core/emailBlocks';
import type { Action, EmailModel, FactRow, Feature } from './model';
import type { DesignBrand } from './brand';
import { structureFromText } from './fromText';
import { labelsFor, longDate, type DesignLabels } from './labels';
import { renderVoucher } from './voucher';

export type { DesignBrand } from './brand';
export { designBrandFrom } from './brand';
export { blocksTemplateText } from '../../core/emailBlocks';

export interface DesignFacts {
  purpose: 'marketing' | 'service';
  /** The message's pool (`welcome_offer`, `stay_welcome`, …): picks the button's words and the key card. */
  pool: string;
  /** The journey's offer from the offer menu, when it holds one. */
  offer?: { kind: OfferKind; value: number; currency?: string } | null;
}

export interface DesignInput {
  brand: DesignBrand;
  lang: Lang;
  /** The wording's email as stored: templates, merge fields not filled in. */
  content: { subject?: string; preheader?: string; body: string; bodyFormat?: 'text' | 'html' | 'blocks' };
  /** The values the message is sent with (links real or placeholders, secrets as the caller wants them). */
  values: RenderValues;
  facts: DesignFacts;
  unsubscribeUrl: string | null;
  poweredBy: boolean;
  /** 'light' for the owner's preview; guests' emails follow their mail app ('auto', the default). */
  colorScheme?: 'auto' | 'light';
}

export type DesignResult = { html: string; model: EmailModel } | { error: 'invalid_blocks' | 'unsupported_format' };

/** Button words by pool, else by link. */
const POOL_BUTTON: Record<string, keyof DesignLabels> = {
  birthday: 'showGift',
  book_direct: 'bookNow',
  holiday: 'bookNow',
  local_tips: 'seeTips',
};
/** Which key card a pool's info link gets. */
const POOL_CARD: Record<string, 'checkin' | 'checkout' | 'wifi'> = {
  stay_welcome: 'checkin',
  stay_checkout: 'checkout',
  checkout_info: 'checkout',
  wifi_info: 'wifi',
};

function fill(template: string | undefined, values: RenderValues): string {
  return renderText(String(template ?? ''), values).text.trim();
}

/**
 * "10%" / "10 %" (German, French) / "CHF 5" / "CHF 4.50"; null for a free item or an upsell (the
 * label says it). An amount is stored in minor units of its currency (core/schemas.ts `offerSchema`).
 */
export function offerValue(offer: DesignFacts['offer'], lang: Lang): string | null {
  if (!offer || !(offer.value > 0)) return null;
  if (offer.kind === 'percent') {
    const n = Number.isInteger(offer.value) ? String(offer.value) : String(Number(offer.value.toFixed(2)));
    return lang === 'de' || lang === 'fr' ? `${n}\u00a0%` : `${n}%`;
  }
  if (offer.kind === 'amount') {
    const major = offer.value / 100;
    return `${offer.currency || 'CHF'}\u00a0${Number.isInteger(major) ? String(major) : major.toFixed(2)}`;
  }
  return null;
}

/** The label under a big value, without the value it starts with ("10% off your next visit" → "off your next visit"). */
export function labelAfterValue(label: string, value: string | null): string {
  const t = label.trim();
  if (!value) return t.charAt(0).toUpperCase() + t.slice(1);
  const pattern = new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(\\u00a0|\u00a0| )/g, '\\s?') + '\\s*', 'i');
  const rest = t.replace(pattern, '');
  return rest && rest !== t ? rest : t;
}

function action(kind: string, values: RenderValues, label: string): Action | null {
  const href = values[`link.${kind}`];
  return href ? { label, href } : null;
}

function buttonWords(pool: string, kind: string, L: DesignLabels): string {
  const key = POOL_BUTTON[pool];
  if (key) return L[key] as string;
  if (kind === 'booking') return L.bookNow;
  if (kind === 'hub') return L.openInfo;
  return L.showOffer;
}

function infoCard(pool: string, values: RenderValues, brand: DesignBrand, lang: Lang, L: DesignLabels, act: Action | null): Feature | null {
  const card = POOL_CARD[pool];
  if (!card) return null;
  const v = (k: string) => (values[k] ?? '').trim();
  const wifi: FactRow[] = v('guestinfo.wifiName') ? [{ label: L.wifi, value: v('guestinfo.wifiName') }] : [];
  if (card === 'checkin') {
    if (!v('guestinfo.checkInTime')) return null;
    const out = [longDate(v('stay.checkOutDate') || undefined, lang), v('guestinfo.checkOutTime')].filter(Boolean).join(', ');
    const rows: FactRow[] = [];
    if (out) rows.push({ label: L.checkOut, value: out });
    if (brand.address) rows.push({ label: L.address, value: brand.address });
    return { kind: 'info', lead: { label: L.checkInFrom, value: v('guestinfo.checkInTime'), sub: longDate(v('stay.checkInDate') || undefined, lang) }, rows, stub: wifi, action: act };
  }
  if (card === 'checkout') {
    if (!v('guestinfo.checkOutTime')) return null;
    return { kind: 'info', lead: { label: L.checkOutBy, value: v('guestinfo.checkOutTime'), sub: longDate(v('stay.checkOutDate') || undefined, lang) }, rows: [], stub: [], action: act };
  }
  if (!v('guestinfo.wifiName')) return null;
  const rows: FactRow[] = v('guestinfo.openingHours') ? [{ label: L.openingHours, value: v('guestinfo.openingHours') }] : [];
  return { kind: 'info', lead: { label: L.wifi, value: v('guestinfo.wifiName'), sub: null }, rows, stub: [], action: act };
}

function offerFeature(i: DesignInput, act: Action | null, L: DesignLabels): Feature | null {
  const label = (i.values['offer.label'] ?? '').trim();
  if (!label) return null;
  const value = offerValue(i.facts.offer, i.lang);
  return {
    kind: 'offer',
    value,
    label: labelAfterValue(label, value),
    untilLabel: L.validUntil,
    untilDate: longDate(i.values['offer.expiryDate'], i.lang),
    action: act,
  };
}

/** The slip and the action for a link the wording uses. */
function featureFor(i: DesignInput, kind: string, L: DesignLabels, href?: string, buttonLabel?: string): { feature: Feature | null; action: Action | null } {
  const values = href ? { ...i.values, [`link.${kind}`]: fill(href, i.values) } : i.values;
  const act = action(kind, values, buttonLabel || buttonWords(i.facts.pool, kind, L));
  if (kind === 'rating') {
    const link = values['link.rating'];
    return link ? { feature: { kind: 'rating', href: link, low: L.rateLow, high: L.rateHigh, aria: L.rateAria }, action: null } : { feature: null, action: null };
  }
  if (kind === 'offer' || (kind === 'booking' && i.facts.offer)) {
    const f = offerFeature({ ...i, values }, act, L);
    return f ? { feature: f, action: null } : { feature: null, action: act };
  }
  if (kind === 'hub') {
    const f = infoCard(i.facts.pool, values, i.brand, i.lang, L, act);
    return f ? { feature: f, action: null } : { feature: null, action: act };
  }
  return { feature: null, action: act };
}

function modelFromText(i: DesignInput, L: DesignLabels): EmailModel {
  const s = structureFromText(i.content.body);
  const before = s.before.map((p) => fill(p, i.values)).filter(Boolean);
  const after = s.after.map((p) => fill(p, i.values)).filter(Boolean);
  let feature: Feature | null = null;
  let act: Action | null = null;
  if (s.link) ({ feature, action: act } = featureFor(i, s.link.kind, L));
  else if (s.code) {
    const code = (i.values['referral.code'] ?? '').trim();
    if (code) feature = { kind: 'code', label: fill(s.code.label, i.values), code };
  }
  return {
    heading: fill(i.content.subject, i.values) || null,
    before,
    after,
    feature,
    action: act,
    image: null,
    signoff: s.signoff === null ? null : fill(s.signoff, i.values),
  };
}

function modelFromBlocks(i: DesignInput, L: DesignLabels): EmailModel | null {
  const body = parseBlocksBody(i.content.body);
  if (!body) return null;
  const model: EmailModel = { heading: null, before: [], after: [], feature: null, action: null, image: null, signoff: null };
  let seenFeature = false;
  for (const b of body.blocks) {
    if (b.t === 'heading') model.heading = fill(b.text, i.values);
    else if (b.t === 'text') (seenFeature ? model.after : model.before).push(fill(b.text, i.values));
    else if (b.t === 'signoff') model.signoff = fill(b.text, i.values);
    else if (b.t === 'image') model.image = { src: b.src, alt: fill(b.alt, i.values) };
    else if (b.t === 'button') {
      const kind = /link\.(\w+)/.exec(b.href)![1];
      model.action = action(kind, { ...i.values, [`link.${kind}`]: fill(b.href, i.values) }, fill(b.label, i.values));
      seenFeature = true; // text after the button stays after it
    } else {
      const kind = /link\.(\w+)/.exec(b.href)![1];
      const r = featureFor(i, kind, L, b.href, 'button' in b && b.button ? fill(b.button, i.values) : undefined);
      model.feature = r.feature;
      if (r.action) model.action = r.action;
      seenFeature = true;
    }
  }
  return model;
}

export function designEmail(i: DesignInput): DesignResult {
  const format = i.content.bodyFormat ?? 'text';
  if (format === 'html') return { error: 'unsupported_format' };
  const L = labelsFor(i.lang);
  const model = format === 'blocks' ? modelFromBlocks(i, L) : modelFromText(i, L);
  if (!model) return { error: 'invalid_blocks' };
  const html = renderVoucher({
    brand: i.brand,
    model,
    lang: i.lang,
    purpose: i.facts.purpose,
    preheader: fill(i.content.preheader, i.values),
    subject: fill(i.content.subject, i.values),
    unsubscribeUrl: i.unsubscribeUrl,
    poweredBy: i.poweredBy,
    colorScheme: i.colorScheme,
  });
  return { html, model };
}
