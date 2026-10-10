/**
 * The AI template writer's pure core (PR W2): what the model is given, how its answer is checked
 * and turned into our text, and which coverage cells still need one. Pure: no Firestore, no model,
 * no env — the API builds the brief from the catalogue and the registry, the worker applies the
 * answer (whatsapp/aiDrafts.ts), and both call these.
 *
 *  - The brief (what the model sees) has no personal data: the message's purpose and rule, the
 *    fields it may use and what they mean, today's SMS/email wording of that message (links and
 *    fields WhatsApp can't carry taken out; any text with contact data left out entirely), the
 *    other templates' bodies, the English template for a translation, Meta's reason for a fix.
 *  - The local part (never shown to the model) carries what the checks need — the check context
 *    as the API saw it, the target template and its version — and travels on the run.
 *  - An answer is rejected (never written) when it asks for another category or language, misses
 *    the link button the message needs, carries contact data, a promotional word in a service
 *    message, a duplicate — or fails any template check (T01–T22). For the daily gap-fill and the
 *    AI fixes a warning rejects it too (WW08): Auto (W2b) never sends a draft with a warning, so
 *    such a draft would fill its cell and stall it.
 *
 *  WW01 category ≠ the message's rule   WW06 promotion in a service message (T19 is only a warning)
 *  WW02 language ≠ the one asked (also   WW07 the same text as another template of the message, or
 *       the text's own words; German: ss)      as the one it fixes / the English one it translates
 *  WW05 contact data in the answer      WW08 a warning (gap-fill and AI fixes)
 *  WW09 no button text where the message's link needs one
 *  WW10 a number, price or percentage the brief doesn't give (in the text, a default or the button)
 *  WW11 a default left as "…", or a first-name default in another language
 *  (a field not allowed, no venue name, a link in the text: the template checks T08, T13, T14)
 */

import { z } from 'zod';
import { LANGS, type Lang } from '../constants';
import { checkWhatsAppTemplate, promoWordsFor, promoWordsIn, type CheckContext, type PoolInfo, type SiblingInfo } from './checks';
import { canonicalField } from '../registry/mergeFields';
import { compileTemplate, normText, WA_BUTTON_FIELDS, WA_DATE_FIELDS, WA_REQUESTABLE, type WaButtonField, type WaRequestable, type WaSource } from './template';
import type { WaDisplay } from './status';

export const WRITER_KINDS = ['new', 'translation', 'alternative', 'fix'] as const;
export type WriterKind = (typeof WRITER_KINDS)[number];
export const WRITER_REQUESTERS = ['suggest', 'gap_fill', 'auto_fix'] as const;
export type WriterRequester = (typeof WRITER_REQUESTERS)[number];

/** A coverage cell: one message × one language. */
export const cellKeyOf = (journeyKey: string, poolKey: string, lang: Lang) => `${journeyKey}:${poolKey}:${lang}`;

const LANG_NAME: Record<Lang, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian' };

/** How each language addresses the guest (the seed's German uses "du" everywhere). */
export const WRITER_TONE: Record<Lang, string> = {
  en: 'Friendly and short, plain English.',
  de: 'Informal "du" (as the venue’s own German wording does), Swiss spelling: "ss" instead of "ß", "innert" for "within".',
  fr: 'Polite "vous", warm and short.',
  it: 'Informal "tu", warm and short.',
};

/** What each field means, for the model (merge fields are filled per guest at send time). */
export const WA_FIELD_MEANINGS: Readonly<Record<string, string>> = {
  'contact.firstName': 'The guest’s first name (often unknown: it then shows the default).',
  'venue.name': 'The venue’s name (always known: no default needed).',
  'offer.label': 'What the offer is, e.g. a dessert on the house.',
  'offer.days': 'How many days the offer is valid.',
  'offer.expiryDate': 'The last day the offer is valid (a date).',
  'guestinfo.wifiName': 'The name of the venue’s guest Wi-Fi.',
  'guestinfo.checkInTime': 'The check-in time.',
  'guestinfo.checkOutTime': 'The check-out time.',
  'guestinfo.openingHours': 'The opening hours.',
  'stay.checkInDate': 'The guest’s check-in date.',
  'stay.checkOutDate': 'The guest’s check-out date.',
  'stay.nights': 'How many nights the guest stays.',
};

/** What the button opens (the link travels only in the button, never in the text). */
export const WA_LINK_MEANINGS: Readonly<Record<WaButtonField, string>> = {
  'link.offer': 'the guest’s offer page',
  'link.rating': 'the page where the guest rates the visit',
  'link.hub': 'the venue’s guest info page (Wi-Fi, house info)',
  'link.booking': 'the venue’s direct booking page',
};

/** The first-name default per language (the cms editor's Insert menu uses the same). */
export const FIRST_NAME_DEFAULT: Record<Lang, string> = { en: 'there', de: 'du', fr: 'à vous', it: 'a te' };

/** How the model writes a field: the exact syntax, with a default (and a date format) where needed. */
export function fieldSyntax(field: string, lang: Lang): string {
  if (field === 'venue.name') return '{{venue.name}}';
  if (field === 'contact.firstName') return `{{contact.firstName | default:"${FIRST_NAME_DEFAULT[lang]}"}}`;
  if (WA_DATE_FIELDS.has(field)) return `{{${field} | date:"d.M." | default:"…"}}`;
  return `{{${field} | default:"…"}}`;
}

// ── The brief (what the model sees) and the local part (what it doesn't) ─────

