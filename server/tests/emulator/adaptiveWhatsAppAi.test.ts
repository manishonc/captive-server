/**
 * PR W2a — the AI template writer on the emulator: "Suggest with AI" through the real router, the
 * worker's AI lane and the fake model, the answer applied once into the registry, and the daily
 * gap-fill in the template tick. Nothing here can reach a real model or Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Suggest is refused (409, logged, nothing queued) with the AI switch off, no budget, or the
 *    writer's runs used; it needs the AI switch only (the writer's Scheduled runs stay off).
 *  - Suggest → an AI draft (origin `ai`, its run, reasoning, the button on the visitor base, the STOP
 *    footer), the run's `apply` stamped, the log naming the admin then the AI, the cell no longer
 *    pending; the draft passes every check and goes to Meta.
 *  - Exactly once: applying the run again does nothing; two clicks queue one run; a Suggest right
 *    after a run finished queues a new one (never a stale pending mark).
 *  - Recovery: an apply that failed is applied by the task's next attempt from the stored answer,
 *    the model called once; a dead task's answer is applied by the sweep after 15 minutes, and
 *    stamped failed (with an alert) after 7 days.
 *  - A rejected answer writes nothing but a log row. A translation whose language appeared while
 *    the model wrote is superseded (logged), never a second template.
 *  - A fix: rewrites the rejected template in place (version + 1, AI fix 1 of 2), sent again; a
 *    person's edit meanwhile skips the run before the model (no run record); at the limit refused.
 *  - The daily gap-fill (in the tick, after a complete sync): needs the AI switch and the writer's
 *    Scheduled runs; English first, within the runs left minus the Suggest reserve; once a day;
 *    translations once the English is in review; cells with a run on its way skipped; a cell
 *    rejected 3 times in a row waits 7 days; an error in it keeps none of W1's alerts back.
 */

import { COL, advance, assert, assertEqual, clearCaches, db, done, now, resetEmulator, runDue, runUntil, seedCatalogue, setClock, test } from './helpers';
import { ADMIN_ACTOR, mountApi } from './ownerApiHelpers';
import { CONFIG_DOC_ID, WHATSAPP_DOC_ID } from '../../src/adaptive/store/collections';
import { runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache } from '../../src/adaptive/whatsapp/hints';
import { STOP_LINES } from '../../src/adaptive/send/compose';
import { jobFor } from '../../src/adaptive/brain/registry';
import { applyStored, runAgent, runIdFor, sweepPendingApplies, APPLY_GIVE_UP_MS, APPLY_SWEEP_AFTER_MS, type RunRequest } from '../../src/adaptive/brain/run';
import { applyRunOnce, queueSandboxAnswers, readAgentSettings, readRunForApply, writeAgentSettings, type AgentSettingsChange } from '../../src/adaptive/store/agents';
import { dayKeyOf } from '../../src/adaptive/brain/budget';
import { ModelError, type ModelClient, type ModelReply } from '../../src/adaptive/brain/modelClient';
import { planGapFill, SUGGEST_RESERVE, writerRequestFor } from '../../src/adaptive/whatsapp/aiRequests';
import { reportWriterRun } from '../../src/adaptive/whatsapp/aiDrafts';
import { cellKeyOf } from '../../src/adaptive/core/whatsapp/aiBrief';

type Doc = Record<string, any>;
const DAY = 86_400_000;
const WRITER = 'wa_template_writer';
const job = jobFor(WRITER)!;

let api: Awaited<ReturnType<typeof mountApi>>;
let actorN = 0;
let actor: { uid: string; kind: 'super_admin' } = { ...ADMIN_ACTOR };

const OFFER = { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' };
const WIFI = { journeyKey: 'wifi_info_card', poolKey: 'wifi_info' };

async function fresh(): Promise<void> {
  await resetEmulator();
  __clearHintCache();
  await seedCatalogue();
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test' });
  clearCaches();
  // Monday 5 Oct 2026, 11:00 in Zurich (CEST).
  await setClock(Date.UTC(2026, 9, 5, 9, 0));
  actorN += 1;
  actor = { uid: `heidifi_admin_ai_${actorN}`, kind: 'super_admin' };
}

const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor });
const put = (path: string, body: Record<string, unknown> = {}) => api.call('PUT', path, { ...body, actor });
const get = (path: string) => api.get(path);

async function connectAndSync(): Promise<void> {
  assertEqual((await post('/admin/whatsapp/connection/check')).status, 200, 'connection');
  assertEqual((await post('/admin/whatsapp/sync')).status, 200, 'sync');
}

