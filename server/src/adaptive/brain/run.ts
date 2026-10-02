/**
 * `runAgent()` — the one way to call a model (PR F2a; PRD 04 §9.3 "one wrapper for every AI
 * call"). Only the worker's AI lane calls it (brain/lane.ts); the API process never loads it.
 *
 *  0. A Test connection that waited over 10 minutes for a worker (one was down or idle) is
 *     skipped, and so is any attempt of a task another attempt of which already started: the
 *     model is never called twice for one task. A run that other attempt's worker left `running`
 *     (it stopped during the call) is closed as `interrupted` and counted at its worst case.
 *  1. Gates (brain/gate.ts): a scheduled run needs the agent on, the AI switch on (for its
 *     account) and, for an account's job, the account live. The admin's Test connection (and the
 *     sandbox's dev route) is one run a person asked for: it runs while the switch is off.
 *  2. Budget: the month's platform spend under the budget, the agent under its runs per day.
 *  3. The package: the job copies allowed fields by name; the privacy scan reads the finished
 *     package (strings and keys; see brain/privacy.ts) for emails, phones and the job's secret
 *     values — a finding stops the run, and nothing of the package is stored. The request must
 *     fit the relay (its bytes, measured as sent).
 *  4. The run record is written `running` — in one transaction with a check that this worker still
 *     holds the task's lease (else nothing is written and nothing called) — then the model is
 *     called: the agent's model, and once more on its fallback after a 408/429, a 5xx, a dropped
 *     connection or a timeout. Never a third.
 *  5. The answer: a normal end, JSON, the job's schema, every number in the reasoning in the input,
 *     the job's own checks. Anything else is `rejected` — logged, never used.
 *  6. Spend is counted first (the budget must see it even if the record can't be finished): the
 *     answer's tokens at the model's list price, plus a worst-case estimate for a call that timed
 *     out, was stopped or broke off after reaching the relay (it may have been billed). Only calls
 *     that reached the relay count toward the agent's runs per day. Then the record is finished.
 *     HeidiFi gets an alert at 80 % / 100 % of the budget, and once a day per cause when an agent
 *     run fails (not for a run stopped by the worker's shutdown).
 *
 * The budget and the runs a day are checked before the call, so with several workers they are
 * soft limits (each worker runs one agent at a time); the relay's 300 calls a day is the hard one.
 *
 * From the model call on, nothing throws: a throw would make the queue hand the task out again,
 * and the model would be called a second time.
 *
 * It never sends a message, never charges credits and never waits on the sending pause: F2a
 * applies nothing (the first job that proposes changes comes with F2b).
 */

import { contentChecksum, hashId } from '../core/checksum';
import { readEngineSettingsStrict, type EngineSettings } from '../store/engineSettings';
import {
  addUsage,
  closeInterruptedRun,
  finishRun,
  listRunningRuns,
  readAgentSettings,
  readUsage,
  runExists,
  startRun,
  usageDocIdsFor,
  type RunAttempt,
  type RunFinish,
  type RunLease,
} from '../store/agents';
import { tsMs } from '../store/time';
import { sandboxEnabled } from '../engine/clock';
import { raiseAlert } from '../engine/alerts';
import { jobFor } from './registry';
import { gateFor } from './gate';
import { budgetBlock, crossedLevels, dayKeyOf, monthKeyOf } from './budget';
import { scanPackage } from './privacy';
import { evaluateAnswer, numbersCheck, type CheckResult } from './checks';
import { costMicroUsd, isKnownModel, microToUsd, MODELS, NO_USAGE, priceOf, type ModelUsage } from './models';
import { classifyModelError, MAX_CALL_MS, ModelError, outputFormatFor, relayClient, type ModelClient, type ModelReply, type OutputFormat } from './modelClient';
import { sandboxModel } from './sandboxModel';
import type { AgentJob, RunOutcome, RunTrigger } from './types';

