/**
 * The admin "WhatsApp" tab of Adaptive Campaigns (PR W1), under `/internal/adaptive/admin/whatsapp…`
 * (SUPER_ADMIN in the cms; writes also need `actor.kind: 'super_admin'`). Reference:
 * docs/adaptive-api.md "WhatsApp templates".
 *
 *   GET  whatsapp                          the whole tab: connection, sync, counts, coverage, templates
 *   GET  whatsapp/templates/:id            one template: text, checks, preview, Meta's state, timeline
 *   GET  whatsapp/log                      the activity log (?templateId&before&limit&routine)
 *   GET  whatsapp/prefill                  a first draft from a message's SMS (?journeyKey&poolKey&lang)
 *   POST whatsapp/templates/check          the checks of a draft, nothing saved
 *   POST whatsapp/templates                a new draft
 *   PUT  whatsapp/templates/:id            save a draft (or a rejected/paused template) {change, baseVersion}
 *   POST whatsapp/templates/:id/submit     Send to Meta {baseVersion}
 *   POST whatsapp/templates/:id/dismiss    hide (not the OTP template)  · …/restore brings it back
 *   PUT  whatsapp/templates/:id/link       tie an imported template to a message {use, map, buttonField, baseVersion}
 *   POST whatsapp/templates/:id/use        {enabled} pause / resume our use (the brake: never refused)
 *   POST whatsapp/connection/check         Check connection
 *   PUT  whatsapp/connection               {wabaId} set the account by hand (verified first)
 *   POST whatsapp/sync                     Sync now (the tick's lease: `running` when it is busy)
 *
 * Every write lands in the activity log with who did it. Nothing here deletes at Meta.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { LANGS } from '../core/constants';
import {
  WA_BODY_FIELDS,
  WA_BUTTON_FIELDS,
  WA_REQUESTABLE,
  compileTemplate,
  metaLanguageFor,
  normText,
  parseOurName,
  prefillFromSms,
  sourceFromPositional,
  waSourceSchema,
  type WaSource,
} from '../core/whatsapp/template';
import { checkWhatsAppTemplate } from '../core/whatsapp/checks';
import type { WaDisplay } from '../core/whatsapp/status';
import { whatsappTemplateIdFor } from '../core/runtime/ids';
import { ApiError, conflict, notFound, validationFailed } from '../api/errors';
import { cachedEngineSettings } from '../store/engineSettings';
import { toJson } from '../store/serialize';
import { sandboxEnabled } from '../engine/clock';
import { loadCatalogue } from './catalogue';
import { STOP_LINES } from '../send/compose';
import { metaClient } from '../whatsapp/source';
import { checkConnection } from '../whatsapp/connection';
import { submitTemplate } from '../whatsapp/submit';
import { reconcile, runWhatsAppTemplateTick } from '../whatsapp/sync';
import { noteTemplateHint } from '../whatsapp/hints';
import { SANDBOX_FAULTS, SANDBOX_WABA_ID, queueSandboxFaults, sandboxDecide, type SandboxDecision } from '../whatsapp/sandbox';
import { checkContext, loadPools, poolFor, templateView, visitorBaseUrl } from '../whatsapp/context';
import { staleTemplate } from '../whatsapp/store';
import {
  adminActor,
  changeTemplate,
  claimLease,
  createDraftDoc,
  createsThisHour,
  getTemplate,
  listLog,
  listTemplates,
  readOps,
  releaseLease,
  type StoredTemplate,
  type WaActor,
} from '../whatsapp/store';
import type { Actor } from '../core/schemas';

const TEMPLATE_ID = /^wt_[0-9a-f]{32}$/;

export function templateIdParam(value: unknown): string {
  const s = String(value ?? '');
  if (!TEMPLATE_ID.test(s)) throw new ApiError('bad_request', 'Not a template id');
  return s;
}

const managerUrl = (wabaId: string | null) => (wabaId ? `https://business.facebook.com/wa/manage/message-templates/?waba_id=${encodeURIComponent(wabaId)}` : null);

const RANK: Record<string, number> = { approved: 1, in_review: 2, submitting: 3, ready: 4, needs_fix: 5, rejected: 6, paused: 7, disabled: 8, blocked: 9, attention: 10, deleted: 11 };
const WAITING: ReadonlySet<WaDisplay> = new Set(['ready', 'needs_fix']);
const WITH_META: ReadonlySet<WaDisplay> = new Set(['in_review', 'submitting']);
const PROBLEMS: ReadonlySet<WaDisplay> = new Set(['rejected', 'paused', 'disabled', 'blocked', 'attention']);

async function who(actor: Actor): Promise<WaActor> {
  return adminActor(actor.uid);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getWhatsAppOverview() {
  const [ops, docs, pools, settings] = await Promise.all([readOps(), listTemplates(), loadPools(), cachedEngineSettings()]);
  const views = docs.map((d) => templateView(d, pools, checkContext(pools, docs, ops, d.use))) as Array<ReturnType<typeof templateView> & { display: WaDisplay }>;
  const messages = pools.map((p) => {
    const cells: Record<string, unknown> = {};
    for (const lang of LANGS) {
      const mine = views.filter((v) => v.use?.kind === 'adaptive' && v.use.poolKey === p.poolKey && v.use.journeyKey === p.journeyKey && v.lang === lang && !v.dismissed);
      mine.sort((a, b) => Number(b.usable) - Number(a.usable) || (RANK[a.display] ?? 99) - (RANK[b.display] ?? 99));
      const best = mine[0];
      cells[lang] = best ? { display: best.display, templateId: best.id, name: best.name, usable: best.usable, count: mine.length } : { display: 'missing', templateId: null, name: null, usable: false, count: 0 };
    }
    return {
      journeyKey: p.journeyKey,
      journeyName: p.journeyName,
      poolKey: p.poolKey,
      name: p.poolName,
      purpose: p.purpose,
      rule: p.whatsappCategory,
      availability: p.availability,
      linkField: p.linkField,
      allowedFields: p.allowedFields,
      cells,
    };
  });
  const visible = views.filter((v) => !v.dismissed);
  const waiting = visible.filter((v) => WAITING.has(v.display));
  const atMeta = visible.filter((v) => WITH_META.has(v.display));
  const problems = visible.filter((v) => PROBLEMS.has(v.display));
  const client = metaClient();
  return {
    connection: ops.connection ? toJson(ops.connection) : null,
    wabaId: ops.wabaId,
    everWorked: ops.everWorked,
    configured: client.ready(),
    client: client.kind,
    lastSync: ops.lastSync ? toJson(ops.lastSync) : null,
    templateCount: ops.templateCount,
    templateLimit: ops.templateLimit,
    createsThisHour: createsThisHour(ops, Date.now()),
    managerUrl: managerUrl(ops.wabaId),
    alertsEmailSet: Boolean(settings.alerts.email),
    languages: LANGS,
    visitorBaseUrl: visitorBaseUrl(),
    messages,
    templates: views,
    counts: {
      total: views.length,
      waiting: waiting.length,
      atMeta: atMeta.length,
      problems: problems.length,
      approved: visible.filter((v) => v.display === 'approved').length,
      dismissed: views.length - visible.length,
    },
    badge: waiting.length + problems.length,
  };
}

export async function getWhatsAppTemplate(id: string) {
  const [doc, ops, docs, pools] = await Promise.all([getTemplate(id), readOps(), listTemplates(), loadPools()]);
  if (!doc) throw notFound('No such template');
  const history = (await listLog({ templateId: id, limit: 50, routine: true })).rows;
  return {
    template: templateView(doc, pools, checkContext(pools, docs, ops, doc.use), { full: true }),
    history,
    managerUrl: managerUrl(ops.wabaId),
  };
}

const logQuerySchema = z.object({
  templateId: z.string().regex(TEMPLATE_ID).optional(),
  before: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  routine: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export async function listWhatsAppLog(query: Record<string, unknown>) {
  const q = logQuerySchema.parse(query ?? {});
  const page = await listLog({ templateId: q.templateId ?? null, before: q.before ?? null, limit: q.limit, routine: q.routine });
  return { log: page.rows, nextBefore: page.nextBefore };
}

const prefillSchema = z.object({ journeyKey: z.string().max(64), poolKey: z.string().max(64), lang: z.enum(LANGS) });

/** A first draft from the message's SMS wording in that language (English when it has none). */
export async function prefillWhatsAppDraft(query: Record<string, unknown>) {
  const q = prefillSchema.parse(query ?? {});
  const pools = await loadPools();
  const pool = poolFor(pools, { kind: 'adaptive', journeyKey: q.journeyKey, poolKey: q.poolKey });
  if (!pool) throw notFound('No such message, or it can’t go by WhatsApp');
  const cat = await loadCatalogue();
  const wording = cat.variants.filter((v) => v.poolKey === q.poolKey && v.status === 'active').sort((a, b) => a.letter.localeCompare(b.letter))[0];
  const sms = wording ? (wording.locales?.[q.lang]?.sms?.text ?? (q.lang === 'en' ? wording.channels.sms?.text : null) ?? null) : null;
  const category = pool.whatsappCategory === 'utility' ? 'UTILITY' : 'MARKETING';
  const source = prefillFromSms(sms ?? (wording?.channels.sms?.text ?? null), { lang: q.lang, category, linkField: pool.linkField, footers: STOP_LINES });
  return { source, category, fromLanguage: sms ? q.lang : 'en' };
}

