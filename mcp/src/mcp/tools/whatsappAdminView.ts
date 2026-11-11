/**
 * Pure views and input schemas of the WhatsApp admin tools (tools/whatsappAdmin.ts). They only
 * reshape what captive-server's `/internal/adaptive/admin/whatsapp…` and `/admin/launch` answer —
 * every rule (checks, status, coverage, what the AI may write, the sending checks) is the server's.
 * No firebase import here, so tests/whatsappAdmin.test.ts can load it alone.
 */

import { z } from 'zod';

export const LANGS = ['en', 'de', 'fr', 'it'] as const;
export type Lang = (typeof LANGS)[number];

/** The phrase the Launch & health card asks for to turn WhatsApp sending on (server: PHRASES.wa_send_on). */
export const WHATSAPP_ON_PHRASE = 'WHATSAPP ON';

export const NOT_ADMIN = 'The WhatsApp admin tools are for HeidiFi super admins only (connect as a SUPER_ADMIN).';

type Rec = Record<string, any>;

// ── Inputs ───────────────────────────────────────────────────────────────────

const TEMPLATE_ID = /^wt_[0-9a-f]{32}$/;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** Which template: its id, or its name + language (names repeat across languages). */
export const templateRefShape = {
  templateId: z.string().regex(TEMPLATE_ID).optional().describe('The template id (wt_…), from list_whatsapp_templates.'),
  name: z.string().min(1).max(512).optional().describe('The template name, e.g. hf_birthday_1 (use with lang).'),
  lang: z.enum(LANGS).optional().describe('The language: en, de, fr or it (with name).'),
};
export const templateRefSchema = z.object(templateRefShape);
export type TemplateRef = z.infer<typeof templateRefSchema>;

export const listInputShape = {
  lang: z.enum(LANGS).optional().describe('Only this language.'),
  journeyKey: z.string().regex(KEY).optional().describe('Only templates of this journey.'),
  poolKey: z.string().regex(KEY).optional().describe('Only templates of this message (pool), e.g. birthday.'),
  status: z
    .string()
    .max(20)
    .optional()
    .describe('Only this status: approved, in_review, submitting, ready, needs_fix, rejected, paused, disabled, blocked, attention, archived, deleted, draft.'),
  kind: z.enum(['ours', 'legacy', 'all']).default('all').describe('ours = hf_<pool>_<n> for Adaptive messages; legacy = everything else (imported, the login code, old Campaign Manager).'),
  includeDismissed: z.boolean().default(false).describe('Also list hidden (dismissed) templates.'),
  search: z.string().max(80).optional().describe('Part of the name, e.g. "review".'),
};
export const listInputSchema = z.object(listInputShape);

/** A draft's text, as the editor writes it: named fields like {{contact.firstName}}, never {{1}}. */
/** PR image header: a picture at the top; which picture is the venue's at each send, `sample` is the one Meta's reviewers see. */
const headerChange = z
  .object({
    type: z.literal('image'),
    sample: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .describe('The sample picture for Meta’s review: an https *.b-cdn.net link from the media library (list_venue_logos lists one account’s), JPEG or PNG, at most 5 MB. Needed before Send to Meta.'),
  })
  .strict();

export const draftChangeShape = {
  header: headerChange
    .nullable()
    .optional()
    .describe('A picture at the top: {type: "image", sample}. null removes it, leave out to keep it. Guests get their venue’s WhatsApp picture (set_venue_whatsapp_image); venues without one get the templates without a picture. Approved templates can’t gain one: make a new template (create_whatsapp_draft).'),
  body: z.string().trim().min(1).max(2000).optional().describe('The new body text with named fields, e.g. "Hallo {{contact.firstName}}, …". Fields allowed for the message are in get_whatsapp_template (allowedFields).'),
  footer: z.string().trim().max(200).nullable().optional().describe('The footer (the stop line); null removes it, leave out to keep it.'),
  button: z
    .object({ text: z.string().trim().min(1).max(100), field: z.enum(['link.offer', 'link.rating', 'link.hub', 'link.booking']) })
    .strict()
    .nullable()
    .optional()
    .describe('The link button {text, field}; null removes it, leave out to keep it.'),
  category: z.enum(['MARKETING', 'UTILITY']).optional().describe('The category asked of Meta (review asks and offers are MARKETING).'),
};
export const draftChangeSchema = z.object(draftChangeShape);
export type DraftChange = z.infer<typeof draftChangeSchema>;

