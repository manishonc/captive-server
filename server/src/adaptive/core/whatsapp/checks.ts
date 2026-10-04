/**
 * The checks a WhatsApp template must pass before it may go to Meta (PR W1). Codes T01–T22
 * (W01/W02 are setup checks already). Errors block "Send to Meta"; warnings are shown (and, from
 * W2, keep Auto from sending it). Run on every read, never stored — a stored result would go
 * stale when the pool, the base URL, a sibling or these rules change. Pure: everything the rules
 * need comes in through `CheckContext`.
 *
 *  T01 name format              T08 allowed fields only        T15 no STOP text in the body
 *  T02 language                 T09 variable placement         T16 room under the template limit
 *  T03 category is ours to ask  T10 enough words per variable  T17 name locked at Meta
 *  T04 category = message rule  T11 fallbacks + date formats   T18 no duplicate body
 *  T05 one category per name    T12 the button link            T19 utility = no promotion
 *  T06 body length              T13 names the venue            T20 the STOP footer
 *  T07 footer length            T14 no links/phones/emails     T21 formatting  · T22 creates/hour
 */

import { makeReport, error, warning, info, type Issue, type ValidationReport } from '../issues';
import { parseMergeExpressions, canonicalField } from '../registry/mergeFields';
import type { Lang } from '../constants';
import {
  WA_ALWAYS_PRESENT,
  WA_BODY_FIELDS,
  WA_BODY_MAX,
  WA_BUTTON_FIELDS,
  WA_BUTTON_TEXT_MAX,
  WA_DATE_FIELDS,
  WA_FOOTER_MAX,
  WA_NAME_PATTERN,
  WA_PROMO_FIELDS,
  WA_WORST_CASE_LENGTH,
  buttonUrlFor,
  normText,
  type MetaButton,
  type WaCompiled,
  type WaSource,
  type WaUse,
} from './template';

export const WA_CHECKS_VERSION = 'wa-checks@1';
/** Meta's limit on template creations per WhatsApp Business Account and hour. */
export const META_CREATES_PER_HOUR = 100;

export interface PoolInfo {
  journeyKey: string;
  poolKey: string;
  purpose: 'marketing' | 'service';
  /** The message's rule (the pool's `whatsappCategory`), null when the pool can't go by WhatsApp. */
  whatsappCategory: 'marketing' | 'utility' | null;
  /** Body fields this message may use (its wording's fields ∩ WA_BODY_FIELDS, plus the venue and first name). */
  allowedFields: string[];
  /** The link its wording carries (what the button should open), or null when it has none. */
  linkField: string | null;
}

export interface SiblingInfo {
  id: string;
  name: string;
  language: string;
  /** Meta's category when it has one, else the one we asked for. */
  category: string | null;
  bodyNorm: string;
  dismissed: boolean;
  /**
   * Counts for duplicates and the one-category rule: a template Meta holds (not deleted) or a draft
   * that can still go (not dismissed, not name-locked). Defaults to true.
   */
  active?: boolean;
}

export interface CheckContext {
  visitorBaseUrl: string;
  /** services/optOut.ts STOP_KEYWORDS (what the inbound handler understands). */
  optOutKeywords: readonly string[];
  /** The STOP line per language (send/compose.ts STOP_LINES) — suggested as the footer. */
  footers: Readonly<Record<Lang, string>>;
  /** The message this template is for (adaptive use), or null. */
  pool: PoolInfo | null;
  /** Every other template in the registry. */
  siblings: SiblingInfo[];
  /** Templates at Meta now (null: unknown — no complete sync yet), and the limit. */
  templateCount: number | null;
  templateLimit: number;
  createsThisHour: number;
}

export interface DraftForCheck {
  id: string | null;
  name: string;
  lang: Lang | null;
  requestedCategory: string | null;
  use: WaUse | null;
  source: WaSource;
  compiled: WaCompiled;
  /** Already at Meta (submitted): no create is needed (T16/T22 don't apply). */
  atMeta: boolean;
  /** The last submit failed because Meta still holds this name and language for deletion. */
  nameLocked: boolean;
}

// ── Word lists ───────────────────────────────────────────────────────────────