// ── Drafts ───────────────────────────────────────────────────────────────────

const useSchema = z.object({ journeyKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), poolKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict();

const draftSchema = z
  .object({
    use: useSchema,
    lang: z.enum(LANGS),
    category: z.enum(WA_REQUESTABLE),
    source: waSourceSchema,
    /** A new language of an existing name of ours (same message). */
    name: z.string().regex(/^hf_[a-z0-9_]{1,200}$/).optional(),
  })
  .strict();

const checkSchema = draftSchema.extend({ id: z.string().regex(TEMPLATE_ID).optional() }).strict();

/** The checks of a draft as typed (the editor calls this as you type). Nothing is saved. */
export async function checkWhatsAppDraft(body: unknown) {
  const input = checkSchema.parse(body ?? {});
  // As you type: the 30 s catalogue cache is plenty (a save and a submit read it fresh).
  const [ops, docs, pools] = await Promise.all([readOps(), listTemplates(), loadPools({ fresh: false })]);
  const use = { kind: 'adaptive' as const, ...input.use };
  const existing = input.id ? docs.find((d) => d.id === input.id) ?? null : null;
  const name = existing?.name ?? input.name ?? `hf_${input.use.poolKey}_${Math.max(1, ops.nextNumber[input.use.poolKey] ?? 1)}`;
  const compiled = compileTemplate(input.source, { lang: input.lang, visitorBaseUrl: visitorBaseUrl() });
  const report = checkWhatsAppTemplate(
    {
      id: existing?.id ?? whatsappTemplateIdFor(name, metaLanguageFor(input.lang)),
      name,
      lang: input.lang,
      requestedCategory: input.category,
      use,
      source: input.source,
      compiled,
      atMeta: existing ? existing.stage !== 'draft' : false,
      nameLocked: existing?.lastSubmitError?.code === 'name_locked',
    },
    checkContext(pools, docs, ops, use),
  );
  return { checks: report, compiled: { bodyText: compiled.bodyText, footerText: compiled.footerText, button: compiled.button, params: compiled.params }, name };
}

function sameSource(a: WaSource | null, b: WaSource): boolean {
  if (!a) return false;
  const btn = (x: WaSource['button']) => (x ? `${x.field}|${x.text}` : '');
  return a.body === b.body && (a.footer ?? null) === (b.footer ?? null) && btn(a.button) === btn(b.button);
}

export async function createWhatsAppDraft(body: unknown, actor: Actor) {
  const input = draftSchema.parse(body ?? {});
  const by = await who(actor);
  const pools = await loadPools();
  const pool = poolFor(pools, { kind: 'adaptive', ...input.use });
  if (!pool) throw validationFailed('This message can’t go by WhatsApp', [{ code: 'T04', severity: 'error', message: 'This message can’t go by WhatsApp' }]);
  if (input.name) {
    const ours = parseOurName(input.name);
    if (!ours || ours.poolKey !== input.use.poolKey) throw new ApiError('bad_request', 'That name belongs to another message');
    const docs = await listTemplates();
    if (!docs.some((d) => d.name === input.name)) throw notFound(`No template “${input.name}” to add a language to`);
  }
  const language = metaLanguageFor(input.lang);
  const compiled = compileTemplate(input.source, { lang: input.lang, visitorBaseUrl: visitorBaseUrl() });
  const doc = await createDraftDoc(
    {
      poolKey: input.use.poolKey,
      lang: input.lang,
      existingName: input.name ?? null,
      build: (name) => ({
        create: {
          name,
          language,
          lang: input.lang,
          use: { kind: 'adaptive', ...input.use },
          origin: 'manual',
          requestedCategory: input.category,
          source: input.source,
          compiled,
          meta: null,
          stage: 'draft',
          submit: null,
          lastSubmitError: null,
          dismissed: false,
          useEnabled: true,
          version: 1,
          hint: null,
          ai: null,
          createdBy: actor.uid,
          updatedBy: actor.uid,
        },
        log: {
          kind: 'draft.created',
          level: 'info',
          actor: by,
          summary: `Draft ${name} (${language}) written for “${pool.poolName}” as ${input.category}`,
          to: 'draft',
          detail: { category: input.category, poolKey: input.use.poolKey, journeyKey: input.use.journeyKey, newLanguageOf: input.name ?? null },
        },
      }),
    },
    whatsappTemplateIdFor,
  );
  return getWhatsAppTemplate(doc.id);
}

const saveSchema = z
  .object({
    change: z.object({ source: waSourceSchema.optional(), category: z.enum(WA_REQUESTABLE).optional() }).strict(),
    baseVersion: z.number().int().min(0),
  })
  .strict();

const EDITABLE_AT_META = new Set(['REJECTED', 'PAUSED']);

export async function saveWhatsAppDraft(id: string, body: unknown, actor: Actor) {
  const input = saveSchema.parse(body ?? {});
  if (!input.change.source && !input.change.category) throw new ApiError('no_changes', 'Nothing to change');
  const by = await who(actor);
  await changeTemplate(id, (cur) => {
    if (!cur) throw notFound('No such template');
    if (cur.version !== input.baseVersion) throw staleTemplate();
    if (cur.use?.kind !== 'adaptive' || !cur.lang) throw conflict('Only templates for Adaptive messages are edited here');
    const metaStatus = String(cur.meta?.status ?? '').toUpperCase();
    const editable = cur.stage === 'draft' || (cur.stage === 'submitted' && EDITABLE_AT_META.has(metaStatus));
    if (!editable) throw conflict(cur.stage === 'submitting' ? 'It is being sent to Meta' : 'Meta has it: an approved template can’t change here — write new wording (a new name) instead');
    const source = input.change.source ?? cur.source;
    if (!source) throw conflict('This template has no text of ours (link it first)');
    const category = input.change.category ?? cur.requestedCategory;
    if (sameSource(cur.source, source) && category === cur.requestedCategory) throw new ApiError('no_changes', 'Nothing changed');
    const compiled = compileTemplate(source, { lang: cur.lang, visitorBaseUrl: visitorBaseUrl() });
    return {
      set: { source, compiled, requestedCategory: category, version: cur.version + 1, updatedBy: actor.uid, lastSubmitError: cur.lastSubmitError?.code === 'name_locked' ? cur.lastSubmitError : null },
      log: {
        kind: cur.stage === 'draft' ? 'draft.saved' : 'template.edited',
        level: 'info',
        actor: by,
        summary:
          cur.stage === 'draft'
            ? `Draft ${cur.name} (${cur.language}) saved${category !== cur.requestedCategory ? ` as ${category}` : ''}`
            : `${cur.name} (${cur.language}) edited after Meta ${metaStatus.toLowerCase()} it — send it to Meta again`,
        detail: { categoryBefore: cur.requestedCategory, category, textChanged: !sameSource(cur.source, source) },
      },
    };
  });
  return getWhatsAppTemplate(id);
}

const submitSchema = z.object({ baseVersion: z.number().int().min(0) }).strict();

export async function submitWhatsAppTemplate(id: string, body: unknown, actor: Actor) {
  const input = submitSchema.parse(body ?? {});
  const by = await who(actor);
  const res = await submitTemplate(id, input.baseVersion, by);
  const view = await getWhatsAppTemplate(id);
  return { outcome: res.outcome, error: res.error, ...view };
}

export async function setWhatsAppDismissed(id: string, dismissed: boolean, actor: Actor) {
  const by = await who(actor);
  await changeTemplate(id, (cur) => {
    if (!cur) throw notFound('No such template');
    if (cur.use?.kind === 'otp') throw conflict('The guest-login code template can’t be hidden');
    if (cur.stage === 'submitting') throw conflict('It is being sent to Meta');
    if (cur.dismissed === dismissed) return null;
    return {
      set: { dismissed, updatedBy: actor.uid },
      log: {
        kind: dismissed ? 'template.dismissed' : 'template.restored',
        level: 'info',
        actor: by,
        summary: dismissed ? `${cur.name} (${cur.language}) dismissed: not shown as waiting and never used (Meta keeps its copy)` : `${cur.name} (${cur.language}) restored`,
      },
    };
  });
  return getWhatsAppTemplate(id);
}

const linkSchema = z
  .object({
    use: useSchema,
    map: z.array(z.object({ n: z.number().int().min(1).max(20), field: z.enum(WA_BODY_FIELDS), fallback: z.string().trim().max(60).nullable().optional(), date: z.string().max(20).nullable().optional() }).strict()).max(20),
    buttonField: z.enum(WA_BUTTON_FIELDS).nullable().default(null),
    baseVersion: z.number().int().min(0),
  })
  .strict();

/** Ties a template made elsewhere (WhatsApp Manager, the old catalogue) to an Adaptive message: its fields get names. */
export async function linkWhatsAppTemplate(id: string, body: unknown, actor: Actor) {
  const input = linkSchema.parse(body ?? {});
  const by = await who(actor);
  const pools = await loadPools();
  const pool = poolFor(pools, { kind: 'adaptive', ...input.use });
  if (!pool) throw validationFailed('This message can’t go by WhatsApp', [{ code: 'T04', severity: 'error', message: 'This message can’t go by WhatsApp' }]);
  await changeTemplate(id, (cur) => {
    if (!cur) throw notFound('No such template');
    if (cur.version !== input.baseVersion) throw staleTemplate();
    if (cur.use?.kind === 'otp') throw conflict('The guest-login code template can’t be linked');
    if (cur.stage !== 'submitted' || !cur.meta?.bodyText) throw conflict('Only a template Meta has can be linked');
    if (!cur.lang) throw conflict('Its language isn’t one of ours (en, de, fr, it)');
    const vars = [...cur.meta.bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
    const missing = [...new Set(vars)].filter((n) => !input.map.some((m) => m.n === n));
    if (missing.length) throw new ApiError('bad_request', `Say which field {{${missing.join('}}, {{')}}} is`);
    const order = [...new Set(vars)];
    if (order.some((n, i) => n !== i + 1)) throw conflict('Its fields aren’t numbered in reading order ({{1}} first): it can’t be linked; write it again as a new template');
    const body = sourceFromPositional(cur.meta.bodyText, input.map);
    const urlButton = cur.meta.buttons.find((b) => b.type === 'URL');
    // A link button with a variable needs our link, or every send fails at Meta (132000).
    if (urlButton && /\{\{\s*1\s*\}\}/.test(urlButton.url ?? '') && !input.buttonField) throw new ApiError('bad_request', 'Its button has a link to fill in: say which page it opens');
    const source: WaSource = {
      body,
      footer: cur.meta.footerText,
      button: input.buttonField && urlButton ? { text: urlButton.text ?? '', field: input.buttonField } : null,
    };
    const compiled = compileTemplate(source, { lang: cur.lang, visitorBaseUrl: visitorBaseUrl() });
    if (normText(compiled.bodyText) !== normText(cur.meta.bodyText)) throw conflict('The fields don’t match Meta’s text');
    const category = cur.meta.category === 'MARKETING' || cur.meta.category === 'UTILITY' ? cur.meta.category : null;
    return {
      set: { use: { kind: 'adaptive', ...input.use }, source, compiled, requestedCategory: category, version: cur.version + 1, updatedBy: actor.uid },
      log: {
        kind: 'template.linked',
        level: 'info',
        actor: by,
        summary: `${cur.name} (${cur.language}) linked to “${pool.poolName}”`,
        from: cur.use?.kind ?? null,
        to: 'adaptive',
        detail: { journeyKey: input.use.journeyKey, poolKey: input.use.poolKey, map: input.map, buttonField: input.buttonField },
      },
    };
  });
  return getWhatsAppTemplate(id);
}

const useBodySchema = z.object({ enabled: z.boolean() }).passthrough();

/** Pause or resume our use of a template (the brake: no baseVersion, never refused for a stale screen). */
export async function setWhatsAppUse(id: string, body: unknown, actor: Actor) {
  const { enabled } = useBodySchema.parse(body ?? {});
  const by = await who(actor);
  await changeTemplate(id, (cur) => {
    if (!cur) throw notFound('No such template');
    if (cur.use?.kind !== 'adaptive') throw conflict('Only templates for Adaptive messages are paused here');
    if ((cur.useEnabled !== false) === enabled) return null;
    return {
      set: { useEnabled: enabled, updatedBy: actor.uid },
      log: {
        kind: enabled ? 'use.resumed' : 'use.paused',
        level: enabled ? 'info' : 'warn',
        actor: by,
        summary: enabled ? `${cur.name} (${cur.language}) may be used again` : `${cur.name} (${cur.language}) paused: Adaptive won’t send it (Meta keeps it approved)`,
      },
    };
  });
  return getWhatsAppTemplate(id);
}

// ── Connection and sync ──────────────────────────────────────────────────────

export async function checkWhatsAppConnection(actor: Actor) {
  const connection = await checkConnection(await who(actor));
  return { connection: toJson(connection) };
}

const wabaSchema = z.object({ wabaId: z.string().trim().regex(/^[A-Za-z0-9_]{3,40}$/, 'not an account id') }).strict();

export async function setWhatsAppWaba(body: unknown, actor: Actor) {
  const { wabaId } = wabaSchema.parse(body ?? {});
  const connection = await checkConnection(await who(actor), { wabaId });
  if (connection.wabaId !== wabaId || !connection.phoneFound) {
    throw validationFailed('That account doesn’t own the number the server sends from', connection.problems.map((p) => ({ code: 'T00', severity: 'error' as const, message: p })));
  }
  return { connection: toJson(connection) };
}

export async function syncWhatsAppNow(actor: Actor) {
  const by = await who(actor);
  const ops = await readOps();
  if (!ops.wabaId) throw conflict('Check the Meta connection first');
  const owner = `manual_${randomUUID().slice(0, 8)}`;
  if (!(await claimLease(owner, 2 * 60_000))) return { running: true };
  try {
    // 35 s for the whole run (the cms proxy allows 60): alerts are left to the tick (≤ 2 minutes).
    const sync = await reconcile({ by, budgetMs: 35_000, reason: 'manual' });
    return { running: false, sync };
  } finally {
    await releaseLease(owner);
  }
}

// ── Sandbox (dev routes; 404 unless ADAPTIVE_SANDBOX=1 runs against the emulator) ──

function requireSandbox(): void {
  if (!sandboxEnabled()) throw notFound('Not found');
}

const reviewSchema = z
  .object({
    templateId: z.string().regex(TEMPLATE_ID).optional(),
    name: z.string().max(512).optional(),
    language: z.string().max(16).optional(),
    decision: z.enum(['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'PENDING_DELETION', 'DELETED', 'RECATEGORISE', 'QUALITY']),
    reason: z.string().max(60).optional(),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
    quality: z.enum(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']).optional(),
    /** Also send the webhook notice Meta would send (default true). */
    hint: z.boolean().default(true),
  })
  .strict();

const FIELD_OF: Record<string, string> = { RECATEGORISE: 'template_category_update', QUALITY: 'message_template_quality_update' };

export async function devWhatsAppReview(body: unknown) {
  requireSandbox();
  const p = reviewSchema.parse(body ?? {});
  let name = p.name;
  let language = p.language;
  let metaId: string | undefined;
  if (p.templateId) {
    const doc: StoredTemplate | null = await getTemplate(p.templateId);
    if (!doc) throw notFound('No such template');
    name = doc.name;
    language = doc.language;
    metaId = doc.meta?.id ?? undefined;
  }
  if (!metaId && !(name && language)) throw new ApiError('bad_request', 'Give a templateId, or a name and language');
  let meta: Record<string, unknown>;
  try {
    meta = await sandboxDecide({ metaId, name, language }, { decision: p.decision as SandboxDecision, reason: p.reason, category: p.category, quality: p.quality });
  } catch (err) {
    throw notFound((err as Error).message);
  }
  if (p.hint) {
    await noteTemplateHint(SANDBOX_WABA_ID, FIELD_OF[p.decision] ?? 'message_template_status_update', {
      event: p.decision,
      message_template_name: meta.name,
      message_template_language: meta.language,
      message_template_id: meta.id,
    });
  }
  return { meta };
}

const faultSchema = z
  .object({ items: z.array(z.object({ op: z.enum(['debug', 'phones', 'list', 'get', 'find', 'create', 'edit', 'any']), fault: z.enum(SANDBOX_FAULTS) }).strict()).min(1).max(20) })
  .strict();

export async function devWhatsAppFault(body: unknown) {
  requireSandbox();
  const p = faultSchema.parse(body ?? {});
  return { queued: await queueSandboxFaults(p.items) };
}

export async function devWhatsAppTick() {
  requireSandbox();
  return { tick: await runWhatsAppTemplateTick() };
}