/** The whole run, both calls included (the lane aborts at its own deadline too). */
export const RUN_DEADLINE_MS = 250_000;
/** A second call with less time than this left isn't worth starting. */
const MIN_CALL_MS = 10_000;
/** After a call that ran into its time limit, a second one needs at least this much time (a long answer). */
const MIN_CALL_AFTER_TIMEOUT_MS = 60_000;
/** Under the relay's 256 KB, measured on the request as it is sent. */
export const MAX_REQUEST_BYTES = 240_000;
const MAX_ANSWER_CHARS = 50_000;
/** A run's summary (its one-line label in the run log). */
const MAX_SUMMARY_CHARS = 500;
/** A Test connection that waited longer than this for a worker is skipped (nobody is looking any more). */
export const STALE_TEST_MS = 10 * 60_000;
/** Attempt numbers checked for another attempt's start (an `agent_run` task has at most 3; one spare). */
const ATTEMPTS_CHECKED = 4;

export interface RunRequest {
  agentKey: string;
  trigger: RunTrigger;
  taskId: string | null;
  attempt: number;
  tenantUserId: string | null;
  venueId: string | null;
  params?: Record<string, unknown>;
  /** How long the task waited after its due time (engine clock), when it came from the queue. */
  waitedMs?: number;
}

export interface RunDeps {
  client?: ModelClient;
  /** The worker's current copy (else read fresh). */
  settings?: EngineSettings;
  /** Aborts the model call (the lane's deadline, a lost lease, a shutdown). */
  signal?: AbortSignal;
  /** Real-time ms by which the run must be done. */
  deadlineAt?: number;
  /** Real clock (tests). */
  now?: () => number;
  /** Tests only: a job that isn't in the registry (e.g. one whose package leaks, for the scan). */
  job?: AgentJob;
  /** The lane's task lease: the run record (and so the call) only while this worker holds it. */
  lease?: RunLease;
}

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  reason: string | null;
  costMicroUsd: number;
}

export function runIdFor(taskId: string | null, attempt: number): string {
  return hashId('ar', `${taskId ?? `direct:${Date.now()}:${Math.random()}`}:${attempt}`);
}

export function defaultModelClient(): ModelClient {
  return sandboxEnabled() ? sandboxModel() : relayClient();
}

const cap = (s: string | null, n: number) => (s === null ? null : s.length > n ? `${s.slice(0, n)}…` : s);

/** What a person should check when an agent run fails with this code (the alert's last line). */
function adviceFor(code: string): string {
  switch (code) {
    case 'relay_not_configured':
    case 'relay_unauthorized':
    case 'connection':
    case 'not_found':
    case 'bad_response':
      return 'Check the worker’s CMS_INTERNAL_URL (the portal domain, e.g. https://portal.heidifi.ai) and INTERNAL_API_SECRET (= the cms’s CAPTIVE_SERVER_INTERNAL_SECRET), and the cms’s AI Gateway credential.';
    case 'unauthorized':
    case 'forbidden':
      return 'Check the cms’s AI Gateway key and that the Vercel team has AI Gateway credits.';
    case 'relay_daily_limit':
      return 'The cms relay allows 300 calls a day; agents go on tomorrow (UTC).';
    case 'answer_lost':
      return 'The model’s answer broke off on the way back (a network break): it was counted at the worst case and runs again at its next due time.';
    case 'privacy_scan':
      return 'The job’s package or its summary held personal data, so nothing was sent — a bug in the job’s input builder.';
    case 'interrupted':
      return 'A worker stopped during the model call (a crash, or a deploy that outlasted its shutdown wait): see the adaptive-worker’s logs.';
    default:
      return 'See the run log under Adaptive Campaigns → Launch & health → AI agents.';
  }
}