/** Words that read as promotion (Meta files a "utility" template carrying them as marketing). Lower case. */
const PROMO_WORDS: Readonly<Record<Lang, readonly string[]>> = {
  en: ['free', 'discount', 'offer', 'deal', 'sale', 'promo', 'promotion', 'coupon', 'voucher', 'gift', 'exclusive', 'limited time', 'special', 'treat', 'come back', 'visit again', 'book now', "don't miss", 'hurry', 'last chance', 'bonus', 'reward', 'win', 'save'],
  de: ['gratis', 'kostenlos', 'rabatt', 'angebot', 'aktion', 'sparen', 'gutschein', 'geschenk', 'exklusiv', 'nur noch', 'letzte chance', 'komm wieder', 'besuch uns wieder', 'jetzt buchen', 'verpasse nicht', 'bonus', 'belohnung', 'aufs haus', 'überraschung'],
  fr: ['gratuit', 'offert', 'offerte', 'réduction', 'remise', 'promo', 'promotion', 'offre', "bon d'achat", 'cadeau', 'exclusif', 'dernière chance', 'revenez', 'réservez', 'bonus', 'récompense', 'soldes'],
  it: ['gratis', 'gratuito', 'omaggio', 'sconto', 'offerta', 'promo', 'promozione', 'buono', 'regalo', 'esclusivo', 'ultima occasione', 'torna a trovarci', 'prenota', 'bonus', 'premio', 'saldi'],
};

/** Every language's list (a German word in an English template is still promotion). */
const ALL_PROMO = [...new Set(Object.values(PROMO_WORDS).flat())];

function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

export function promoWordsIn(text: string): string[] {
  const found = ALL_PROMO.filter((w) => hasWord(text, w));
  if (/\d\s?%/.test(text)) found.push('%');
  return found;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ch|de|net|org|app|io|to|ly|me|info|co|it|fr|at)\b)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/g;

/** A phone number: 9+ digits in a run — after dates (31.12.2026) and times / time ranges (7.00 - 10.30) are taken out. */
function hasPhone(text: string): boolean {
  const cleaned = text
    .replace(/\b\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}[.:]\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\.\d{1,2}\.(\d{2,4})?/g, ' ')
    .replace(/\b\d{1,2}[.:]\d{2}\b/g, ' ');
  return [...cleaned.matchAll(PHONE_LIKE)].some((m) => (m[0].match(/\d/g) ?? []).length >= 9);
}

function wordsOutsideVariables(bodyText: string): number {
  return bodyText
    .replace(/\{\{\s*\d+\s*\}\}/g, ' ')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w)).length;
}

function stopWordIn(text: string, keywords: readonly string[]): string | null {
  for (const k of keywords) {
    if (new RegExp(`(^|[^A-Za-z])${k}($|[^A-Za-z])`).test(text)) return k;
  }
  return null;
}

// ── The checks ───────────────────────────────────────────────────────────────

const WANTS: Record<'marketing' | 'utility', 'MARKETING' | 'UTILITY'> = { marketing: 'MARKETING', utility: 'UTILITY' };

