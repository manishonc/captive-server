/**
 * WhatsApp templates (PR W1) — the pure model: what a template is in our registry, how our
 * wording becomes the exact JSON Meta wants, and how Meta's JSON reads back.
 *
 * People (and, from W2, the AI) write a template in Adaptive's usual merge-field grammar —
 * `Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}!` — and
 * pick a button link (`link.offer`, `link.rating`, `link.hub`, `link.booking`). `compileTemplate`
 * turns that into Meta's positional form (`{{1}}`, `{{2}}` in order of first use, one map per
 * language because word order differs) with example values from a fixed sample table (never real
 * data). The button is always `${VISITOR_BASE_URL}/{{1}}`; at send time (W3) its variable is
 * `s/<code>`, so the guest lands on `${VISITOR_BASE_URL}/s/<code>`.
 *
 * Pure: no Firestore, no network, no env — the base URL and the STOP lines come in as arguments.
 */

import { z } from 'zod';
import { LANGS, type Lang } from '../constants';
import { canonicalField, parseMergeExpressions } from '../registry/mergeFields';
import { formatDate } from '../render';

export const WA_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type WaCategory = (typeof WA_CATEGORIES)[number];
/** What we ever ask Meta for (authentication templates are Meta's own OTP format). */
export const WA_REQUESTABLE = ['MARKETING', 'UTILITY'] as const;
export type WaRequestable = (typeof WA_REQUESTABLE)[number];

/** Links only ever travel in the button (a body link would need no button and could be anything). */
export const WA_BUTTON_FIELDS = ['link.offer', 'link.rating', 'link.hub', 'link.booking'] as const;
export type WaButtonField = (typeof WA_BUTTON_FIELDS)[number];

/**
 * Merge fields a WhatsApp body may use: one-line values that are always safe to show. Never links
 * (button only), secrets, URLs (`guestinfo.hostContactUrl`, `guestinfo.menuUrl`) or multi-line
 * text (`guestinfo.houseRules`): Meta refuses a value with a line break, a tab or 4+ spaces.
 */
export const WA_BODY_FIELDS = [
  'contact.firstName',
  'venue.name',
  'offer.label',
  'offer.days',
  'offer.expiryDate',
  'guestinfo.wifiName',
  'guestinfo.checkInTime',
  'guestinfo.checkOutTime',
  'guestinfo.openingHours',
  'stay.checkInDate',
  'stay.checkOutDate',
  'stay.nights',
] as const;

/** Always filled at send time: no fallback needed. Everything else needs `| default:"…"` (Meta refuses an empty value). */
export const WA_ALWAYS_PRESENT: ReadonlySet<string> = new Set(['venue.name']);
/** Offer and price fields: never in a UTILITY template (Meta would file it as marketing). */
export const WA_PROMO_FIELDS: ReadonlySet<string> = new Set(['offer.label', 'offer.days', 'offer.expiryDate']);
/** Dates must carry a `| date:"…"` format, or the guest would see an ISO timestamp. */
export const WA_DATE_FIELDS: ReadonlySet<string> = new Set(['offer.expiryDate', 'stay.checkInDate', 'stay.checkOutDate']);

/** Longest value we expect per field — for the "body still ≤ 1024 once filled in" warning. */
export const WA_WORST_CASE_LENGTH: Readonly<Record<string, number>> = {
  'contact.firstName': 30,
  'venue.name': 60,
  'offer.label': 60,
  'offer.days': 3,
  'offer.expiryDate': 10,
  'guestinfo.wifiName': 40,
  'guestinfo.checkInTime': 5,
  'guestinfo.checkOutTime': 5,
  'guestinfo.openingHours': 40,
  'stay.checkInDate': 10,
  'stay.checkOutDate': 10,
  'stay.nights': 3,
};

/** A starting label for the button (≤ 25 characters), per link and language; editable. */
export const WA_BUTTON_DEFAULTS: Readonly<Record<WaButtonField, Readonly<Record<Lang, string>>>> = {
  'link.offer': { en: 'See your offer', de: 'Angebot ansehen', fr: 'Voir l’offre', it: 'Vedi l’offerta' },
  'link.rating': { en: 'Rate your visit', de: 'Besuch bewerten', fr: 'Noter la visite', it: 'Valuta la visita' },
  'link.hub': { en: 'Open guest info', de: 'Gästeinfo öffnen', fr: 'Infos pratiques', it: 'Info per gli ospiti' },
  'link.booking': { en: 'Book direct', de: 'Direkt buchen', fr: 'Réserver en direct', it: 'Prenota diretto' },
};