/** Worst case for a call that may have been billed without an answer: the request in, a full answer out. */
function estimateMicroUsd(requestBytes: number, maxOutputTokens: number, model: string): number {
  const m = MODELS[model];
  if (!m) return 0;
  return costMicroUsd({ inputTokens: Math.ceil(requestBytes / 3), outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, m);
}

/** Worst case for a run its worker left during the call: a full answer on its model and on its fallback. */
function interruptedCostMicro(run: Record<string, unknown>): number {
  const bytes = Number(run.requestBytes) || 0;
  const max = Number(run.maxOutputTokens) || 0;
  return [run.model, run.fallbackModel]
    .filter((m, i, all): m is string => typeof m === 'string' && isKnownModel(m) && all.indexOf(m) === i)
    .reduce((sum, m) => sum + estimateMicroUsd(bytes, max, m), 0);
}

/** Why the lane stopped a call (the AbortController's reason). */
function abortWords(reason: unknown): string {
  switch (reason) {
    case 'shutdown':
      return 'the worker was stopping for a deploy or restart';
    case 'lease_lost':
      return 'the worker lost the task to another';
    case 'deadline':
      return 'the run’s time limit';
    default:
      return 'stopped';
  }
}

/** Once a day per agent and cause (raiseAlert never throws). */
function alertAgentFailing(key: string, label: string, code: string, detail: string | null, day: string): Promise<void> {
  return raiseAlert({
    kind: 'agent_failing',
    dedupeKey: `agent_failing:${key}:${code}:${day}`,
    audience: 'heidifi',
    subject: `HeidiFi AI: “${label}” failed (${code})`,
    text: `The AI agent “${label}” failed: ${code}${detail ? ` — ${detail}` : ''}.\n${adviceFor(code)}`,
  });
}

/** At 80 % / 100 % of the month's budget, once per month, budget and level (raiseAlert never throws). */
async function alertBudgetCrossings(spend: { beforeMicro: number; afterMicro: number }, month: string, budgetUsd: number): Promise<void> {
  for (const level of crossedLevels(spend.beforeMicro, spend.afterMicro, budgetUsd)) {
    await raiseAlert({
      kind: 'agent_budget',
      // With the budget in the key: after a raise, the new 80 % / 100 % alert again.
      dedupeKey: `agent_budget:${month}:${budgetUsd}:${level}`,
      audience: 'heidifi',
      subject: level === 100 ? 'HeidiFi AI: this month’s AI budget is used up' : 'HeidiFi AI: 80 % of this month’s AI budget used',
      text:
        `The AI agents have used $${microToUsd(spend.afterMicro).toFixed(2)} of the $${budgetUsd} budget for ${month.slice(0, 4)}-${month.slice(4)}.\n` +
        (level === 100
          ? 'Every agent is paused until the month ends or the budget goes up (Adaptive Campaigns → Launch & health → AI agents). Messages keep sending.'
          : 'At 100 % every agent pauses until the month ends or the budget goes up. Messages keep sending.'),
    });
  }
}

/** A run still `running` this long after it started is abandoned (a run gives up after about 5 minutes). */
export const ABANDONED_AFTER_MS = 30 * 60_000;

/**
 * Closes the runs no attempt will close (the worker died on its task's last attempt, or the
 * closing attempt failed) — interrupted, counted at the worst case if they got as far as the model
 * call. The worker runs it every 10 minutes. Returns how many it closed.
 */
export async function closeAbandonedRuns(realNow: number = Date.now(), settings?: EngineSettings): Promise<number> {
  const stuck = (await listRunningRuns()).filter((r) => r.createdAtMs !== null && realNow - r.createdAtMs >= ABANDONED_AFTER_MS);
  if (!stuck.length) return 0;
  const budgetUsd = (settings ?? (await readEngineSettingsStrict())).agents?.monthlyBudgetUsd ?? 0;
  let closedCount = 0;
  for (const r of stuck) {
    const closed = await closeInterruptedRun(r.runId, realNow, interruptedCostMicro);
    if (!closed) continue;
    closedCount += 1;
    if (closed.spend) await alertBudgetCrossings(closed.spend, monthKeyOf(r.createdAtMs ?? realNow), budgetUsd);
    if (closed.calledModel) {
      const job = jobFor(r.agentKey);
      await alertAgentFailing(
        r.agentKey,
        job?.label ?? r.agentKey,
        'interrupted',
        closed.costMicro > 0 ? 'a run was left unfinished; counted at the worst case' : 'a run was left unfinished after its call was counted',
        dayKeyOf(realNow),
      );
    }
  }
  return closedCount;
}

export async function runAgent(req: RunRequest, deps: RunDeps = {}): Promise<RunResult> {
  const job = deps.job ?? jobFor(req.agentKey);
  if (!job) throw new Error(`Unknown agent: ${req.agentKey}`);
  const now = deps.now ?? Date.now;
  const client = deps.client ?? defaultModelClient();
  const t0 = now();
  const runId = runIdFor(req.taskId, req.attempt);
  const engine = deps.settings ?? (await readEngineSettingsStrict());
  const settings = await readAgentSettings(job);
  const budgetUsd = engine.agents?.monthlyBudgetUsd ?? 0;
  // A run is counted in the month and day it started (so a run at midnight stays in one place).
  const usageDocs = usageDocIdsFor(job.key, t0);
  const base = {
    runId,
    agentKey: job.key,
    trigger: req.trigger,
    taskId: req.taskId,
    attempt: req.attempt,
    tenantUserId: req.tenantUserId,
    venueId: req.venueId,
    model: settings.model,
    fallbackModel: settings.fallbackModel,
    effort: settings.effort,
    promptVersion: settings.promptVersion,
    client: client.name,
    usageDocs,
  };
  const empty: Omit<RunFinish, 'outcome' | 'reason' | 'latencyMs'> = {
    modelUsed: null,
    fallbackUsed: false,
    attempts: [],
    stopReason: null,
    refusalCategory: null,
    output: { text: null, parsed: null, reasoning: null },
    checks: [],
    usage: NO_USAGE,
    costMicroUsd: 0,
    price: null,
    error: null,
  };

  const alertFailure = (code: string, detail: string | null) => alertAgentFailing(job.key, job.label, code, detail, dayKeyOf(now()));
  const alertBudget = (spend: { beforeMicro: number; afterMicro: number }, month: string) => alertBudgetCrossings(spend, month, budgetUsd);

  /** A run that never called the model: recorded (with no package), not counted as a run. */
  const endEarly = async (outcome: RunOutcome, reason: string, summary: string, extra: Partial<RunFinish> = {}): Promise<RunResult> => {
    const created = await startRun({ ...base, input: { summary, hash: null, package: null, chars: 0 }, realNow: t0 });
    if (!created) return { runId, outcome: 'skipped', reason: 'duplicate', costMicroUsd: 0 };
    await finishRun(runId, { ...empty, ...extra, outcome, reason, latencyMs: now() - t0 }, now());
    await addUsage({ realNow: t0, agentKey: job.key, runId, tenantUserId: req.tenantUserId, outcome, counted: false, costMicro: 0, usage: NO_USAGE });
    if (outcome === 'failed') await alertFailure(reason, extra.error ?? null);
    return { runId, outcome, reason, costMicroUsd: 0 };
  };

  /**
   * Another attempt's run its worker left `running`: closed once, and counted in the same
   * transaction (brain/store: the worst case, unless it counted its own spend before it stopped,
   * or never got to the call). An error here fails the task (nothing was called; it is tried again).
   */
  const closeInterrupted = async (earlierId: string) => {
    const closed = await closeInterruptedRun(earlierId, now(), interruptedCostMicro);
    if (!closed) return;
    if (closed.spend) await alertBudget(closed.spend, monthKeyOf(tsMs(closed.run.createdAt) ?? t0));
    if (closed.calledModel) {
      await alertFailure('interrupted', closed.costMicro > 0 ? 'the worker stopped during the model call; counted at the worst case' : 'the worker stopped after the call was counted');
    }
  };

  // 0. A task another attempt of which already started (first: its dead run is closed even when
  //    this one is too late anyway), then a stale Test connection.
  if (req.taskId) {
    let started = false;
    for (let a = 1; a <= Math.max(req.attempt - 1, ATTEMPTS_CHECKED); a += 1) {
      if (a === req.attempt) continue;
      const earlierId = runIdFor(req.taskId, a);
      if (!(await runExists(earlierId))) continue;
      started = true;
      await closeInterrupted(earlierId);
    }
    if (started) return endEarly('skipped', 'already_called', job.label);
  }
  if (req.trigger === 'test' && (req.waitedMs ?? 0) > STALE_TEST_MS) return endEarly('skipped', 'stale', job.label);

  // 1. Gates.
  const gate = gateFor(job, req, engine, settings);
  if (gate) return endEarly('skipped', gate, job.label);

  // 2. Budget.
  const { spentMicro, runsToday } = await readUsage(job.key, t0);
  const block = budgetBlock({ spentMicro, budgetUsd, runsToday, maxRunsPerDay: settings.maxRunsPerDay });
  if (block) return endEarly('skipped', block, job.label);

  // 3. The package (as it is serialized: what is checked is what is sent), its size, the privacy
  //    scan (the job's summary for the run log too), the schema and the request's size.
  const built = await job.buildInput({ runId, realNow: t0, tenantUserId: req.tenantUserId, venueId: req.venueId, params: req.params ?? {} });
  const pkgText = JSON.stringify(built.pkg) ?? 'null';
  if (Buffer.byteLength(pkgText, 'utf8') > MAX_REQUEST_BYTES) {
    return endEarly('failed', 'too_large', `${job.label} (the package was too large to check)`, { error: `The package has more than ${MAX_REQUEST_BYTES} bytes` });
  }
  const wire: unknown = JSON.parse(pkgText);
  // The run log's one-line label: short, and scanned like the package — whole and as stored (a cut
  // can split what the scan looks for); one too long to check is replaced by the job's label.
  const whole = String(built.summary ?? '');
  const checked = whole.length > MAX_REQUEST_BYTES ? job.label : whole;
  const summary = cap(checked, MAX_SUMMARY_CHARS) ?? '';
  const inSummary = new Set(scanPackage([checked, summary], built.secrets).map((f) => f.kind));
  const findings = [
    ...scanPackage(wire, built.secrets),
    ...[...inSummary].map((kind) => ({ kind, path: `(the run's summary)` })),
  ];
  if (findings.length) {
    // The job's own summary could hold what the scan found: a fixed one instead.
    return endEarly('failed', 'privacy_scan', `${job.label} (withheld: personal data found)`, {
      privacyFindings: findings,
      error: `The scan found ${findings.map((f) => `${f.kind} at ${f.path}`).join(', ')}`,
    });
  }
  let format: OutputFormat;
  try {
    format = await outputFormatFor(job.outputSchema);
  } catch (err) {
    if (err instanceof ModelError && err.code === 'sdk_unavailable') return endEarly('failed', 'sdk_unavailable', summary, { error: err.message });
    return endEarly('failed', 'bad_schema', summary, { error: `The answer schema can't be used: ${cap(String((err as Error)?.message ?? err), 300)}` });
  }
  const prompt = job.prompts[settings.promptVersion] ?? job.prompts[job.defaults.promptVersion];
  const user = `${prompt.instructions}\n\n${pkgText}`;
  const requestBytes = Buffer.byteLength(
    JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxOutputTokens,
      system: [{ type: 'text', text: prompt.system }],
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: settings.effort, format },
    }),
    'utf8',
  );
  if (requestBytes > MAX_REQUEST_BYTES) return endEarly('failed', 'too_large', summary, { error: `The request has ${requestBytes} bytes (max ${MAX_REQUEST_BYTES})` });

  // A shutdown before the call: nothing recorded, and the lane gives the task back to the queue
  // (the next worker runs it).
  if (deps.signal?.aborted && deps.signal.reason === 'shutdown') return { runId, outcome: 'skipped', reason: 'shutdown', costMicroUsd: 0 };

  // 4. Record (under the lease), then call.
  const created = await startRun(
    {
      ...base,
      input: { summary, hash: contentChecksum(built.pkg), package: pkgText, chars: pkgText.length },
      requestBytes,
      maxOutputTokens: settings.maxOutputTokens,
      realNow: t0,
    },
    deps.lease,
  );
  // Another attempt owns the task now: nothing was written, and the model isn't called.
  if (created === 'lease_lost') return { runId, outcome: 'skipped', reason: 'lease_lost', costMicroUsd: 0 };
  // This run id was already recorded (the same task attempt twice): never call the model twice for it.
  if (!created) return { runId, outcome: 'skipped', reason: 'duplicate', costMicroUsd: 0 };

  // ── From here on nothing throws (see the file header). ──
  const deadlineAt = deps.deadlineAt ?? t0 + RUN_DEADLINE_MS;
  const models = [settings.model, settings.fallbackModel].filter((m, i, all): m is string => typeof m === 'string' && isKnownModel(m) && all.indexOf(m) === i);
  const attempts: RunAttempt[] = [];
  let reply: ModelReply | null = null;
  let modelUsed: string | null = null;
  let lastError: ModelError | null = null;
  let estimatedMicro = 0;
  for (const model of models) {
    if (deps.signal?.aborted) {
      // Stopped before this call was sent: nothing reached the model.
      lastError = lastError ?? new ModelError('retryable', 'aborted', `The run was stopped before the model was called (${abortWords(deps.signal.reason)})`);
      break;
    }
    const left = deadlineAt - now();
    if (left < (lastError?.code === 'timeout' ? MIN_CALL_AFTER_TIMEOUT_MS : MIN_CALL_MS)) {
      lastError = lastError ?? new ModelError('retryable', 'deadline', 'No time left to call the model');
      break;
    }
    const started = now();
    try {
      reply = await client.call(
        {
          agentKey: job.key,
          runId,
          model,
          system: prompt.system,
          cacheSystem: job.cacheSystem,
          user,
          format,
          effort: settings.effort,
          maxOutputTokens: settings.maxOutputTokens,
          timeoutMs: Math.min(MAX_CALL_MS, left),
          pkg: built.pkg,
          sandboxAnswer: () => job.sandboxAnswer(built.pkg),
        },
        deps.signal,
      );
      attempts.push({ model, ms: now() - started, error: null, status: null, detail: null, reachedRelay: true });
      modelUsed = model;
      break;
    } catch (err) {
      let e = classifyModelError(err);
      if (e.code === 'aborted' && deps.signal?.aborted) e = new ModelError(e.kind, e.code, `${e.message} (${abortWords(deps.signal.reason)})`, e.status, e.reachedRelay);
      attempts.push({ model, ms: now() - started, error: e.code, status: e.status, detail: cap(e.message, 300), reachedRelay: e.reachedRelay });
      // A call that timed out, was stopped or broke off after reaching the relay may still have been
      // billed: count the worst case.
      if (e.reachedRelay && ['timeout', 'aborted', 'unknown', 'connection', 'answer_lost'].includes(e.code)) {
        estimatedMicro += estimateMicroUsd(requestBytes, settings.maxOutputTokens, model);
      }
      lastError = e;
      if (e.kind !== 'retryable' || deps.signal?.aborted) break;
    }
  }

  // 5. The answer.
  let outcome: RunOutcome = 'failed';
  let reason: string | null = lastError?.code ?? 'no_answer';
  let checks: CheckResult[] = [];
  let parsed: string | null = null;
  let reasoning: string | null = null;
  if (reply) {
    try {
      const ev = evaluateAnswer(reply, job.outputSchema);
      if (!ev.ok) {
        outcome = 'rejected';
        reason = ev.problem;
        checks = [{ code: ev.problem, ok: false, detail: ev.detail }];
      } else {
        reasoning = job.reasoningOf(ev.value);
        checks = [numbersCheck(reasoning, wire, [prompt.system, prompt.instructions, JSON.stringify(format.schema)]), ...job.check(ev.value, built.pkg)];
        parsed = JSON.stringify(ev.value);
        const failed = checks.find((c) => !c.ok);
        outcome = failed ? 'rejected' : 'ok';
        reason = failed ? failed.code : null;
      }
    } catch (err) {
      outcome = 'failed';
      reason = 'internal_error';
      checks = [{ code: 'internal_error', ok: false, detail: `The answer couldn't be checked: ${(err as Error)?.name ?? 'Error'}` }];
    }
  }

  // 6. Count the spend first, then finish the record, then alert.
  const usage: ModelUsage = reply?.usage ?? NO_USAGE;
  const priced = modelUsed ? MODELS[modelUsed] : null;
  const cost = (priced ? costMicroUsd(usage, priced) : 0) + estimatedMicro;
  const counted = attempts.some((a) => a.reachedRelay);
  const finishedAt = now();
  let spend: { beforeMicro: number; afterMicro: number } | null = null;
  try {
    spend = await addUsage({ realNow: t0, agentKey: job.key, runId, tenantUserId: req.tenantUserId, outcome, counted, costMicro: cost, usage });
  } catch (err) {
    console.error('[ADAPTIVE AI] the spend counters could not be updated:', runId, (err as Error)?.name ?? 'Error');
  }
  const error = reply ? (outcome === 'failed' ? checks[0]?.detail ?? null : null) : lastError ? `${lastError.code}: ${lastError.message}` : 'no model to call';
  let finishState: 'finished' | 'gone' | 'closed' | 'failed' = 'failed';
  try {
    const finished = await finishRun(
      runId,
      {
        outcome,
        reason,
        modelUsed,
        fallbackUsed: modelUsed !== null && modelUsed !== settings.model,
        attempts,
        stopReason: reply?.stopReason ?? null,
        refusalCategory: reply?.refusalCategory ?? null,
        output: { text: cap(reply?.text ?? null, MAX_ANSWER_CHARS), parsed: cap(parsed, MAX_ANSWER_CHARS), reasoning: cap(reasoning, 4_000) },
        checks,
        usage,
        costMicroUsd: cost,
        price: priced ? priceOf(priced) : null,
        latencyMs: finishedAt - t0,
        error,
        modelReported: reply?.model ?? null,
        estimatedMicroUsd: estimatedMicro,
      },
      finishedAt,
      // Counting it above failed: count it with the finish (unless that count did land after all).
      spend ? undefined : { realNow: t0, agentKey: job.key, runId, tenantUserId: req.tenantUserId, outcome, counted, costMicro: cost, usage },
    );
    finishState = finished.state;
    if (finished.spend) spend = finished.spend;
    if (finished.state === 'gone') console.warn('[ADAPTIVE AI] the run record was gone when the run finished (an account delete?):', runId);
    if (finished.state === 'closed') console.warn('[ADAPTIVE AI] another attempt had closed this run as interrupted meanwhile (its record is kept):', runId);
  } catch (err) {
    console.error('[ADAPTIVE AI] the run record could not be finished:', runId, (err as Error)?.name ?? 'Error');
  }

  if (spend) await alertBudget(spend, monthKeyOf(t0));
  // Never an outcome to use for a run another attempt closed, or whose account is gone.
  if (finishState === 'closed') return { runId, outcome: 'failed', reason: 'interrupted', costMicroUsd: cost };
  if (finishState === 'gone') return { runId, outcome: 'skipped', reason: 'gone', costMicroUsd: cost };
  // A run stopped by the worker's shutdown (a deploy) is in the run log; no alert for it.
  const shutdown = reason === 'aborted' && deps.signal?.reason === 'shutdown';
  if (outcome === 'failed' && reason && !shutdown) await alertFailure(reason, lastError?.message ?? error);
  return { runId, outcome, reason, costMicroUsd: cost };
}
