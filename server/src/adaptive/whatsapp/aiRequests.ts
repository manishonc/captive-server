/**
 * The API side of the AI template writer (PR W2): the writer's status for the tab, the brief and
 * its local part (built here, where the catalogue, the registry and the check context are — the
 * worker never loads whatsapp/context.ts), queuing a run, and the daily gap-fill the 2-minute tick
 * runs after a complete sync.
 *
 * Nothing here calls a model or Meta: a run is one `agent_run` task (brain/tasks.ts); the worker's
 * AI lane runs it. A request that can't run (the AI switch off, the budget or today's runs used,
 * a run already queued for the cell) is refused here, before anything is queued, so the run log
 * isn't filled with skips.
 */

import { randomUUID } from 'crypto';
import { firestoreScheduler, LIVE_TASK_STATES, taskStatuses, taskStatusInTx } from '../queue/firestoreQueue';
import { taskIdFor } from '../core/runtime/ids';
import { agentRunTask } from '../brain/tasks';
import { jobFor } from '../brain/registry';
import { scanPackage } from '../brain/privacy';
import { dayKeyOf } from '../brain/budget';
import { readAgentSettings, readUsage } from '../store/agents';
import { cachedEngineSettings } from '../store/engineSettings';
import { now as engineNow } from '../engine/clock';
import { loadCatalogue } from '../service/catalogue';
import type { Lang } from '../core/constants';
import { LANGS } from '../core/constants';
import { metaLanguageFor } from '../core/whatsapp/template';
import { canonicalField } from '../core/registry/mergeFields';
import { rejectionWords, type WaDisplay } from '../core/whatsapp/status';
import {
  buildWriterRequest,
  cellKeyOf,
  coverageGaps,
  writerCodeWords,
  type WriterBrief,
  type WriterKind,
  type WriterLocal,
  type WriterRefusal,
  type WriterRequester,
  type WriterTemplateView,
} from '../core/whatsapp/aiBrief';
import type { PoolRow } from '../core/whatsapp/pools';
import { checkContext, displayOf, loadPools, poolFor, reportFor } from './context';
import { writerViewOf } from './aiDrafts';
import { AUTO_ACTOR, SYSTEM, inTransaction, listTemplates, opsInTx, readOps, readOpsInTx, updateOps, writeLog, type StoredTemplate, type WaActor, type WaOps } from './store';
import { autoFixCandidates } from '../core/whatsapp/auto';
import { autoViewsFor } from './autoViews';

export const WRITER_KEY = 'wa_template_writer';
/** Of the writer's runs a day, this many are always left for "Suggest with AI" (the gap-fill takes the rest). */
export const SUGGEST_RESERVE = 3;
/** Gap-fill runs are spread out (one lane per worker runs one at a time anyway). */
const GAP_STAGGER_MS = 3 * 60_000;

export interface WriterStatus {
  /** The global AI switch (the writer is a platform job: per-account overrides don't count). */
  aiOn: boolean;
  /** The writer's "Scheduled runs" switch: the daily gap-fill (and, from W2b, the AI fixes). */
  scheduledOn: boolean;
  runsToday: number;
  maxRunsPerDay: number;
  /** Runs queued and not run yet (they will use today's runs). */
  queued: number;
  /** Today's runs not used and not taken by a queued run. */
  runsLeft: number;
  budgetOk: boolean;
  model: string;
  fallbackModel: string | null;
  /** Why "Suggest with AI" can't run now (null: it can). */
  blocked: 'ai_off' | 'budget' | 'daily_limit' | null;
}

/**
 * The cells with a writer run on its way: those whose mark's task is still queued or held by a
 * worker. A mark whose task is done, dead, cancelled or gone is not (so a run that ended in any
 * way — even one that never reported — never leaves its cell "writing").
 */
export async function livePendingCells(ops: WaOps): Promise<WaOps['aiPending']> {
  const entries = Object.entries(ops.aiPending);
  if (!entries.length) return {};
  const states = await taskStatuses(entries.map(([, e]) => e.taskId));
  return Object.fromEntries(entries.filter(([, e]) => LIVE_TASK_STATES.has(states.get(e.taskId) ?? '')));
}