/**
 * A first draft from a message's SMS wording: the same text without its links (the button carries
 * the link), the STOP footer for marketing, a button to the message's link. Pure; checks still apply.
 */
export function prefillFromSms(
  smsText: string | null,
  opts: { lang: Lang; category: WaRequestable; linkField: string | null; footers: Readonly<Record<Lang, string>> },
): WaSource {
  const body = String(smsText ?? '')
    .replace(/\{\{\s*link\.[a-z]+[^}]*\}\}/gi, '')
    .replace(/[ \t]+([.,!?:;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[:\-–]\s*$/g, '')
    .trim();
  const field = (WA_BUTTON_FIELDS as readonly string[]).includes(opts.linkField ?? '') ? (opts.linkField as WaButtonField) : null;
  return {
    body: body || ' ',
    footer: opts.category === 'MARKETING' ? opts.footers[opts.lang] : null,
    button: field ? { text: WA_BUTTON_DEFAULTS[field][opts.lang], field } : null,
  };
}

/** The button variable's example: what `s/<code>` looks like (8 characters, the short-link alphabet). */
export const WA_BUTTON_EXAMPLE = 's/gkgq7j5z';

export const WA_BODY_MAX = 1024;
export const WA_FOOTER_MAX = 60;
export const WA_BUTTON_TEXT_MAX = 25;
export const WA_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

// ── What a template is ───────────────────────────────────────────────────────

export type WaUse =
  | { kind: 'adaptive'; journeyKey: string; poolKey: string }
  /** The guest-login code (`heidifi_verification_code`): shown, never edited here. */
  | { kind: 'otp' }
  /** Used by the old Campaign Manager / venue automations (cms `lib/whatsapp-templates.ts`): shown only. */
  | { kind: 'legacy' };

const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;

export const waUseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('adaptive'), journeyKey: z.string().regex(keyPattern), poolKey: z.string().regex(keyPattern) }).strict(),
  z.object({ kind: z.literal('otp') }).strict(),
  z.object({ kind: z.literal('legacy') }).strict(),
]);

/**
 * Our editable text. Lengths are checked by T-codes (so an over-long draft can be saved and shows
 * a check), the schema only stops absurd input.
 */
