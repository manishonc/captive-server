/**
 * Storage of the AI foundation (PR F2a) — the only file in captive-server that reads or writes these
 * collections (the cms relay also writes its daily count `relay-{yyyymmdd}` to AgentUsage, and the
 * cms account delete strips AgentUsage and deletes AgentRuns):
 *
 *  - `CaptivePortal_Agents/{agentKey}`: an agent's settings. A missing doc, or a field that can't
 *    be read, is the code's default (and a scheduled agent is off until HeidiFi turns it on).
 *  - `CaptivePortal_AgentRuns/{runId}`: one record per run (skipped ones too): what went in (the
 *    package as JSON text), what came back, the checks, tokens, cost, time. Written `running`
 *    before the model is called — in one transaction with a check that the worker still holds the
 *    task's lease — and finished after; a run the worker dies in is closed by the task's next
 *    attempt (`interrupted`, counted at its worst case).
 *    It names its usage docs from the start (`usageDocs`: the cms account delete strips the
 *    account's share there, even from a run still going). `expireAt` +13 months for the TTL
 *    policy (set by hand in the Firebase console).
 *  - `CaptivePortal_AgentUsage`: `month_{yyyymm}` (the platform's spend, per agent and per
 *    account) and `{agentKey}_{yyyymmdd}` (runs, outcomes, tokens, cost). Real UTC dates. An
 *    account's share is only written while its run's record exists (the account delete removes
 *    the records, then the shares).
 *  - Sandbox only: the fake model's request log and its queued answers.
 *
 * Reads are by id except the admin run log (newest first by `createdAt`) and the sweep of
 * unfinished runs (by `status`): single-field queries, so no composite index, and the worker's
 * start check is unchanged.
 */

import { randomUUID } from 'crypto';
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { COL } from './collections';
import { toJson } from './serialize';
import { tsMs } from './time';
import { isKnownModel, NO_USAGE, type ModelUsage } from '../brain/models';
import { counterValue, dayKeyOf, monthKeyOf } from '../brain/budget';
import type { AgentJob, AgentKey, AgentSettings, RunOutcome } from '../brain/types';

const DAY_MS = 24 * 60 * 60_000;
export const RUN_KEEP_MS = 396 * DAY_MS; // 13 months
/** An agent's output limit (thinking included): what a model writes within one call's time limit. */
export const MAX_OUTPUT_TOKENS = 8_000;

// ── Settings ─────────────────────────────────────────────────────────────────

const EFFORTS = ['low', 'medium', 'high'] as const;

function settingsSchema(job: AgentJob) {
  const d = job.defaults;
  return z.object({
    enabled: z.boolean().catch(false),
    model: z.string().refine(isKnownModel).catch(d.model),
    fallbackModel: z.string().refine(isKnownModel).nullable().catch(d.fallbackModel),
    effort: z.enum(EFFORTS).catch(d.effort),
    maxRunsPerDay: z.number().int().min(0).max(1000).catch(d.maxRunsPerDay),
    maxOutputTokens: z.number().int().min(256).max(MAX_OUTPUT_TOKENS).catch(d.maxOutputTokens),
    promptVersion: z
      .string()
      .refine((v) => Object.prototype.hasOwnProperty.call(job.prompts, v))
      .catch(d.promptVersion),
    version: z.number().int().min(0).catch(0),
    updatedAt: z.unknown().optional(),
    updatedBy: z.string().nullable().catch(null).optional(),
  });
}

/** An agent's settings from a stored doc (or none): every field on its own, falling back to the default. */
export function parseAgentSettings(job: AgentJob, raw: Record<string, unknown> | undefined): AgentSettings {
  const d = job.defaults;
  const p = settingsSchema(job).parse({ ...d, enabled: false, ...(raw ?? {}) });
  return {
    agentKey: job.key,
    enabled: p.enabled,
    model: p.model,
    fallbackModel: p.fallbackModel === p.model ? null : p.fallbackModel,
    effort: p.effort,
    maxRunsPerDay: p.maxRunsPerDay,
    maxOutputTokens: p.maxOutputTokens,
    promptVersion: p.promptVersion,
    version: p.version,
    updatedAt: (toJson(p.updatedAt ?? null) as string | null) ?? null,
    updatedBy: p.updatedBy ?? null,
  };
}