/** `queued`: the live pending cells when the caller has them (else they are read). */
export async function writerStatus(realNow: number = Date.now(), queued?: number): Promise<WriterStatus> {
  const job = jobFor(WRITER_KEY);
  if (!job) throw new Error('The WhatsApp template writer is not registered');
  const [engine, settings, usage, waiting] = await Promise.all([
    cachedEngineSettings(),
    readAgentSettings(job),
    readUsage(WRITER_KEY, realNow),
    queued ?? readOps().then(async (ops) => Object.keys(await livePendingCells(ops)).length),
  ]);
  const aiOn = engine.agents?.mode === 'on';
  const budgetUsd = engine.agents?.monthlyBudgetUsd ?? 0;
  const budgetOk = budgetUsd > 0 && usage.spentMicro < budgetUsd * 1_000_000;
  const runsLeft = Number.isFinite(usage.runsToday) ? Math.max(0, settings.maxRunsPerDay - usage.runsToday - waiting) : 0;
  return {
    aiOn,
    scheduledOn: settings.enabled,
    runsToday: Number.isFinite(usage.runsToday) ? usage.runsToday : settings.maxRunsPerDay,
    maxRunsPerDay: settings.maxRunsPerDay,
    queued: waiting,
    runsLeft,
    budgetOk,
    model: settings.model,
    fallbackModel: settings.fallbackModel,
    blocked: !aiOn ? 'ai_off' : !budgetOk ? 'budget' : runsLeft <= 0 ? 'daily_limit' : null,
  };
}

export function writerBlockedWords(b: WriterStatus['blocked']): string {
  switch (b) {
    case 'ai_off':
      return 'The AI agents are off: turn them on under Launch & health → AI agents (type AI ON). The writer follows the global switch only.';
    case 'budget':
      return 'This month’s AI budget is used up (Launch & health → AI agents).';
    case 'daily_limit':
      return 'The writer’s runs for today are used up or already queued; it runs again tomorrow (UTC), or raise its runs a day on the AI agents card.';
    default:
      return '';
  }
}

// ── Views of the registry ────────────────────────────────────────────────────

export interface RegistrySnapshot {
  docs: StoredTemplate[];
  pools: PoolRow[];
  ops: WaOps;
  /** Each template with its real display (the template checks included). */
  views: Map<string, WriterTemplateView>;
}

export async function registrySnapshot(): Promise<RegistrySnapshot> {
  const [docs, pools, ops] = await Promise.all([listTemplates(), loadPools(), readOps()]);
  return snapshotOf(docs, pools, ops);
}

export function snapshotOf(docs: StoredTemplate[], pools: PoolRow[], ops: WaOps, displays?: Map<string, WaDisplay>): RegistrySnapshot {
  const views = new Map<string, WriterTemplateView>();
  for (const d of docs) {
    const display = displays?.get(d.id) ?? displayOf(d, reportFor(d, checkContext(pools, docs, ops, d.use)), pools);
    views.set(d.id, writerViewOf(d, display));
  }
  return { docs, pools, ops, views };
}

/** Every template of one message (all languages, dismissed too). */
export function templatesOfMessage(snap: RegistrySnapshot, journeyKey: string, poolKey: string): WriterTemplateView[] {
  return snap.docs
    .filter((d) => d.use?.kind === 'adaptive' && d.use.journeyKey === journeyKey && d.use.poolKey === poolKey)
    .map((d) => snap.views.get(d.id)!)
    .filter(Boolean);
}

// ── A request ────────────────────────────────────────────────────────────────

type Wording = Partial<Record<Lang, { sms?: string | null; email?: string | null }>>;

/** The fields a text uses that this message's WhatsApp template can't carry (links aside: the button has them). */
function foreignFields(v: unknown, allowed: ReadonlySet<string>): number {
  const text = JSON.stringify(v ?? '');
  let n = 0;
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)) {
    const f = canonicalField(m[1]);
    if (!allowed.has(f) && !f.startsWith('link.')) n += 1;
  }
  return n;
}

/**
 * The message's active platform wording, per language (the seed has English and German): the
 * variant whose text WhatsApp can carry best — the fewest fields the template can't have (a
 * template serves every venue: "Checkout instructions" B, without the late check-out offer only
 * some venues make, rather than A) — then by letter.
 */