async function aiOn(monthlyBudgetUsd = 100): Promise<void> {
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd, changedBy: 'test' } });
  clearCaches();
}

async function writerSettings(change: AgentSettingsChange): Promise<void> {
  const cur = await readAgentSettings(job);
  await writeAgentSettings(job, change, cur.version, 'test');
}

const suggest = (body: Record<string, unknown>) => post('/admin/whatsapp/suggest', body);

async function aiTemplates(): Promise<Doc[]> {
  const snap = await db.collection(COL.whatsappTemplates).where('origin', '==', 'ai').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function writerRuns(): Promise<Doc[]> {
  const snap = await db.collection(COL.agentRuns).where('agentKey', '==', WRITER).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function agentTasks(): Promise<Doc[]> {
  const snap = await db.collection(COL.journeyTasks).where('kind', '==', 'agent_run').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function modelCalls(): Promise<number> {
  return (await db.collection(COL.sandboxModelCalls).get()).size;
}

async function ops(): Promise<Doc> {
  return ((await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).data() ?? {}) as Doc;
}

async function logRows(kind?: string): Promise<Doc[]> {
  const snap = await db.collection(COL.whatsappLog).get();
  return snap.docs.map((d) => d.data()).filter((r) => !kind || r.kind === kind);
}

async function alertsOf(kind: string): Promise<Doc[]> {
  const snap = await db.collection(COL.alerts).where('kind', '==', kind).get();
  return snap.docs.map((d) => d.data());
}

async function view(id: string) {
  const r = await get(`/admin/whatsapp/templates/${id}`);
  assertEqual(r.status, 200, `view ${r.text}`);
  return r.body as { template: Doc; history: Doc[] };
}

async function overview() {
  const r = await get('/admin/whatsapp');
  assertEqual(r.status, 200, `overview ${r.text}`);
  return r.body as Doc;
}

const cellOf = (o: Doc, use: { poolKey: string }, lang: string) => o.messages.find((m: Doc) => m.poolKey === use.poolKey).cells[lang];

async function submit(id: string, baseVersion: number) {
  return post(`/admin/whatsapp/templates/${id}/submit`, { baseVersion });
}

async function review(id: string, decision: string, extra: Record<string, unknown> = {}) {
  const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision, ...extra });
  assertEqual(r.status, 200, `review ${r.text}`);
}

/** Suggest → the worker runs it → the one AI template it wrote. */
async function suggestAndRun(use: typeof OFFER, lang: string, kind = 'new', templateId?: string): Promise<Doc> {
  const before = new Set((await aiTemplates()).map((t) => t.id));
  const r = await suggest({ use, lang, kind, ...(templateId ? { templateId } : {}) });
  assertEqual(r.status, 200, `suggest ${r.text}`);
  await runDue();
  const fresh = (await aiTemplates()).filter((t) => !before.has(t.id));
  assertEqual(fresh.length, 1, 'one AI template written');
  return fresh[0];
}

const writerReq = (taskId: string, params: Record<string, unknown>, over: Partial<RunRequest> = {}): RunRequest => ({
  agentKey: WRITER,
  trigger: 'manual',
  taskId,
  attempt: 1,
  tenantUserId: null,
  venueId: null,
  params,
  ...over,
});

/** A stand-in model: runs `during` inside the call, then gives the job's valid answer. */
function stubClient(during: () => Promise<void>): ModelClient {
  return {
    name: 'stub',
    async call(req): Promise<ModelReply> {
      await during();
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

/** Swaps the writer's apply for a test (always put back). */
async function withApply<T>(apply: NonNullable<typeof job.apply>, fn: () => Promise<T>): Promise<T> {
  const real = job.apply;
  job.apply = apply;
  try {
    return await fn();
  } finally {
    job.apply = real;
  }
}

async function main() {
  api = await mountApi();
  console.log('\nThe AI template writer on the emulator (PR W2a)\n');

  await test('Suggest is refused (409, logged, nothing queued) with the AI switch off, no budget, or the writer’s runs used', async () => {
    await fresh();
    await connectAndSync();
    const off = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual([off.status, off.body?.code], [409, 'ai_off'], off.text);
    assert(/AI ON/.test(off.body.error), off.body.error);
    await aiOn(0);
    const broke = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual([broke.status, broke.body?.code], [409, 'budget'], broke.text);
    const rows = await logRows('ai.request_refused');
    assertEqual([rows.length, rows[0].actor.kind, rows[0].actor.uid], [2, 'admin', actor.uid], 'each refusal logged with the admin');
    assertEqual((await agentTasks()).length, 0, 'nothing queued');
    await aiOn(100);
    const bad = await suggest({ use: { journeyKey: 'nope', poolKey: 'nope' }, lang: 'en', kind: 'new' });
    assertEqual([bad.status, bad.body?.code], [409, 'no_message'], bad.text);
    const tr = await suggest({ use: WIFI, lang: 'de', kind: 'translation' });
    assertEqual([tr.status, tr.body?.code], [409, 'english_missing'], tr.text);
    assertEqual((await agentTasks()).length, 0, 'still nothing queued');
    await writerSettings({ maxRunsPerDay: 1 });
    await suggestAndRun(OFFER, 'en');
    const used = await suggest({ use: WIFI, lang: 'en', kind: 'new' });
    assertEqual([used.status, used.body?.code], [409, 'daily_limit'], used.text);
  });

  await test('Suggest → an AI draft: its run applied once, the log naming the admin then the AI, the cell no longer pending; it passes every check and goes to Meta', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    assertEqual((await readAgentSettings(job)).enabled, false, 'the writer’s Scheduled runs stay off');
    const o0 = await overview();
    assertEqual([o0.ai.aiOn, o0.ai.scheduledOn, o0.ai.blocked, o0.ai.runsLeft, o0.ai.model], [true, false, null, 10, 'anthropic/claude-opus-5.5'], 'the AI block');
    assertEqual(cellOf(o0, OFFER, 'en').suggest.map((s: Doc) => s.kind), ['new'], 'a missing English cell offers a new one');
    const r = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual([r.status, r.body.queued, r.body.runsLeft], [200, true, 9], r.text);
    const o1 = await overview();
    assertEqual([cellOf(o1, OFFER, 'en').aiPending, o1.ai.pendingCells], [true, 1], 'pending while the AI writes');
    const asked = await logRows('ai.requested');
    assertEqual([asked.length, asked[0].actor.kind, asked[0].level], [1, 'admin', 'info'], 'who asked');

    await runDue();
    const [run] = await writerRuns();
    assertEqual([run.outcome, run.trigger, run.apply?.state], ['ok', 'manual', 'applied'], `the run ${JSON.stringify(run.apply)}`);
    const [t] = await aiTemplates();
    assertEqual(run.apply.ref.templateId, t.id, 'the run names its template');
    const line = await get(`/admin/agent-runs?agentKey=${WRITER}`);
    assertEqual([line.status, line.body.runs[0]?.apply?.state, line.body.runs[0]?.apply?.ref?.templateId], [200, 'applied', t.id], `the run log line ${line.text.slice(0, 300)}`);
    assert(/Welcome offer · EN · suggest/.test(line.body.runs[0].summary), line.body.runs[0].summary);
    assertEqual([t.stage, t.lang, t.language, t.useEnabled, t.version, t.requestedCategory], ['draft', 'en', 'en', true, 1, 'MARKETING'], 'a draft');
    assert(/^hf_welcome_offer_\d+$/.test(t.name), t.name);
    assertEqual([t.ai.runId, t.ai.kind, t.ai.requestedBy, t.ai.fixes, t.ai.appliedVersion], [run.runId, 'new', 'suggest', 0, 1], 'its AI info');
    assert(t.ai.reasoning && t.ai.categoryReason && t.ai.model, 'reasoning, category reason and model kept');
    assertEqual([t.source.footer, t.source.button?.field], [STOP_LINES.en, 'link.offer'], 'footer and button added by our code');
    assertEqual(t.compiled.button.url, `${o0.visitorBaseUrl}/{{1}}`, 'the button on the visitor base');
    const v = await view(t.id);
    assertEqual(v.template.display, 'ready', 'ready to send');
    assertEqual(v.template.checks.issues, [], 'no check issue with the full context');
    const written = await logRows('ai.draft_written');
    assertEqual([written.length, written[0].actor.kind, written[0].runId, written[0].templateId], [1, 'ai', run.runId, t.id], 'logged by the AI');
    assertEqual(Object.keys((await ops()).aiPending ?? {}).length, 0, 'the cell is not pending any more');
    const o2 = await overview();
    assertEqual([cellOf(o2, OFFER, 'en').display, cellOf(o2, OFFER, 'en').aiPending, o2.ai.runsLeft], ['ready', false, 9], 'the cell');

    const s = await submit(t.id, 1);
    assertEqual([s.status, s.body.outcome, s.body.template?.display], [200, 'submitted', 'in_review'], s.text);
    const o3 = await overview();
    assertEqual(cellOf(o3, OFFER, 'en').suggest.map((x: Doc) => x.kind), ['alternative'], 'in review: only an alternative');
    assertEqual(cellOf(o3, OFFER, 'de').suggest.map((x: Doc) => `${x.kind}:${x.templateId}`), [`translation:${t.id}`, 'new:null'], 'German: a translation first');
  });

  await test('exactly once: applying the run again does nothing; two clicks queue one run; a Suggest after a finished run queues a new one', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const [a, b] = await Promise.all([suggest({ use: OFFER, lang: 'en', kind: 'new' }), suggest({ use: OFFER, lang: 'en', kind: 'new' })]);
    assertEqual([a.status, b.status].sort(), [200, 409], `${a.text} ${b.text}`);
    assertEqual([a, b].find((x) => x.status === 409)!.body.code, 'pending', 'the second click: already writing');
    assertEqual((await agentTasks()).length, 1, 'one task');
    await runDue();
    const [run] = await writerRuns();
    const stored = await readRunForApply(run.runId);
    assertEqual(stored?.applyState, 'applied', 'applied');
    assertEqual(await applyStored(job, stored!), 'not_applicable', 'applying the stored answer again does nothing');
    let called = false;
    const again = await applyRunOnce(run.runId, async () => {
      called = true;
      return { state: 'applied', code: null, detail: null };
    });
    assertEqual([again, called], ['not_applicable', false], 'never called for an applied run');
    assertEqual([(await aiTemplates()).length, (await logRows('ai.draft_written')).length], [1, 1], 'one draft, one log row');
    // The same minute, the same cell and kind: a new run (the queue ignores a key it has seen).
    const c = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual(c.status, 200, c.text);
    await runDue();
    assertEqual([(await agentTasks()).length, (await aiTemplates()).length], [2, 2], 'a second run, a second draft (a person’s Suggest writes next to a draft)');
    assertEqual(Object.keys((await ops()).aiPending ?? {}).length, 0, 'nothing left pending');
  });

  await test('recovery: an apply that failed is applied by the next attempt from the stored answer (the model called once)', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    let fails = 1;
    const real = job.apply!;
    await withApply(
      async (tx, args) => {
        if (fails-- > 0) throw new Error('a passing Firestore error');
        return real(tx, args);
      },
      async () => {
        assertEqual((await suggest({ use: OFFER, lang: 'en', kind: 'new' })).status, 200, 'suggest');
        await runDue();
        const [first] = await writerRuns();
        assertEqual([first.outcome, first.apply?.state], ['ok', 'pending'], 'finished, not applied');
        assertEqual((await aiTemplates()).length, 0, 'nothing written yet');
        await runUntil(now() + 5 * 60_000);
      },
    );
    const runs = await writerRuns();
    assertEqual(runs.map((r) => `${r.outcome}:${r.reason ?? '-'}:${r.apply?.state ?? '-'}`), ['ok:-:applied', 'skipped:applied_earlier:-'], 'the next attempt applied it');
    assertEqual([await modelCalls(), (await aiTemplates()).length], [1, 1], 'one model call, one draft');
    assertEqual((await logRows('ai.skipped')).length, 0, 'a recovered attempt logs no skip');
  });

  await test('a dead task’s answer: applied by the sweep after 15 minutes; stamped failed (with an alert) after 7 days', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const broken: NonNullable<typeof job.apply> = async () => {
      throw new Error('a passing Firestore error');
    };
    await withApply(broken, async () => {
      assertEqual((await suggest({ use: OFFER, lang: 'en', kind: 'new' })).status, 200, 'suggest');
      await runUntil(now() + 10 * 60_000);
    });
    const [task] = await agentTasks();
    assertEqual(task.status, 'dead', 'the task died');
    assertEqual(await sweepPendingApplies(Date.now() + APPLY_SWEEP_AFTER_MS - 60_000), 0, 'not before 15 minutes');
    assertEqual(await sweepPendingApplies(Date.now() + APPLY_SWEEP_AFTER_MS + 60_000), 1, 'the sweep applies it');
    const [run] = await writerRuns();
    assertEqual([run.apply?.state, (await aiTemplates()).length, await modelCalls()], ['applied', 1, 1], 'applied once, from the stored answer');
    assertEqual(Object.keys((await ops()).aiPending ?? {}).length, 0, 'the cell is not pending any more');

    await withApply(broken, async () => {
      assertEqual((await suggest({ use: WIFI, lang: 'en', kind: 'new' })).status, 200, 'suggest');
      await runUntil(now() + 10 * 60_000);
      assertEqual(await sweepPendingApplies(Date.now() + APPLY_SWEEP_AFTER_MS + 60_000), 0, 'still failing: left for later');
      assertEqual(await sweepPendingApplies(Date.now() + APPLY_GIVE_UP_MS + 60_000), 1, 'given up');
    });
    const wifi = (await writerRuns()).find((r) => r.runId !== run.runId)!;
    assertEqual([wifi.apply?.state, wifi.apply?.code], ['failed', 'apply_gave_up'], 'stamped failed');
    assertEqual((await aiTemplates()).length, 1, 'nothing written for it');
    const alerts = await alertsOf('agent_failing');
    assert(alerts.some((a) => /apply_gave_up/.test(a.subject)), JSON.stringify(alerts.map((a) => a.subject)));
    assertEqual(await sweepPendingApplies(Date.now() + APPLY_GIVE_UP_MS + 120_000), 0, 'nothing left');
  });

  await test('a rejected answer writes nothing but a log row; a translation whose language appeared meanwhile is superseded', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await queueSandboxAnswers(WRITER, [
      {
        answer: {
          reasoning: 'A warm welcome back.',
          language: 'en',
          body: 'Hello {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today, we hope to see you again soon.',
          buttonText: 'See offer',
          category: 'UTILITY',
          categoryReason: 'It informs.',
        },
      },
    ]);
    assertEqual((await suggest({ use: OFFER, lang: 'en', kind: 'new' })).status, 200, 'suggest');
    await runDue();
    const [run] = await writerRuns();
    assertEqual([run.outcome, run.apply ?? null], ['rejected', null], 'rejected, nothing to apply');
    assertEqual((await aiTemplates()).length, 0, 'no draft');
    const rej = await logRows('ai.rejected');
    assertEqual([rej.length, rej[0].actor.kind, rej[0].level], [1, 'ai', 'warn'], 'logged');
    assert(/nothing was written/.test(rej[0].summary), rej[0].summary);
    assertEqual(Object.keys((await ops()).aiPending ?? {}).length, 0, 'not pending');

    const en = await suggestAndRun(OFFER, 'en');
    const reqA = await writerRequestFor({ kind: 'translation', requestedBy: 'suggest', use: OFFER, lang: 'de', templateId: en.id });
    const reqB = await writerRequestFor({ kind: 'translation', requestedBy: 'suggest', use: OFFER, lang: 'de', templateId: en.id });
    assert(!('refuse' in reqA) && !('refuse' in reqB), 'built');
    const params = (r: typeof reqA) => ({ brief: (r as any).brief, local: (r as any).local });
    const b = await runAgent(writerReq('task_b', params(reqB)), {
      client: stubClient(async () => {
        const a = await runAgent(writerReq('task_a', params(reqA)));
        assertEqual(a.applied?.state, 'applied', 'the first one wrote German');
      }),
    });
    assertEqual([b.outcome, b.applied?.state, b.applied?.code], ['ok', 'superseded', 'language_exists'], 'the second one superseded');
    const de = (await aiTemplates()).filter((t) => t.lang === 'de');
    assertEqual([de.length, de[0].name, de[0].ai.kind], [1, en.name, 'translation'], 'one German template, under the English name');
    const sup = await logRows('ai.superseded');
    assertEqual([sup.length, sup[0].level], [1, 'info'], 'logged');
  });

  await test('a fix: the rejected template rewritten in place and sent again; a person’s edit meanwhile skips the run (no run record); at the limit refused', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const t = await suggestAndRun(OFFER, 'en');
    assertEqual((await submit(t.id, 1)).status, 200, 'submitted');
    await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    await runWhatsAppTemplateTick();
    const o = await overview();
    assertEqual(cellOf(o, OFFER, 'en').suggest.map((x: Doc) => `${x.kind}:${x.templateId ?? '-'}`), [`fix:${t.id}`, 'alternative:-'], 'offers a fix');

    const r = await suggest({ use: OFFER, lang: 'en', kind: 'fix', templateId: t.id });
    assertEqual(r.status, 200, r.text);
    await runDue();
    const fixed = await view(t.id);
    assertEqual([fixed.template.version, fixed.template.display, fixed.template.ai?.kind, fixed.template.ai?.fixes], [2, 'rejected', 'fix', 1], 'rewritten in place');
    assertEqual((await aiTemplates()).length, 1, 'no second template');
    const fw = await logRows('ai.fix_written');
    assertEqual([fw.length, fw[0].templateId], [1, t.id], 'logged on the template');
    assert(/INVALID_FORMAT/.test(fw[0].summary) && /1 of 2/.test(fw[0].summary), fw[0].summary);
    const again = await submit(t.id, 2);
    assertEqual([again.status, again.body.outcome], [200, 'submitted'], again.text);

    await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    await runWhatsAppTemplateTick();
    const runsBefore = (await writerRuns()).length;
    assertEqual((await suggest({ use: OFFER, lang: 'en', kind: 'fix', templateId: t.id })).status, 200, 'queued');
    const cur = await view(t.id);
    const edit = await put(`/admin/whatsapp/templates/${t.id}`, { change: { source: { ...cur.template.source, body: `${cur.template.source.body} See you soon.` } }, baseVersion: cur.template.version });
    assertEqual(edit.status, 200, edit.text);
    await runDue();
    assertEqual((await writerRuns()).length, runsBefore, 'skipped before the model: no run record');
    const skipped = await logRows('ai.skipped');
    assertEqual([skipped.length, skipped[0].level, skipped[0].detail.reason], [1, 'routine', 'edited_since'], 'one routine row');
    assertEqual(Object.keys((await ops()).aiPending ?? {}).length, 0, 'not pending');

    await db.collection(COL.whatsappTemplates).doc(t.id).update({ 'ai.fixes': 2 });
    const limit = await suggest({ use: OFFER, lang: 'en', kind: 'fix', templateId: t.id });
    assertEqual([limit.status, limit.body?.code], [409, 'fix_limit'], limit.text);
  });

  await test('the daily gap-fill in the tick: needs the AI switch and Scheduled runs; English first within the runs left minus the reserve; once a day', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await advance(7 * 3_600_000);
    const off = await runWhatsAppTemplateTick();
    assertEqual([off.synced, off.aiQueued ?? 0], [true, 0], 'Scheduled runs off: nothing');
    await writerSettings({ enabled: true });
    await advance(7 * 3_600_000);
    const on = await runWhatsAppTemplateTick();
    assertEqual(on.aiQueued, 10 - SUGGEST_RESERVE, 'the runs left minus the Suggest reserve');
    const tasks = await agentTasks();
    assertEqual(tasks.length, 7, 'tasks');
    assert(tasks.every((t) => t.payload.trigger === 'schedule' && t.payload.params.local.kind === 'new' && t.payload.params.local.lang === 'en' && t.payload.params.local.requestedBy === 'gap_fill'), 'English, new, from the gap-fill');
    assertEqual(Object.keys((await ops()).aiPending).length, 7, 'their cells pending');
    assertEqual((await ops()).aiGapFill.lastDay, dayKeyOf(Date.now()), 'the day stamped');
    const gf = await logRows('ai.gap_fill');
    assertEqual([gf.length, gf[0].detail.queued, gf[0].detail.missing], [1, 7, 10], 'one summary row');
    await advance(7 * 3_600_000);
    assertEqual((await runWhatsAppTemplateTick()).aiQueued ?? 0, 0, 'once a day');
    await runUntil(now() + 30 * 60_000);
    const drafts = await aiTemplates();
    assertEqual([drafts.length, new Set(drafts.map((d) => d.use.poolKey)).size], [7, 7], 'seven English drafts, one per message');
    for (const d of drafts) assertEqual((await view(d.id)).template.display, 'ready', `${d.name}: ready to send (no duplicate text)`);
    assert(drafts.every((d) => d.lang === 'en' && d.ai.requestedBy === 'gap_fill'), 'English, by the gap-fill');
    assert(!drafts.some((d) => d.use.poolKey === 'birthday'), 'a coming-soon message is skipped');
  });

  await test('gap-fill: translations once the English is in review; a cell with a run on its way skipped; 3 rejections in a row → 7 days off', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ enabled: true, maxRunsPerDay: 40 });
    const en = await suggestAndRun(OFFER, 'en');
    assertEqual((await submit(en.id, 1)).status, 200, 'in review');
    assertEqual((await suggest({ use: WIFI, lang: 'en', kind: 'new' })).status, 200, 'a Suggest on its way for Wi-Fi info');
    const queued = await planGapFill(Date.now());
    assertEqual(queued, 11, '8 English (Wi-Fi info pending) + 3 translations of the offer');
    await runUntil(now() + 60 * 60_000);
    const all = await aiTemplates();
    const tr = all.filter((t) => t.use.poolKey === OFFER.poolKey && t.lang !== 'en');
    assertEqual(tr.map((t) => `${t.lang}:${t.name}:${t.ai.kind}`).sort(), ['de', 'fr', 'it'].map((l) => `${l}:${en.name}:translation`), 'under the English name');
    assertEqual(all.filter((t) => t.use.poolKey === WIFI.poolKey).length, 1, 'Wi-Fi info: only the Suggest’s draft');
    assert(!all.some((t) => t.ai.kind === 'alternative'), 'never an alternative');

    // Rejected three days running: the cell waits 7 days.
    const req = await writerRequestFor({ kind: 'new', requestedBy: 'gap_fill', use: { journeyKey: 'review_ask', poolKey: 'review_ask' }, lang: 'de' });
    assert(!('refuse' in req), 'built');
    const cell = cellKeyOf('review_ask', 'review_ask', 'de');
    for (let i = 0; i < 3; i += 1) {
      await reportWriterRun({ runId: `r${i}`, agentKey: WRITER, trigger: 'schedule', outcome: 'rejected', reason: 'WW07', params: { brief: (req as any).brief, local: (req as any).local }, detail: 'The same text as another template of this message', modelUsed: null, taskId: null });
      if (i < 2) assertEqual((await ops()).aiGapFill.rejects[cell], i + 1, `counted ${i + 1}`);
    }
    const o = await ops();
    assert(o.aiGapFill.cooldowns[cell] > Date.now() + 6 * DAY, `cooled down ${JSON.stringify(o.aiGapFill)}`);
    assertEqual(o.aiGapFill.rejects?.[cell], undefined, 'the count reset');
    assertEqual((await logRows('ai.rejected')).length, 3, 'each logged');
  });

  await test('review: “AI is writing…” follows the task — a task that ended without a word frees its cell', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const r = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual(r.status, 200, r.text);
    assertEqual(cellOf(await overview(), OFFER, 'en').aiPending, true, 'pending while queued');
    // The task dies without the run reporting (a crash on its last attempt): the mark stays, the cell is free.
    await db.collection(COL.journeyTasks).doc(r.body.taskId).update({ status: 'dead' });
    const o = await overview();
    assertEqual([cellOf(o, OFFER, 'en').aiPending, o.ai.pendingCells, o.ai.queued], [false, 0, 0], 'not pending any more');
    assert((await ops()).aiPending[cellKeyOf(OFFER.journeyKey, OFFER.poolKey, 'en')], 'the stale mark is still on the doc');
    const again = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual(again.status, 200, `a new Suggest is accepted ${again.text}`);
    assert(again.body.taskId !== r.body.taskId, 'a new task');
  });

  await test('review: a run the shutdown stopped mid-call, and one a crash left running, each log a row and free their cell', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const cell = cellKeyOf(OFFER.journeyKey, OFFER.poolKey, 'en');
    // 1. A deploy stops the call: failed/aborted, reported (routine words), the mark cleared.
    const a = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    const params = (await db.collection(COL.journeyTasks).doc(a.body.taskId).get()).get('payload.params');
    const stop = new AbortController();
    const res = await runAgent(writerReq(a.body.taskId, params), {
      signal: stop.signal,
      client: {
        name: 'stub',
        async call(): Promise<ModelReply> {
          stop.abort('shutdown');
          throw new ModelError('retryable', 'aborted', 'The request was aborted');
        },
      },
    });
    assertEqual([res.outcome, res.reason], ['failed', 'aborted'], 'stopped');
    const stopped = await logRows('ai.failed');
    assertEqual([stopped.length, stopped[0].level, stopped[0].detail.reason], [1, 'info', 'aborted'], 'one routine-level row');
    assert(/restarted/.test(stopped[0].summary), stopped[0].summary);
    assertEqual((await ops()).aiPending?.[cell], undefined, 'its mark cleared');
    // 2. A worker crash leaves attempt 1 running; attempt 2 closes it and reports it.
    const b = await suggest({ use: OFFER, lang: 'en', kind: 'new' });
    assertEqual(b.status, 200, b.text);
    const params2 = (await db.collection(COL.journeyTasks).doc(b.body.taskId).get()).get('payload.params');
    await db
      .collection(COL.agentRuns)
      .doc(runIdFor(b.body.taskId, 1))
      .set({ runId: runIdFor(b.body.taskId, 1), agentKey: WRITER, trigger: 'manual', taskId: b.body.taskId, attempt: 1, status: 'running', createdAt: new Date(), requestBytes: 0, input: { summary: 'crashed' } });
    const second = await runAgent(writerReq(b.body.taskId, params2, { attempt: 2 }));
    assertEqual([second.outcome, second.reason], ['skipped', 'already_called'], 'the second attempt ends quietly');
    const rows = (await logRows('ai.failed')).filter((x) => x.detail.reason === 'interrupted');
    assertEqual(rows.length, 1, 'the interrupted run is logged');
    assertEqual((await ops()).aiPending?.[cell], undefined, 'its mark cleared');
    assertEqual(await modelCalls(), 0, 'no model call');
  });

  await test('review: an answer applied late (recovery or the sweep) is not used once the AI was switched off', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const broken: NonNullable<typeof job.apply> = async () => {
      throw new Error('a passing Firestore error');
    };
    await withApply(broken, async () => {
      assertEqual((await suggest({ use: OFFER, lang: 'en', kind: 'new' })).status, 200, 'suggest');
      await runUntil(now() + 10 * 60_000);
    });
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'agents.mode': 'off' });
    clearCaches();
    assertEqual(await sweepPendingApplies(Date.now() + APPLY_SWEEP_AFTER_MS + 60_000), 1, 'settled');
    const [run] = await writerRuns();
    assertEqual([run.apply?.state, run.apply?.code], ['superseded', 'agents_off'], 'not used');
    assertEqual((await aiTemplates()).length, 0, 'no draft');
    const skipped = await logRows('ai.skipped');
    assertEqual(skipped.length, 1, 'logged');
    assert(/wasn’t used/.test(skipped[0].summary), skipped[0].summary);
  });

  await test('review: runs already queued count against today’s runs (Suggest is refused when they would exceed them)', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ enabled: true });
    assertEqual(await planGapFill(Date.now()), 7, 'the gap-fill queues 7 of 10');
    const o = await overview();
    assertEqual([o.ai.queued, o.ai.runsLeft, o.ai.blocked], [7, 3, null], 'three left for Suggest');
    const cells = [OFFER, WIFI, { journeyKey: 'review_ask', poolKey: 'review_ask' }, { journeyKey: 'stay_guide', poolKey: 'stay_welcome' }];
    for (const [i, use] of cells.entries()) {
      const r = await suggest({ use, lang: 'de', kind: 'new' });
      if (i < 3) assertEqual(r.status, 200, `suggest ${i + 1}: ${r.text}`);
      else assertEqual([r.status, r.body?.code], [409, 'daily_limit'], `the fourth: ${r.text}`);
    }
  });

  await test('an error in the gap-fill keeps none of W1’s alerts back (logged as ai.error)', async () => {
    await fresh();
    await connectAndSync();
    const d = await post('/admin/whatsapp/templates', {
      use: OFFER,
      lang: 'de',
      category: 'MARKETING',
      source: {
        body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days | default:"14"}} Tagen wieder – dann wartet {{offer.label | default:"eine Überraschung"}} auf dich.',
        footer: STOP_LINES.de,
        button: { text: 'Angebot ansehen', field: 'link.offer' },
      },
    });
    assertEqual(d.status, 200, d.text);
    const id = d.body.template.id;
    assertEqual((await submit(id, d.body.template.version)).status, 200, 'submitted');
    await review(id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    const real = Object.getOwnPropertyDescriptor(job, 'defaults')!;
    Object.defineProperty(job, 'defaults', {
      configurable: true,
      get() {
        throw new Error('broken settings');
      },
    });
    let tick: Awaited<ReturnType<typeof runWhatsAppTemplateTick>> | undefined;
    try {
      tick = await runWhatsAppTemplateTick();
    } finally {
      Object.defineProperty(job, 'defaults', real);
    }
    assertEqual([tick?.ran, tick?.synced, tick?.alerts], [true, true, 1], `the tick ${JSON.stringify(tick)}`);
    assertEqual((await alertsOf('whatsapp_template')).length, 1, 'the rejection alerted');
    const err = await logRows('ai.error');
    assertEqual([err.length, err[0].level], [1, 'error'], 'logged');
    assertEqual((await logRows('tick.error')).length, 0, 'not a tick error');
  });

  await api.close();
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