export interface WriterBrief {
  task: WriterKind;
  language: Lang;
  languageName: string;
  tone: string;
  /** The category the template must have (the message's rule). */
  category: WaRequestable;
  message: { journey: string; name: string; purpose: 'marketing' | 'service' };
  fields: Array<{ field: string; meaning: string; write: string }>;
  /** The button (one link, chosen by us): what it opens. Null: no button. */
  button: { opens: string } | null;
  /** Today's wording of this message (SMS / email), in any language we have it in. */
  wording: Array<{ language: Lang; channel: 'sms' | 'email'; text: string }>;
  /** The bodies of the other templates of this message in this language (never repeat one). */
  existingBodies: string[];
  /** For a translation: the English template it translates. */
  english: { body: string; buttonText: string | null } | null;
  /** For a fix: the template Meta rejected and why. */
  current: { body: string; buttonText: string | null } | null;
  rejection: { reason: string; words: string } | null;
  limits: { bodyCharacters: number; buttonCharacters: number };
  /** A service (UTILITY) message: words that read as promotion — never use them (else empty). */
  avoidWords: string[];
}

export interface WriterLocal {
  use: { journeyKey: string; poolKey: string };
  lang: Lang;
  kind: WriterKind;
  requestedBy: WriterRequester;
  /** fix: the template to edit; translation: the English template. */
  targetTemplateId: string | null;
  /** fix: the version the fix was written against (compare-and-set). */
  targetVersion: number | null;
  /** translation: the name the new language goes under. */
  existingName: string | null;
  /** The check context as the API saw it (no Meta limits: they never reject a run). */
  checkCtx: CheckContext;
  /** Texts left out of the brief because they held contact data. */
  withheld: number;
}

export const writerAnswerSchema = z
  .object({
    reasoning: z.string().min(1).max(1200),
    language: z.enum(LANGS),
    body: z.string().min(1).max(1600),
    buttonText: z.string().min(1).max(25).nullable(),
    category: z.enum(WA_REQUESTABLE),
    categoryReason: z.string().min(1).max(300),
  })
  .strict();
export type WriterAnswer = z.infer<typeof writerAnswerSchema>;

const poolInfoSchema = z.object({
  journeyKey: z.string(),
  poolKey: z.string(),
  purpose: z.enum(['marketing', 'service']),
  whatsappCategory: z.enum(['marketing', 'utility']).nullable(),
  allowedFields: z.array(z.string()),
  linkField: z.string().nullable(),
});
const siblingSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string().nullable(),
  bodyNorm: z.string(),
  dismissed: z.boolean(),
  active: z.boolean().optional(),
});
const checkCtxSchema = z.object({
  visitorBaseUrl: z.string().min(1),
  optOutKeywords: z.array(z.string()),
  footers: z.record(z.string(), z.string()),
  pool: poolInfoSchema.nullable(),
  siblings: z.array(siblingSchema),
  templateCount: z.number().nullable(),
  templateLimit: z.number(),
  createsThisHour: z.number(),
});
export const writerLocalSchema = z.object({
  use: z.object({ journeyKey: z.string().min(1).max(64), poolKey: z.string().min(1).max(64) }),
  lang: z.enum(LANGS),
  kind: z.enum(WRITER_KINDS),
  requestedBy: z.enum(WRITER_REQUESTERS),
  targetTemplateId: z.string().nullable(),
  targetVersion: z.number().int().nullable(),
  existingName: z.string().nullable(),
  checkCtx: checkCtxSchema,
  withheld: z.number().int().min(0),
});
/** The task params of a writer run: the brief and the local part (validated again in the worker). */
export const writerParamsSchema = z.object({ brief: z.record(z.string(), z.unknown()), local: writerLocalSchema });

/** The task params, checked (a run whose params don't read is skipped, never guessed). */
export function parseWriterParams(params: Record<string, unknown>): { brief: WriterBrief; local: WriterLocal } | null {
  const p = writerParamsSchema.safeParse(params);
  if (!p.success) return null;
  return { brief: p.data.brief as unknown as WriterBrief, local: p.data.local as unknown as WriterLocal };
}

// ── Building a request ───────────────────────────────────────────────────────

/** A template of the message, as the brief and the gap rules need it. */
export interface WriterTemplateView {
  id: string;
  name: string;
  lang: Lang | null;
  origin: 'imported' | 'manual' | 'ai';
  display: WaDisplay;
  dismissed: boolean;
  version: number;
  stage: 'draft' | 'submitting' | 'submitted';
  metaStatus: string | null;
  rejectedReason: string | null;
  /** Our text (null for an imported template not linked). */
  source: WaSource | null;
  /** When the display last changed (Meta's last change, else the doc's), real ms. */
  changedAtMs: number;
  /** AI fixes made on it so far. */
  aiFixes: number;
  /** origin 'ai' and dismissed: when (real ms), for the gap cooldown. */
  dismissedAtMs: number | null;
  /** The category it has: Meta's once Meta filed it, else the one asked for (null: unknown). */
  category: string | null;
  /** PR W2b: the AI fixed it and the fix hasn't been to Meta yet (aiFixUnsentOf). */
  aiFixUnsent?: boolean;
}

/** PR W2b: submit errors that only say Meta was unreachable or busy (nothing of the text was judged). */
export const TRANSIENT_SUBMIT_ERRORS: ReadonlySet<string> = new Set(['rate_limited', 'unavailable', 'unknown', 'unknown_outcome']);
/** PR W2b: submit errors about the account (the token, its permission, the account gone) — never about the text. */
export const ACCOUNT_SUBMIT_ERRORS: ReadonlySet<string> = new Set(['setup', 'permission', 'not_found']);

