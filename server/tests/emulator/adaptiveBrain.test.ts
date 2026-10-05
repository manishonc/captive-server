/**
 * PR F2a on the emulator: the AI foundation with the fake model — the Test connection through
 * the worker's AI lane, the run log, the spend counters and alerts, the admin routes and the
 * AI switch on the launch card. Nothing here can reach a real model.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - Settings: a missing `agents` block is off with the $100 budget; a malformed budget is 0.
 *    The launch card: "AI ON" to turn on, off in one click; a higher budget needs "LOOSEN LIMITS".
 *  - Test connection (admin route → task → the worker's lane → the fake model): an `ok` run with
 *    tokens and cost, the month's and the day's counters, the request logged without personal
 *    data; one task a minute (a double click is one run).
 *  - Answers the checks reject: a refusal, a cut-off answer, prose, a wrong echo, a number the
 *    reasoning invents — logged as `rejected`, their tokens still counted.
 *  - The fallback: a 429 on the first model → the second answers (`fallbackUsed`); two in a row →
 *    `failed`, a timeout costed at its worst case; a refused credential → `failed` at once, no
 *    second try. Every failed run alerts HeidiFi, once a day per cause.
 *  - Budget: a used-up month skips the run without calling the model; the run that crosses 80 %
 *    alerts once per budget (a raised budget alerts again); the agent's runs per day, counting only
 *    runs that reached the relay.
 *  - Never twice: a Test connection that waited over 10 min is skipped; any attempt of a task
 *    another attempt of which started is skipped (a run its worker left mid-call is closed as
 *    `interrupted` and counted at the worst case); a run whose worker lost the lease writes nothing
 *    and calls nothing; a dead AI task can't be retried; the run's usage docs are on it from the
 *    start, and a run whose record was deleted meanwhile (an account delete) still finishes and
 *    counts — in the platform totals only, never as the deleted account's share.
 *  - Shutdown: the run in the lane is stopped and recorded (no alert); what is claimed after goes
 *    back to the queue at once.
 *  - A damaged spend counter pauses every agent (and says so); a write to a damaged `agents`
 *    setting keeps its $0 budget.
 *  - Privacy: a package with an email fails the scan — nothing called, nothing of it stored.
 *  - The lane: a slow model call doesn't hold anything else; a second agent task waits (released,
 *    no attempt counted); a task for an unknown agent is left for a newer worker; its own task
 *    handed back stays with the run; a lease lost before the start runs nothing, one lost during
 *    the run aborts it.
 *  - The admin routes: only HeidiFi may run the Test connection; an idle worker is a warning.
 *  - The real client refuses under the emulator even with the relay env set; the heartbeat
 *    reports only whether that env is set, never a value.
 */

import { assert, assertEqual, clearCaches, COL, db, done, resetEmulator, runDue, seedCatalogue, test, worker } from './helpers';
import { ADMIN_ACTOR, mountApi } from './ownerApiHelpers';
import { CONFIG_DOC_ID, ENGINE_STATUS_DOC_ID } from '../../src/adaptive/store/collections';
import { parseEngineSettings, readEngineSettingsStrict } from '../../src/adaptive/store/engineSettings';
import { queueSandboxAnswers, type SandboxAnswer } from '../../src/adaptive/store/agents';
import { runAgent, runIdFor, STALE_TEST_MS, type RunRequest } from '../../src/adaptive/brain/run';
import { AiLane } from '../../src/adaptive/brain/lane';
import { agentRunTask } from '../../src/adaptive/brain/tasks';
import { pingJob } from '../../src/adaptive/brain/jobs/ping';
import { relayClient, ModelError, outputFormatFor, type ModelClient, type ModelReply } from '../../src/adaptive/brain/modelClient';
import { monthKeyOf, dayKeyOf } from '../../src/adaptive/brain/budget';
import { scanPackage } from '../../src/adaptive/brain/privacy';
import { claimDue, firestoreScheduler } from '../../src/adaptive/queue/firestoreQueue';
import { addUsage, startRun } from '../../src/adaptive/store/agents';
import { NO_USAGE } from '../../src/adaptive/brain/models';
import { now } from '../../src/adaptive/engine/clock';
import { devAgentRun } from '../../src/adaptive/service/engine';
import type { AgentJob } from '../../src/adaptive/brain/types';

type Doc = Record<string, any>;

async function fresh(): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
}

async function runs(): Promise<Doc[]> {
  const snap = await db.collection(COL.agentRuns).orderBy('createdAt', 'asc').get();
  return snap.docs.map((d) => d.data());
}

async function lastRun(): Promise<Doc> {
  const all = await runs();
  assert(all.length > 0, 'a run was recorded');
  return all[all.length - 1];
}

async function calls(): Promise<Doc[]> {
  const snap = await db.collection(COL.sandboxModelCalls).get();
  return snap.docs.map((d) => d.data());
}

async function answers(list: SandboxAnswer[]): Promise<void> {
  await queueSandboxAnswers('ping', list);
}

/** One dev run of the ping agent through the worker (task → lane → fake model). */
async function devRun(): Promise<Doc> {
  await devAgentRun({ agentKey: 'ping' });
  await runDue();
  return lastRun();
}

async function monthDoc(): Promise<Doc | null> {
  const snap = await db.collection(COL.agentUsage).doc(`month_${monthKeyOf(Date.now())}`).get();
  return snap.exists ? (snap.data() as Doc) : null;
}

async function alerts(kind: string): Promise<Doc[]> {
  const snap = await db.collection(COL.alerts).where('kind', '==', kind).get();
  return snap.docs.map((d) => d.data());
}

async function setAgents(agents: Record<string, unknown> | null): Promise<void> {
  const ref = db.collection(COL.config).doc(CONFIG_DOC_ID);
  const { FieldValue } = await import('firebase-admin/firestore');
  await ref.update({ agents: agents === null ? FieldValue.delete() : agents });
  clearCaches();
}

const devReq = (taskId: string, over: Partial<RunRequest> = {}): RunRequest => ({ agentKey: 'ping', trigger: 'dev', taskId, attempt: 1, tenantUserId: null, venueId: null, ...over });

/** A stand-in client: runs `during` inside the call, then gives the job's valid answer. */
function stubClient(during: (runId: string) => Promise<void> = async () => undefined): ModelClient {
  return {
    name: 'stub',
    async call(req): Promise<ModelReply> {
      await during(req.runId);
      return {
        stopReason: 'end_turn',
        text: JSON.stringify(req.sandboxAnswer!()),
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        refusalCategory: null,
        model: req.model,
      };
    },
  };
}

async function dayDoc(): Promise<Doc | null> {
  const snap = await db.collection(COL.agentUsage).doc(`ping_${dayKeyOf(Date.now())}`).get();
  return snap.exists ? (snap.data() as Doc) : null;
}