export async function readAgentSettings(job: AgentJob): Promise<AgentSettings> {
  const snap = await db.collection(COL.agents).doc(job.key).get();
  return parseAgentSettings(job, snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
}

export type AgentSettingsChange = Partial<Pick<AgentSettings, 'enabled' | 'model' | 'fallbackModel' | 'effort' | 'maxRunsPerDay' | 'maxOutputTokens' | 'promptVersion'>>;

export class StaleSettingsError extends Error {
  constructor(readonly version: number) {
    super('stale');
    this.name = 'StaleSettingsError';
  }
}

/**
 * One transaction: refuses a stale `baseVersion`, writes the whole settings doc, bumps `version`.
 * Turning an agent off (and nothing else) is the brake: it goes through on a stale card too.
 */
export async function writeAgentSettings(job: AgentJob, change: AgentSettingsChange, baseVersion: number, by: string): Promise<AgentSettings> {
  const ref = db.collection(COL.agents).doc(job.key);
  const brakeOnly = Object.keys(change).length === 1 && change.enabled === false;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = parseAgentSettings(job, snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
    if (current.version !== baseVersion && !brakeOnly) throw new StaleSettingsError(current.version);
    const next: AgentSettings = { ...current, ...change, version: current.version + 1, updatedBy: by };
    if (next.fallbackModel === next.model) next.fallbackModel = null;
    const stored = {
      agentKey: job.key,
      enabled: next.enabled,
      model: next.model,
      fallbackModel: next.fallbackModel,
      effort: next.effort,
      maxRunsPerDay: next.maxRunsPerDay,
      maxOutputTokens: next.maxOutputTokens,
      promptVersion: next.promptVersion,
      version: next.version,
      updatedAt: new Date(),
      updatedBy: by,
    };
    tx.set(ref, stored);
    return parseAgentSettings(job, stored);
  });
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface RunAttempt {
  model: string;
  ms: number;
  /** A short code ('rate_limited', 'timeout', 'unauthorized'…) or null when the model answered. */
  error: string | null;
  status: number | null;
  /** The relay's / gateway's own words for a failure (type: message, capped), or null. */
  detail: string | null;
  /** The request reached the relay (so it may have been billed, and counts toward runs per day). */
  reachedRelay: boolean;
}

export interface RunStart {
  runId: string;
  agentKey: AgentKey;
  trigger: string;
  taskId: string | null;
  attempt: number;
  tenantUserId: string | null;
  venueId: string | null;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  promptVersion: string | null;
  client: string;
  input: { summary: string; hash: string | null; package: string | null; chars: number };
  /** The usage docs this run is counted in (the month's and the agent's day's, by the run's start). */
  usageDocs: string[];
  /** The request's size as sent and the output limit: what an interrupted run is costed at. */
  requestBytes?: number;
  maxOutputTokens?: number;
  realNow: number;
}

/** The task lease a run must still hold when its record is written (the model call follows). */
export interface RunLease {
  taskId: string;
  workerId: string;
}

export interface RunFinish {
  outcome: RunOutcome;
  reason: string | null;
  modelUsed: string | null;
  fallbackUsed: boolean;
  attempts: RunAttempt[];
  stopReason: string | null;
  refusalCategory: string | null;
  output: { text: string | null; parsed: string | null; reasoning: string | null };
  checks: Array<{ code: string; ok: boolean; detail: string }>;
  usage: ModelUsage;
  costMicroUsd: number;
  price: Record<string, unknown> | null;
  latencyMs: number;
  error: string | null;
  privacyFindings?: Array<{ kind: string; path: string }>;
  /** The model the provider says answered. */
  modelReported?: string | null;
  /** Part of `costMicroUsd` estimated for calls that timed out after reaching the relay (maybe billed). */
  estimatedMicroUsd?: number;
  /** False when the spend counters couldn't be updated (the run still happened). */
  usageCounted?: boolean;
}

const runs = () => db.collection(COL.agentRuns);

/**
 * Writes the record `running`: true, false when this run id is already recorded (the same task
 * attempt twice), or `lease_lost` when a lease is given and this worker no longer holds it — then
 * nothing is written and the caller must not call the model (another attempt owns the task).
 */
export async function startRun(r: RunStart, lease?: RunLease): Promise<boolean | 'lease_lost'> {
  const ref = runs().doc(r.runId);
  // The transaction may be retried after a commit that did land but answered late: the nonce
  // tells our own record from another attempt's.
  const startNonce = randomUUID();
  const doc = {
    startNonce,
    runId: r.runId,
    agentKey: r.agentKey,
    trigger: r.trigger,
    taskId: r.taskId,
    attempt: r.attempt,
    tenantUserId: r.tenantUserId,
    venueId: r.venueId,
    status: 'running',
    outcome: null,
    reason: null,
    model: r.model,
    fallbackModel: r.fallbackModel,
    effort: r.effort,
    promptVersion: r.promptVersion,
    client: r.client,
    input: r.input,
    usageDocs: r.usageDocs,
    requestBytes: r.requestBytes ?? 0,
    maxOutputTokens: r.maxOutputTokens ?? 0,
    createdAt: new Date(r.realNow),
    finishedAt: null,
    expireAt: new Date(r.realNow + RUN_KEEP_MS),
  };
  if (lease) {
    // One transaction with the lease check: a claim by another worker (which changes the lease)
    // lands either before it (nothing written) or after it (the next attempt sees this record).
    return db.runTransaction(async (tx) => {
      const [task, run] = await tx.getAll(db.collection(COL.journeyTasks).doc(lease.taskId), ref);
      if (run.exists) return run.get('startNonce') === startNonce;
      if (!task.exists || task.get('status') !== 'leased' || task.get('leaseOwner') !== lease.workerId) return 'lease_lost' as const;
      tx.create(ref, doc);
      return true;
    });
  }
  try {
    await ref.create(doc);
    return true;
  } catch (err) {
    const e = err as { code?: number | string; message?: string };
    if (e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message))) return false;
    throw err;
  }
}