async function wordingFor(pool: PoolRow): Promise<Wording> {
  const { journeyKey, poolKey } = pool;
  const allowed = new Set(pool.allowedFields);
  const cat = await loadCatalogue();
  const v = cat.variants
    .filter((x) => x.poolKey === poolKey && (!x.journeyKey || x.journeyKey === journeyKey) && x.status === 'active' && x.scope === 'platform')
    .map((x) => ({ x, foreign: foreignFields({ channels: x.channels, locales: x.locales }, allowed) }))
    .sort((a, b) => a.foreign - b.foreign || a.x.letter.localeCompare(b.x.letter))[0]?.x;
  if (!v) return {};
  const out: Wording = {};
  for (const lang of LANGS) {
    const c = (v.locales?.[lang] ?? (lang === 'en' ? v.channels : null)) as Record<string, any> | null;
    if (!c) continue;
    const sms = typeof c.sms?.text === 'string' ? c.sms.text : null;
    const email = c.email && typeof c.email.subject === 'string' ? [c.email.subject, c.email.bodyFormat === 'text' && typeof c.email.body === 'string' ? c.email.body : ''].filter(Boolean).join('\n') : null;
    out[lang] = { sms, email };
  }
  return out;
}

export interface WriterRequestArgs {
  kind: WriterKind;
  requestedBy: WriterRequester;
  use: { journeyKey: string; poolKey: string };
  lang: Lang;
  templateId?: string | null;
}

export type WriterRequest = { brief: WriterBrief; local: WriterLocal; pool: PoolRow };

export async function writerRequestFor(a: WriterRequestArgs, snap?: RegistrySnapshot): Promise<WriterRequest | { refuse: WriterRefusal }> {
  const s = snap ?? (await registrySnapshot());
  const pool = poolFor(s.pools, { kind: 'adaptive', ...a.use });
  if (!pool) return { refuse: 'no_message' };
  const ctx = checkContext(s.pools, s.docs, s.ops, { kind: 'adaptive', ...a.use });
  const language = metaLanguageFor(a.lang);
  const templates = templatesOfMessage(s, pool.journeyKey, pool.poolKey);
  const target = a.templateId ? s.docs.find((d) => d.id === a.templateId) ?? null : null;
  // Only the siblings the checks can use (same language: duplicates; same name: one category).
  const sameName = a.kind === 'translation' || a.kind === 'fix' ? target?.name ?? null : null;
  ctx.siblings = ctx.siblings.filter((x) => x.language === language || (sameName && x.name === sameName));
  const built = buildWriterRequest({
    kind: a.kind,
    requestedBy: a.requestedBy,
    lang: a.lang,
    pool,
    templates,
    targetTemplateId: a.templateId ?? null,
    wording: await wordingFor(pool),
    checkCtx: ctx,
    hasContactData: (text) => scanPackage(text).length > 0,
    rejectionWords: (code) => rejectionWords(code),
  });
  if ('refuse' in built) return built;
  return { ...built, pool };
}

/**
 * Queues one writer run (an `agent_run` task) and marks its cell pending, in one transaction:
 * null when a run is already on its way for the cell (a double click, two ticks: the mark's task
 * is still queued or held). The task id is new each time (`key` + a random part): the queue ignores
 * a key it has seen, so a fixed key would leave a second Suggest in the same minute with a pending
 * mark and no task. A transaction the SDK replays after a commit that landed knows its own mark.
 * Then logs who asked.
 */