export const waSourceSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    footer: z.string().trim().max(200).nullable().default(null),
    button: z
      .object({ text: z.string().trim().min(1).max(100), field: z.enum(WA_BUTTON_FIELDS) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type WaSource = z.infer<typeof waSourceSchema>;

export interface WaParam {
  /** The positional number Meta sees (`{{n}}`), in order of first use. */
  n: number;
  /** The merge field (canonical name), e.g. `venue.name`. */
  field: string;
  /** `| default:"…"` — used when the value is empty at send time. */
  fallback: string | null;
  /** `| date:"…"` — the format of a date field. */
  date: string | null;
  example: string;
}

export interface MetaComponent {
  type: string;
  [key: string]: unknown;
}

export interface WaCompiled {
  bodyText: string;
  footerText: string | null;
  button: { text: string; field: WaButtonField; url: string; example: string } | null;
  params: WaParam[];
  /** Exactly what goes to Meta (`components`). */
  components: MetaComponent[];
}

// ── Languages ────────────────────────────────────────────────────────────────

/** The Meta language code we create for one of our languages: the bare code (`en`, not `en_US`). */
export function metaLanguageFor(lang: Lang): string {
  return lang;
}

/** Our language for a Meta code: its base (`en_US` → `en`, `de_CH` → `de`), or null when we don't speak it. */
export function langOfMeta(code: string | null | undefined): Lang | null {
  const base = String(code ?? '').toLowerCase().split(/[_-]/)[0];
  return (LANGS as readonly string[]).includes(base) ? (base as Lang) : null;
}

// ── Names ────────────────────────────────────────────────────────────────────

/** `hf_<poolKey>_<n>` — ours; never reused (Meta locks a deleted name for ~30 days). */
export function templateNameFor(poolKey: string, n: number): string {
  return `hf_${poolKey}_${Math.max(1, Math.floor(n))}`;
}

/** The pool and number of one of our names, or null for any other name (imported, legacy, OTP). */
export function parseOurName(name: string): { poolKey: string; n: number } | null {
  const m = /^hf_([a-z][a-z0-9_]*)_(\d{1,6})$/.exec(name);
  return m ? { poolKey: m[1], n: Number(m[2]) } : null;
}

// ── Samples (Meta's examples; never real data) ───────────────────────────────

const SAMPLE_DAY = '2026-10-20T12:00:00.000Z';
const SAMPLE_OUT_DAY = '2026-10-23T12:00:00.000Z';

const SAMPLE_TEXT: Readonly<Record<string, string | Readonly<Record<Lang, string>>>> = {
  'contact.firstName': 'Anna',
  'venue.name': 'Café Bellevue',
  'offer.label': { en: 'a free dessert', de: 'ein Gratis-Dessert', fr: 'un dessert offert', it: 'un dolce in omaggio' },
  'offer.days': '14',
  'guestinfo.wifiName': 'Bellevue Guest',
  'guestinfo.checkInTime': '15:00',
  'guestinfo.checkOutTime': '10:00',
  'guestinfo.openingHours': '11:30–22:00',
  'stay.nights': '3',
};

const SAMPLE_DATES: Readonly<Record<string, string>> = {
  'offer.expiryDate': SAMPLE_DAY,
  'stay.checkInDate': SAMPLE_DAY,
  'stay.checkOutDate': SAMPLE_OUT_DAY,
};

/** The example Meta gets for a field (dates in the field's own format). */
export function sampleFor(field: string, lang: Lang, date: string | null): string {
  if (SAMPLE_DATES[field]) return formatDate(SAMPLE_DATES[field], date ?? 'd.M.yyyy');
  const s = SAMPLE_TEXT[field];
  if (s === undefined) return 'Example';
  return typeof s === 'string' ? s : s[lang] ?? s.en;
}

// ── Compile ──────────────────────────────────────────────────────────────────

export interface CompileContext {
  lang: Lang;
  /** `VISITOR_BASE_URL` (no trailing slash). */
  visitorBaseUrl: string;
}

/** The button URL every template of ours registers: the bare visitor host plus one variable. */
export function buttonUrlFor(visitorBaseUrl: string): string {
  return `${visitorBaseUrl.replace(/\/+$/, '')}/{{1}}`;
}

/**
 * Our text → Meta's positional body, the parameter map and the exact `components`. The same field
 * twice reuses its number (T08 still reports it). Malformed braces stay in the text (T08 reports them).
 */
export function compileTemplate(source: WaSource, ctx: CompileContext): WaCompiled {
  const params: WaParam[] = [];
  const byField = new Map<string, WaParam>();
  let bodyText = source.body;
  for (const expr of parseMergeExpressions(source.body)) {
    const field = canonicalField(expr.name);
    let p = byField.get(field);
    if (!p) {
      const fallback = expr.filters.find((f) => f.name === 'default')?.arg ?? null;
      const date = expr.filters.find((f) => f.name === 'date')?.arg ?? null;
      p = { n: params.length + 1, field, fallback: fallback === '' ? null : fallback, date, example: sampleFor(field, ctx.lang, date) };
      byField.set(field, p);
      params.push(p);
    }
    bodyText = bodyText.split(expr.raw).join(`{{${p.n}}}`);
  }
  const footerText = source.footer ? source.footer : null;
  const button = source.button
    ? { text: source.button.text, field: source.button.field, url: buttonUrlFor(ctx.visitorBaseUrl), example: WA_BUTTON_EXAMPLE }
    : null;

  const components: MetaComponent[] = [];
  const body: MetaComponent = { type: 'BODY', text: bodyText };
  if (params.length) body.example = { body_text: [params.map((p) => p.example)] };
  components.push(body);
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  if (button) components.push({ type: 'BUTTONS', buttons: [{ type: 'URL', text: button.text, url: button.url, example: [button.example] }] });
  return { bodyText, footerText, button, params, components };
}

/**
 * The editable text of a positional Meta body (an imported template being linked): each `{{n}}`
 * becomes the field the map gives it, with its fallback and date format.
 */
export function sourceFromPositional(
  bodyText: string,
  map: Array<{ n: number; field: string; fallback?: string | null; date?: string | null }>,
): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (raw, num: string) => {
    const m = map.find((p) => p.n === Number(num));
    if (!m) return raw;
    const filters = [m.fallback ? ` | default:"${m.fallback.replace(/"/g, '')}"` : '', m.date ? ` | date:"${m.date.replace(/"/g, '')}"` : ''].join('');
    return `{{${m.field}${filters}}}`;
  });
}