/**
 * PR W2b: the AI fixed a template and the fix hasn't been to Meta yet (a second fix would answer the
 * same rejection). `ai.sentVersion` is the version Meta last saw (stamped when a submit starts, put
 * back when it never reached Meta or Meta was only unreachable). A template fixed before W2b (no
 * `sentVersion` at all) falls back on Meta's change time: Meta's last word older than the fix.
 */
export function aiFixUnsentOf(
  ai: { kind: string; appliedVersion: number; atMs: number | null; sentVersion?: number | null } | null,
  version: number,
  metaChangedAtMs: number | null,
): boolean {
  if (!ai || ai.kind !== 'fix' || ai.appliedVersion !== version) return false;
  if (ai.sentVersion !== undefined) return ai.sentVersion !== version;
  return !(metaChangedAtMs !== null && ai.atMs !== null && metaChangedAtMs > ai.atMs);
}

export interface WriterRequestInput {
  kind: WriterKind;
  requestedBy: WriterRequester;
  lang: Lang;
  pool: PoolInfo & { journeyName: string; poolName: string; availability: 'available' | 'coming_soon' };
  /** Every template of this message (all languages, dismissed too). */
  templates: WriterTemplateView[];
  /** fix: the template to fix; translation: the English template (else the best English one is found). */
  targetTemplateId?: string | null;
  /** Today's wording per language (SMS text, email subject and body), from the catalogue. */
  wording: Partial<Record<Lang, { sms?: string | null; email?: string | null }>>;
  /** The check context without Meta's limits (templateCount null, createsThisHour 0). */
  checkCtx: CheckContext;
  /** True when a text holds contact data (brain/privacy.ts): such texts are left out of the brief. */
  hasContactData: (text: string) => boolean;
  rejectionWords: (code: string | null) => string;
}

export type WriterRefusal =
  | 'no_message'
  | 'english_missing'
  | 'not_rejected'
  | 'not_ours'
  | 'language_exists'
  | 'no_target'
  | 'fix_limit'
  | 'other_language'
  | 'fix_unsent';

const WANTS: Record<'marketing' | 'utility', WaRequestable> = { marketing: 'MARKETING', utility: 'UTILITY' };

/** The category a message's templates must have (its rule), or null when it can't go by WhatsApp. */
export function wantedCategory(pool: Pick<PoolInfo, 'whatsappCategory'>): WaRequestable | null {
  return pool.whatsappCategory ? WANTS[pool.whatsappCategory] : null;
}

const DROPPED = '\u0000';

/**
 * Today's wording as the model may see it: the fields WhatsApp can carry for this message (by their
 * canonical names — an old alias such as {{firstName}} counts), links taken out (the button carries
 * the link), and any sentence that held another field left out whole (never a fragment such as
 * "Late check-out until 14:00 is CHF."). Exported for the tests.
 */
export function cleanText(text: string, allowed: ReadonlySet<string>): string {
  const marked = text.replace(/<[^>]+>/g, ' ').replace(/\{\{\s*([a-zA-Z0-9_.]+)([^}]*)\}\}/g, (_all, name: string, rest: string) => {
    const f = canonicalField(name);
    if (allowed.has(f)) return `{{${f}${rest}}}`;
    return f.startsWith('link.') ? '' : DROPPED;
  });
  const lines = marked.split(/\r?\n/).map((line) =>
    line
      .split(/(?<=[.!?…])\s+/)
      .filter((sentence) => !sentence.includes(DROPPED))
      .join(' ')
      .replace(/[ \t]+([.,!?:;])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s*[:\-–]\s*$/g, '')
      .trim(),
  );
  return lines
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, 1500);
}

const SOURCE_ORDER: Partial<Record<WaDisplay, number>> = { approved: 1, in_review: 2, submitting: 3, ready: 4, needs_fix: 5 };

/**
 * An English template a translation can be written from: ours, with text, not dismissed, alive —
 * and with the message's category (all languages of a name share one category, T05: an English
 * template Meta filed under another category could never get a translation that passes).
 */
export function isEnglishSource(t: WriterTemplateView, wanted: WaRequestable | null): boolean {
  return t.lang === 'en' && Boolean(t.source) && !t.dismissed && SOURCE_ORDER[t.display] !== undefined && (!wanted || !t.category || t.category === wanted);
}

/** The English template a translation is written from: the best state first. */
export function englishSourceFor(templates: WriterTemplateView[], wanted: WaRequestable | null = null): WriterTemplateView | null {
  return templates.filter((t) => isEnglishSource(t, wanted)).sort((a, b) => (SOURCE_ORDER[a.display] ?? 9) - (SOURCE_ORDER[b.display] ?? 9))[0] ?? null;
}

