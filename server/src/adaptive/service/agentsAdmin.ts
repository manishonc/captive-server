/**
 * The admin "AI agents" card on Launch & health (PR F2a), under `/internal/adaptive/admin/…`
 * (SUPER_ADMIN in the cms; writes and the Test connection also need `actor.kind: 'super_admin'` here):
 *
 *   GET  agents              the switch and budget, this month's spend, each agent's settings and
 *                            today's runs, and whether the running workers can reach the relay (and
 *                            aren't idle)
 *   PUT  agents/:key         {change, baseVersion}   an agent's settings (409 on a stale card)
 *   POST agents/test         queue one Test connection run (one per real-clock minute; the worker
 *                            picks it up within a minute while every account is off, else ~5 s;
 *                            one that waited over 10 minutes is skipped as stale)
 *   GET  agent-runs          ?agentKey&limit&before   newest runs, one line each
 *   GET  agent-runs/:runId   one run in full (package, answer, checks, tokens, cost)
 *
 * The switch and the budget change on the launch card's route (`PUT /admin/launch`,
 * `change.agents`): "AI ON" to turn on, one click to turn off. Nothing here calls a model — the
 * API never loads the model client; the Test connection is a task the worker's AI lane runs.
 */

import { z } from 'zod';
import { db } from '../../firebase';
import { COL, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { readEngineSettings } from '../store/engineSettings';
import { tsMs } from '../store/time';
import { toJson } from '../store/serialize';
import {
  getRun,
  listRuns,
  MAX_OUTPUT_TOKENS,
  readAgentSettings,
  readDayUsage,
  readMonthUsage,
  StaleSettingsError,
  writeAgentSettings,
} from '../store/agents';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { now as engineNow, refreshClock } from '../engine/clock';
import { AGENT_KEYS, jobFor } from '../brain/registry';
import { testConnectionTask } from '../brain/tasks';
import { counterValue, monthKeyOf } from '../brain/budget';
import { isKnownModel, microToUsd, MODEL_IDS, MODELS } from '../brain/models';
import { ApiError, conflict, notFound } from '../api/errors';
import type { Actor } from '../core/schemas';

const ALIVE_MS = 3 * 60_000;
/** A run still `running` after this long was abandoned (its worker stopped). */
const INTERRUPTED_AFTER_MS = 10 * 60_000;

function jobOr404(key: string) {
  const job = jobFor(key);
  if (!job) throw notFound(`No agent “${key}”`);
  return job;
}

export async function getAgentsAdmin() {
  const realNow = Date.now();
  const [settings, month, status] = await Promise.all([readEngineSettings(), readMonthUsage(realNow), db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get()]);
  const agents = await Promise.all(
    AGENT_KEYS.map(async (key) => {
      const job = jobFor(key)!;
      const [s, today] = await Promise.all([readAgentSettings(job), readDayUsage(key, realNow)]);
      return {
        key,
        label: job.label,
        description: job.description,
        scope: job.scope,
        settings: s,
        defaults: job.defaults,
        promptVersions: Object.keys(job.prompts),
        today: {
          // null: the day's counter can't be read (the agent is paused today; a warning says so).
          runs: Number.isFinite(counterValue(today?.runs)) ? counterValue(today?.runs) : null,
          outcomes: (today?.outcomes as Record<string, number> | undefined) ?? {},
          costUsd: microToUsd(Number(today?.costMicroUsd) || 0),
        },
      };
    }),
  );
  const workers = Object.entries((status.get('workers') ?? {}) as Record<string, Record<string, unknown>>).map(([id, w]) => {
    const beat = tsMs(w.lastBeatAt);
    const ai = (w.ai ?? null) as Record<string, unknown> | null;
    return {
      id,
      alive: beat !== null && realNow - beat < ALIVE_MS,
      version: typeof w.version === 'string' ? w.version : null,
      // `running`, or idle (identity key / indexes) — an idle worker runs nothing, agents included.
      state: typeof w.state === 'string' ? w.state : null,
      // Older workers (before PR F2a) report no `ai`: they can't run agents at all.
      ai: ai ? (toJson(ai) as Record<string, unknown>) : null,
    };
  });
  const agentsSwitch = settings.agents ?? { mode: 'off' as const, accounts: {}, monthlyBudgetUsd: 0, changedBy: null };
  const spentMicro = counterValue(month?.costMicroUsd);
  const budget = agentsSwitch.monthlyBudgetUsd;
  const warnings: string[] = [];
  const alive = workers.filter((w) => w.alive);
  if (!alive.length) warnings.push('No adaptive-worker is running: nothing can run an agent');
  else if (!alive.some((w) => w.ai)) warnings.push('The running worker is older than PR F2a: it can’t run agents (deploy it)');
  // Idle only when every live worker is idle (not while one is starting or stopping, e.g. a deploy).
  else if (alive.every((w) => typeof w.state === 'string' && w.state.startsWith('idle'))) {
    warnings.push('The worker is idle (identity key or indexes — see the engine status): it runs no task, agents included');
  }
  else {
    if (alive.some((w) => w.ai && w.ai.relayUrlSet === false)) warnings.push('The worker has no CMS_INTERNAL_URL: it can’t reach the cms model relay');
    if (alive.some((w) => w.ai && w.ai.relaySecretSet === false)) warnings.push('The worker has no INTERNAL_API_SECRET: the cms model relay will refuse it');
  }
  if (!(budget > 0)) warnings.push('The AI budget is 0 (or couldn’t be read): every agent is paused');
  else if (!Number.isFinite(spentMicro)) warnings.push('This month’s AI spend can’t be read (a damaged counter): every agent is paused');
  else if (spentMicro >= budget * 1_000_000) warnings.push('This month’s AI budget is used up: every agent is paused until the month ends or it goes up');
  for (const a of agents) {
    if (a.today.runs === null) warnings.push(`Today’s run count of “${a.label}” can’t be read (a damaged counter): it is paused today`);
  }
  if (!settings.alerts.email) warnings.push('No alert email is set: budget and failure alerts reach nobody');
  return {
    switch: agentsSwitch,
    month: {
      month: monthKeyOf(realNow),
      // null when the counter can't be read (the warning says so; every agent is paused).
      spentUsd: Number.isFinite(spentMicro) ? microToUsd(spentMicro) : null,
      budgetUsd: budget,
      pct: budget > 0 && Number.isFinite(spentMicro) ? Math.round((spentMicro / (budget * 1_000_000)) * 1000) / 10 : null,
      runs: Number(month?.runs) || 0,
      byAgent: (month?.byAgent as Record<string, unknown> | undefined) ?? {},
    },
    agents,
    models: MODEL_IDS.map((id) => MODELS[id]),
    workers,
    warnings,
  };
}

const changeSchema = z
  .object({
    change: z
      .object({
        enabled: z.boolean().optional(),
        model: z.string().refine(isKnownModel, 'not an allowed model').optional(),
        fallbackModel: z.string().refine(isKnownModel, 'not an allowed model').nullable().optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
        maxRunsPerDay: z.number().int().min(0).max(1000).optional(),
        maxOutputTokens: z.number().int().min(256).max(MAX_OUTPUT_TOKENS).optional(),
        promptVersion: z.string().min(1).max(40).optional(),
      })
      .strict(),
    baseVersion: z.number().int().min(0),
  })
  .strict();

export async function putAgentSettings(key: string, body: unknown, actor: Actor) {
  const job = jobOr404(key);
  const input = changeSchema.parse(body ?? {});
  if (!Object.keys(input.change).length) throw new ApiError('no_changes', 'Nothing to change');
  if (input.change.promptVersion !== undefined && !Object.prototype.hasOwnProperty.call(job.prompts, input.change.promptVersion)) {
    throw new ApiError('bad_request', `No prompt version “${input.change.promptVersion}” for this agent`);
  }
  try {
    const settings = await writeAgentSettings(job, input.change, input.baseVersion, actor.uid);
    return { settings };
  } catch (err) {
    if (err instanceof StaleSettingsError) throw conflict('Someone else changed this agent meanwhile — reload and check');
    throw err;
  }
}

/** Queues one Test connection run; the worker's AI lane picks it up within a minute (a stale one is skipped). */
export async function testConnection(actor: Actor) {
  void actor;
  await refreshClock();
  const taskId = await firestoreScheduler.schedule(testConnectionTask(Date.now(), engineNow()));
  return { queued: true, taskId };
}

const listSchema = z.object({
  agentKey: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(30),
  before: z.string().max(40).optional(),
});

function runLine(r: Record<string, unknown>, realNow: number) {
  const input = (r.input ?? {}) as Record<string, unknown>;
  const created = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
  return {
    runId: r.runId,
    agentKey: r.agentKey,
    trigger: r.trigger,
    status: r.status,
    interrupted: r.status === 'running' && Number.isFinite(created) && realNow - created > INTERRUPTED_AFTER_MS,
    outcome: r.outcome ?? null,
    reason: r.reason ?? null,
    model: r.model ?? null,
    modelUsed: r.modelUsed ?? null,
    fallbackUsed: r.fallbackUsed === true,
    summary: typeof input.summary === 'string' ? input.summary : null,
    tenantUserId: r.tenantUserId ?? null,
    venueId: r.venueId ?? null,
    usage: r.usage ?? null,
    costUsd: microToUsd(Number(r.costMicroUsd) || 0),
    latencyMs: r.latencyMs ?? null,
    createdAt: r.createdAt ?? null,
    finishedAt: r.finishedAt ?? null,
    // PR W2a: what a job that uses its answer did with it (pending · applied · superseded · failed).
    apply: r.apply ?? null,
  };
}

export async function listAgentRuns(query: Record<string, unknown>) {
  const q = listSchema.parse(query ?? {});
  if (q.agentKey !== undefined && !jobFor(q.agentKey)) throw new ApiError('bad_request', `No agent “${q.agentKey}”`);
  const rows = await listRuns({ limit: q.limit, before: q.before ?? null, agentKey: q.agentKey ?? null });
  const realNow = Date.now();
  return { runs: rows.map((r) => runLine(r, realNow)) };
}

export async function getAgentRun(runId: string) {
  const run = await getRun(runId);
  if (!run) throw notFound('No such run');
  return { run: { ...run, costUsd: microToUsd(Number(run.costMicroUsd) || 0), interrupted: runLine(run, Date.now()).interrupted } };
}