// ── Reading Meta's JSON ──────────────────────────────────────────────────────

export interface MetaButton {
  type: string;
  text: string | null;
  url: string | null;
  example: string[] | null;
  otpType: string | null;
}

/** A Meta template as we keep it: the facts we act on, read leniently (unknown parts kept raw). */
export interface MetaTemplateFacts {
  id: string;
  name: string;
  language: string;
  lang: Lang | null;
  status: string | null;
  category: string | null;
  previousCategory: string | null;
  rejectedReason: string | null;
  quality: string | null;
  parameterFormat: string | null;
  headerText: string | null;
  bodyText: string | null;
  footerText: string | null;
  buttons: MetaButton[];
  /** Component types we don't model (media headers, carousels…). */
  otherComponents: string[];
}

const str = (v: unknown, max = 4000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Meta's template JSON (list / get) → the facts. Null when it has no id, name or language. */
export function parseMetaTemplate(raw: unknown): MetaTemplateFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const id = str(t.id, 64);
  const name = str(t.name, 512);
  const language = str(t.language, 16);
  if (!id || !name || !language) return null;
  const quality = t.quality_score && typeof t.quality_score === 'object' ? str((t.quality_score as Record<string, unknown>).score, 40) : str(t.quality_score, 40);
  const out: MetaTemplateFacts = {
    id,
    name,
    language,
    lang: langOfMeta(language),
    status: str(t.status, 40),
    category: str(t.category, 40),
    previousCategory: str(t.previous_category, 40),
    rejectedReason: str(t.rejected_reason, 200),
    quality: quality ? quality.toUpperCase() : null,
    parameterFormat: str(t.parameter_format, 20),
    headerText: null,
    bodyText: null,
    footerText: null,
    buttons: [],
    otherComponents: [],
  };
  const comps = Array.isArray(t.components) ? (t.components as unknown[]) : [];
  for (const c of comps) {
    if (!c || typeof c !== 'object') continue;
    const comp = c as Record<string, unknown>;
    const type = String(comp.type ?? '').toUpperCase();
    if (type === 'BODY') out.bodyText = str(comp.text);
    else if (type === 'FOOTER') out.footerText = str(comp.text, 200);
    else if (type === 'HEADER') {
      if (String(comp.format ?? 'TEXT').toUpperCase() === 'TEXT') out.headerText = str(comp.text, 200);
      else out.otherComponents.push(`HEADER:${String(comp.format ?? '').toUpperCase()}`);
    } else if (type === 'BUTTONS') {
      const buttons = Array.isArray(comp.buttons) ? (comp.buttons as unknown[]) : [];
      for (const b of buttons) {
        if (!b || typeof b !== 'object') continue;
        const btn = b as Record<string, unknown>;
        out.buttons.push({
          type: String(btn.type ?? '').toUpperCase(),
          text: str(btn.text, 200),
          url: str(btn.url, 2000),
          example: Array.isArray(btn.example) ? (btn.example as unknown[]).map((e) => String(e)).slice(0, 5) : null,
          otpType: str(btn.otp_type, 40),
        });
      }
    } else if (type) out.otherComponents.push(type);
  }
  return out;
}

/** Whitespace-insensitive text for comparing what we sent with what Meta stores. */
export function normText(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The visible parts of a template, normalised — equal means Meta holds what we compiled. */
export function contentKey(parts: { bodyText: string | null; footerText: string | null; buttons: Array<{ text: string | null; url: string | null }> }): string {
  return JSON.stringify([normText(parts.bodyText), normText(parts.footerText), parts.buttons.map((b) => [normText(b.text), normText(b.url)])]);
}

/** Body variables `{{n}}` / `{{name}}` in a Meta body. */
export function metaBodyVariables(bodyText: string | null): string[] {
  return [...String(bodyText ?? '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]);
}