export interface InterruptedClose {
  run: Record<string, unknown>;
  /** Did the run get as far as the model call (it recorded its request)? */
  calledModel: boolean;
  /** Counted by this close (the worst case), or 0: the run counted itself before it stopped, or never called. */
  costMicro: number;
  /** The month's spend before and after, when this close counted. */
  spend: { beforeMicro: number; afterMicro: number } | null;
}

/**
 * Closes a run its worker left `running` (it stopped during the call: a crash, or a restart that
 * outlasted the shutdown wait) as `failed / interrupted`, once — and counts it in the same
 * transaction: at `costOf` (the worst case: the call may have been billed) if it got as far as the
 * model call and hadn't counted its own spend yet. Null when the run isn't recorded or finished.
 */
export async function closeInterruptedRun(
  runId: string,
  realNow: number,
  costOf: (run: Record<string, unknown>) => number,
): Promise<InterruptedClose | null> {
  const ref = runs().doc(runId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'running') return null;
    const run = snap.data() as Record<string, unknown>;
    const calledModel = Number(run.requestBytes) > 0;
    const countedBefore = Boolean(run.countedAt);
    let costMicro = 0;
    let spend: InterruptedClose['spend'] = null;
    if (calledModel && !countedBefore) {
      costMicro = Math.max(0, Math.round(costOf(run)));
      const startedAt = tsMs(run.createdAt) ?? realNow;
      const entry: UsageEntry = {
        realNow: startedAt,
        agentKey: String(run.agentKey),
        runId,
        tenantUserId: typeof run.tenantUserId === 'string' ? run.tenantUserId : null,
        outcome: 'failed',
        counted: true,
        costMicro,
        usage: NO_USAGE,
      };
      const refs = usageRefs(entry);
      const [m, d] = await tx.getAll(refs.mRef, refs.dRef);
      spend = writeUsage(tx, entry, refs, m, d, true);
    }
    tx.update(ref, {
      status: 'done',
      outcome: 'failed',
      reason: 'interrupted',
      error: !calledModel
        ? 'The worker stopped before the model call; nothing was counted'
        : countedBefore
          ? 'The worker stopped after the call was counted, before the run was finished'
          : 'The worker stopped during the model call (a crash, or a restart that outlasted its shutdown wait); counted at the worst case',
      // A run that counted its own spend may still finish (and write its real result over this).
      ...(countedBefore
        ? { costMicroUsd: Number(run.countedMicroUsd) || 0, closedAfterCount: true }
        : { costMicroUsd: costMicro, estimatedMicroUsd: costMicro }),
      ...(calledModel && !countedBefore ? { countedAt: new Date(realNow), countedMicroUsd: costMicro } : {}),
      finishedAt: new Date(realNow),
    });
    return { run, calledModel, costMicro, spend };
  });
}