export const suggestInputShape = {
  journeyKey: z.string().regex(KEY).describe('The journey of the coverage cell (get_whatsapp_coverage).'),
  poolKey: z.string().regex(KEY).describe('The message (pool) of the cell.'),
  lang: z.enum(LANGS).describe('The language of the cell.'),
  kind: z
    .enum(['new', 'translation', 'alternative', 'fix'])
    .describe('new = Suggest with AI for an empty cell; translation = Translate with AI (from the English template); alternative = another wording; fix = fix a rejected/paused one. Use only a kind the cell lists in get_whatsapp_coverage (aiCanWrite), as the tab offers.'),
  templateId: z.string().regex(TEMPLATE_ID).optional().describe('For fix and translation: the template the cell lists with that kind.'),
};

export const testOptionsShape = {
  tenantUserId: z.string().min(1).max(128).optional().describe('The account (default: the one picked when connecting).'),
  journeyKey: z.string().regex(KEY).optional().describe('Also list this journey’s message steps (nodeId, offerSlot) and whether each has an approved WhatsApp template.'),
  lang: z.enum(LANGS).default('en'),
};

export const testSendShape = {
  tenantUserId: z.string().min(1).max(128).optional().describe('The account (default: the one picked when connecting).'),
  venueId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('The venue whose setup and values the test uses.'),
  journeyKey: z.string().regex(KEY).describe('The journey, e.g. birthday.'),
  nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('The message step (default: the journey’s first message step).'),
  offerSlot: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).optional().describe('The step’s offer blank (Win-back stages share one step).'),
  lang: z.enum(LANGS).optional().describe('The language (default en).'),
  recipientId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('A saved test phone number’s id (list_whatsapp_test_options). The number itself never travels.'),
};

/** PR image header: the venue's WhatsApp picture. */
export const venueImageShape = {
  tenantUserId: z.string().min(1).max(128).optional().describe('The account (default: the one picked when connecting).'),
  venueId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('The venue (list_whatsapp_test_options lists the account’s venues).'),
};

export const setVenueImageShape = {
  ...venueImageShape,
  url: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .describe('An https *.b-cdn.net link from the account’s media library (list_venue_logos), JPEG or PNG, at most 5 MB; null removes the picture.'),
};

/** PR image header: a new draft (D1: an image version of a message is a new template, next to the approved plain one). */
export const createDraftShape = {
  journeyKey: z.string().regex(KEY).describe('The journey of the message (get_whatsapp_coverage).'),
  poolKey: z.string().regex(KEY).describe('The message (pool).'),
  lang: z.enum(LANGS),
  category: z.enum(['MARKETING', 'UTILITY']).describe('Review asks and offers MARKETING, info messages UTILITY (the message’s rule).'),
  header: draftChangeShape.header,
  body: z.string().trim().min(1).max(2000).describe('The body with named fields, e.g. "Hallo {{contact.firstName | default:\"du\"}}, …" (allowedFields in get_whatsapp_template).'),
  footer: z.string().trim().max(200).nullable().optional().describe('The footer (the STOP line for marketing).'),
  button: draftChangeShape.button,
  name: z.string().regex(/^hf_[a-z0-9_]{1,200}$/).optional().describe('Only for a new LANGUAGE of an existing template of ours (same message): its name. Leave out for a new template (the next hf_<pool>_<n>).'),
};

export const setSendingShape = {
  mode: z.enum(['on', 'off']).describe('off = the brake, one call; on = needs confirmPhrase "WHATSAPP ON" and all three sending checks.'),
  confirmPhrase: z.string().max(40).optional().describe('Only for on: exactly WHATSAPP ON, and only when Manish has written it in the chat himself.'),
  note: z.string().trim().max(500).optional().describe('A note for the launch history.'),
};

// ── Picking a template ───────────────────────────────────────────────────────