/** All checks of a draft (or of one of ours already at Meta, from its stored text). */
export function checkWhatsAppTemplate(d: DraftForCheck, ctx: CheckContext): ValidationReport {
  const issues: Issue[] = [];
  const { source, compiled } = d;
  const adaptive = d.use?.kind === 'adaptive';

  // T01–T03 name, language, category asked
  if (!WA_NAME_PATTERN.test(d.name)) issues.push(error('T01', 'The name may only use a–z, 0–9 and _ (at most 512 characters)', 'name'));
  if (!d.lang) issues.push(error('T02', 'The language must be English, German, French or Italian', 'lang'));
  if (d.requestedCategory !== 'MARKETING' && d.requestedCategory !== 'UTILITY') {
    issues.push(error('T03', 'Choose Marketing or Utility (authentication templates are Meta’s own OTP format)', 'category'));
  }

  // T04 the message's rule
  if (adaptive) {
    if (!ctx.pool || !ctx.pool.whatsappCategory) {
      issues.push(error('T04', 'This message can’t go by WhatsApp (its journey doesn’t allow it)', 'use'));
    } else if (d.requestedCategory && d.requestedCategory !== WANTS[ctx.pool.whatsappCategory]) {
      issues.push(
        error(
          'T04',
          ctx.pool.whatsappCategory === 'marketing'
            ? 'This message is marketing by our rules (offers, review asks, tips): it must be filed as Marketing'
            : 'This message is a service message by our rules: it must be filed as Utility',
          'category',
        ),
      );
    }
  }

  // T05 one category per name
  const mine = d.requestedCategory;
  const otherLangs = ctx.siblings.filter((s) => s.id !== d.id && s.name === d.name && s.language !== (d.lang ?? '') && !s.dismissed && s.active !== false);
  // Drafts only: a draft must never make a template already at Meta look broken (and unusable).
  const clash = d.atMeta ? undefined : otherLangs.find((s) => s.category && mine && s.category !== mine);
  if (clash) issues.push(error('T05', `Every language of “${d.name}” must have the same category (${clash.language} is ${clash.category})`, 'category'));

  // T06 body length (as written, and in the worst case once values are filled in)
  if (compiled.bodyText.length > WA_BODY_MAX) {
    issues.push(error('T06', `The text is ${compiled.bodyText.length} characters; Meta allows ${WA_BODY_MAX}`, 'source.body'));
  } else {
    const worst = compiled.params.reduce(
      (len, p) => len - `{{${p.n}}}`.length * countOf(compiled.bodyText, `{{${p.n}}}`) + (WA_WORST_CASE_LENGTH[p.field] ?? 40) * countOf(compiled.bodyText, `{{${p.n}}}`),
      compiled.bodyText.length,
    );
    if (worst > WA_BODY_MAX) issues.push(warning('T06', `With long values (a long venue name, offer…) the message could reach ${worst} characters; Meta refuses more than ${WA_BODY_MAX}`, 'source.body'));
  }

  // T07 footer length — and fixed text only (Meta takes no field and no line break in a footer)
  if (compiled.footerText && compiled.footerText.length > WA_FOOTER_MAX) {
    issues.push(error('T07', `The footer is ${compiled.footerText.length} characters; Meta allows ${WA_FOOTER_MAX}`, 'source.footer'));
  }
  if (compiled.footerText && /\{\{|\}\}|\n/.test(compiled.footerText)) issues.push(error('T07', 'The footer can’t hold a {{ … }} field or a line break', 'source.footer'));

  // T08 fields: known, allowed for this message, used once; braces well formed
  const exprs = parseMergeExpressions(source.body);
  const opened = (source.body.match(/\{\{/g) ?? []).length;
  const closed = (source.body.match(/\}\}/g) ?? []).length;
  if (opened !== exprs.length || closed !== exprs.length) {
    issues.push(error('T08', 'Some {{ … }} are not well formed (use the Insert menu, e.g. {{venue.name}})', 'source.body'));
  }
  const allowed = new Set(ctx.pool ? ctx.pool.allowedFields : WA_BODY_FIELDS);
  const seen = new Map<string, number>();
  for (const e of exprs) {
    const field = canonicalField(e.name);
    seen.set(field, (seen.get(field) ?? 0) + 1);
    if (field.startsWith('link.')) issues.push(error('T08', `Links go only through the button, not in the text ({{${field}}})`, 'source.body'));
    else if (field.startsWith('guestinfo.secret.')) issues.push(error('T08', `Secrets never go in a WhatsApp template ({{${field}}})`, 'source.body'));
    else if (!(WA_BODY_FIELDS as readonly string[]).includes(field)) issues.push(error('T08', `{{${field}}} can’t be used in WhatsApp (links, multi-line text and unknown fields can’t)`, 'source.body'));
    else if (!allowed.has(field)) issues.push(error('T08', `This message has no {{${field}}}`, 'source.body'));
  }
  for (const [field, n] of seen) if (n > 1) issues.push(error('T08', `{{${field}}} is used ${n} times; use each field once`, 'source.body'));

  // T09 placement
  const body = compiled.bodyText.trim();
  if (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body)) {
    issues.push(error('T09', 'The text may not start or end with a {{ … }} field (Meta rejects it)', 'source.body'));
  }
  if (/\{\{\d+\}\}[\s\p{P}]*\{\{\d+\}\}/u.test(body)) issues.push(error('T09', 'Two {{ … }} fields may not stand side by side (Meta rejects it)', 'source.body'));

  // T10 density
  // Meta's exact ratio is unpublished: under 2 words a field is an error, under 3 a warning (Auto, W2, won't send it).
  if (compiled.params.length) {
    const words = wordsOutsideVariables(compiled.bodyText);
    if (words < 2 * compiled.params.length) {
      issues.push(error('T10', `Too few words for ${compiled.params.length} fields (${words}); Meta rejects templates that are mostly fields`, 'source.body'));
    } else if (words < 3 * compiled.params.length) {
      issues.push(warning('T10', `Few words for ${compiled.params.length} fields (${words}); Meta may reject it as mostly fields`, 'source.body'));
    }
  }

  // T11 fallbacks and date formats (Meta refuses an empty value at send time)
  for (const p of compiled.params) {
    if (!WA_ALWAYS_PRESENT.has(p.field) && !p.fallback) {
      issues.push(error('T11', `{{${p.field}}} needs a default for guests without one, e.g. {{${p.field} | default:"…"}}`, 'source.body'));
    }
    if (WA_DATE_FIELDS.has(p.field) && !p.date) issues.push(error('T11', `{{${p.field}}} needs a date format, e.g. {{${p.field} | date:"d.M."}}`, 'source.body'));
  }

  // T12 the button
  if (source.button) {
    if (!(WA_BUTTON_FIELDS as readonly string[]).includes(source.button.field)) issues.push(error('T12', 'The button must open the offer, rating, info or booking page', 'source.button'));
    if (source.button.text.length > WA_BUTTON_TEXT_MAX) issues.push(error('T12', `The button text is ${source.button.text.length} characters; Meta allows ${WA_BUTTON_TEXT_MAX}`, 'source.button.text'));
    if (/\{\{|\}\}|\n/.test(source.button.text)) issues.push(error('T12', 'The button text can’t hold a {{ … }} field or a line break', 'source.button.text'));
    if (!/^https:\/\//.test(ctx.visitorBaseUrl)) issues.push(error('T12', 'The visitor link base must be https (VISITOR_BASE_URL)', 'source.button'));
    if (ctx.pool && ctx.pool.linkField && source.button.field !== ctx.pool.linkField) {
      issues.push(warning('T12', `This message usually opens {{${ctx.pool.linkField}}}; the button opens {{${source.button.field}}}`, 'source.button.field'));
    }
    if (ctx.pool && !ctx.pool.linkField) issues.push(warning('T12', 'This message has no page to open; a button is not needed', 'source.button'));
  } else if (ctx.pool?.linkField) {
    issues.push(warning('T12', `Guests get no link: add a button to {{${ctx.pool.linkField}}}`, 'source.button'));
  }

  // T13 names the venue (HeidiFi's one number sends for every venue)
  if (adaptive && !compiled.params.some((p) => p.field === 'venue.name')) {
    issues.push(error('T13', 'Name the venue ({{venue.name}}): guests see HeidiFi’s number, not the venue’s', 'source.body'));
  }

  // T14 no links, emails or phone numbers in the fixed text
  const fixed = compiled.bodyText.replace(/\{\{\d+\}\}/g, ' ');
  if (URL_LIKE.test(fixed)) issues.push(error('T14', 'No links or web addresses in the text: the button carries the link', 'source.body'));
  if (EMAIL_LIKE.test(fixed)) issues.push(error('T14', 'No email addresses in the text', 'source.body'));
  if (hasPhone(fixed)) issues.push(error('T14', 'No phone numbers in the text', 'source.body'));

  // T15 STOP text belongs in the footer
  const stopInBody = stopWordIn(compiled.bodyText, ctx.optOutKeywords);
  if (stopInBody) issues.push(error('T15', `“${stopInBody}” belongs in the footer, not the text`, 'source.body'));

  // T16 / T22 Meta's limits (only for a create)
  if (!d.atMeta) {
    if (ctx.templateCount !== null) {
      if (ctx.templateCount + 1 > ctx.templateLimit) issues.push(error('T16', `Meta holds ${ctx.templateCount} templates; the limit is ${ctx.templateLimit}`));
      else if (ctx.templateCount + 1 > ctx.templateLimit * 0.9) issues.push(warning('T16', `Nearly at Meta’s limit: ${ctx.templateCount} of ${ctx.templateLimit} templates`));
    }
    if (ctx.createsThisHour >= META_CREATES_PER_HOUR) issues.push(error('T22', `Meta allows ${META_CREATES_PER_HOUR} new templates an hour; try again in the next hour`));
  }

  // T17 name locked (Meta still deleting this name and language)
  if (d.nameLocked) issues.push(error('T17', 'Meta is still deleting a template with this name and language (about 30 days): copy it to a new name', 'name'));

  // T18 no duplicate text in the same language
  const myNorm = normText(compiled.bodyText);
  const dup = d.atMeta ? undefined : ctx.siblings.find((s) => s.id !== d.id && !s.dismissed && s.active !== false && s.language === (d.lang ?? '') && s.bodyNorm === myNorm);
  if (dup) issues.push(error('T18', `The same text already exists in this language (${dup.name}); Meta rejects duplicates`, 'source.body'));

  // T19 utility = no promotion
  if (d.requestedCategory === 'UTILITY') {
    const promo = promoWordsIn(`${compiled.bodyText} ${compiled.footerText ?? ''} ${compiled.button?.text ?? ''}`);
    // A warning, not an error: "feel free to ask" is a normal service sentence. It keeps Auto (W2) from sending it.
    if (promo.length) issues.push(warning('T19', `Words that can read as promotion in a utility template (${promo.slice(0, 4).join(', ')}): Meta may file it as marketing`, 'source.body'));
    const promoFields = compiled.params.filter((p) => WA_PROMO_FIELDS.has(p.field)).map((p) => p.field);
    if (promoFields.length) issues.push(error('T19', `Offer fields in a utility template (${promoFields.join(', ')})`, 'source.body'));
    if (EMOJI.test(compiled.bodyText)) issues.push(warning('T19', 'Emoji make a utility template read as promotion', 'source.body'));
  }

  // T20 the STOP footer (marketing needs one; utility should have none)
  if (d.requestedCategory === 'MARKETING') {
    const suggestion = d.lang ? ctx.footers[d.lang] : ctx.footers.en;
    if (!compiled.footerText) issues.push(error('T20', `Marketing templates need a STOP footer, e.g. “${suggestion}”`, 'source.footer'));
    else if (!stopWordIn(compiled.footerText, ctx.optOutKeywords)) {
      issues.push(error('T20', `The footer must contain STOP (the word guests reply), e.g. “${suggestion}”`, 'source.footer'));
    }
  } else if (d.requestedCategory === 'UTILITY' && compiled.footerText) {
    issues.push(warning('T20', 'An opt-out footer on a utility template nudges Meta to file it as marketing', 'source.footer'));
  }

  // T21 formatting Meta refuses
  if (/\t/.test(compiled.bodyText)) issues.push(error('T21', 'No tabs in the text', 'source.body'));
  if (/\n\s*\n\s*\n/.test(compiled.bodyText)) issues.push(error('T21', 'At most one empty line in a row', 'source.body'));
  if (/ {4,}/.test(compiled.bodyText)) issues.push(error('T21', 'No runs of 4 or more spaces', 'source.body'));

  return makeReport(issues);
}