export async function queueWriterRun(args: {
  request: WriterRequest;
  trigger: 'manual' | 'schedule';
  key: string;
  by: WaActor;
  realNow: number;
  delayMs?: number;
  /** PR W2b: more ops fields written with the task (Auto's "one fix per rejection" stamp), given the task id. */
  extraOps?: (taskId: string) => Record<string, unknown>;
}): Promise<string | null> {
  const { brief, local } = args.request;
  const cell = cellKeyOf(local.use.journeyKey, local.use.poolKey, local.lang);
  const task = agentRunTask({ agentKey: WRITER_KEY, trigger: args.trigger, dedupeKey: `${args.key}:${randomUUID()}`, dueAt: engineNow() + (args.delayMs ?? 0), params: { brief, local } });
  const ownId = taskIdFor(task.dedupeKey);
  const taskId = await inTransaction(async (tx) => {
    const mark = (await readOpsInTx(tx)).aiPending[cell];
    if (mark?.taskId === ownId) return ownId;
    if (mark && LIVE_TASK_STATES.has((await taskStatusInTx(tx, mark.taskId)) ?? '')) return null;
    const id = firestoreScheduler.scheduleInTx(tx, task);
    opsInTx(tx, { aiPending: { [cell]: { taskId: id, kind: local.kind, atMs: args.realNow, by: args.by.label ?? args.by.kind } }, ...(args.extraOps ? args.extraOps(id) : {}) });
    return id;
  });
  if (!taskId) return null;
  const who = local.requestedBy === 'gap_fill' ? 'The daily gap-fill' : local.requestedBy === 'auto_fix' ? (args.by.kind === 'auto' ? 'Auto' : 'HeidiFi') : 'A Suggest';
  await writeLog(
    {
      kind: 'ai.requested',
      level: local.requestedBy === 'suggest' ? 'info' : 'routine',
      actor: args.by,
      summary: `${who} asked the AI for a ${local.kind} of “${args.request.pool.poolName}” (${local.lang.toUpperCase()})${local.requestedBy === 'auto_fix' ? ' after Meta rejected it' : ''}`,
      detail: { taskId, kind: local.kind, requestedBy: local.requestedBy, trigger: args.trigger, withheld: local.withheld, targetTemplateId: local.targetTemplateId },
    },
    { poolKey: local.use.poolKey, language: metaLanguageFor(local.lang), templateId: local.kind === 'fix' ? local.targetTemplateId : null },
  );
  return taskId;
}

export function writerRefusalWords(code: WriterRefusal | string): string {
  return writerCodeWords(code);
}

// ── The daily gap-fill ───────────────────────────────────────────────────────

/**
 * Once a (UTC) day, right after a complete sync: queue a writer run for each cell with nothing
 * usable or on its way (core/whatsapp/aiBrief.ts `coverageGaps`: English first, translations once
 * the English template is approved or in review), within the writer's runs left today minus the
 * Suggest reserve. Needs the AI switch, the writer's Scheduled runs switch and budget. The day is
 * stamped only when something was queued or nothing was missing (else the next complete sync tries
 * again). Returns how many runs it queued.
 */
export async function planGapFill(realNow: number = Date.now()): Promise<number> {
  const status = await writerStatus(realNow);
  if (!status.aiOn || !status.scheduledOn || !status.budgetOk) return 0;
  const snap = await registrySnapshot();
  const day = dayKeyOf(realNow);
  if (snap.ops.aiGapFill.lastDay === day) return 0;
  const pending = await livePendingCells(snap.ops);
  const gaps = coverageGaps({
    pools: snap.pools,
    templatesOf: (j, p) => templatesOfMessage(snap, j, p),
    realNow,
    cooldowns: snap.ops.aiGapFill.cooldowns,
    pending: new Set(Object.keys(pending)),
  });
  if (!gaps.length) {
    await updateOps({ aiGapFill: { lastDay: day } });
    return 0;
  }
  // `runsLeft` already counts the runs queued (Suggest's and the gap-fill's).
  const quota = Math.max(0, status.runsLeft - SUGGEST_RESERVE);
  if (quota <= 0) return 0;
  let queued = 0;
  for (const g of gaps) {
    if (queued >= quota) break;
    const req = await writerRequestFor({ kind: g.kind, requestedBy: 'gap_fill', use: { journeyKey: g.journeyKey, poolKey: g.poolKey }, lang: g.lang, templateId: g.englishId }, snap);
    if ('refuse' in req) continue;
    const taskId = await queueWriterRun({
      request: req,
      trigger: 'schedule',
      key: `wa:gap:${day}:${cellKeyOf(g.journeyKey, g.poolKey, g.lang)}`,
      by: { kind: 'system', uid: null, label: 'Daily gap-fill' },
      realNow,
      delayMs: queued * GAP_STAGGER_MS,
    });
    if (taskId) queued += 1;
  }
  if (queued) {
    await updateOps({ aiGapFill: { lastDay: day } });
    await writeLog({
      kind: 'ai.gap_fill',
      level: 'info',
      actor: { kind: 'system', uid: null, label: 'Daily gap-fill' },
      summary: `The daily gap-fill asked the AI for ${queued} missing template${queued === 1 ? '' : 's'} (${gaps.length} missing in all)`,
      detail: { queued, missing: gaps.length, runsLeft: status.runsLeft, reserve: SUGGEST_RESERVE },
    });
  }
  return queued;
}