/** The template a ref means, among the overview's templates: an id, or an error to show. */
export function pickTemplate(templates: Rec[], ref: TemplateRef): { id: string } | { error: string } {
  if (ref.templateId) {
    return templates.some((t) => t.id === ref.templateId) ? { id: ref.templateId } : { error: `No template ${ref.templateId}` };
  }
  if (!ref.name) return { error: 'Say which template: templateId, or name and lang' };
  const named = templates.filter((t) => t.name === ref.name);
  if (!named.length) return { error: `No template named ${ref.name}` };
  if (ref.lang) {
    const hit = named.filter((t) => t.lang === ref.lang);
    if (hit.length === 1) return { id: hit[0].id };
    if (hit.length > 1) return { error: `${ref.name} has ${hit.length} ${ref.lang} entries — use templateId (${hit.map((t) => t.id).join(', ')})` };
    return { error: `${ref.name} has no ${ref.lang} language (it has: ${named.map((t) => t.lang ?? t.language).join(', ')})` };
  }
  if (named.length === 1) return { id: named[0].id };
  return { error: `${ref.name} exists in ${named.map((t) => t.lang ?? t.language).join(', ')} — say which lang` };
}

// ── Views ────────────────────────────────────────────────────────────────────

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string') return v;
  return null;
}

/** The connection strip of the WhatsApp tab. */
export function connectionView(o: Rec) {
  const c: Rec = o.connection ?? {};
  const s: Rec | null = o.lastSync ?? null;
  return {
    connected: c.ok === true,
    account: o.wabaId ?? c.wabaId ?? null,
    accountName: c.verifiedName ?? null,
    number: c.displayPhoneNumber ?? null,
    phoneNumberId: c.phoneNumberId ?? null,
    quality: c.quality ?? null,
    // Meta says "never" with no date; null with an undescribed token means unknown.
    tokenExpires: c.tokenExpiresAt ? iso(c.tokenExpiresAt) : c.tokenDescribed ? 'never' : 'unknown',
    notices: c.notices ?? 'unknown',
    problems: Array.isArray(c.problems) ? c.problems : [],
    checkedAt: iso(c.checkedAt),
    serverConfigured: o.configured === true,
    client: o.client ?? null,
    lastSync: s
      ? { at: iso(s.at), ok: s.ok === true, complete: s.complete === true, changes: s.changes ?? 0, imported: s.imported ?? 0, error: s.error?.message ?? null }
      : null,
    templateCount: o.templateCount ?? null,
    templateLimit: o.templateLimit ?? null,
    counts: o.counts ?? null,
    managerUrl: o.managerUrl ?? null,
  };
}

function isOurs(t: Rec): boolean {
  return t.use?.kind === 'adaptive' && /^hf_[a-z0-9_]+_\d+$/.test(String(t.name ?? ''));
}

/**
 * The server's check report: `{ ok, errors: <count>, warnings: <count>, issues? }` — the list line
 * has the counts only, the full template and the check route add `issues` (severity error/warning).
 */
export function checksView(c: Rec | undefined) {
  const issues: Rec[] = Array.isArray(c?.issues) ? c!.issues : [];
  const count = (v: unknown, severity: string) => (typeof v === 'number' ? v : issues.filter((i) => i.severity === severity).length);
  return {
    ok: c?.ok === true,
    errors: count(c?.errors, 'error'),
    warnings: count(c?.warnings, 'warning'),
    ...(issues.length ? { issues: issues.map((i) => `${i.severity === 'warning' ? 'warning' : 'error'} ${issueLine(i)}`) } : {}),
  };
}

function issueLine(i: Rec): string {
  return `${i.code ? `${i.code}: ` : ''}${i.message ?? ''}`;
}

/** One row of the template list. */
export function templateRow(t: Rec) {
  return {
    templateId: t.id,
    name: t.name,
    language: t.language,
    lang: t.lang ?? null,
    kind: isOurs(t) ? 'ours' : 'legacy',
    use: t.use?.kind ?? null,
    message: t.message ? { journeyKey: t.message.journeyKey, poolKey: t.message.poolKey, name: t.message.name, journey: t.message.journeyName, rule: t.message.rule } : null,
    status: t.display,
    metaStatus: t.metaStatus ?? null,
    category: { asked: t.requestedCategory ?? null, meta: t.metaCategory ?? null },
    inUse: t.usable === true,
    usePaused: t.useEnabled === false,
    dismissed: t.dismissed === true,
    checks: checksView(t.checks),
    metaReason: t.rejectedReason ? { code: t.rejectedReason, words: t.rejectedWords ?? null } : null,
    origin: t.origin ?? null,
    version: t.version,
    updatedAt: t.updatedAt ?? null,
  };
}