/** The runs still `running` (a handful at most; by `status` alone, no composite index), oldest first. */
export async function listRunningRuns(limit = 50): Promise<Array<{ runId: string; agentKey: string; createdAtMs: number | null }>> {
  const snap = await runs().where('status', '==', 'running').select('agentKey', 'createdAt').limit(limit).get();
  return snap.docs
    .map((d) => ({ runId: d.id, agentKey: String(d.get('agentKey')), createdAtMs: tsMs(d.get('createdAt')) }))
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
}

/**
 * Finishes the record: `finished`; `gone` when it no longer exists (an account delete took it
 * meanwhile — it is never re-created then); `closed` when another attempt already closed it as
 * interrupted and counted it at the worst case: it is kept as it is, matching what was counted
 * (a caller never applies an answer then). A record closed after the run had counted its own
 * spend (`closedAfterCount`) takes the real finish: the counters already match it.
 */
export interface FinishResult {
  state: 'finished' | 'gone' | 'closed';
  /**
   * Is the run counted now (by itself before, or by this finish — when `gone`, in the platform's
   * totals)? `false` for a `gone` record without `usage` means unknown: the record that says is gone.
   */
  counted: boolean;
  /** The month's spend before and after, when this finish counted it. */
  spend: { beforeMicro: number; afterMicro: number } | null;
}

/**
 * `usage`: the run's count, given when counting it earlier failed — it is counted here, in the
 * same transaction, unless the record says it already was (the earlier commit did land).
 */
export async function finishRun(runId: string, f: RunFinish, realNow: number, usage?: UsageEntry): Promise<FinishResult> {
  const ref = runs().doc(runId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      if (!usage) return { state: 'gone' as const, counted: false, spend: null };
      // Its account was deleted meanwhile and counting it failed: the platform's totals only, as
      // `addUsage` does (a count that landed unseen, or another attempt's close that counted it before
      // the delete, makes it twice — high, the safe side).
      const refs = usageRefs(usage);
      const [m, d] = await tx.getAll(refs.mRef, refs.dRef);
      return { state: 'gone' as const, counted: true, spend: writeUsage(tx, usage, refs, m, d, false) };
    }
    if (snap.get('status') !== 'running' && snap.get('closedAfterCount') !== true) return { state: 'closed' as const, counted: true, spend: null };
    let counted = Boolean(snap.get('countedAt'));
    let spend: FinishResult['spend'] = null;
    let countFields: Record<string, unknown> = {};
    if (!counted && usage) {
      const refs = usageRefs(usage);
      const [m, d] = await tx.getAll(refs.mRef, refs.dRef);
      spend = writeUsage(tx, usage, refs, m, d, true);
      counted = true;
      countFields = { countedAt: new Date(realNow), countedMicroUsd: Math.max(0, Math.round(usage.costMicro)) };
    }
    finishRunDoc(tx, ref, { ...f, usageCounted: counted }, realNow, countFields);
    return { state: 'finished' as const, counted, spend };
  });
}

function finishRunDoc(tx: Transaction, ref: DocumentReference, f: RunFinish, realNow: number, extra: Record<string, unknown> = {}): void {
  tx.update(ref, {
    ...extra,
      status: 'done',
      outcome: f.outcome,
      reason: f.reason,
      modelUsed: f.modelUsed,
      fallbackUsed: f.fallbackUsed,
      attempts: f.attempts,
      stopReason: f.stopReason,
      refusalCategory: f.refusalCategory,
      output: f.output,
      checks: f.checks,
      usage: f.usage,
      costMicroUsd: f.costMicroUsd,
      price: f.price,
      latencyMs: f.latencyMs,
      error: f.error,
      privacyFindings: f.privacyFindings ?? [],
      modelReported: f.modelReported ?? null,
      estimatedMicroUsd: f.estimatedMicroUsd ?? 0,
      usageCounted: f.usageCounted ?? true,
      finishedAt: new Date(realNow),
    });
}

/** Did a run with this id start (an earlier attempt of the same task got as far as the model)? */
export async function runExists(runId: string): Promise<boolean> {
  return (await runs().doc(runId).get()).exists;
}

/** The fields one run-log line needs (never the package or the answer). */
const LINE_FIELDS = [
  'runId',
  'agentKey',
  'trigger',
  'status',
  'outcome',
  'reason',
  'model',
  'modelUsed',
  'fallbackUsed',
  'input.summary',
  'tenantUserId',
  'venueId',
  'usage',
  'costMicroUsd',
  'estimatedMicroUsd',
  'latencyMs',
  'createdAt',
  'finishedAt',
];