export function buildWriterRequest(i: WriterRequestInput): { brief: WriterBrief; local: WriterLocal } | { refuse: WriterRefusal } {
  const pool = i.pool;
  if (!pool.whatsappCategory) return { refuse: 'no_message' };
  const category = WANTS[pool.whatsappCategory];
  const allowed = new Set(pool.allowedFields);
  let withheld = 0;
  const clean = (text: string | null | undefined): string | null => {
    if (!text || !text.trim()) return null;
    if (i.hasContactData(text)) {
      withheld += 1;
      return null;
    }
    const c = cleanText(text, allowed);
    return c || null;
  };

  let english: WriterBrief['english'] = null;
  let current: WriterBrief['current'] = null;
  let rejection: WriterBrief['rejection'] = null;
  let targetTemplateId: string | null = null;
  let targetVersion: number | null = null;
  let existingName: string | null = null;

  if (i.kind === 'translation') {
    if (i.lang === 'en') return { refuse: 'english_missing' };
    const en = i.targetTemplateId ? i.templates.find((t) => t.id === i.targetTemplateId && isEnglishSource(t, category)) ?? null : englishSourceFor(i.templates, category);
    if (!en || !en.source) return { refuse: 'english_missing' };
    if (i.templates.some((t) => t.name === en.name && t.lang === i.lang)) return { refuse: 'language_exists' };
    const body = clean(en.source.body);
    if (!body) return { refuse: 'english_missing' };
    english = { body, buttonText: en.source.button?.text ?? null };
    targetTemplateId = en.id;
    existingName = en.name;
  } else if (i.kind === 'fix') {
    const t = i.targetTemplateId ? i.templates.find((x) => x.id === i.targetTemplateId) ?? null : null;
    if (!t) return { refuse: 'no_target' };
    if (t.lang !== i.lang) return { refuse: 'other_language' };
    if (!t.source) return { refuse: 'not_ours' };
    const status = String(t.metaStatus ?? '').toUpperCase();
    if (t.stage !== 'submitted' || (status !== 'REJECTED' && status !== 'PAUSED')) return { refuse: 'not_rejected' };
    if (t.aiFixes >= MAX_AI_FIXES) return { refuse: 'fix_limit' };
    if (t.aiFixUnsent) return { refuse: 'fix_unsent' };
    const body = clean(t.source.body);
    if (!body) return { refuse: 'not_ours' };
    current = { body, buttonText: t.source.button?.text ?? null };
    rejection = { reason: t.rejectedReason ?? status, words: i.rejectionWords(t.rejectedReason) };
    targetTemplateId = t.id;
    targetVersion = t.version;
    existingName = t.name;
  }

  const wording: WriterBrief['wording'] = [];
  // The asked language first, then English and German (the seed has wording in those two).
  const langs = [i.lang, ...(['en', 'de', 'fr', 'it'] as Lang[]).filter((l) => l !== i.lang)];
  for (const l of langs) {
    const w = i.wording[l];
    if (!w) continue;
    const sms = clean(w.sms);
    if (sms) wording.push({ language: l, channel: 'sms', text: sms });
    const email = clean(w.email);
    if (email) wording.push({ language: l, channel: 'email', text: email });
    if (wording.length >= 6) break;
  }

  const existingBodies: string[] = [];
  for (const t of i.templates) {
    if (t.lang !== i.lang || !t.source || t.id === targetTemplateId) continue;
    const b = clean(t.source.body);
    if (b) existingBodies.push(b);
  }

  const link = (WA_BUTTON_FIELDS as readonly string[]).includes(pool.linkField ?? '') ? (pool.linkField as WaButtonField) : null;
  const brief: WriterBrief = {
    task: i.kind,
    language: i.lang,
    languageName: LANG_NAME[i.lang],
    tone: WRITER_TONE[i.lang],
    category,
    message: { journey: pool.journeyName, name: pool.poolName, purpose: pool.purpose },
    fields: pool.allowedFields.filter((f) => WA_FIELD_MEANINGS[f]).map((f) => ({ field: f, meaning: WA_FIELD_MEANINGS[f], write: fieldSyntax(f, i.lang) })),
    button: link ? { opens: WA_LINK_MEANINGS[link] } : null,
    wording,
    existingBodies: existingBodies.slice(0, 10),
    english,
    current,
    rejection,
    limits: { bodyCharacters: 1024, buttonCharacters: 25 },
    avoidWords: category === 'UTILITY' ? promoWordsFor(i.lang) : [],
  };
  const local: WriterLocal = {
    use: { journeyKey: pool.journeyKey, poolKey: pool.poolKey },
    lang: i.lang,
    kind: i.kind,
    requestedBy: i.requestedBy,
    targetTemplateId,
    targetVersion,
    existingName,
    checkCtx: { ...i.checkCtx, templateCount: null, createsThisHour: 0 },
    withheld,
  };
  return { brief, local };
}

// ── The answer ───────────────────────────────────────────────────────────────

/** Our text from an answer: the STOP footer for marketing, the button to the message's link. */
export function sourceFromAnswer(out: WriterAnswer, local: WriterLocal): WaSource {
  const pool = local.checkCtx.pool;
  const link = pool && (WA_BUTTON_FIELDS as readonly string[]).includes(pool.linkField ?? '') ? (pool.linkField as WaButtonField) : null;
  return {
    body: out.body.trim(),
    footer: out.category === 'MARKETING' ? local.checkCtx.footers[local.lang] ?? null : null,
    button: link && out.buttonText ? { text: out.buttonText.trim(), field: link } : null,
  };
}

export interface WriterCheck {
  code: string;
  ok: boolean;
  detail: string;
}

// ── Content guards (what Meta never checks: the venue's facts, the defaults guests see) ──

/** Short words that mark a language (a text written in another language than asked shows them). */
const FUNCTION_WORDS: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['the', 'and', 'you', 'your', 'to', 'for', 'of', 'is', 'we', 'with', 'our', 'are', 'this', 'have']),
  de: new Set(['und', 'du', 'dein', 'deine', 'dich', 'dir', 'der', 'das', 'ist', 'wir', 'bei', 'mit', 'für', 'auf', 'zu', 'dass']),
  fr: new Set(['le', 'la', 'les', 'et', 'vous', 'votre', 'vos', 'est', 'nous', 'pour', 'avec', 'chez', 'au', 'une']),
  it: new Set(['e', 'di', 'per', 'con', 'tuo', 'tua', 'che', 'siamo', 'grazie', 'ti', 'sei', 'una', 'del']),
};