export function listView(o: Rec, q: z.infer<typeof listInputSchema>) {
  const all: Rec[] = Array.isArray(o.templates) ? o.templates : [];
  const search = q.search?.toLowerCase();
  const rows = all
    .filter((t) => q.includeDismissed || !t.dismissed)
    .filter((t) => !q.lang || t.lang === q.lang)
    .filter((t) => !q.journeyKey || t.message?.journeyKey === q.journeyKey || t.use?.journeyKey === q.journeyKey)
    .filter((t) => !q.poolKey || t.message?.poolKey === q.poolKey || t.use?.poolKey === q.poolKey)
    .filter((t) => !q.status || t.display === q.status)
    .filter((t) => q.kind === 'all' || (q.kind === 'ours') === isOurs(t))
    .filter((t) => !search || String(t.name ?? '').toLowerCase().includes(search))
    .map(templateRow);
  return { count: rows.length, of: all.length, counts: o.counts ?? null, templates: rows };
}

const EDITABLE_AT_META = new Set(['REJECTED', 'PAUSED']);

/** One template in full: Meta's text with {{n}}, our text, the field mapping, checks, timeline. */
export function templateDetail(r: Rec) {
  const t: Rec = r.template ?? {};
  const compiled: Rec | null = t.compiled ?? null;
  const meta: Rec | null = t.meta ?? null;
  const metaStatus = String(t.metaStatus ?? '').toUpperCase();
  const editable = t.use?.kind === 'adaptive' && Boolean(t.lang) && (t.stage === 'draft' || (t.stage === 'submitted' && EDITABLE_AT_META.has(metaStatus)));
  const history: Rec[] = Array.isArray(r.history) ? r.history : [];
  return {
    ...templateRow(t),
    stage: t.stage,
    editable,
    canSendToMeta: editable && t.checks?.ok === true,
    ourText: t.source ? { header: t.source.header ?? null, body: t.source.body, footer: t.source.footer ?? null, button: t.source.button ?? null } : null,
    // PR image header: a picture at the top (guests get their venue's; `sample` is what Meta's reviewers see).
    header: compiled?.header ?? t.preview?.header ?? null,
    metaBody: compiled?.bodyText ?? meta?.bodyText ?? null,
    metaFooter: compiled?.footerText ?? meta?.footerText ?? null,
    button: compiled?.button ?? null,
    fields: Array.isArray(compiled?.params)
      ? compiled!.params.map((p: Rec) => ({ n: p.n, field: p.field, fallback: p.fallback ?? null, date: p.date ?? null, example: p.example ?? null }))
      : [],
    atMeta: meta ? { id: meta.id ?? null, status: meta.status ?? null, category: meta.category ?? null, bodyText: meta.bodyText ?? null, quality: meta.quality ?? null } : null,
    allowedFields: t.allowedFields ?? null,
    linkField: t.linkField ?? null,
    lastSubmitError: t.lastSubmitError ?? null,
    ai: t.ai ? { kind: t.ai.kind ?? null, reasoning: t.ai.reasoning ?? null } : null,
    timeline: history.map((h) => ({ at: h.at ?? null, what: h.summary ?? h.kind, kind: h.kind, by: h.actor?.label ?? h.actor?.kind ?? null })),
    managerUrl: r.managerUrl ?? null,
  };
}

/** Coverage: every message × EN/DE/FR/IT, and "N of 44 in use". */
export function coverageView(o: Rec, journeyKey?: string) {
  const messages: Rec[] = Array.isArray(o.messages) ? o.messages : [];
  let inUse = 0;
  let cells = 0;
  const rows = messages.map((m) => {
    const out: Rec = {};
    for (const lang of LANGS) {
      const c: Rec = m.cells?.[lang] ?? { display: 'missing' };
      cells += 1;
      if (c.usable) inUse += 1;
      out[lang] = {
        status: c.display,
        inUse: c.usable === true,
        name: c.name ?? null,
        templateId: c.templateId ?? null,
        templates: c.count ?? 0,
        aiCanWrite: Array.isArray(c.suggest) ? c.suggest.map((s: Rec) => ({ kind: s.kind, templateId: s.templateId ?? null })) : [],
        aiWriting: c.aiPending === true,
      };
    }
    return { journeyKey: m.journeyKey, journey: m.journeyName, poolKey: m.poolKey, message: m.name, rule: m.rule, availability: m.availability ?? null, cells: out };
  });
  const shown = journeyKey ? rows.filter((r) => r.journeyKey === journeyKey) : rows;
  const ai: Rec | null = o.ai ?? null;
  return {
    summary: `${inUse} of ${cells} in use`,
    inUse,
    cells,
    ai: ai ? { on: ai.aiOn ?? null, budgetOk: ai.budgetOk ?? null, runsLeftToday: ai.runsLeft ?? null, blocked: ai.blocked ?? null, cellsBeingWritten: ai.pendingCells ?? 0 } : null,
    messages: shown,
  };
}

