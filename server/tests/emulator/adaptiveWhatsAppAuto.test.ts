/**
 * PR W2b — WhatsApp Auto on the emulator: the launch card's switch and cap, the tick sending AI
 * templates to Meta by itself (the sandbox Meta), what it leaves and why, the day's cap (also with
 * two ticks at once), the AI fixes it asks for after a rejection (once per rejection, at most two),
 * Suggest's refusal of a second fix not sent yet, Meta failing on the account (Auto pauses, the
 * place goes back, the template isn't parked), the hour's creates and the template limit (only new
 * drafts wait), the 08:00 summary and the overview. Nothing here
 * reaches a real model or Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 */

import { COL, assert, assertEqual, clearCaches, db, done, now, resetEmulator, runDue, runUntil, seedCatalogue, setClock, test } from './helpers';
import { ADMIN_ACTOR, mountApi } from './ownerApiHelpers';
import { CONFIG_DOC_ID, WHATSAPP_DOC_ID } from '../../src/adaptive/store/collections';
import { maybeDigest, runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache } from '../../src/adaptive/whatsapp/hints';
import { jobFor } from '../../src/adaptive/brain/registry';
import { readAgentSettings, writeAgentSettings, type AgentSettingsChange } from '../../src/adaptive/store/agents';
import { dayKeyOf } from '../../src/adaptive/brain/budget';
import { parseEngineSettings, SAFE_SETTINGS } from '../../src/adaptive/store/engineSettings';
import { runAuto } from '../../src/adaptive/whatsapp/auto';
import { STOP_LINES } from '../../src/adaptive/send/compose';
import { queueSandboxFaults } from '../../src/adaptive/whatsapp/sandbox';
import { hourKey } from '../../src/adaptive/whatsapp/store';
import { FieldValue } from 'firebase-admin/firestore';

type Doc = Record<string, any>;
const WRITER = 'wa_template_writer';
const job = jobFor(WRITER)!;

let api: Awaited<ReturnType<typeof mountApi>>;
let actorN = 0;
let actor: { uid: string; kind: 'super_admin' } = { ...ADMIN_ACTOR };

const OFFER = { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' };
const WIFI = { journeyKey: 'wifi_info_card', poolKey: 'wifi_info' };
const REVIEW = { journeyKey: 'review_ask', poolKey: 'review_ask' };

async function fresh(): Promise<void> {
  await resetEmulator();
  __clearHintCache();
  await seedCatalogue();
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test' });
  clearCaches();
  // Monday 5 Oct 2026, 11:00 in Zurich (CEST).
  await setClock(Date.UTC(2026, 9, 5, 9, 0));
  actorN += 1;
  actor = { uid: `heidifi_admin_auto_${actorN}`, kind: 'super_admin' };
}

const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor });
const put = (path: string, body: Record<string, unknown> = {}) => api.call('PUT', path, { ...body, actor });
const get = (path: string) => api.get(path);

async function connectAndSync(): Promise<void> {
  assertEqual((await post('/admin/whatsapp/connection/check')).status, 200, 'connection');
  assertEqual((await post('/admin/whatsapp/sync')).status, 200, 'sync');
}

async function aiOn(): Promise<void> {
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd: 100, changedBy: 'test' } });
  clearCaches();
}

async function autoOn(maxPerDay = 10): Promise<void> {
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ whatsappTemplates: { autoSubmit: 'on', maxPerDay, changedBy: 'test' } });
  clearCaches();
}

async function writerSettings(change: AgentSettingsChange): Promise<void> {
  const cur = await readAgentSettings(job);
  await writeAgentSettings(job, change, cur.version, 'test');
}

/** The daily gap-fill stays out of the way (it ran today). */
async function gapFillDoneToday(): Promise<void> {
  await db.collection(COL.config).doc(WHATSAPP_DOC_ID).set({ aiGapFill: { lastDay: dayKeyOf(Date.now()) } }, { merge: true });
}

async function template(id: string): Promise<Doc> {
  return ((await db.collection(COL.whatsappTemplates).doc(id).get()).data() ?? {}) as Doc;
}