// ── PR W2b: the AI fixes Auto asks for ────────────────────────────────────────

/**
 * Every tick, ask the AI to fix the AI templates Meta rejected — one fix run per rejection
 * (`ops.autoFix`: the Meta change each template's last fix was asked for), at most 2 AI fixes per
 * template (Suggest's count too). Needs the AI switch, the writer's Scheduled runs and budget; uses
 * the writer's runs left minus the Suggest reserve (before the gap-fill). Returns how many runs it
 * queued. `snap`: the registry the tick already read. With Auto off (`autoOn: false`, for now:
 * Manish, 2026-10-10) each fix is a draft a person sends; with Auto on, Auto sends it.
 */
export async function planAutoFixes(realNow: number, snap?: RegistrySnapshot, opts: { autoOn: boolean } = { autoOn: true }): Promise<number> {
  const actor = opts.autoOn ? AUTO_ACTOR : SYSTEM;
  const who = opts.autoOn ? 'Auto' : 'HeidiFi';
  const s = snap ?? (await registrySnapshot());
  const candidates = autoFixCandidates(autoViewsFor(s.docs, s.pools, s.ops), s.ops.autoFix);
  if (!candidates.length) return 0;
  const status = await writerStatus(realNow);
  if (!status.aiOn || !status.scheduledOn || !status.budgetOk) return 0;
  const pending = await livePendingCells(s.ops);
  const quota = Math.max(0, status.runsLeft - SUGGEST_RESERVE);
  let queued = 0;
  for (const v of candidates) {
    if (queued >= quota) break;
    const use = v.use!;
    const lang = v.lang!;
    if (pending[cellKeyOf(use.journeyKey, use.poolKey, lang)]) continue;
    const prev = s.ops.autoFix[v.id];
    const tries = prev && prev.at === v.metaChangedAtMs ? prev.tries + 1 : 1;
    const stamp = (taskId: string | null) => ({ autoFix: { [v.id]: { at: v.metaChangedAtMs, tries, taskId, retry: false } } });
    const req = await writerRequestFor({ kind: 'fix', requestedBy: 'auto_fix', use, lang, templateId: v.id }, s);
    if ('refuse' in req) {
      // Not one the AI can fix (its words say why): asked once for this rejection, never again.
      await updateOps(stamp(null));
      await writeLog(
        { kind: 'ai.auto_fix_skipped', level: 'routine', actor, summary: `${who} didn’t ask the AI to fix ${v.name} (${lang}): ${writerRefusalWords(req.refuse)}`, detail: { code: req.refuse } },
        { templateId: v.id, name: v.name, language: metaLanguageFor(lang), poolKey: use.poolKey },
      );
      continue;
    }
    const taskId = await queueWriterRun({
      request: req,
      trigger: 'schedule',
      key: `wa:autofix:${v.id}:v${v.version}`,
      by: actor,
      realNow,
      delayMs: queued * GAP_STAGGER_MS,
      extraOps: (taskId) => stamp(taskId),
    });
    if (taskId) queued += 1;
  }
  if (queued) {
    await writeLog({
      kind: 'ai.auto_fix',
      level: 'info',
      actor,
      summary: `${who} asked the AI to fix ${queued} template${queued === 1 ? '' : 's'} Meta rejected${opts.autoOn ? '' : ': each fix waits for you to send it to Meta'}`,
      detail: { queued, candidates: candidates.length, runsLeft: status.runsLeft, reserve: SUGGEST_RESERVE, autoOn: opts.autoOn },
    });
  }
  return queued;
}