/** The draft text the server checks/saves: the template's current text with the asked changes. */
export function mergeSource(current: Rec | null, change: DraftChange) {
  const base = current ?? { body: '', footer: null, button: null };
  const header = change.header === undefined ? (base.header?.type === 'image' ? { type: 'image', sample: base.header.sample ?? null } : null) : change.header ? { type: 'image', sample: change.header.sample ?? null } : null;
  return {
    ...(header ? { header } : {}),
    body: change.body ?? base.body,
    footer: change.footer === undefined ? base.footer ?? null : change.footer,
    button: change.button === undefined ? base.button ?? null : change.button,
  };
}

export function hasTextChange(change: DraftChange): boolean {
  return change.header !== undefined || change.body !== undefined || change.footer !== undefined || change.button !== undefined;
}

/** The launch card's WhatsApp part: the switch, the three checks, and whether ON would pass. */
export function sendingView(l: Rec) {
  const ws: Rec = l.whatsappSending ?? {};
  const checks: Rec[] | null = Array.isArray(ws.checks) ? ws.checks : null;
  const warnings: string[] = Array.isArray(l.warnings) ? l.warnings.filter((w: string) => /whatsapp/i.test(w)) : [];
  return {
    switch: ws.mode ?? 'off',
    changedBy: ws.changedBy ?? null,
    checks: checks ? checks.map((c) => ({ key: c.key, ok: c.ok === true, text: c.text })) : null,
    readyToTurnOn: checks ? checks.every((c) => c.ok === true) : false,
    turnOnPhrase: WHATSAPP_ON_PHRASE,
    autoSubmit: l.whatsappTemplates?.autoSubmit ?? 'off',
    launchVersion: l.version ?? null,
    warnings,
  };
}

/** Saved test recipients, phone numbers only, masked (the number never leaves the server whole). */
export function recipientsView(raw: unknown) {
  const list = Array.isArray(raw) ? (raw as Rec[]) : [];
  return list
    .filter((r) => r && r.kind === 'phone' && typeof r.id === 'string')
    .map((r) => ({ recipientId: r.id, label: r.label || null, number: maskPhone(String(r.value ?? '')), isDefault: r.isDefault === true }));
}

export function maskPhone(v: string): string {
  const digits = v.replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '•••';
  return `${digits.slice(0, 3)}•••${digits.slice(-2)}`;
}

/** A journey's message steps (from the admin journey messages read), for Send test. */
export function stepsView(r: Rec) {
  const messages: Rec[] = Array.isArray(r.messages) ? r.messages : [];
  return messages.flatMap((m) =>
    (Array.isArray(m.steps) ? m.steps : []).map((s: Rec) => ({
      nodeId: s.nodeId,
      step: s.number,
      what: s.detail ?? null,
      poolKey: m.poolKey,
      message: m.name,
      byWhatsApp: Array.isArray(m.channels) ? m.channels.includes('whatsapp') : false,
      whatsappTemplates: Array.isArray(m.whatsapp?.templates) ? m.whatsapp.templates.map((t: Rec) => `${t.name} (${t.lang ?? '?'})`) : [],
    })),
  );
}

/** A server refusal in words: its message, plus the checks, blockers or missing fields it names. */
export function errorText(status: number, data: Rec): string {
  const parts = [String(data.error || `Request failed (${status})`)];
  if (data.code) parts.push(`[${data.code}]`);
  if (Array.isArray(data.blockers) && data.blockers.length) parts.push(`Blockers: ${data.blockers.join('; ')}`);
  if (Array.isArray(data.issues) && data.issues.length) parts.push(`Issues: ${data.issues.map((i: Rec) => issueLine(i)).join('; ')}`);
  if (Array.isArray(data.missing) && data.missing.length) parts.push(`Missing: ${data.missing.join(', ')}`);
  if (data.confirmPhrase) parts.push(`Phrase: ${data.confirmPhrase}`);
  return parts.join(' — ');
}