/** Newest runs first (the admin run log, list fields only); `before` = an ISO time to page from. */
export async function listRuns(opts: { limit: number; before?: string | null; agentKey?: string | null }) {
  let q = runs().select(...LINE_FIELDS).orderBy('createdAt', 'desc');
  if (opts.before) {
    const t = Date.parse(opts.before);
    if (Number.isFinite(t)) q = q.startAfter(new Date(t));
  }
  // Filtering by agent in memory keeps the query on the single-field index (no composite).
  const page = await q.limit(opts.agentKey ? Math.min(opts.limit * 5, 500) : opts.limit).get();
  const rows = page.docs.map((d) => d.data()).filter((r) => !opts.agentKey || r.agentKey === opts.agentKey);
  return rows.slice(0, opts.limit).map((r) => toJson(r) as Record<string, unknown>);
}

export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const snap = await runs().doc(runId).get();
  return snap.exists ? (toJson(snap.data()) as Record<string, unknown>) : null;
}

// ── Usage ────────────────────────────────────────────────────────────────────

const usage = () => db.collection(COL.agentUsage);
export const monthUsageId = (month: string) => `month_${month}`;
export const dayUsageId = (agentKey: string, day: string) => `${agentKey}_${day}`;

/** The usage docs a run started at `realNow` is counted in: the month's and the agent's day's. */
export function usageDocIdsFor(agentKey: string, realNow: number): string[] {
  return [monthUsageId(monthKeyOf(realNow)), dayUsageId(agentKey, dayKeyOf(realNow))];
}

/** This month's platform spend and this agent's counted runs today. */
export async function readUsage(agentKey: string, realNow: number): Promise<{ spentMicro: number; runsToday: number }> {
  const [m, d] = await db.getAll(usage().doc(monthUsageId(monthKeyOf(realNow))), usage().doc(dayUsageId(agentKey, dayKeyOf(realNow))));
  return { spentMicro: counterValue(m.get('costMicroUsd')), runsToday: counterValue(d.get('runs')) };
}

export async function readMonthUsage(realNow: number): Promise<Record<string, unknown> | null> {
  const snap = await usage().doc(monthUsageId(monthKeyOf(realNow))).get();
  return snap.exists ? (toJson(snap.data()) as Record<string, unknown>) : null;
}

export async function readDayUsage(agentKey: string, realNow: number): Promise<Record<string, unknown> | null> {
  const snap = await usage().doc(dayUsageId(agentKey, dayKeyOf(realNow))).get();
  return snap.exists ? (toJson(snap.data()) as Record<string, unknown>) : null;
}

export interface UsageEntry {
  /** The run's start (real time): its usage docs are that month's and that day's. */
  realNow: number;
  agentKey: string;
  /**
   * The run's record: the account's share is only written while it exists (see the file header),
   * and a run is counted once — the record is marked `countedAt` in the same transaction.
   */
  runId?: string;
  tenantUserId: string | null;
  outcome: RunOutcome;
  /** Counts toward the agent's runs per day (every run that got as far as the model call). */
  counted: boolean;
  costMicro: number;
  usage: ModelUsage;
}

interface UsageRefs {
  month: string;
  day: string;
  mRef: DocumentReference;
  dRef: DocumentReference;
}

function usageRefs(e: UsageEntry): UsageRefs {
  const month = monthKeyOf(e.realNow);
  const day = dayKeyOf(e.realNow);
  return { month, day, mRef: usage().doc(monthUsageId(month)), dRef: usage().doc(dayUsageId(e.agentKey, day)) };
}