async function aiTemplates(): Promise<Doc[]> {
  const snap = await db.collection(COL.whatsappTemplates).where('origin', '==', 'ai').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function ops(): Promise<Doc> {
  return ((await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).data() ?? {}) as Doc;
}

async function logRows(kind?: string): Promise<Doc[]> {
  const snap = await db.collection(COL.whatsappLog).get();
  return snap.docs.map((d) => d.data()).filter((r) => !kind || r.kind === kind);
}

async function overview() {
  const r = await get('/admin/whatsapp');
  assertEqual(r.status, 200, `overview ${r.text}`);
  return r.body as Doc;
}

const cellOf = (o: Doc, use: { poolKey: string }, lang: string) => o.messages.find((m: Doc) => m.poolKey === use.poolKey).cells[lang];

async function review(id: string, decision: string, extra: Record<string, unknown> = {}) {
  const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision, ...extra });
  assertEqual(r.status, 200, `review ${r.text}`);
}

async function suggestAndRun(use: typeof OFFER, lang: string, kind = 'new', templateId?: string): Promise<Doc> {
  const before = new Set((await aiTemplates()).map((t) => t.id));
  const r = await post('/admin/whatsapp/suggest', { use, lang, kind, ...(templateId ? { templateId } : {}) });
  assertEqual(r.status, 200, `suggest ${r.text}`);
  await runDue();
  const fresh = (await aiTemplates()).filter((t) => !before.has(t.id));
  assertEqual(fresh.length, 1, 'one AI template written');
  return fresh[0];
}