/**
 * Checks for an imported template we don't edit (legacy, OTP, not linked yet): its button link and
 * its name. A legacy button with anything but the bare host before the variable is what broke
 * `heidifi_visit_feedback`.
 */
export function checkImportedTemplate(t: { name: string; buttons: MetaButton[]; use: WaUse | null }, ctx: { visitorBaseUrl: string }): ValidationReport {
  const issues: Issue[] = [];
  if (t.use?.kind === 'otp') {
    issues.push(info('T00', 'The guest-login code template: managed by Meta’s OTP format, shown here only'));
    return makeReport(issues);
  }
  if (!WA_NAME_PATTERN.test(t.name)) issues.push(warning('T01', 'Not a name we would create (a–z, 0–9, _)'));
  const urlButtons = t.buttons.filter((b) => b.type === 'URL');
  if (urlButtons.length > 1) issues.push(warning('T12', 'More than one link button: our sender fills only the first'));
  for (const b of urlButtons) {
    const url = b.url ?? '';
    if (!/\{\{\s*1\s*\}\}/.test(url)) continue; // a fixed link: nothing to fill in
    const want = buttonUrlFor(ctx.visitorBaseUrl);
    if (url !== want) {
      issues.push(error('T12', `The button link is registered as “${url}”; it must be exactly “${want}” or guests get a broken link (fix it in WhatsApp Manager)`));
    }
  }
  if (t.use?.kind !== 'adaptive') issues.push(info('T00', 'Used by the old Campaign Manager / venue automations, or not linked to an Adaptive message yet'));
  return makeReport(issues);
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export type { Issue, ValidationReport };