/** The counter writes of one run inside a transaction (its reads done): the month's spend before and after. */
function writeUsage(tx: Transaction, e: UsageEntry, refs: UsageRefs, m: DocumentSnapshot, d: DocumentSnapshot, recorded: boolean) {
  const inc = FieldValue.increment;
  const cost = Math.max(0, Math.round(e.costMicro));
  const beforeMicro = counterValue(m.get('costMicroUsd'));
  // A counter that can't be read stays as it is (an increment would reset it to this run's
  // amount): the budget keeps failing closed until a person fixes it (the admin card says so).
  const monthCost = Number.isFinite(beforeMicro) ? { costMicroUsd: inc(cost) } : {};
  const dayRuns = Number.isFinite(counterValue(d.get('runs'))) ? { runs: inc(e.counted ? 1 : 0) } : {};
  const byTenant = e.tenantUserId && cost > 0 && recorded ? { byTenant: { [e.tenantUserId]: inc(cost) } } : {};
  tx.set(
    refs.mRef,
    {
      month: refs.month,
      ...monthCost,
      runs: inc(e.counted ? 1 : 0),
      byAgent: { [e.agentKey]: { runs: inc(e.counted ? 1 : 0), costMicroUsd: inc(cost) } },
      ...byTenant,
      updatedAt: new Date(e.realNow),
    },
    { merge: true },
  );
  tx.set(
    refs.dRef,
    {
      agentKey: e.agentKey,
      day: refs.day,
      ...dayRuns,
      outcomes: { [e.outcome]: inc(1) },
      inputTokens: inc(e.usage.inputTokens),
      outputTokens: inc(e.usage.outputTokens),
      cacheReadTokens: inc(e.usage.cacheReadTokens),
      cacheWriteTokens: inc(e.usage.cacheWriteTokens),
      costMicroUsd: inc(cost),
      ...byTenant,
      updatedAt: new Date(e.realNow),
    },
    { merge: true },
  );
  return { beforeMicro, afterMicro: beforeMicro + cost };
}

/**
 * Adds one run to the day's and month's counters; returns the month's spend before and after.
 * A run is counted once: its record gets `countedAt` (and `countedMicroUsd`) in the same
 * transaction, and a run already counted — by itself, or by the attempt that closed it as
 * interrupted — is not counted again (whichever comes first counts).
 */
export async function addUsage(e: UsageEntry): Promise<{ beforeMicro: number; afterMicro: number }> {
  const refs = usageRefs(e);
  const cost = Math.max(0, Math.round(e.costMicro));
  return db.runTransaction(async (tx) => {
    const runRef = e.runId ? runs().doc(e.runId) : null;
    const snaps = runRef ? await tx.getAll(refs.mRef, refs.dRef, runRef) : await tx.getAll(refs.mRef, refs.dRef);
    const [m, d] = snaps;
    const run = runRef ? snaps[2] : null;
    if (run?.exists && run.get('countedAt')) {
      const before = counterValue(m.get('costMicroUsd'));
      return { beforeMicro: before, afterMicro: before };
    }
    // A run that ends after its account was deleted (the cms removes the records, then the
    // shares) adds to the platform's totals only.
    const recorded = runRef ? Boolean(run?.exists) : true;
    const spend = writeUsage(tx, e, refs, m, d, recorded);
    // `usageCounted`: a run that ended before the model call is finished first and counted after.
    if (runRef && run?.exists) tx.update(runRef, { countedAt: new Date(Date.now()), countedMicroUsd: cost, usageCounted: true });
    return spend;
  });
}

// ── Sandbox (the local emulator stack only; callers check sandboxEnabled()) ──────────────────

export type SandboxFault = 'refusal' | 'max_tokens' | 'bad_json' | 'rate_limit' | 'server_error' | 'timeout' | 'unauthorized' | 'unknown_model' | 'slow';

export interface SandboxAnswer {
  /** A JSON answer (object) or raw text; absent = the job's valid answer. */
  answer?: unknown;
  fault?: SandboxFault;
  /** For `slow`: how long the fake takes (ms). */
  ms?: number;
}

export async function queueSandboxAnswers(agentKey: string, answers: SandboxAnswer[]): Promise<number> {
  const ref = db.collection(COL.sandboxModelAnswers).doc(agentKey);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const queue = [...((snap.get('queue') as SandboxAnswer[] | undefined) ?? []), ...answers];
    tx.set(ref, { agentKey, queue });
    return queue.length;
  });
}

/** The next queued answer for this agent, taken off the queue (null = none queued). */
export async function takeSandboxAnswer(agentKey: string): Promise<SandboxAnswer | null> {
  const ref = db.collection(COL.sandboxModelAnswers).doc(agentKey);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const queue = (snap.get('queue') as SandboxAnswer[] | undefined) ?? [];
    if (!queue.length) return null;
    const [next, ...rest] = queue;
    tx.set(ref, { agentKey, queue: rest });
    return next;
  });
}

export async function logSandboxCall(id: string, call: Record<string, unknown>): Promise<void> {
  await db.collection(COL.sandboxModelCalls).doc(id).set({ ...call, at: new Date() });
}

export async function listSandboxCalls(limit: number): Promise<Array<Record<string, unknown>>> {
  const snap = await db.collection(COL.sandboxModelCalls).orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...(toJson(d.data()) as Record<string, unknown>) }));
}