async function main() {
  api = await mountApi();
  console.log('\nWhatsApp Auto on the emulator (PR W2b)\n');

  await test('the setting reads safe: missing off/10, an unreadable cap 0, a damaged block off/0, no config off/0', async () => {
    const wa = (raw: unknown) => parseEngineSettings({ whatsappTemplates: raw } as Record<string, unknown>).whatsappTemplates;
    assertEqual(parseEngineSettings({}).whatsappTemplates, { autoSubmit: 'off', maxPerDay: 10, changedBy: null }, 'missing');
    assertEqual(wa({ autoSubmit: 'on' }), { autoSubmit: 'on', maxPerDay: 10, changedBy: null }, 'on, no cap');
    for (const bad of ['lots', 101, 2.5, -1]) assertEqual(wa({ autoSubmit: 'on', maxPerDay: bad })!.maxPerDay, 0, `cap ${bad}`);
    assertEqual(wa('on'), { autoSubmit: 'off', maxPerDay: 0, changedBy: null }, 'not a map');
    assertEqual(wa({ autoSubmit: 'maybe', maxPerDay: 3 })!.autoSubmit, 'off', 'a bad switch');
    assertEqual(SAFE_SETTINGS.whatsappTemplates, { autoSubmit: 'off', maxPerDay: 0, changedBy: null }, 'safe');
  });

  await test('the launch card: "WA AUTO-SUBMIT ON" to turn Auto on, off in one click; a higher cap needs "LOOSEN LIMITS"; each change logged', async () => {
    await fresh();
    const card = await api.get('/admin/launch');
    assertEqual(card.body.whatsappTemplates, { autoSubmit: 'off', maxPerDay: 10, changedBy: null }, 'shown off, 10 a day');
    const change = { change: { whatsappTemplates: { autoSubmit: 'on' } }, baseVersion: card.body.version, actor: ADMIN_ACTOR };
    const noPhrase = await api.call('PUT', '/admin/launch', change);
    assertEqual([noPhrase.status, noPhrase.body.confirmPhrase], [400, 'WA AUTO-SUBMIT ON'], 'the phrase is asked for');
    const on = await api.call('PUT', '/admin/launch', { ...change, confirm: 'wa auto-submit on' });
    assertEqual([on.status, on.body.whatsappTemplates?.autoSubmit], [200, 'on'], 'on');
    assert(on.body.warnings.some((w: string) => /AI agents are off/.test(w)), 'warns: the AI is off');
    const up = await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: { maxPerDay: 15 } }, baseVersion: on.body.version, actor: ADMIN_ACTOR });
    assertEqual([up.status, up.body.confirmPhrase], [400, 'LOOSEN LIMITS'], 'a higher cap');
    const down = await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: { maxPerDay: 5 } }, actor: ADMIN_ACTOR });
    assertEqual([down.status, down.body.whatsappTemplates?.maxPerDay], [200, 5], 'a lower cap: one click');
    const hist = await db.collection(COL.config).doc(CONFIG_DOC_ID).collection('history').doc(String(down.body.version)).get();
    assertEqual(hist.get('lines'), ['WhatsApp Auto: 10 → 5 templates a day'], 'the history line');
    const off = await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: { autoSubmit: 'off' } }, actor: ADMIN_ACTOR });
    assertEqual([off.status, off.body.whatsappTemplates?.autoSubmit, off.body.whatsappTemplates?.maxPerDay], [200, 'off', 5], 'off: one click, the cap kept');
    for (const bad of [{ maxPerDay: 101 }, { maxPerDay: 2.5 }, { auto: 'on' }]) {
      assertEqual((await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: bad }, actor: ADMIN_ACTOR })).status, 400, `refused ${JSON.stringify(bad)}`);
    }
    const rows = await logRows('settings.auto_changed');
    assertEqual(rows.length, 3, 'on, the cap, off — each in the WhatsApp log');
    assert(rows.every((r) => r.actor?.kind === 'admin' && r.actor?.uid === ADMIN_ACTOR.uid), `by the admin ${JSON.stringify(rows.map((r) => r.actor))}`);
    // A damaged block reads off/0; one click off keeps the cap at 0 (not the default 10)…
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ whatsappTemplates: 'on' });
    clearCaches();
    const brake = await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: { autoSubmit: 'off' } }, actor: ADMIN_ACTOR });
    assertEqual([brake.status, brake.body.whatsappTemplates?.maxPerDay], [200, 0], 'the brake on a damaged block');
    // …and so does turning it on with the phrase: a person sets the cap on purpose.
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ whatsappTemplates: 'on' });
    clearCaches();
    const v = (await api.get('/admin/launch')).body.version;
    const onDamaged = await api.call('PUT', '/admin/launch', { change: { whatsappTemplates: { autoSubmit: 'on' } }, baseVersion: v, confirm: 'WA AUTO-SUBMIT ON', actor: ADMIN_ACTOR });
    assertEqual([onDamaged.status, onDamaged.body.whatsappTemplates?.autoSubmit, onDamaged.body.whatsappTemplates?.maxPerDay], [200, 'on', 0], 'on, but the cap stays 0');
    const dev = await api.call('POST', '/dev/launch', { whatsappTemplates: { autoSubmit: 'on', maxPerDay: 3 } });
    assertEqual([dev.status, dev.body.whatsappTemplates?.autoSubmit, dev.body.whatsappTemplates?.maxPerDay], [200, 'on', 3], 'the sandbox route');
    const sys = (await logRows('settings.auto_changed')).filter((r) => r.actor?.kind === 'system');
    assertEqual(sys.length, 1, 'the sandbox route is HeidiFi’s, not an admin’s');
  });

  await test('Auto sends a clean AI draft on the tick (stamped, counted, logged by Auto); approved, it is used at once — and nothing while Auto is off', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const t = await suggestAndRun(OFFER, 'en');
    assertEqual((await runWhatsAppTemplateTick()).auto, undefined, 'Auto off: no Auto step');
    assertEqual((await template(t.id)).stage, 'draft', 'still a draft');
    await autoOn(10);
    const o0 = await overview();
    assertEqual([o0.auto.on, o0.auto.maxPerDay, o0.auto.sentToday, o0.auto.blocked, o0.auto.ready], [true, 10, 0, null, [t.id]], 'the overview: ready to go');
    assertEqual(o0.auto.fixesBlocked, 'writer_scheduled_off', 'AI fixes need the writer’s scheduled runs');
    const tick = await runWhatsAppTemplateTick();
    assertEqual([tick.auto?.sent, tick.auto?.stopped], [1, null], `sent ${JSON.stringify(tick.auto)}`);
    const doc = await template(t.id);
    assertEqual([doc.stage, doc.meta?.status, doc.ai?.autoSubmittedVersion], ['submitted', 'PENDING', 1], 'with Meta, stamped');
    assert(typeof doc.ai?.autoSubmittedAt === 'string' && doc.ai.runId === t.ai.runId, 'the rest of the AI info kept');
    const started = (await logRows('submit.started')).filter((r) => r.templateId === t.id);
    assertEqual([started.length, started[0].actor.kind, started[0].detail.auto], [1, 'auto', true], 'Auto sent it');
    assertEqual((await logRows('auto.run')).length, 1, 'one summary row');
    const counted = (await ops()).autoSubmits;
    assertEqual([counted.day, counted.count], [dayKeyOf(Date.now()), 1], 'counted');
    const o1 = await overview();
    assertEqual([o1.auto.sentToday, cellOf(o1, OFFER, 'en').display], [1, 'in_review'], 'the overview');
    assertEqual((await runWhatsAppTemplateTick()).auto?.sent, 0, 'never twice');
    await review(t.id, 'APPROVED');
    await runWhatsAppTemplateTick();
    const o2 = await overview();
    assertEqual([cellOf(o2, OFFER, 'en').display, cellOf(o2, OFFER, 'en').usable], ['approved', true], 'used as soon as Meta approves it');
  });

  await test('Auto leaves an alternative, a hand-edited AI draft and anything of a person, and says why once a day', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ maxRunsPerDay: 40 });
    const clean = await suggestAndRun(WIFI, 'en');
    const alt = await suggestAndRun(WIFI, 'en', 'alternative');
    const edited = await suggestAndRun(REVIEW, 'en');
    const cur = await template(edited.id);
    const e = await put(`/admin/whatsapp/templates/${edited.id}`, { change: { source: { ...cur.source, body: `${cur.source.body} See you soon.` } }, baseVersion: cur.version });
    assertEqual(e.status, 200, e.text);
    const manual = await post('/admin/whatsapp/templates', {
      use: OFFER,
      lang: 'en',
      category: 'MARKETING',
      source: { body: 'Hello {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today — we would love to see you again soon.', footer: STOP_LINES.en, button: { text: 'See your offer', field: 'link.offer' } },
    });
    assertEqual(manual.status, 200, manual.text);
    await autoOn(10);
    const tick = await runWhatsAppTemplateTick();
    assertEqual(tick.auto?.sent, 1, `only the clean one ${JSON.stringify(tick.auto)}`);
    assertEqual([(await template(clean.id)).stage, (await template(alt.id)).stage, (await template(edited.id)).stage, (await template(manual.body.template.id)).stage], ['submitted', 'draft', 'draft', 'draft'], 'stages');
    const left = await logRows('auto.left');
    const reasonFor = (id: string) => left.find((r) => r.templateId === id)?.detail?.reason ?? null;
    assertEqual([reasonFor(alt.id), reasonFor(edited.id), reasonFor(manual.body.template.id)], ['alternative', 'edited_by_hand', null], 'why (a person’s own draft isn’t Auto’s)');
    await runWhatsAppTemplateTick();
    assertEqual((await logRows('auto.left')).length, left.length, 'once a day');
    const o = await overview();
    assertEqual(o.auto.waiting.find((w: Doc) => w.templateId === alt.id)?.reason, 'alternative', 'the overview says it too');
  });

  await test('the day’s cap holds — also with two ticks at once — and its note comes once a day', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await suggestAndRun(OFFER, 'en');
    await suggestAndRun(WIFI, 'en');
    await autoOn(1);
    const far = Date.now() + 10 * 60_000;
    const [a, b] = await Promise.all([runAuto({ maxPerDay: 1, deadlineMs: far, renew: async () => true }), runAuto({ maxPerDay: 1, deadlineMs: far, renew: async () => true })]);
    assertEqual(a.sent + b.sent, 1, `one send in all ${JSON.stringify([a, b])}`);
    assertEqual((await ops()).autoSubmits.count, 1, 'counted once');
    const t1 = await runWhatsAppTemplateTick();
    assertEqual([t1.auto?.sent, t1.auto?.stopped], [0, 'cap_reached'], 'the cap');
    await runWhatsAppTemplateTick();
    assertEqual((await logRows('auto.cap_reached')).length, 1, 'the note once a day');
    const o = await overview();
    assertEqual([o.auto.blocked, o.auto.sentToday], ['cap_reached', 1], 'the overview');
    await autoOn(0);
    assertEqual((await runWhatsAppTemplateTick()).auto?.stopped, 'cap_zero', 'a cap of 0 sends nothing');
  });

  await test('AI fixes: after Meta rejects an AI template Auto asks for one fix per rejection, sends it again, and stops at two', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ enabled: true, maxRunsPerDay: 40 });
    await gapFillDoneToday();
    const t = await suggestAndRun(OFFER, 'en');
    await autoOn(10);
    assertEqual((await runWhatsAppTemplateTick()).auto?.sent, 1, 'sent');
    for (const round of [1, 2]) {
      await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
      const asked = await runWhatsAppTemplateTick();
      assertEqual(asked.auto?.fixes, 1, `round ${round}: a fix asked for ${JSON.stringify(asked.auto)}`);
      assertEqual((await runWhatsAppTemplateTick()).auto?.fixes, 0, `round ${round}: once for this rejection`);
      await runUntil(now() + 5 * 60_000);
      const fixed = await template(t.id);
      assertEqual([fixed.version, fixed.ai?.kind, fixed.ai?.fixes, fixed.ai?.requestedBy, fixed.ai?.writtenAs], [1 + round, 'fix', round, 'auto_fix', 'new'], `round ${round}: fixed`);
      const second = await post('/admin/whatsapp/suggest', { use: OFFER, lang: 'en', kind: 'fix', templateId: t.id });
      // Round 1: not sent yet; round 2: also the AI-fix limit (2 of 2), which is said first.
      assertEqual([second.status, second.body?.code], [409, round === 1 ? 'fix_unsent' : 'fix_limit'], `round ${round}: no further fix now`);
      const resend = await runWhatsAppTemplateTick();
      assertEqual(resend.auto?.sent, 1, `round ${round}: sent again ${JSON.stringify(resend.auto)}`);
      assertEqual((await template(t.id)).meta?.status, 'PENDING', `round ${round}: with Meta`);
    }
    await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    const last = await runWhatsAppTemplateTick();
    assertEqual(last.auto?.fixes, 0, 'never a third AI fix');
    assertEqual((await logRows('ai.auto_fix')).length, 2, 'two fixes asked for, each logged');
  });

  await test('Auto off (for now): Meta rejects an AI template, the AI writes its fix, and it waits in the ready list until a person sends it', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ enabled: true, maxRunsPerDay: 40 });
    await gapFillDoneToday();
    const t = await suggestAndRun(OFFER, 'en');
    const o0 = await overview();
    assertEqual([o0.auto.on, o0.auto.ready, o0.auto.blocked], [false, [t.id], null], 'Auto off; the draft listed as ready');
    // Nothing goes by itself: a person sends it.
    assertEqual((await runWhatsAppTemplateTick()).auto, undefined, 'no Auto step');
    assertEqual((await template(t.id)).stage, 'draft', 'still a draft');
    assertEqual((await post(`/admin/whatsapp/templates/${t.id}/submit`, { baseVersion: 1 })).status, 200, 'sent by a person');
    await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    const asked = await runWhatsAppTemplateTick();
    assertEqual([asked.aiFixes, asked.auto], [1, undefined], `a fix asked for ${JSON.stringify(asked)}`);
    assertEqual((await runWhatsAppTemplateTick()).aiFixes, 0, 'once for this rejection');
    const row = (await logRows('ai.auto_fix'))[0];
    assertEqual(row.actor.kind, 'system', 'asked by HeidiFi, not Auto');
    assert(/each fix waits for you to send it/.test(row.summary), row.summary);
    await runUntil(now() + 5 * 60_000);
    const fixed = await template(t.id);
    assertEqual([fixed.version, fixed.ai?.kind, fixed.ai?.requestedBy, fixed.meta?.status], [2, 'fix', 'auto_fix', 'REJECTED'], 'fixed, not sent');
    for (let i = 0; i < 3; i += 1) await runWhatsAppTemplateTick();
    assertEqual([(await template(t.id)).meta?.status, (await template(t.id)).version], ['REJECTED', 2], 'the ticks never send it');
    assertEqual((await overview()).auto.ready, [t.id], 'the fix is in the ready list');
    assertEqual((await post(`/admin/whatsapp/templates/${t.id}/submit`, { baseVersion: 2 })).status, 200, 'a person sends the fix');
    const sent = await template(t.id);
    assertEqual([sent.meta?.status, sent.ai?.sentVersion, sent.ai?.autoSubmittedVersion ?? null], ['PENDING', 2, null], 'with Meta, sent by a person');
    assertEqual((await overview()).auto.ready, [], 'nothing left to send');
  });

  await test('Meta refuses the account: Auto stops and pauses an hour, the place goes back, the template isn’t parked', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    const t = await suggestAndRun(OFFER, 'en');
    const w = await suggestAndRun(WIFI, 'en');
    await autoOn(10);
    const countBefore = (await ops()).templateCount;
    await queueSandboxFaults([{ op: 'create', fault: 'invalid_token' }]);
    const tick = await runWhatsAppTemplateTick();
    assertEqual([tick.auto?.sent, tick.auto?.stopped], [0, 'meta_account'], `stopped ${JSON.stringify(tick.auto)}`);
    const doc = await template(t.id);
    assertEqual([doc.stage, doc.lastSubmitError?.code, doc.ai?.autoAttempts, doc.ai?.sentVersion], ['draft', 'setup', 0, null], 'back to a draft, the try not counted');
    assertEqual([(await template(w.id)).stage, (await template(w.id)).lastSubmitError ?? null], ['draft', null], 'the next one not tried');
    const o1 = await ops();
    assertEqual([o1.autoSubmits.count, o1.templateCount], [0, countBefore], 'the place and the count given back');
    assert(o1.autoPauseUntilMs > Date.now() + 50 * 60_000, 'paused an hour');
    assertEqual((await logRows('auto.stopped')).map((r) => r.detail.reason), ['meta_account'], 'said once');
    assertEqual((await runWhatsAppTemplateTick()).auto?.stopped, 'meta_paused', 'paused');
    assertEqual((await overview()).auto.blocked, 'meta_paused', 'the overview says so');
    // An hour later (the token fixed): both go, the first one too.
    await db.collection(COL.config).doc(WHATSAPP_DOC_ID).update({ autoPauseUntilMs: Date.now() - 1 });
    const after = await runWhatsAppTemplateTick();
    assertEqual(after.auto?.sent, 2, `both sent ${JSON.stringify(after.auto)}`);
    assertEqual([(await template(t.id)).ai?.autoAttempts, (await ops()).autoSubmits.count], [1, 2], 'counted now');
  });

  await test('the hour’s creates (80 for Auto) and an unknown template count stop only new drafts: an AI fix still goes', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await writerSettings({ enabled: true, maxRunsPerDay: 40 });
    await gapFillDoneToday();
    const t = await suggestAndRun(OFFER, 'en');
    await autoOn(10);
    assertEqual((await runWhatsAppTemplateTick()).auto?.sent, 1, 'sent');
    await review(t.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
    assertEqual((await runWhatsAppTemplateTick()).auto?.fixes, 1, 'a fix asked for');
    await runUntil(now() + 5 * 60_000);
    assertEqual((await template(t.id)).ai?.kind, 'fix', 'fixed');
    // A new draft, first in line (older than the fix).
    const w = await suggestAndRun(WIFI, 'en');
    await db.collection(COL.whatsappTemplates).doc(w.id).update({ createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await db.collection(COL.config).doc(WHATSAPP_DOC_ID).update({ createsHour: { key: hourKey(Date.now()), count: 80 } });
    const far = Date.now() + 10 * 60_000;
    const run = () => runAuto({ maxPerDay: 10, deadlineMs: far, renew: async () => true });
    const a = await run();
    assertEqual([a.sent, a.stopped], [1, 'creates_hour'], `the fix went, the draft waits ${JSON.stringify(a)}`);
    assertEqual([(await template(t.id)).meta?.status, (await template(w.id)).stage], ['PENDING', 'draft'], 'stages');
    // A new hour, but the count unknown (no full list yet): the draft still waits.
    await db.collection(COL.config).doc(WHATSAPP_DOC_ID).update({ createsHour: { key: 'old', count: 0 }, templateCount: FieldValue.delete() });
    const b = await run();
    assertEqual([b.sent, b.stopped, (await template(w.id)).stage], [0, 'template_limit', 'draft'], `template limit ${JSON.stringify(b)}`);
    assertEqual((await logRows('auto.stopped')).map((r) => r.detail.reason).sort(), ['creates_hour', 'template_limit'], 'each said once');
    const o = await overview();
    assertEqual(o.auto.blocked, 'template_count_unknown', 'the overview says why');
  });

  await test('the 08:00 summary lists what the AI wrote and what Auto sent', async () => {
    await fresh();
    await connectAndSync();
    await aiOn();
    await suggestAndRun(OFFER, 'en');
    // Monday 11:00: the day's summary goes out on the first tick (it lists the AI's draft), then Auto sends it.
    await autoOn(10);
    await runWhatsAppTemplateTick();
    // Tuesday 08:05 in Zurich: what Auto sent since.
    await setClock(Date.UTC(2026, 9, 6, 6, 5));
    assertEqual(await maybeDigest(), true, 'sent');
    const snap = await db.collection(COL.alerts).where('kind', '==', 'whatsapp_digest').get();
    const digests = snap.docs.map((d) => ({ text: String(d.get('text') ?? ''), subject: String(d.get('subject') ?? '') }));
    assertEqual(digests.length, 2, 'Monday and Tuesday');
    const monday = digests.find((d) => /Written by the AI/.test(d.text));
    const tuesday = digests.find((d) => /Sent to Meta by Auto/.test(d.text));
    assert(monday && /Written by the AI \(1\)/.test(monday.text) && /1 written by AI/.test(monday.subject), JSON.stringify(digests));
    assert(tuesday && /Sent to Meta by Auto \(1\)/.test(tuesday.text) && /1 sent by Auto/.test(tuesday.subject), JSON.stringify(digests));
  });

  await api.close();
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