async function main() {
  const api = await mountApi();
  try {
    await test('settings: no `agents` block = off with a $100 budget; a malformed budget = 0 (paused)', async () => {
      await fresh();
      const s = await readEngineSettingsStrict();
      assertEqual(s.agents, { mode: 'off', accounts: {}, monthlyBudgetUsd: 100, changedBy: null }, 'defaults');
      assertEqual(parseEngineSettings({ agents: { mode: 'on', monthlyBudgetUsd: 'lots' } }).agents?.monthlyBudgetUsd, 0, 'malformed budget');
      assertEqual(parseEngineSettings({ agents: { mode: 'maybe' } }).agents?.mode, 'off', 'malformed mode');
      assertEqual(parseEngineSettings({ agents: 'on' }).agents, { mode: 'off', accounts: {}, monthlyBudgetUsd: 0, changedBy: null }, 'not an object');
    });

    await test('the launch card: "AI ON" to turn the agents on, off in one click; a higher budget needs "LOOSEN LIMITS"', async () => {
      await fresh();
      const card = await api.get('/admin/launch');
      assertEqual(card.body.agents?.mode, 'off', 'shown off');
      assertEqual(card.body.agents?.monthlyBudgetUsd, 100, 'the default budget shown');
      const change = { change: { agents: { mode: 'on' } }, baseVersion: card.body.version, actor: ADMIN_ACTOR };
      const noPhrase = await api.call('PUT', '/admin/launch', change);
      assertEqual([noPhrase.status, noPhrase.body.confirmPhrase], [400, 'AI ON'], 'the phrase is asked for');
      const on = await api.call('PUT', '/admin/launch', { ...change, confirm: 'ai on' });
      assertEqual([on.status, on.body.agents?.mode], [200, 'on'], 'on (case doesn’t matter)');
      const off = await api.call('PUT', '/admin/launch', { change: { agents: { mode: 'off' } }, actor: ADMIN_ACTOR });
      assertEqual([off.status, off.body.agents?.mode], [200, 'off'], 'off: one click, no base version');
      const up = await api.call('PUT', '/admin/launch', { change: { agents: { monthlyBudgetUsd: 150 } }, baseVersion: off.body.version, actor: ADMIN_ACTOR });
      assertEqual([up.status, up.body.confirmPhrase], [400, 'LOOSEN LIMITS'], 'a higher budget');
      const down = await api.call('PUT', '/admin/launch', { change: { agents: { monthlyBudgetUsd: 20 } }, actor: ADMIN_ACTOR });
      assertEqual([down.status, down.body.agents?.monthlyBudgetUsd], [200, 20], 'a lower budget: one click');
      const hist = await db.collection(COL.config).doc(CONFIG_DOC_ID).collection('history').doc(String(down.body.version)).get();
      assertEqual(hist.get('lines'), ['AI budget: $100 → $20 a month'], 'the history line');
    });

    await test('Test connection: admin route → the worker’s lane → an ok run with tokens and cost, counted once', async () => {
      await fresh();
      // Both clicks in one minute (a minute boundary in between would make two tasks, rightly).
      while (Date.now() % 60_000 > 55_000) await new Promise((r) => setTimeout(r, 500));
      const t = await api.call('POST', '/admin/agents/test', { actor: ADMIN_ACTOR });
      assertEqual([t.status, t.body.queued], [200, true], 'queued');
      const again = await api.call('POST', '/admin/agents/test', { actor: ADMIN_ACTOR });
      assertEqual(again.body.taskId, t.body.taskId, 'a double click is the same task');
      await runDue();
      const all = await runs();
      assertEqual(all.length, 1, 'one run');
      const r = all[0];
      assertEqual([r.status, r.outcome, r.reason, r.trigger, r.client], ['done', 'ok', null, 'test', 'sandbox'], 'an ok test run');
      assertEqual([r.modelUsed, r.fallbackUsed, r.attempts.length], ['anthropic/claude-opus-5.5', false, 1], 'the first model answered');
      assert(r.usage.inputTokens > 0 && r.usage.outputTokens > 0 && r.costMicroUsd > 0, 'tokens and cost');
      assert(r.checks.every((c: Doc) => c.ok) && r.checks.some((c: Doc) => c.code === 'numbers_in_input'), 'every check passed');
      assert(typeof r.input.package === 'string' && r.input.package.includes('"nonce"'), 'the package is stored as text');
      assertEqual(r.usageDocs, [`month_${monthKeyOf(Date.now())}`, `ping_${dayKeyOf(Date.now())}`], 'the usage docs it was counted in');
      const m = await monthDoc();
      assertEqual([m?.runs, m?.costMicroUsd, m?.byAgent?.ping?.runs], [1, r.costMicroUsd, 1], 'the month');
      const d = await db.collection(COL.agentUsage).doc(`ping_${dayKeyOf(Date.now())}`).get();
      assertEqual([d.get('runs'), d.get('outcomes')?.ok], [1, 1], 'the day');
      const task = await db.collection(COL.journeyTasks).doc(t.body.taskId).get();
      assertEqual(task.get('status'), 'done', 'the task is done');
      // What left for the model: the prompt and the package — nothing personal.
      const c = await calls();
      assertEqual(c.length, 1, 'one call');
      assertEqual(scanPackage({ system: c[0].system, user: c[0].user }), [], 'no email, phone or secret in the request');
      assert(String(c[0].schema).includes('"echo"'), 'the JSON schema is logged');
    });

    await test('the admin routes: the tab, the run log, one run in full', async () => {
      const tab = await api.get('/admin/agents');
      assertEqual(tab.status, 200, 'tab');
      assertEqual(tab.body.agents.map((a: Doc) => a.key), ['ping', 'wa_template_writer'], 'agents (PR W2a adds the WhatsApp template writer)');
      assertEqual(tab.body.agents[0].today.runs, 1, 'today');
      assert(tab.body.month.spentUsd >= 0 && tab.body.month.budgetUsd === 100, 'the month');
      assert(tab.body.models.some((m: Doc) => m.id === 'anthropic/claude-sonnet-5.5'), 'the models');
      const log = await api.get('/admin/agent-runs?limit=5');
      assertEqual([log.status, log.body.runs.length, log.body.runs[0].outcome, log.body.runs[0].apply], [200, 1, 'ok', null], 'the log (the ping uses no answer: no apply)');
      assert(!('input' in log.body.runs[0]), 'the log line carries no package');
      const one = await api.get(`/admin/agent-runs/${log.body.runs[0].runId}`);
      assertEqual([one.status, one.body.run.outcome], [200, 'ok'], 'one run');
      assert(typeof one.body.run.input.package === 'string', 'in full');
      const bad = await api.get('/admin/agent-runs?agentKey=nope');
      assertEqual(bad.status, 400, 'unknown agent');
      const missing = await api.get('/admin/agent-runs/ar_missing');
      assertEqual(missing.status, 404, 'unknown run');
      const owner = await api.call('POST', '/admin/agents/test', { actor: { uid: 'o', kind: 'tenant_user', role: 'ADMIN' } });
      assertEqual(owner.status, 403, 'only HeidiFi runs the Test connection');
    });

    await test('agent settings: a stale card gets 409, unknown models and prompt versions 400, a write needs HeidiFi', async () => {
      const tab = await api.get('/admin/agents');
      const v = tab.body.agents[0].settings.version;
      const ok = await api.call('PUT', '/admin/agents/ping', { change: { effort: 'medium', maxRunsPerDay: 3 }, baseVersion: v, actor: ADMIN_ACTOR });
      assertEqual([ok.status, ok.body.settings.effort, ok.body.settings.version], [200, 'medium', v + 1], 'saved');
      const stale = await api.call('PUT', '/admin/agents/ping', { change: { effort: 'low' }, baseVersion: v, actor: ADMIN_ACTOR });
      assertEqual(stale.status, 409, 'stale');
      const model = await api.call('PUT', '/admin/agents/ping', { change: { model: 'anthropic/claude-fable-5.1' }, baseVersion: v + 1, actor: ADMIN_ACTOR });
      assertEqual(model.status, 400, 'not an allowed model');
      const prompt = await api.call('PUT', '/admin/agents/ping', { change: { promptVersion: 'ping-v9' }, baseVersion: v + 1, actor: ADMIN_ACTOR });
      assertEqual(prompt.status, 400, 'no such prompt');
      const owner = await api.call('PUT', '/admin/agents/ping', { change: { effort: 'low' }, baseVersion: v + 1, actor: { uid: 'o', kind: 'tenant_user', role: 'ADMIN' } });
      assertEqual(owner.status, 403, 'only HeidiFi');
      const nobody = await api.call('PUT', '/admin/agents/nope', { change: { effort: 'low' }, baseVersion: 0, actor: ADMIN_ACTOR });
      assertEqual(nobody.status, 404, 'unknown agent');
      const long = await api.call('PUT', '/admin/agents/ping', { change: { maxOutputTokens: 8_001 }, baseVersion: v + 1, actor: ADMIN_ACTOR });
      assertEqual(long.status, 400, 'over the 8,000-token output limit (what fits in one call’s time)');
    });

    await test('rejected answers are logged and their tokens counted: refusal, cut off, prose, wrong echo, invented number', async () => {
      await fresh();
      const expect: Array<[SandboxAnswer, string]> = [
        [{ fault: 'refusal' }, 'refusal'],
        [{ fault: 'max_tokens' }, 'cut_off'],
        [{ fault: 'bad_json' }, 'bad_json'],
        [{ answer: { reasoning: 'The nonce is 1.', echo: 1 } }, 'echo'],
        [{ answer: { reasoning: 'Clicks went up 37 % since last week.', echo: -1 } }, 'numbers_in_input'],
      ];
      for (const [answer, reason] of expect) {
        await answers([answer]);
        const r = await devRun();
        assertEqual([r.outcome, r.reason], ['rejected', reason], `${JSON.stringify(answer)} → ${reason}`);
        assert(r.usage.inputTokens > 0 && r.costMicroUsd > 0, `${reason}: tokens counted`);
      }
      const m = await monthDoc();
      assertEqual(m?.runs, expect.length, 'every rejected run counts');
      const refusal = (await runs())[0];
      assertEqual(refusal.refusalCategory, 'sandbox', 'the refusal category is kept');
    });

    await test('the fallback: a 429 → the second model answers; two in a row → failed (a timeout costed at worst case); a refused credential → no second try; one alert a day per cause', async () => {
      await fresh();
      await answers([{ fault: 'rate_limit' }]);
      let r = await devRun();
      assertEqual([r.outcome, r.fallbackUsed, r.modelUsed], ['ok', true, 'anthropic/claude-sonnet-5.5'], 'fallback answered');
      assertEqual(r.attempts.map((a: Doc) => [a.model, a.error, a.reachedRelay]), [['anthropic/claude-opus-5.5', 'rate_limited', true], ['anthropic/claude-sonnet-5.5', null, true]], 'attempts');
      assertEqual((await alerts('agent_failing')).length, 0, 'an answered run: no alert');
      const before = (await monthDoc())?.costMicroUsd ?? 0;
      await answers([{ fault: 'server_error' }, { fault: 'timeout' }]);
      r = await devRun();
      assertEqual([r.outcome, r.reason, r.attempts.length, r.usage.inputTokens], ['failed', 'timeout', 2, 0], 'two failures: failed, no answer');
      assert(r.estimatedMicroUsd > 0 && r.costMicroUsd === r.estimatedMicroUsd, 'the timed-out call is costed at its worst case (it may have been billed)');
      assertEqual((await monthDoc())?.costMicroUsd, before + r.costMicroUsd, 'and counted in the month');
      await answers([{ fault: 'unauthorized' }]);
      r = await devRun();
      assertEqual([r.outcome, r.reason, r.attempts.length, r.costMicroUsd], ['failed', 'unauthorized', 1, 0], 'no second try, nothing charged');
      await answers([{ fault: 'unauthorized' }]);
      await devRun();
      const a = await alerts('agent_failing');
      assertEqual(a.map((x) => x.dedupeKey.split(':')[2]).sort(), ['timeout', 'unauthorized'], 'one alert a day per cause');
      assert(a.every((x) => !/secret|key/i.test(x.subject)), 'the subject names no secret');
      assert(a.some((x) => /AI Gateway/.test(x.text)), 'the alert says what to check');
    });

    await test('runs per day count only runs that reached the relay; an unreachable relay fails without using one', async () => {
      await fresh();
      const unreachable: ModelClient = {
        name: 'stub',
        async call() {
          throw new ModelError('retryable', 'connection', 'Could not reach the relay (ECONNREFUSED)');
        },
      };
      const r = await runAgent(devReq('jt_unreachable'), { client: unreachable });
      assertEqual([r.outcome, r.reason, r.costMicroUsd], ['failed', 'connection', 0], 'failed, nothing charged');
      const run = await lastRun();
      assertEqual(run.attempts.map((a: Doc) => [a.error, a.reachedRelay]), [['connection', false], ['connection', false]], 'both models tried, neither reached');
      const d = await dayDoc();
      assertEqual([d?.runs ?? 0, d?.outcomes?.failed], [0, 1], 'not a run toward the cap; the outcome is counted');
    });

    await test('budget: a used-up month skips without calling the model; the run crossing 80 % alerts once; runs per day', async () => {
      await fresh();
      const month = monthKeyOf(Date.now());
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 100_000_000 });
      let r = await devRun();
      assertEqual([r.outcome, r.reason], ['skipped', 'budget'], 'skipped');
      assertEqual((await calls()).length, 0, 'the model was not called');
      assertEqual(r.input.package, null, 'nothing stored');
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 80_000_000 - 100 });
      r = await devRun();
      assertEqual(r.outcome, 'ok', 'ran');
      await devRun();
      const a = await alerts('agent_budget');
      assertEqual(a.length, 1, 'one 80 % alert');
      assert(/80 %/.test(a[0].subject), 'the 80 % alert');
      // Runs per day.
      await fresh();
      const tab = await api.get('/admin/agents');
      await api.call('PUT', '/admin/agents/ping', { change: { maxRunsPerDay: 1 }, baseVersion: tab.body.agents[0].settings.version, actor: ADMIN_ACTOR });
      r = await devRun();
      assertEqual(r.outcome, 'ok', 'the first run');
      r = await devRun();
      assertEqual([r.outcome, r.reason], ['skipped', 'daily_limit'], 'the second is over the cap');
      const d = await db.collection(COL.agentUsage).doc(`ping_${dayKeyOf(Date.now())}`).get();
      assertEqual([d.get('runs'), d.get('outcomes')?.skipped], [1, 1], 'a skipped run is not counted as a run');
    });

    await test('a raised budget alerts again at its own 80 %', async () => {
      await fresh();
      const month = monthKeyOf(Date.now());
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 80_000_000 - 100 });
      await devRun();
      assertEqual((await alerts('agent_budget')).length, 1, '80 % of $100');
      await setAgents({ mode: 'off', monthlyBudgetUsd: 200 });
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 160_000_000 - 100 });
      await devRun();
      const a = await alerts('agent_budget');
      assertEqual(a.map((x) => x.dedupeKey).sort(), [`agent_budget:${month}:100:80`, `agent_budget:${month}:200:80`], '80 % of $200 too');
    });

    await test('never twice: a stale Test connection and a second attempt are skipped; the usage docs are on the run from the start', async () => {
      await fresh();
      const stale = await runAgent(devReq('jt_stale', { trigger: 'test', waitedMs: STALE_TEST_MS + 1000 }));
      assertEqual([stale.outcome, stale.reason], ['skipped', 'stale'], 'nobody is waiting for it any more');
      let seenAtStart: Doc | null = null;
      const first = await runAgent(
        devReq('jt_twice'),
        {
          client: stubClient(async (runId) => {
            seenAtStart = (await db.collection(COL.agentRuns).doc(runId).get()).data() ?? null;
          }),
        },
      );
      assertEqual(first.outcome, 'ok', 'the first attempt');
      const atStart = seenAtStart as Doc | null;
      assertEqual([atStart?.status, atStart?.usageDocs], ['running', [`month_${monthKeyOf(Date.now())}`, `ping_${dayKeyOf(Date.now())}`]], 'written before the call');
      let called = 0;
      const second = await runAgent(devReq('jt_twice', { attempt: 2 }), { client: stubClient(async () => void (called += 1)) });
      assertEqual([second.outcome, second.reason, called], ['skipped', 'already_called', 0], 'the queue handing it out again never calls the model again');
      assertEqual((await dayDoc())?.runs, 1, 'one run counted');
    });

    await test('a run whose record is deleted meanwhile (an account delete) still finishes and counts its spend — never as that account’s share', async () => {
      await fresh();
      const r = await runAgent(devReq('jt_deleted', { tenantUserId: 't_gone' }), {
        client: stubClient(async (runId) => {
          await db.collection(COL.agentRuns).doc(runId).delete();
        }),
      });
      assertEqual([r.outcome, r.reason], ['skipped', 'gone'], 'no throw (the queue would call the model again), and nothing to use: the account is gone');
      assertEqual((await db.collection(COL.agentRuns).doc(runIdFor('jt_deleted', 1)).get()).exists, false, 'the record is not written back');
      const m = await monthDoc();
      assertEqual(m?.costMicroUsd, r.costMicroUsd, 'the spend is counted');
      assertEqual(m?.byTenant?.t_gone, undefined, 'no share for the deleted account (the delete already stripped it)');
      // A run whose record is still there: its account's share is written.
      const kept = await runAgent(devReq('jt_kept', { tenantUserId: 't_here' }), { client: stubClient() });
      assertEqual((await monthDoc())?.byTenant?.t_here, kept.costMicroUsd, 'the share of a recorded run');
    });

    await test('never twice across attempts: a lost lease writes and calls nothing; an interrupted run is closed and counted; a retry-reset attempt still skips', async () => {
      await fresh();
      // The lease: another worker took the task over before the record.
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lease-lost', dueAt: now() - 1000 }));
      const [task] = await claimDue('test-worker', now(), 10);
      await db.collection(COL.journeyTasks).doc(task.id).update({ leaseOwner: 'other-worker' });
      let called = 0;
      const lost = await runAgent(devReq(task.id), { client: stubClient(async () => void (called += 1)), lease: { taskId: task.id, workerId: 'test-worker' } });
      assertEqual([lost.outcome, lost.reason, called], ['skipped', 'lease_lost', 0], 'no call');
      assertEqual((await db.collection(COL.agentRuns).doc(runIdFor(task.id, 1)).get()).exists, false, 'no record');
      // Interrupted: attempt 1 was recorded `running` and its worker died during the call.
      const first = runIdFor('jt_died', 1);
      const created = await startRun({
        runId: first,
        agentKey: 'ping',
        trigger: 'schedule',
        taskId: 'jt_died',
        attempt: 1,
        tenantUserId: null,
        venueId: null,
        model: 'anthropic/claude-opus-5.5',
        fallbackModel: 'anthropic/claude-sonnet-5.5',
        effort: 'low',
        promptVersion: 'ping-v1',
        client: 'relay',
        input: { summary: 'Test connection', hash: null, package: null, chars: 0 },
        usageDocs: [`month_${monthKeyOf(Date.now())}`, `ping_${dayKeyOf(Date.now())}`],
        requestBytes: 3000,
        maxOutputTokens: 2048,
        realNow: Date.now(),
      });
      assertEqual(created, true, 'recorded');
      const second = await runAgent(devReq('jt_died', { attempt: 2 }), { client: stubClient(async () => void (called += 1)) });
      assertEqual([second.outcome, second.reason, called], ['skipped', 'already_called', 0], 'attempt 2 never calls');
      const closed = (await db.collection(COL.agentRuns).doc(first).get()).data()!;
      // Worst case, both models: Opus (1,000 in × 4 + 2,048 out × 20) + Sonnet (1,000 × 2 + 2,048 × 10) µ$.
      assertEqual([closed.status, closed.outcome, closed.reason, closed.costMicroUsd], ['done', 'failed', 'interrupted', 4_000 + 40_960 + 2_000 + 20_480], 'closed and costed');
      const m = await monthDoc();
      assertEqual([m?.costMicroUsd, m?.runs], [closed.costMicroUsd, 1], 'counted once, as a run');
      assertEqual((await alerts('agent_failing')).filter((a) => a.dedupeKey.includes(':interrupted:')).length, 1, 'HeidiFi is told');
      const again = await runAgent(devReq('jt_died', { attempt: 2 }), { client: stubClient() });
      assertEqual(again.reason, 'duplicate', 'the same attempt twice');
      assertEqual((await monthDoc())?.costMicroUsd, closed.costMicroUsd, 'closed only once');
      // A retry that restarted the attempt count (attempt 1 again after attempt 2 ran).
      await runAgent(devReq('jt_reset', { attempt: 2 }), { client: stubClient() });
      const reset = await runAgent(devReq('jt_reset', { attempt: 1 }), { client: stubClient(async () => void (called += 1)) });
      assertEqual([reset.outcome, reset.reason, called], ['skipped', 'already_called', 0], 'never a second call');
    });

    await test('round 3: a stale Test connection still closes a dead run; a record that never called the model is closed without a count; a run is counted once', async () => {
      await fresh();
      const started = (taskId: string, attempt: number, requestBytes: number) =>
        startRun({
          runId: runIdFor(taskId, attempt),
          agentKey: 'ping',
          trigger: 'test',
          taskId,
          attempt,
          tenantUserId: null,
          venueId: null,
          model: 'anthropic/claude-opus-5.5',
          fallbackModel: null,
          effort: 'low',
          promptVersion: 'ping-v1',
          client: 'relay',
          input: { summary: 'Test connection', hash: null, package: null, chars: 0 },
          usageDocs: [],
          requestBytes,
          maxOutputTokens: 2048,
          realNow: Date.now(),
        });
      // Attempt 1 died during its call; attempt 2 comes 11 minutes late: it closes the dead run, then is skipped.
      await started('jt_late', 1, 3000);
      const late = await runAgent(devReq('jt_late', { trigger: 'test', attempt: 2, waitedMs: STALE_TEST_MS + 60_000 }), { client: stubClient() });
      assertEqual([late.outcome, late.reason], ['skipped', 'already_called'], 'the dead run first');
      const dead = (await db.collection(COL.agentRuns).doc(runIdFor('jt_late', 1)).get()).data()!;
      assertEqual([dead.status, dead.reason, dead.costMicroUsd > 0], ['done', 'interrupted', true], 'closed and costed');
      // A record written by a run that ended before the call (no request): closed, not counted, no alert.
      await started('jt_early', 1, 0);
      const before = (await monthDoc())?.costMicroUsd;
      const alertsBefore = (await alerts('agent_failing')).length;
      await runAgent(devReq('jt_early', { attempt: 2 }), { client: stubClient() });
      const early = (await db.collection(COL.agentRuns).doc(runIdFor('jt_early', 1)).get()).data()!;
      assertEqual([early.status, early.reason], ['done', 'interrupted'], 'closed');
      assertEqual([(await monthDoc())?.costMicroUsd, (await alerts('agent_failing')).length], [before, alertsBefore], 'not counted, no alert');
      // Counted once: a second count for the same run is ignored (e.g. its worker counted, then stopped).
      const once = await runAgent(devReq('jt_once'), { client: stubClient() });
      const m1 = await monthDoc();
      const again = await addUsage({ realNow: Date.now(), agentKey: 'ping', runId: once.runId, tenantUserId: null, outcome: 'failed', counted: true, costMicro: 99_999, usage: NO_USAGE });
      assertEqual(again.afterMicro, again.beforeMicro, 'nothing added');
      const m2 = await monthDoc();
      assertEqual([m2?.costMicroUsd, m2?.runs], [m1?.costMicroUsd, m1?.runs], 'the counters are unchanged');
    });

    await test('round 4: a close counts in its own transaction, never after a run counted itself (which may still finish); a worst-case close is kept; abandoned runs are swept', async () => {
      await fresh();
      const started = (taskId: string, attempt: number, createdAt: number) =>
        startRun({
          runId: runIdFor(taskId, attempt),
          agentKey: 'ping',
          trigger: 'schedule',
          taskId,
          attempt,
          tenantUserId: null,
          venueId: null,
          model: 'anthropic/claude-opus-5.5',
          fallbackModel: null,
          effort: 'low',
          promptVersion: 'ping-v1',
          client: 'relay',
          input: { summary: 'Test connection', hash: null, package: null, chars: 0 },
          usageDocs: [],
          requestBytes: 3000,
          maxOutputTokens: 2048,
          realNow: createdAt,
        });
      // A run that counted its real spend, then its worker stopped before finishing it.
      await started('jt_counted', 1, Date.now());
      await addUsage({ realNow: Date.now(), agentKey: 'ping', runId: runIdFor('jt_counted', 1), tenantUserId: null, outcome: 'ok', counted: true, costMicro: 1_234, usage: NO_USAGE });
      const m1 = await monthDoc();
      await runAgent(devReq('jt_counted', { attempt: 2 }), { client: stubClient() });
      const closed = (await db.collection(COL.agentRuns).doc(runIdFor('jt_counted', 1)).get()).data()!;
      assertEqual([closed.reason, closed.costMicroUsd], ['interrupted', 1_234], 'closed with what it counted');
      assertEqual([(await monthDoc())?.costMicroUsd, (await monthDoc())?.runs], [m1?.costMicroUsd, m1?.runs], 'not counted again');
      // The original, finishing late after it had counted itself, writes its real result (the counters already match).
      const { finishRun } = await import('../../src/adaptive/store/agents');
      const late = await finishRun(runIdFor('jt_counted', 1), { outcome: 'ok', reason: null, modelUsed: 'x', fallbackUsed: false, attempts: [], stopReason: 'end_turn', refusalCategory: null, output: { text: null, parsed: null, reasoning: null }, checks: [], usage: NO_USAGE, costMicroUsd: 1, price: null, latencyMs: 1, error: null }, Date.now());
      assertEqual(late.state, 'finished', 'a run that counted itself still writes its real result');
      assertEqual((await db.collection(COL.agentRuns).doc(runIdFor('jt_counted', 1)).get()).get('outcome'), 'ok', 'its own outcome');
      assertEqual([(await monthDoc())?.costMicroUsd, (await monthDoc())?.runs], [m1?.costMicroUsd, m1?.runs], 'the counters unchanged');
      // Closed at the worst case first: the late count is skipped and the late finish is kept `closed`.
      await started('jt_worst', 1, Date.now());
      await runAgent(devReq('jt_worst', { attempt: 2 }), { client: stubClient() });
      const worst = (await db.collection(COL.agentRuns).doc(runIdFor('jt_worst', 1)).get()).data()!;
      const lateCount = await addUsage({ realNow: Date.now(), agentKey: 'ping', runId: runIdFor('jt_worst', 1), tenantUserId: null, outcome: 'ok', counted: true, costMicro: 5, usage: NO_USAGE });
      assertEqual(lateCount.afterMicro, lateCount.beforeMicro, 'the late count is skipped');
      const lateFinish = await finishRun(runIdFor('jt_worst', 1), { outcome: 'ok', reason: null, modelUsed: 'x', fallbackUsed: false, attempts: [], stopReason: 'end_turn', refusalCategory: null, output: { text: null, parsed: null, reasoning: null }, checks: [], usage: NO_USAGE, costMicroUsd: 5, price: null, latencyMs: 1, error: null }, Date.now());
      assertEqual(lateFinish.state, 'closed', 'kept');
      const kept = (await db.collection(COL.agentRuns).doc(runIdFor('jt_worst', 1)).get()).data()!;
      assertEqual([kept.reason, kept.costMicroUsd], ['interrupted', worst.costMicroUsd], 'the worst case stays, as counted');
      // The sweep: a run left `running` for 31 minutes is closed and counted; a fresh one is not touched.
      const { closeAbandonedRuns } = await import('../../src/adaptive/brain/run');
      const oldAt = Date.now() - 31 * 60_000;
      await started('jt_old', 3, oldAt);
      await started('jt_new', 1, Date.now());
      // Counted in the month the run started (31 minutes ago may be last month).
      const oldMonth = async () => (await db.collection(COL.agentUsage).doc(`month_${monthKeyOf(oldAt)}`).get()).get('costMicroUsd') ?? 0;
      const before = await oldMonth();
      assertEqual(await closeAbandonedRuns(), 1, 'one closed');
      const old = (await db.collection(COL.agentRuns).doc(runIdFor('jt_old', 3)).get()).data()!;
      assert(old.status === 'done' && old.reason === 'interrupted' && old.costMicroUsd > 0, 'the old one: closed and costed');
      assertEqual(await oldMonth(), before + old.costMicroUsd, 'counted');
      assertEqual((await db.collection(COL.agentRuns).doc(runIdFor('jt_new', 1)).get()).get('status'), 'running', 'the fresh one: untouched');
      assertEqual(await closeAbandonedRuns(), 0, 'once');
    });

    await test('round 7: a finish counts a run whose count failed (once); a shutdown before the call gives the task back; every dead attempt is closed', async () => {
      await fresh();
      const { finishRun } = await import('../../src/adaptive/store/agents');
      const rec = (taskId: string, attempt: number) =>
        startRun({
          runId: runIdFor(taskId, attempt),
          agentKey: 'ping',
          trigger: 'schedule',
          taskId,
          attempt,
          tenantUserId: null,
          venueId: null,
          model: 'anthropic/claude-opus-5.5',
          fallbackModel: null,
          effort: 'low',
          promptVersion: 'ping-v1',
          client: 'relay',
          input: { summary: 'Test connection', hash: null, package: null, chars: 0 },
          usageDocs: [],
          requestBytes: 3000,
          maxOutputTokens: 2048,
          realNow: Date.now(),
        });
      const finish = { outcome: 'ok' as const, reason: null, modelUsed: 'anthropic/claude-opus-5.5', fallbackUsed: false, attempts: [], stopReason: 'end_turn', refusalCategory: null, output: { text: null, parsed: null, reasoning: null }, checks: [], usage: NO_USAGE, costMicroUsd: 777, price: null, latencyMs: 1, error: null };
      const entry = { realNow: Date.now(), agentKey: 'ping', runId: runIdFor('jt_uncounted', 1), tenantUserId: null, outcome: 'ok' as const, counted: true, costMicro: 777, usage: NO_USAGE };
      await rec('jt_uncounted', 1);
      const before = (await monthDoc())?.costMicroUsd ?? 0;
      const fin = await finishRun(runIdFor('jt_uncounted', 1), finish, Date.now(), entry);
      assertEqual([fin.state, fin.counted, (await monthDoc())?.costMicroUsd], ['finished', true, before + 777], 'counted with the finish');
      const doc = (await db.collection(COL.agentRuns).doc(runIdFor('jt_uncounted', 1)).get()).data()!;
      assert(doc.usageCounted === true && doc.countedAt, 'marked counted');
      // A count that did land (its reply lost): the finish sees `countedAt` and doesn't count again.
      await rec('jt_landed', 1);
      await addUsage({ ...entry, runId: runIdFor('jt_landed', 1) });
      const mid = (await monthDoc())?.costMicroUsd;
      const fin2 = await finishRun(runIdFor('jt_landed', 1), finish, Date.now(), { ...entry, runId: runIdFor('jt_landed', 1) });
      assertEqual([fin2.counted, (await monthDoc())?.costMicroUsd], [true, mid], 'once');
      // Round 9: gone (an account delete) and its count failed — the finish counts it, in the platform's totals only.
      const gone = { ...entry, runId: runIdFor('jt_gone_uncounted', 1), tenantUserId: 'tenant_gone' };
      const beforeGone = (await monthDoc())?.costMicroUsd ?? 0;
      const fin3 = await finishRun(runIdFor('jt_gone_uncounted', 1), finish, Date.now(), gone);
      assertEqual([fin3.state, fin3.counted, (await monthDoc())?.costMicroUsd], ['gone', true, beforeGone + 777], 'gone: still counted');
      assertEqual((await monthDoc())?.byTenant?.tenant_gone, undefined, 'never as the deleted account’s share');
      assert(!(await db.collection(COL.agentRuns).doc(runIdFor('jt_gone_uncounted', 1)).get()).exists, 'the record is not re-created');
      // Two dead attempts: the third closes both.
      await rec('jt_two', 1);
      await rec('jt_two', 2);
      const third = await runAgent(devReq('jt_two', { attempt: 3 }), { client: stubClient() });
      assertEqual(third.reason, 'already_called', 'skipped');
      for (const a of [1, 2]) assertEqual((await db.collection(COL.agentRuns).doc(runIdFor('jt_two', a)).get()).get('reason'), 'interrupted', `attempt ${a} closed`);
      // A shutdown before the call: no record, and the lane gives the task back.
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'sd-early', dueAt: now() - 1000 }));
      const [task] = await claimDue('test-worker', now(), 10);
      const lane = new AiLane('test-worker', async (req, opts) => {
        const stop = new AbortController();
        stop.abort('shutdown');
        return runAgent(req, { ...opts, signal: stop.signal, client: stubClient() });
      });
      assertEqual(await lane.take(task, { now: now(), settings: await readEngineSettingsStrict() }), 'started', 'started');
      await lane.whenIdle();
      assertEqual((await db.collection(COL.agentRuns).doc(runIdFor(task.id, 1)).get()).exists, false, 'no record');
      const t = await db.collection(COL.journeyTasks).doc(task.id).get();
      assertEqual([t.get('status'), t.get('attempts')], ['queued', 0], 'back in the queue, no attempt counted');
    });

    await test('round 3: a renewal that fails (Firestore unreachable) stops the run only after three intervals without a good one', async () => {
      await fresh();
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'renew-1', dueAt: now() - 1000 }));
      const [task] = await claimDue('test-worker', now(), 10);
      const settings = await readEngineSettingsStrict();
      let answers = 0;
      const script: Array<'held' | 'lost' | 'error'> = ['held', 'error', 'held', 'error', 'error', 'error', 'error', 'error'];
      let stoppedAt = 0;
      const lane = new AiLane(
        'test-worker',
        async (_req, opts) => {
          const t0 = Date.now();
          await new Promise<void>((r) => opts.signal.addEventListener('abort', () => r()));
          stoppedAt = Date.now() - t0;
          return { runId: 'x', outcome: 'failed', reason: 'aborted', costMicroUsd: 0 };
        },
        100,
        async () => script[Math.min(answers++, script.length - 1)],
      );
      assertEqual(await lane.take(task, { now: now(), settings }), 'started', 'started');
      await lane.whenIdle();
      // held at the start; error; held (the clock restarts); then errors: stopped after > 3 × 100 ms without a good one.
      assert(stoppedAt >= 400 && stoppedAt < 1500, `stopped after the grace, not at the first error (${stoppedAt} ms)`);
    });

    await test('a dead AI task is never retried (it may already have called the model)', async () => {
      await fresh();
      const id = await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'dead-1', dueAt: now() }));
      await db.collection(COL.journeyTasks).doc(id).update({ status: 'dead' });
      const res = await api.call('POST', `/admin/tasks/${id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual(res.status, 409, 'refused');
      assert(/never retried/.test(String(res.body.message ?? res.body.error ?? '')), `the reason: ${JSON.stringify(res.body)}`);
      assertEqual((await db.collection(COL.journeyTasks).doc(id).get()).get('status'), 'dead', 'still dead');
    });

    await test('shutdown: the run in the lane is stopped and recorded without an alert; a task claimed after goes straight back', async () => {
      await fresh();
      await answers([{ fault: 'slow', ms: 20_000 }]);
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'sd-1', dueAt: now() - 2000 }));
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'sd-2', dueAt: now() - 1000 }));
      const [a, b] = await claimDue('test-worker', now(), 10);
      const lane = new AiLane('test-worker');
      const settings = await readEngineSettingsStrict();
      assertEqual(await lane.take(a, { now: now(), settings }), 'started', 'started');
      await new Promise((r) => setTimeout(r, 800));
      const t0 = Date.now();
      lane.abortForShutdown();
      await lane.whenIdle();
      assert(Date.now() - t0 < 5000, 'stopped at once');
      const r = await lastRun();
      assertEqual([r.outcome, r.reason], ['failed', 'aborted'], 'recorded');
      assert(/stopping for a deploy/.test(String(r.error)), `why: ${r.error}`);
      assertEqual((await alerts('agent_failing')).length, 0, 'no alert for a deploy');
      assertEqual(await lane.take(b, { now: now(), settings }), 'released', 'the next task goes back');
      const bDoc = await db.collection(COL.journeyTasks).doc(b.id).get();
      assert(bDoc.get('status') === 'queued' && bDoc.get('attempts') === 0 && bDoc.get('dueAt').toMillis() <= now() + 1000, 'due at once, no attempt counted');
    });

    await test('a damaged spend counter pauses every agent and says so; a write to a damaged `agents` setting keeps its $0 budget', async () => {
      await fresh();
      const month = monthKeyOf(Date.now());
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 'lots' });
      const r = await devRun();
      assertEqual([r.outcome, r.reason], ['skipped', 'budget'], 'fails closed');
      const tab = await api.get('/admin/agents');
      assert(tab.body.warnings.some((w: string) => /can’t be read/.test(w)), `the warning: ${JSON.stringify(tab.body.warnings)}`);
      assert(!tab.body.warnings.some((w: string) => /used up/.test(w)), `not "used up" (raising the budget won't help): ${JSON.stringify(tab.body.warnings)}`);
      assertEqual(tab.body.month.spentUsd, null, 'no made-up spend');
      // A damaged day counter: that agent is paused today, and the card says so.
      await db.collection(COL.agentUsage).doc(`month_${month}`).set({ month, costMicroUsd: 0 });
      await db.collection(COL.agentUsage).doc(`ping_${dayKeyOf(Date.now())}`).set({ agentKey: 'ping', runs: 'many' });
      const r2 = await devRun();
      assertEqual([r2.outcome, r2.reason], ['skipped', 'daily_limit'], 'fails closed');
      const tab2 = await api.get('/admin/agents');
      assert(tab2.body.warnings.some((w: string) => /run count of “Test connection” can’t be read/.test(w)), `the warning: ${JSON.stringify(tab2.body.warnings)}`);
      assertEqual(tab2.body.warnings.filter((w: string) => /used up|budget is 0/.test(w)).length, 0, 'no budget warning for a day counter');
      assertEqual(tab2.body.agents[0].today.runs, null, 'no made-up count');
      await setAgents('on' as unknown as Record<string, unknown>);
      assertEqual((await readEngineSettingsStrict()).agents?.monthlyBudgetUsd, 0, 'a damaged setting reads as $0');
      const off = await api.call('PUT', '/admin/launch', { change: { agents: { accounts: { t1: 'off' } } }, actor: ADMIN_ACTOR });
      assertEqual(off.status, 200, `one click: ${JSON.stringify(off.body).slice(0, 200)}`);
      clearCaches();
      assertEqual((await readEngineSettingsStrict()).agents?.monthlyBudgetUsd, 0, 'still $0 (not the $100 default of a map without a budget)');
    });

    await test('the gate: a scheduled run needs the agent on and the AI switch on', async () => {
      await fresh();
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'schedule', dedupeKey: 'sched-1', dueAt: now() }));
      await runDue();
      let r = await lastRun();
      assertEqual([r.outcome, r.reason], ['skipped', 'agent_off'], 'agent off');
      await db.collection(COL.agents).doc('ping').set({ enabled: true });
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'schedule', dedupeKey: 'sched-2', dueAt: now() }));
      await runDue();
      r = await lastRun();
      assertEqual([r.outcome, r.reason], ['skipped', 'agents_off'], 'the AI switch off');
      await setAgents({ mode: 'on' });
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'schedule', dedupeKey: 'sched-3', dueAt: now() }));
      await runDue();
      r = await lastRun();
      assertEqual(r.outcome, 'ok', 'on: runs');
      assertEqual((await calls()).length, 1, 'only the last one called the model');
    });

    await test('privacy: a package with an email fails the scan — nothing called, nothing of it stored', async () => {
      await fresh();
      const leaky: AgentJob<any, any> = {
        ...pingJob,
        buildInput: () => ({ pkg: { test: 'connection', nonce: 1234, note: 'from anna@example.ch' }, secrets: [], summary: 'leaky' }),
      };
      const result = await runAgent({ agentKey: 'ping', trigger: 'dev', taskId: 'jt_leaky', attempt: 1, tenantUserId: null, venueId: null }, { job: leaky });
      assertEqual([result.outcome, result.reason], ['failed', 'privacy_scan'], 'failed');
      const r = await lastRun();
      assertEqual([r.input.package, r.input.hash], [null, null], 'nothing of the package stored');
      assert(/withheld/.test(r.input.summary), 'a fixed summary (the job’s own could hold what was found)');
      assertEqual(r.privacyFindings, [{ kind: 'email', path: 'note' }], 'where, not what');
      assert(!JSON.stringify(r).includes('anna'), 'the address is nowhere in the run');
      assertEqual((await calls()).length, 0, 'the model was not called');
      // The same task attempt twice never calls the model twice.
      const again = await runAgent({ agentKey: 'ping', trigger: 'dev', taskId: 'jt_leaky', attempt: 1, tenantUserId: null, venueId: null }, { job: leaky });
      assertEqual([again.outcome, again.reason], ['skipped', 'duplicate'], 'duplicate');
    });

    await test('round 8: the summary is scanned whole (the 500-character cut would split the address); an early end is counted', async () => {
      await fresh();
      const long: AgentJob<any, any> = {
        ...pingJob,
        buildInput: () => ({ pkg: { test: 'connection', nonce: 1234 }, secrets: [], summary: `${'x'.repeat(490)} anna.muster@example.ch` }),
      };
      const result = await runAgent({ agentKey: 'ping', trigger: 'dev', taskId: 'jt_long_summary', attempt: 1, tenantUserId: null, venueId: null }, { job: long });
      assertEqual([result.outcome, result.reason], ['failed', 'privacy_scan'], 'failed');
      const r = await lastRun();
      assertEqual(r.privacyFindings, [{ kind: 'email', path: "(the run's summary)" }], 'found in the summary');
      assert(!JSON.stringify(r).includes('anna'), 'nothing of it stored');
      assertEqual((await calls()).length, 0, 'the model was not called');
      // Finished first, counted after: the record doesn't say the counters failed.
      assertEqual(r.usageCounted, true, 'usageCounted');
    });

    await test('the lane: a slow call holds nothing else; a second agent task waits; an unknown agent is left for later', async () => {
      await fresh();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const lane = new AiLane('test-worker', async (req) => {
        await gate;
        return { runId: `ar_${req.taskId}`, outcome: 'ok', reason: null, costMicroUsd: 0 };
      });
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lane-1', dueAt: now() - 2000 }));
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lane-2', dueAt: now() - 1000 }));
      const [a, b] = await claimDue('test-worker', now(), 10);
      const settings = await readEngineSettingsStrict();
      const t0 = Date.now();
      assertEqual(await lane.take(a, { now: now(), settings }), 'started', 'started');
      assert(Date.now() - t0 < 1500, 'take() returns at once');
      assertEqual(lane.busy, true, 'busy');
      assertEqual(await lane.take(b, { now: now(), settings }), 'released', 'a second one waits');
      const bDoc = await db.collection(COL.journeyTasks).doc(b.id).get();
      assertEqual([bDoc.get('status'), bDoc.get('attempts')], ['queued', 0], 'back in the queue, no attempt counted');
      release();
      await lane.whenIdle();
      assertEqual(lane.busy, false, 'free again');
      const aDoc = await db.collection(COL.journeyTasks).doc(a.id).get();
      assertEqual(aDoc.get('status'), 'done', 'done');
      // A task for an agent this build doesn't know (a newer build wrote it).
      await firestoreScheduler.schedule({ ...agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lane-3', dueAt: now() - 500 }), payload: { agentKey: 'future_agent', trigger: 'schedule', params: {} } });
      const [c] = (await claimDue('test-worker', now(), 10)).filter((t) => t.payload.agentKey === 'future_agent');
      assertEqual(await lane.take(c, { now: now(), settings }), 'released', 'released');
      const cDoc = await db.collection(COL.journeyTasks).doc(c.id).get();
      assert(cDoc.get('status') === 'queued' && cDoc.get('dueAt').toMillis() > now() + 9 * 60_000, 'left for ten minutes');
    });

    await test('the lane and the lease: its own task stays with the run; a lease lost before the start runs nothing; one lost during the run aborts it', async () => {
      await fresh();
      const settings = await readEngineSettingsStrict();
      let calledFn = 0;
      let sawAbort = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const lane = new AiLane(
        'test-worker',
        async (req, opts) => {
          calledFn += 1;
          await Promise.race([gate, new Promise<void>((r) => opts.signal.addEventListener('abort', () => ((sawAbort = true), r())))]);
          return { runId: `ar_${req.taskId}`, outcome: sawAbort ? 'failed' : 'ok', reason: sawAbort ? 'aborted' : null, costMicroUsd: 0 };
        },
        150,
      );
      // Its own task, handed back to it: the run goes on.
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lease-1', dueAt: now() - 1000 }));
      const [a] = await claimDue('test-worker', now(), 10);
      assertEqual(await lane.take(a, { now: now(), settings }), 'started', 'started');
      assertEqual(await lane.take(a, { now: now(), settings }), 'running', 'the same task again: still running, not released');
      release();
      await lane.whenIdle();
      assertEqual([calledFn, (await db.collection(COL.journeyTasks).doc(a.id).get()).get('status')], [1, 'done'], 'ran once, done');
      // Lost before the start: another worker took it over.
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lease-2', dueAt: now() - 1000 }));
      const [b] = await claimDue('test-worker', now(), 10);
      await db.collection(COL.journeyTasks).doc(b.id).update({ leaseOwner: 'other-worker' });
      assertEqual(await lane.take(b, { now: now(), settings }), 'started', 'taken');
      await lane.whenIdle();
      assertEqual(calledFn, 1, 'nothing ran');
      assertEqual((await db.collection(COL.journeyTasks).doc(b.id).get()).get('leaseOwner'), 'other-worker', 'left to its new owner');
      // Lost during the run: the renewal fails and the call is aborted.
      await firestoreScheduler.schedule(agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'lease-3', dueAt: now() - 1000 }));
      const [c] = (await claimDue('test-worker', now(), 10)).filter((t) => t.id !== b.id);
      const blocked = new AiLane(
        'test-worker',
        async (_req, opts) => {
          calledFn += 1;
          await new Promise<void>((r) => opts.signal.addEventListener('abort', () => ((sawAbort = true), r())));
          return { runId: 'x', outcome: 'failed', reason: 'aborted', costMicroUsd: 0 };
        },
        150,
      );
      assertEqual(await blocked.take(c, { now: now(), settings }), 'started', 'started');
      await new Promise((r) => setTimeout(r, 100));
      await db.collection(COL.journeyTasks).doc(c.id).update({ leaseOwner: 'other-worker' });
      const t0 = Date.now();
      await blocked.whenIdle();
      assert(sawAbort && Date.now() - t0 < 3000, 'aborted at the next renewal');
      assertEqual((await db.collection(COL.journeyTasks).doc(c.id).get()).get('status'), 'leased', 'not completed by the worker that lost it');
    });

    await test('a slow model inside the worker: its task returns at once (the batch moves on) while the AI run goes on', async () => {
      await fresh();
      await answers([{ fault: 'slow', ms: 1500 }]);
      await devAgentRun({ agentKey: 'ping' });
      const lane = (worker as unknown as { aiLane: AiLane }).aiLane;
      const tasks = await claimDue(worker.id, now(), 10);
      assertEqual(tasks.map((t) => t.kind), ['agent_run'], 'the agent task');
      const t0 = Date.now();
      await (worker as unknown as { runTask(t: unknown): Promise<void> }).runTask(tasks[0]);
      assert(Date.now() - t0 < 1000, 'runTask returned before the model answered');
      assertEqual(lane.busy, true, 'the lane is running it');
      await lane.whenIdle();
      assertEqual((await lastRun()).outcome, 'ok', 'it finished');
    });

    await test('the real client refuses under the emulator, env set or not; the heartbeat says only whether it is set', async () => {
      const secretBefore = process.env.INTERNAL_API_SECRET;
      process.env.CMS_INTERNAL_URL = 'https://cms.invalid';
      process.env.INTERNAL_API_SECRET = 'never-written-anywhere-7f3a';
      try {
        let error: unknown = null;
        try {
          await relayClient().call({
            agentKey: 'ping',
            runId: 'ar_x',
            model: 'anthropic/claude-opus-5.5',
            system: 's',
            cacheSystem: false,
            user: 'u',
            format: await outputFormatFor(pingJob.outputSchema),
            effort: 'low',
            maxOutputTokens: 256,
            timeoutMs: 1000,
            pkg: {},
          });
        } catch (e) {
          error = e;
        }
        assert(error instanceof ModelError && error.code === 'emulator' && error.kind === 'setup', 'refused: emulator');
        (worker as unknown as { lastBeatAt: number }).lastBeatAt = 0;
        await (worker as unknown as { heartbeat(): Promise<void> }).heartbeat();
        const status = await db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get();
        const ai = status.get(`workers.${worker.id.replace(/\./g, '\\.')}`)?.ai ?? (status.get('workers') ?? {})[worker.id]?.ai;
        assertEqual([ai?.relayUrlSet, ai?.relaySecretSet], [true, true], 'booleans');
        assert(!JSON.stringify(status.data()).includes('cms.invalid'), 'the URL is never written');
        assert(!JSON.stringify(status.data()).includes('never-written-anywhere'), 'the secret is never written');
      } finally {
        delete process.env.CMS_INTERNAL_URL;
        process.env.INTERNAL_API_SECRET = secretBefore;
      }
    });

    await test('the admin view warns when the only live worker is idle (it runs no task, agents included)', async () => {
      const ref = db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID);
      const saved = (await ref.get()).data() ?? {};
      try {
        await ref.set({ workers: { 'idle-1': { lastBeatAt: new Date(), version: 'x', state: 'idle_indexes', ai: { busy: false, relayUrlSet: true, relaySecretSet: true } } } });
        const tab = await api.get('/admin/agents');
        assert(tab.body.warnings.some((w: string) => /idle/.test(w)), `the warning: ${JSON.stringify(tab.body.warnings)}`);
        assertEqual(tab.body.workers[0].state, 'idle_indexes', 'the state is shown');
      } finally {
        await ref.set(saved);
      }
    });
  } finally {
    await api.close();
  }
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