/** The language another than `lang` the words clearly read as (null: none). */
export function readsAs(text: string, lang: Lang): Lang | null {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []) as string[];
  const count = (l: Lang) => words.filter((w) => FUNCTION_WORDS[l].has(w)).length;
  const asked = count(lang);
  for (const l of LANGS) {
    if (l === lang) continue;
    const n = count(l);
    if (n >= 3 && n >= 2 * Math.max(1, asked)) return l;
  }
  return null;
}

/** Numbers as written digits ("11:00" → 11, 0; "CHF 10" → 10). */
function digitsIn(text: string): string[] {
  return (text.match(/\d+/g) ?? []).map((d) => String(Number(d)));
}
/** A price or a rate, in any of our languages. */
const MONEY = /%|\bCHF\b|\bFr\.|\bSFr\b|€|\bEUR\b|\$|\bprozent\b|\bpercent\b|\bper\s?cent\b|\bpour\s?cent\b|\bper\s?cento\b/i;
const withoutFields = (text: string) => text.replace(/\{\{[^}]*\}\}/g, ' ');

/** A default a guest would see as a placeholder ("…", "...", only punctuation). */
const PLACEHOLDER = /^[\s.…·_\-–—*?!,;:'"]*$/u;

/** The name the checks see: the existing one (translation, fix) or a placeholder of this message. */
function provisionalName(local: WriterLocal): string {
  return local.existingName ?? `hf_${local.use.poolKey}_0`;
}

/**
 * Every check of an answer. Any `ok: false` rejects the run (its code is the run's reason): the
 * writer's own WW checks first, then the template checks' first error (under its T code).
 */
export function writerChecks(out: WriterAnswer, brief: WriterBrief, local: WriterLocal, hasContactData: (text: string) => boolean): WriterCheck[] {
  const checks: WriterCheck[] = [];
  const add = (code: string, ok: boolean, detail: string) => checks.push({ code, ok, detail });
  const pool = local.checkCtx.pool;
  add('WW01', out.category === brief.category, out.category === brief.category ? `Category ${out.category}, as the message’s rule` : `Asked for ${out.category}; this message is ${brief.category}`);
  // The language: as the answer says, as its own words read (a "translation" left in English), and
  // Swiss German spelling ("ss", never "ß").
  const ownWords = `${withoutFields(out.body)} ${out.buttonText ?? ''}`;
  const other = readsAs(ownWords, local.lang);
  const eszett = local.lang === 'de' && /ß/.test(ownWords);
  add(
    'WW02',
    out.language === local.lang && !other && !eszett,
    out.language !== local.lang
      ? `Written in ${out.language}, not ${local.lang}`
      : other
        ? `The text reads as ${LANG_NAME[other]}, not ${LANG_NAME[local.lang]}`
        : eszett
          ? 'Swiss German writes “ss”, never “ß”'
          : `Written in ${LANG_NAME[local.lang]}`,
  );
  const needsButton = Boolean(pool && (WA_BUTTON_FIELDS as readonly string[]).includes(pool.linkField ?? ''));
  add('WW09', !needsButton || Boolean(out.buttonText), needsButton ? (out.buttonText ? 'Has the button text the message’s link needs' : 'No button text, but this message’s link needs a button') : 'No button needed');
  const contact = [out.body, out.buttonText ?? '', out.reasoning, out.categoryReason].some((t) => hasContactData(t));
  add('WW05', !contact, contact ? 'The answer holds contact data (an email or phone number)' : 'No contact data');
  const promo = brief.category === 'UTILITY' ? promoWordsIn(out.body) : [];
  add('WW06', !promo.length, promo.length ? `A service message with promotion: ${promo.join(', ')}` : 'No promotion in a service message');
  const norm = normText(out.body);
  const dup = brief.existingBodies.some((b) => normText(b) === norm);
  // A fix that changes nothing (text and button), or a "translation" that is the English text.
  const sameFix = brief.current && normText(brief.current.body) === norm && normText(brief.current.buttonText ?? '') === normText(out.buttonText ?? '');
  const same = sameFix ? 'the template it fixes' : brief.english && normText(brief.english.body) === norm ? 'the English template' : null;
  add('WW07', !dup && !same, dup ? 'The same text as another template of this message' : same ? `The same text as ${same}` : 'Not a repeat');

  const source = sourceFromAnswer(out, local);
  const compiled = compileTemplate(source, { lang: local.lang, visitorBaseUrl: local.checkCtx.visitorBaseUrl });

  // WW10: every number, price and rate comes from the brief (today's wording, the English
  // template, the one being fixed) — never made up: a discount, a fee or a time the venue never
  // gave would reach every venue's guests. In the text, the defaults and the button text.
  const givenTexts = [...brief.wording.map((w) => w.text), brief.english?.body, brief.english?.buttonText, brief.current?.body, brief.current?.buttonText]
    .filter((t): t is string => typeof t === 'string')
    .map(withoutFields);
  const given = new Set(givenTexts.flatMap(digitsIn));
  const answerTexts = [compiled.bodyText.replace(/\{\{\d+\}\}/g, ' '), ...compiled.params.map((p) => p.fallback ?? ''), out.buttonText ?? ''];
  const madeUp = [...new Set(answerTexts.flatMap(digitsIn).filter((n) => !given.has(n)))];
  const money = answerTexts.some((t) => MONEY.test(t)) && !givenTexts.some((t) => MONEY.test(t));
  add(
    'WW10',
    !madeUp.length && !money,
    madeUp.length ? `Numbers the brief doesn’t give: ${madeUp.slice(0, 5).join(', ')}` : money ? 'A price or a percentage the brief doesn’t give' : 'No made-up numbers or prices',
  );

  // WW11: the defaults guests see when a value is missing (Meta never sees them).
  const otherNames = LANGS.filter((l) => l !== local.lang).map((l) => FIRST_NAME_DEFAULT[l].toLowerCase());
  const badDefault = compiled.params.find((p) => {
    if (p.fallback === null) return false;
    if (PLACEHOLDER.test(p.fallback)) return true;
    return p.field === 'contact.firstName' && otherNames.includes(p.fallback.trim().toLowerCase()) && p.fallback.trim().toLowerCase() !== FIRST_NAME_DEFAULT[local.lang].toLowerCase();
  });
  add(
    'WW11',
    !badDefault,
    badDefault
      ? PLACEHOLDER.test(badDefault.fallback ?? '')
        ? `The default of {{${badDefault.field}}} is a placeholder (“${badDefault.fallback}”)`
        : `The default of {{${badDefault.field}}} is in another language (“${badDefault.fallback}”)`
      : 'Every default reads well',
  );

  const report = checkWhatsAppTemplate(
    {
      id: local.kind === 'fix' ? local.targetTemplateId : null,
      name: provisionalName(local),
      lang: local.lang,
      requestedCategory: out.category,
      use: { kind: 'adaptive', ...local.use },
      source,
      compiled,
      atMeta: local.kind === 'fix',
      nameLocked: false,
    },
    local.checkCtx,
  );
  const firstError = report.issues.find((x) => x.severity === 'error');
  if (firstError) add(firstError.code, false, firstError.message);
  else add('checks', true, `Every template check passes${report.warnings ? ` (${report.warnings} warning${report.warnings === 1 ? '' : 's'})` : ''}`);
  // The daily gap-fill and the AI fixes write only what Auto could send (no warnings).
  if (local.requestedBy !== 'suggest') {
    const warn = report.issues.find((x) => x.severity === 'warning');
    add('WW08', !warn, warn ? `${warn.code}: ${warn.message}` : 'No warnings');
  }
  return checks;
}

// ── Still needed? (the precheck and the apply) ───────────────────────────────

const FILLS: ReadonlySet<WaDisplay> = new Set(['approved', 'in_review', 'submitting', 'ready', 'needs_fix']);

/**
 * An AI draft in another language than English whose name has an English template that is gone
 * for good (dismissed, deleted, disabled…): a translation left without its English. It can't be
 * sent on its own (Auto waits for the English), so it doesn't fill its cell. A draft under a name
 * with no English template at all (a person's Suggest "new" in German) is not an orphan.
 */
function isOrphan(t: WriterTemplateView, all: WriterTemplateView[]): boolean {
  if (t.lang === 'en' || t.origin !== 'ai' || (t.display !== 'ready' && t.display !== 'needs_fix')) return false;
  const en = all.find((x) => x.name === t.name && x.lang === 'en');
  return Boolean(en) && !englishAlive(all, t.name);
}

/** The templates that fill a cell (the gap-fill writes nothing next to them): alive, and not orphans. */
export function fillingTemplates(cell: WriterTemplateView[], all: WriterTemplateView[]): WriterTemplateView[] {
  return cell.filter((t) => !t.dismissed && FILLS.has(t.display) && !isOrphan(t, all));
}

/**
 * Null when the run is still wanted, else why not. Read fresh before the model is called and again
 * when the answer is applied (the registry may have moved meanwhile).
 */
export function stillNeeded(local: WriterLocal, templates: WriterTemplateView[]): string | null {
  const cell = templates.filter((t) => t.lang === local.lang && !t.dismissed);
  switch (local.kind) {
    case 'new':
      // The daily gap-fill fills a gap only; a person's Suggest writes even next to a draft.
      if (local.requestedBy === 'gap_fill' && fillingTemplates(cell, templates).length) return 'cell_filled';
      return null;
    case 'alternative':
      return null;
    case 'translation': {
      if (!local.existingName) return 'english_missing';
      if (templates.some((t) => t.name === local.existingName && t.lang === local.lang)) return 'language_exists';
      const en = templates.find((t) => t.name === local.existingName && t.lang === 'en');
      if (!en || !en.source || en.dismissed) return 'english_missing';
      if (local.requestedBy === 'gap_fill' && fillingTemplates(cell, templates).length) return 'cell_filled';
      return null;
    }
    case 'fix': {
      const t = templates.find((x) => x.id === local.targetTemplateId);
      if (!t) return 'no_target';
      if (t.lang !== local.lang) return 'other_language';
      if (t.version !== local.targetVersion) return 'edited_since';
      const status = String(t.metaStatus ?? '').toUpperCase();
      if (t.stage !== 'submitted' || (status !== 'REJECTED' && status !== 'PAUSED')) return 'not_editable';
      if (t.aiFixes >= MAX_AI_FIXES) return 'fix_limit';
      return null;
    }
    default:
      return 'bad_params';
  }
}

/** AI fixes per template (then a person, or a new template). */
export const MAX_AI_FIXES = 2;

// ── Coverage: the gaps the daily run fills, the kinds a Suggest button offers ──

const DAY = 86_400_000;
/** A cell whose template Meta blocked, rejected, paused, disabled or archived — or whose AI draft was dismissed — waits this long. */
export const GAP_COOLDOWN_MS = 30 * DAY;

export interface CellGap {
  journeyKey: string;
  poolKey: string;
  lang: Lang;
  kind: 'new' | 'translation';
  /** translation: the English template. */
  englishId: string | null;
}

export interface GapInput {
  pools: Array<PoolInfo & { availability: 'available' | 'coming_soon' }>;
  /** Every template of an Adaptive message, by `journeyKey:poolKey`. */
  templatesOf: (journeyKey: string, poolKey: string) => WriterTemplateView[];
  realNow: number;
  /** Cells waiting after repeated rejected runs (cellKey → real ms until). */
  cooldowns: Record<string, number>;
  /** Cells with a writer run already queued. */
  pending: ReadonlySet<string>;
}

const COOLDOWN_STATES: ReadonlySet<WaDisplay> = new Set(['blocked', 'rejected', 'paused', 'disabled', 'archived']);

/**
 * The cells the daily gap-fill writes, English first: a cell with nothing usable or on its way.
 * A cell whose best template Meta blocked, rejected, paused, disabled or archived — or where an AI
 * draft was dismissed — waits 30 days (a person decides first); deleted counts as missing; a
 * template in "attention" waits for a person. Coming-soon messages are skipped. A language other
 * than English is written as a translation, only once the English template is approved or in
 * review. A cell with a run queued, or in cooldown after repeated rejections, is skipped.
 */
export function coverageGaps(i: GapInput): CellGap[] {
  const en: CellGap[] = [];
  const others: CellGap[] = [];
  for (const pool of i.pools) {
    if (pool.availability === 'coming_soon' || !pool.whatsappCategory) continue;
    const all = i.templatesOf(pool.journeyKey, pool.poolKey);
    for (const lang of LANGS) {
      const key = cellKeyOf(pool.journeyKey, pool.poolKey, lang);
      if (i.pending.has(key)) continue;
      if ((i.cooldowns[key] ?? 0) > i.realNow) continue;
      const cell = all.filter((t) => t.lang === lang);
      const live = cell.filter((t) => !t.dismissed);
      // Filled (an orphaned translation — its English gone for good — doesn't count: isOrphan).
      if (fillingTemplates(cell, all).length) continue;
      if (live.some((t) => t.display === 'attention')) continue;
      if (live.some((t) => COOLDOWN_STATES.has(t.display) && i.realNow - t.changedAtMs < GAP_COOLDOWN_MS)) continue;
      if (cell.some((t) => t.dismissed && t.origin === 'ai' && t.dismissedAtMs !== null && i.realNow - t.dismissedAtMs < GAP_COOLDOWN_MS)) continue;
      if (lang === 'en') {
        en.push({ journeyKey: pool.journeyKey, poolKey: pool.poolKey, lang, kind: 'new', englishId: null });
        continue;
      }
      const english = all.find((t) => isEnglishSource(t, wantedCategory(pool)) && (t.display === 'approved' || t.display === 'in_review' || t.display === 'submitting'));
      if (!english) continue;
      // Its name already has this language (a dismissed or rejected one): a person decides.
      if (all.some((t) => t.name === english.name && t.lang === lang)) continue;
      others.push({ journeyKey: pool.journeyKey, poolKey: pool.poolKey, lang, kind: 'translation', englishId: english.id });
    }
  }
  return [...en, ...others];
}

function englishAlive(all: WriterTemplateView[], name: string): boolean {
  const en = all.find((t) => t.name === name && t.lang === 'en');
  return Boolean(en && !en.dismissed && (FILLS.has(en.display) || en.display === 'rejected'));
}

export interface SuggestOption {
  kind: WriterKind;
  /** fix: the template; translation: the English one. */
  templateId: string | null;
}

/**
 * What "Suggest with AI" may write for one cell: a missing cell → a new template (and a
 * translation when an English one with text exists); a cell whose best template Meta rejected or
 * paused and that is ours → a fix (while under the AI-fix limit) and an alternative; any other
 * filled cell → an alternative.
 */
export function suggestOptionsFor(cell: WriterTemplateView[], all: WriterTemplateView[], lang: Lang, wanted: WaRequestable | null = null): SuggestOption[] {
  const live = cell.filter((t) => !t.dismissed);
  const out: SuggestOption[] = [];
  if (!live.length) {
    if (lang !== 'en') {
      const en = englishSourceFor(all, wanted);
      if (en && !all.some((t) => t.name === en.name && t.lang === lang)) out.push({ kind: 'translation', templateId: en.id });
    }
    out.push({ kind: 'new', templateId: null });
    return out;
  }
  const fixable = live.find((t) => {
    const s = String(t.metaStatus ?? '').toUpperCase();
    return t.source && t.stage === 'submitted' && (s === 'REJECTED' || s === 'PAUSED') && t.aiFixes < MAX_AI_FIXES && !t.aiFixUnsent;
  });
  if (fixable) out.push({ kind: 'fix', templateId: fixable.id });
  out.push({ kind: 'alternative', templateId: null });
  return out;
}

// ── The sandbox's answer (the local fake model) ──────────────────────────────

const SANDBOX_TEXT: Record<Lang, { open: string; thanks: string; about: (name: string) => string; closings: string[] }> = {
  en: {
    open: 'Hello {{contact.firstName | default:"there"}}',
    thanks: 'thank you for choosing {{venue.name}} today.',
    about: (name) => `This is your “${name}” note.`,
    closings: [
      'We are happy to have you with us and wish you a lovely time.',
      'It is a pleasure to have you here, and we hope you enjoy every moment.',
      'Our team is glad you are here and wishes you a pleasant stay.',
      'We hope everything is just right for you during your time with us.',
      'Thanks for being with us, and have a wonderful time here.',
      'We are glad you picked us and hope you have a relaxed time.',
    ],
  },
  de: {
    open: 'Hallo {{contact.firstName | default:"du"}}',
    thanks: 'danke, dass du heute bei {{venue.name}} bist.',
    about: (name) => `Hier ist deine Nachricht „${name}“.`,
    closings: [
      'Wir freuen uns sehr über deinen Besuch und wünschen dir eine schöne Zeit.',
      'Schön, dass du da bist, wir wünschen dir einen angenehmen Aufenthalt.',
      'Unser Team freut sich über dich und wünscht dir einen tollen Tag.',
      'Wir hoffen, dass für dich alles passt, und wünschen dir viel Freude.',
      'Danke, dass du bei uns bist, und eine gute Zeit hier.',
      'Wir freuen uns, dass du uns gewählt hast, und wünschen dir Erholung.',
    ],
  },
  fr: {
    open: 'Bonjour {{contact.firstName | default:"à vous"}}',
    thanks: 'merci d’avoir choisi {{venue.name}} aujourd’hui.',
    about: (name) => `Voici votre message « ${name} ».`,
    closings: [
      'Nous sommes ravis de vous accueillir et vous souhaitons un très bon moment.',
      'C’est un plaisir de vous recevoir, profitez bien de chaque instant.',
      'Toute notre équipe est heureuse de vous accueillir parmi nous.',
      'Nous espérons que tout vous convient pendant votre passage chez nous.',
      'Merci d’être avec nous, nous vous souhaitons un agréable séjour.',
      'Nous sommes heureux de votre choix et vous souhaitons une belle journée.',
    ],
  },
  it: {
    open: 'Ciao {{contact.firstName | default:"a te"}}',
    thanks: 'grazie per aver scelto {{venue.name}} oggi.',
    about: (name) => `Ecco il tuo messaggio “${name}”.`,
    closings: [
      'Siamo felici di averti con noi e ti auguriamo un bel momento.',
      'È un piacere averti qui, goditi ogni momento con calma.',
      'Tutto il nostro team è contento di averti con noi oggi.',
      'Speriamo che tutto sia perfetto per te durante la tua visita.',
      'Grazie di essere con noi, ti auguriamo una giornata serena.',
      'Siamo contenti della tua scelta e ti auguriamo un buon soggiorno.',
    ],
  },
};

const SANDBOX_BUTTON: Record<string, Record<Lang, string>> = {
  'the guest’s offer page': { en: 'See your offer', de: 'Angebot ansehen', fr: 'Voir l’offre', it: 'Vedi l’offerta' },
  'the page where the guest rates the visit': { en: 'Rate your visit', de: 'Besuch bewerten', fr: 'Noter la visite', it: 'Valuta la visita' },
  'the venue’s guest info page (Wi-Fi, house info)': { en: 'Open guest info', de: 'Gästeinfo öffnen', fr: 'Infos pratiques', it: 'Info per gli ospiti' },
  'the venue’s direct booking page': { en: 'Book direct', de: 'Direkt buchen', fr: 'Réserver en direct', it: 'Prenota diretto' },
};

/**
 * A valid answer for any brief (the local fake model): the venue and the first name only, the
 * message's name (so two messages never get the same text: Meta refuses duplicates, T18 — left out
 * of a service message whose name reads as promotion), a closing that changes with the bodies
 * already there (so a second Suggest isn't a duplicate), the button text the link needs, the
 * category asked for, no numbers in the reasoning.
 */
export function sandboxWriterAnswer(brief: WriterBrief): WriterAnswer {
  const t = SANDBOX_TEXT[brief.language] ?? SANDBOX_TEXT.en;
  // Never the text it fixes or translates either (WW07).
  const taken = new Set([...brief.existingBodies, brief.current?.body, brief.english?.body].filter((b): b is string => Boolean(b)).map((b) => normText(b)));
  const name = brief.message.name.replace(/[{}"“”„«»]/g, '').trim();
  const about = name && !(brief.category === 'UTILITY' && promoWordsIn(name).length) ? ` ${t.about(name)}` : '';
  let body = '';
  for (let i = 0; i < t.closings.length * 2; i += 1) {
    const closing = t.closings[(brief.existingBodies.length + i) % t.closings.length];
    const second = i >= t.closings.length ? ` ${t.closings[(i + 1) % t.closings.length]}` : '';
    body = `${t.open}, ${t.thanks}${about} ${closing}${second}`;
    if (!taken.has(normText(body))) break;
  }
  const button = brief.button ? SANDBOX_BUTTON[brief.button.opens]?.[brief.language] ?? 'Open' : null;
  return {
    reasoning: `A short ${brief.languageName} message for “${brief.message.name}” that names the venue and greets the guest by first name.`,
    language: brief.language,
    body,
    buttonText: button,
    category: brief.category,
    categoryReason: brief.category === 'UTILITY' ? 'It informs the guest about their visit and promotes nothing.' : 'It invites the guest to engage with the venue, which Meta treats as marketing.',
  };
}

/** A plain reading of a refusal or skip code (log rows and the API's 409s). */
export function writerCodeWords(code: string): string {
  switch (code) {
    case 'no_message':
      return 'This message can’t go by WhatsApp';
    case 'english_missing':
      return 'There is no English template with text to translate yet';
    case 'not_rejected':
    case 'not_editable':
      return 'Only a template Meta rejected or paused can be fixed';
    case 'not_ours':
      return 'This template has no text of ours (link it to a message first)';
    case 'language_exists':
      return 'This name already has this language';
    case 'no_target':
      return 'The template is gone';
    case 'no_free_name':
      return 'No free template name for this message';
    case 'cell_filled':
      return 'This message has a template in this language now';
    case 'edited_since':
      return 'Someone edited the template meanwhile';
    case 'fix_limit':
      return `The AI fixed this template ${MAX_AI_FIXES} times already: a person decides now`;
    case 'other_language':
      return 'That template is in another language than the one asked for';
    case 'fix_unsent':
      return 'The AI’s fix hasn’t been sent to Meta yet — send it again first';
    case 'bad_params':
      return 'The request couldn’t be read';
    default:
      return code;
  }
}

export type { SiblingInfo };
