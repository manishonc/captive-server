/**
 * PR W1 — WhatsApp templates on the emulator, through the real router and the sandbox Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Route guards; nothing runs before "Check connection"; the connection check finds the account
 *    (and says why not, without the management permission or with the wrong account).
 *  - The first sync imports production's three templates: the OTP one protected, the legacy ones
 *    labelled, `heidifi_visit_feedback`'s broken button caught (T12); a sync with no change is routine.
 *  - Draft → stale save 409 → Send to Meta → Meta approves (webhook hint → tick) → approved, with
 *    the timeline and the log naming each actor; `version` untouched by Meta; pause stops use.
 *  - A rejection alerts once; edited, resubmitted and rejected again it alerts again. A service
 *    message approved as MARKETING is blocked + alerts. The 08:00 summary: once a day, skipped
 *    when there is nothing to tell.
 *  - Races and failures: two submits → one create; no answer → taken over (it arrived) or put back
 *    (it didn't) after 10 minutes; "already exists" → adopted; "being deleted" → name locked (T17);
 *    an incomplete list deletes nothing, a complete one plus a not-found read does (+ alert);
 *    two ticks → one sync; Meta's 100-an-hour and the template limit refuse before any call.
 *  - Webhook hints: another account ignored, the same notice twice logged once, an unknown
 *    template makes the next tick sync; nothing is changed until Meta is re-read.
 *  - Linking an imported template to a message; its broken button keeps it unusable.
 *  - No secret in any console line.
 */

import {
  COL,
  advance,
  assert,
  assertEqual,
  clearCaches,
  db,
  done,
  now,
  resetEmulator,
  seedCatalogue,
  setClock,
  test,
} from './helpers';
import { ADMIN_ACTOR, OWNER_ACTOR, captureLogs, mountApi } from './ownerApiHelpers';
import { CONFIG_DOC_ID, WHATSAPP_DOC_ID } from '../../src/adaptive/store/collections';
import { runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache, noteTemplateHint } from '../../src/adaptive/whatsapp/hints';
import { queueSandboxFaults, SANDBOX_WABA_ID } from '../../src/adaptive/whatsapp/sandbox';
import { hourKey } from '../../src/adaptive/whatsapp/store';
import { STOP_LINES } from '../../src/adaptive/send/compose';

let api: Awaited<ReturnType<typeof mountApi>>;
let actorN = 0;
/** A fresh admin per test (the per-admin rate limits are per process). */
let actor: { uid: string; kind: 'super_admin' } = { ...ADMIN_ACTOR };

async function fresh(): Promise<void> {
  await resetEmulator();
  __clearHintCache();
  await seedCatalogue();
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test' });
  clearCaches();
  // Monday 5 Oct 2026, 11:00 in Zurich (CEST).
  await setClock(Date.UTC(2026, 9, 5, 9, 0));
  actorN += 1;
  actor = { uid: `heidifi_admin_${actorN}`, kind: 'super_admin' };
}

const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor });
const put = (path: string, body: Record<string, unknown> = {}) => api.call('PUT', path, { ...body, actor });
const get = (path: string) => api.get(path);

async function connectAndSync(): Promise<void> {
  const c = await post('/admin/whatsapp/connection/check');
  assertEqual(c.status, 200, `connection ${c.text}`);
  const s = await post('/admin/whatsapp/sync');
  assertEqual(s.status, 200, `sync ${s.text}`);
}

const DE_OFFER = {
  body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days | default:"14"}} Tagen wieder – dann wartet {{offer.label | default:"eine Überraschung"}} auf dich.',
  footer: STOP_LINES.de,
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};
const DE_LAST = {
  body: 'Hallo {{contact.firstName | default:"du"}}, bei {{venue.name}} wartet noch {{offer.label | default:"eine Überraschung"}} auf dich – aber nur bis {{offer.expiryDate | date:"d.M." | default:"bald"}}. Wir freuen uns!',
  footer: STOP_LINES.de,
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};
const EN_WIFI = {
  body: 'Welcome to {{venue.name}}! The Wi-Fi network is {{guestinfo.wifiName | default:"the guest network"}}. Tap below for the house info.',
  footer: null,
  button: { text: 'Open guest info', field: 'link.hub' },
};

async function draft(use: { journeyKey: string; poolKey: string }, lang: string, category: string, source: unknown) {
  const r = await post('/admin/whatsapp/templates', { use, lang, category, source });
  assertEqual(r.status, 200, `draft ${r.text}`);
  return r.body.template as { id: string; name: string; version: number; display: string };
}
const offerDraft = () => draft({ journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' }, 'de', 'MARKETING', DE_OFFER);

async function submit(id: string, baseVersion: number) {
  return post(`/admin/whatsapp/templates/${id}/submit`, { baseVersion });
}

async function review(id: string, decision: string, extra: Record<string, unknown> = {}) {
  const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision, ...extra });
  assertEqual(r.status, 200, `review ${r.text}`);
}

async function view(id: string) {
  const r = await get(`/admin/whatsapp/templates/${id}`);
  assertEqual(r.status, 200, `view ${r.text}`);
  return r.body as { template: Record<string, any>; history: Array<Record<string, any>> };
}

async function logRows(kind?: string): Promise<Array<Record<string, any>>> {
  const snap = await db.collection(COL.whatsappLog).get();
  return snap.docs.map((d) => d.data()).filter((r) => !kind || r.kind === kind);
}

async function alertsOf(kind: string): Promise<Array<Record<string, any>>> {
  const snap = await db.collection(COL.alerts).where('kind', '==', kind).get();
  return snap.docs.map((d) => d.data());
}

async function sandboxTemplates(name?: string): Promise<Array<Record<string, any>>> {
  const snap = await db.collection(COL.sandboxWhatsAppTemplates).get();
  return snap.docs.filter((d) => d.id !== '__faults').map((d) => ({ id: d.id, ...d.data() })).filter((t) => !name || t.name === name);
}

async function main() {
api = await mountApi();
console.log('\nWhatsApp templates on the emulator (PR W1)\n');

await test('route guards: secret, JSON 404, actor, HeidiFi staff only, template ids', async () => {
  await fresh();
  assertEqual((await api.get('/admin/whatsapp', { secret: null })).status, 401, 'no secret');
  const nf = await get('/admin/whatsapp/nope');
  assertEqual([nf.status, nf.body?.code], [404, 'not_found'], 'json 404');
  assertEqual((await api.call('POST', '/admin/whatsapp/templates', { use: {} })).status, 400, 'no actor');
  assertEqual((await api.call('POST', '/admin/whatsapp/sync', { actor: OWNER_ACTOR })).status, 403, 'owner');
  assertEqual((await get('/admin/whatsapp/templates/not-an-id')).status, 400, 'bad id');
});

await test('nothing runs before Check connection: the tick idles, Send to Meta refuses', async () => {
  await fresh();
  assertEqual(await runWhatsAppTemplateTick(), { ran: false, reason: 'not_connected' }, 'tick');
  const o = await get('/admin/whatsapp');
  assertEqual([o.body.connection, o.body.templates.length], [null, 0], 'overview');
  const d = await offerDraft();
  const s = await submit(d.id, d.version);
  assertEqual(s.status, 409, `submit ${s.text}`);
  assertEqual((await sandboxTemplates()).length, 0, 'nothing at Meta');
});

await test('Check connection finds the account from the token; without the permission or with another account it says why', async () => {
  await fresh();
  const c = await post('/admin/whatsapp/connection/check');
  assertEqual([c.body.connection.ok, c.body.connection.wabaId, c.body.connection.phoneFound, c.body.connection.quality], [true, SANDBOX_WABA_ID, true, 'GREEN'], 'ok');
  const rows = await logRows('connection.checked');
  assertEqual([rows.length, rows[0].level, rows[0].actor.kind, rows[0].actor.uid], [1, 'info', 'admin', actor.uid], 'logged with the admin');
  await queueSandboxFaults([{ op: 'debug', fault: 'no_waba_scope' }]);
  const bad = await post('/admin/whatsapp/connection/check');
  assert(bad.body.connection.ok === false && bad.body.connection.problems.some((p: string) => /whatsapp_business_management/.test(p)), JSON.stringify(bad.body.connection.problems));
  const wrong = await put('/admin/whatsapp/connection', { wabaId: 'someone_else' });
  assertEqual(wrong.status, 422, `wrong account ${wrong.text}`);
});

await test('the first sync imports production’s three templates; the OTP one is protected; the broken button is caught; a no-change sync is routine', async () => {
  await fresh();
  await connectAndSync();
  const o = (await get('/admin/whatsapp')).body;
  const byName = Object.fromEntries(o.templates.map((t: any) => [t.name, t]));
  assertEqual(Object.keys(byName).sort(), ['heidifi_verification_code', 'heidifi_visit_feedback', 'restaurant_feedback_request'], 'imported');
  assertEqual([byName.heidifi_verification_code.use.kind, byName.restaurant_feedback_request.use.kind], ['otp', 'legacy'], 'uses');
  assert(byName.heidifi_visit_feedback.checks.errors >= 1, 'broken button flagged');
  assertEqual(byName.restaurant_feedback_request.checks.errors, 0, 'correct button passes');
  const t12 = (await view(byName.heidifi_visit_feedback.id)).template.checks.issues.find((i: any) => i.code === 'T12');
  assert(t12 && /%7B%7B1%7D%7D/.test(t12.message), JSON.stringify(t12));
  assertEqual((await post(`/admin/whatsapp/templates/${byName.heidifi_verification_code.id}/dismiss`)).status, 409, 'OTP not dismissable');
  assertEqual((await logRows('template.imported')).length, 3, 'three import rows');
  assertEqual((await alertsOf('whatsapp_template')).length, 0, 'an import of approved templates alerts nobody');
  const again = await post('/admin/whatsapp/sync');
  assertEqual([again.body.sync.imported, again.body.sync.changes], [0, 0], 'nothing new');
  const runs = await logRows('sync.run');
  assertEqual(runs.map((r) => r.level).sort(), ['info', 'routine'], 'second run is routine');
  const visible = (await get('/admin/whatsapp/log')).body.log.filter((r: any) => r.kind === 'sync.run');
  assertEqual(visible.length, 1, 'routine rows hidden by default');
  assertEqual((await get('/admin/whatsapp/log?routine=1')).body.log.filter((r: any) => r.kind === 'sync.run').length, 2, 'shown on request');
});

await test('prefill: the message’s SMS without its link, the STOP footer, the button to its page', async () => {
  await fresh();
  const p = await get('/admin/whatsapp/prefill?journeyKey=review_ask&poolKey=review_ask&lang=de');
  assertEqual(p.status, 200, p.text);
  assert(!p.body.source.body.includes('link.'), p.body.source.body);
  assertEqual([p.body.category, p.body.source.footer, p.body.source.button.field], ['MARKETING', STOP_LINES.de, 'link.rating'], 'prefill');
});

await test('draft → stale save 409 → Send to Meta → approved by Meta (hint, then the tick); timeline, actors, version', async () => {
  await fresh();
  await connectAndSync();
  const checkOnly = await post('/admin/whatsapp/templates/check', { use: { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' }, lang: 'de', category: 'UTILITY', source: DE_OFFER });
  assert(checkOnly.body.checks.ok === false && checkOnly.body.checks.issues.some((i: any) => i.code === 'T04'), 'check only');
  const d = await offerDraft();
  assertEqual([d.name, d.display, d.version], ['hf_welcome_offer_1', 'ready', 1], 'draft');
  assertEqual((await put(`/admin/whatsapp/templates/${d.id}`, { change: { source: { ...DE_OFFER, button: { text: 'Jetzt ansehen', field: 'link.offer' } } }, baseVersion: 0 })).status, 409, 'stale save');
  const saved = await put(`/admin/whatsapp/templates/${d.id}`, { change: { source: { ...DE_OFFER, button: { text: 'Jetzt ansehen', field: 'link.offer' } } }, baseVersion: 1 });
  assertEqual(saved.body.template.version, 2, 'saved');
  assertEqual((await submit(d.id, 1)).status, 409, 'stale submit');
  const s = await submit(d.id, 2);
  assertEqual([s.status, s.body.outcome, s.body.template.display], [200, 'submitted', 'in_review'], `submit ${s.text}`);
  const atMeta = await sandboxTemplates('hf_welcome_offer_1');
  assertEqual([atMeta.length, atMeta[0].status, atMeta[0].category, atMeta[0].language], [1, 'PENDING', 'MARKETING', 'de'], 'at Meta');
  assert(String(JSON.parse(atMeta[0].componentsJson)[0].text).startsWith('Hallo {{1}}, danke für deinen Besuch bei {{2}}!'), 'compiled text sent');
  await review(d.id, 'APPROVED');
  assert((await view(d.id)).template.display === 'in_review', 'nothing changes before the tick re-reads Meta');
  const tick = await runWhatsAppTemplateTick();
  assert(tick.ran && tick.synced, JSON.stringify(tick));
  const v = await view(d.id);
  assertEqual([v.template.display, v.template.usable, v.template.version, v.template.metaCategory], ['approved', true, 2, 'MARKETING'], 'approved, version untouched');
  const kinds = v.history.map((h) => h.kind).reverse();
  assertEqual(kinds, ['draft.created', 'draft.saved', 'submit.started', 'submit.done', 'webhook.hint', 'meta.status_changed'], 'timeline (Meta’s notice included)');
  const byKind = Object.fromEntries(v.history.map((h) => [h.kind, h.actor.kind]));
  assertEqual([byKind['draft.created'], byKind['submit.started'], byKind['meta.status_changed']], ['admin', 'admin', 'meta'], 'actors');
  assertEqual((await logRows('webhook.hint')).length, 1, 'the hint was logged');
  const cell = (await get('/admin/whatsapp')).body.messages.find((m: any) => m.poolKey === 'welcome_offer').cells.de;
  assertEqual([cell.display, cell.usable], ['approved', true], 'coverage');
  const paused = await post(`/admin/whatsapp/templates/${d.id}/use`, { enabled: false });
  assertEqual([paused.body.template.usable, paused.body.template.useEnabled], [false, false], 'paused');
  assertEqual((await logRows('use.paused')).length, 1, 'pause logged');
});

await test('a rejection alerts once; edited, resubmitted and rejected again it alerts again', async () => {
  await fresh();
  await connectAndSync();
  const d = await draft({ journeyKey: 'welcome_second_visit', poolKey: 'last_chance' }, 'de', 'MARKETING', DE_LAST);
  await submit(d.id, d.version);
  await review(d.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
  await runWhatsAppTemplateTick();
  let v = await view(d.id);
  assertEqual([v.template.display, v.template.rejectedReason], ['rejected', 'INVALID_FORMAT'], 'rejected');
  let alerts = await alertsOf('whatsapp_template');
  assertEqual(alerts.length, 1, 'one alert');
  assert(/rejected/.test(alerts[0].subject) && alerts[0].emailedTo === 'sandbox:alerts@heidifi.test', JSON.stringify(alerts[0]));
  await runWhatsAppTemplateTick();
  assertEqual((await alertsOf('whatsapp_template')).length, 1, 'not again');
  const edited = await put(`/admin/whatsapp/templates/${d.id}`, { change: { source: { ...DE_LAST, body: DE_LAST.body.replace('Wir freuen uns!', 'Bis bald!') } }, baseVersion: v.template.version });
  assertEqual(edited.status, 200, edited.text);
  const s = await submit(d.id, edited.body.template.version);
  assertEqual([s.status, s.body.outcome, s.body.template?.display], [200, 'submitted', 'in_review'], `resubmit ${s.text}`);
  assertEqual((await sandboxTemplates(d.name)).length, 1, 'edited, not a second template');
  await review(d.id, 'REJECTED', { reason: 'ABUSIVE_CONTENT' });
  await runWhatsAppTemplateTick();
  v = await view(d.id);
  alerts = await alertsOf('whatsapp_template');
  assertEqual([v.template.display, alerts.length], ['rejected', 2], 'second rejection alerts');
  assertEqual((await logRows('alert.sent')).length, 2, 'each email logged');
});

await test('a service message Meta approves as MARKETING is blocked and alerts', async () => {
  await fresh();
  await connectAndSync();
  const d = await draft({ journeyKey: 'wifi_info_card', poolKey: 'wifi_info' }, 'en', 'UTILITY', EN_WIFI);
  assertEqual(d.display, 'ready', 'clean utility draft');
  await submit(d.id, d.version);
  await review(d.id, 'APPROVED', { category: 'MARKETING' });
  await runWhatsAppTemplateTick();
  const v = await view(d.id);
  assertEqual([v.template.display, v.template.usable, v.template.metaCategory], ['blocked', false, 'MARKETING'], 'blocked');
  const alerts = await alertsOf('whatsapp_template');
  assertEqual(alerts.length, 1, 'alert');
  assert(/can't be used|can’t be used/.test(alerts[0].subject), alerts[0].subject);
});

await test('the 08:00 summary: once a day, only with something to tell', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  await submit(d.id, d.version);
  await review(d.id, 'APPROVED');
  await runWhatsAppTemplateTick(); // 11:00: the day's summary with the approval
  let digests = await alertsOf('whatsapp_digest');
  assertEqual(digests.length, 1, 'today');
  assert(/1 approved/.test(digests[0].subject) && digests[0].emailedTo === 'sandbox:alerts@heidifi.test', digests[0].subject);
  await runWhatsAppTemplateTick();
  assertEqual((await alertsOf('whatsapp_digest')).length, 1, 'once a day');
  await setClock(Date.UTC(2026, 9, 6, 5, 0)); // 07:00 next day
  await runWhatsAppTemplateTick();
  assertEqual((await alertsOf('whatsapp_digest')).length, 1, 'not before 08:00');
  await setClock(Date.UTC(2026, 9, 6, 6, 5)); // 08:05: nothing new, nothing waiting
  await runWhatsAppTemplateTick();
  assertEqual((await alertsOf('whatsapp_digest')).length, 1, 'skipped when empty');
  await draft({ journeyKey: 'welcome_second_visit', poolKey: 'last_chance' }, 'de', 'MARKETING', DE_LAST);
  await setClock(Date.UTC(2026, 9, 7, 6, 5));
  await runWhatsAppTemplateTick();
  digests = await alertsOf('whatsapp_digest');
  assertEqual(digests.length, 2, 'next day');
  assert(digests.some((x) => /1 waiting for you/.test(x.subject)), digests.map((x) => x.subject).join(' | '));
});

await test('two clicks on Send to Meta: one create, the other gets 409', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  const [a, b] = await Promise.all([submit(d.id, d.version), submit(d.id, d.version)]);
  assertEqual([a.status, b.status].sort(), [200, 409], `${a.text} | ${b.text}`);
  assertEqual((await sandboxTemplates('hf_welcome_offer_1')).length, 1, 'one template at Meta');
});

await test('no answer from Meta: after 10 minutes taken over when it arrived, put back when it didn’t', async () => {
  await fresh();
  await connectAndSync();
  const a = await offerDraft();
  await queueSandboxFaults([{ op: 'create', fault: 'timeout' }]);
  const s = await submit(a.id, a.version);
  assertEqual([s.body.outcome, s.body.template.display], ['unknown', 'submitting'], s.text);
  await runWhatsAppTemplateTick();
  assertEqual((await view(a.id)).template.display, 'submitting', 'not before 10 minutes');
  await advance(11 * 60_000);
  await runWhatsAppTemplateTick();
  assertEqual((await view(a.id)).template.display, 'in_review', 'taken over');
  assertEqual((await logRows('submit.adopted')).length, 1, 'adopt logged');

  const b = await draft({ journeyKey: 'welcome_second_visit', poolKey: 'last_chance' }, 'de', 'MARKETING', DE_LAST);
  await queueSandboxFaults([{ op: 'create', fault: 'timeout_lost' }]);
  await submit(b.id, b.version);
  await advance(11 * 60_000);
  await runWhatsAppTemplateTick();
  const vb = await view(b.id);
  assertEqual([vb.template.display, vb.template.lastSubmitError?.code], ['ready', 'unknown_outcome'], 'put back');
  assertEqual((await sandboxTemplates(b.name)).length, 0, 'nothing at Meta');
});

await test('"already exists" → taken over; "being deleted" → name locked (T17)', async () => {
  await fresh();
  await connectAndSync();
  const a = await offerDraft();
  await queueSandboxFaults([{ op: 'create', fault: 'timeout' }]);
  await submit(a.id, a.version);
  // As if the submit had been put back while Meta kept it.
  await db.collection(COL.whatsappTemplates).doc(a.id).update({ stage: 'draft', submit: null });
  const again = await submit(a.id, a.version);
  assertEqual([again.body.outcome, again.body.template.display], ['adopted', 'in_review'], again.text);

  const b = await draft({ journeyKey: 'welcome_second_visit', poolKey: 'last_chance' }, 'de', 'MARKETING', DE_LAST);
  await queueSandboxFaults([{ op: 'create', fault: 'locked' }]);
  const locked = await submit(b.id, b.version);
  assertEqual(locked.body.outcome, 'locked', locked.text);
  const vb = await view(b.id);
  assert(vb.template.display === 'needs_fix' && vb.template.checks.issues.some((i: any) => i.code === 'T17'), JSON.stringify(vb.template.checks));
  assertEqual((await logRows('submit.failed')).length, 1, 'logged');
});

await test('an incomplete list deletes nothing; a complete list plus a not-found read marks it deleted and alerts', async () => {
  await fresh();
  await connectAndSync();
  await api.call('POST', '/dev/whatsapp/review', { name: 'restaurant_feedback_request', language: 'en', decision: 'DELETED', hint: false });
  await queueSandboxFaults([{ op: 'list', fault: 'list_incomplete' }]);
  await post('/admin/whatsapp/sync');
  const o1 = (await get('/admin/whatsapp')).body.templates.find((t: any) => t.name === 'restaurant_feedback_request');
  assertEqual(o1.display, 'approved', 'kept');
  const s = await post('/admin/whatsapp/sync');
  assertEqual(s.body.sync.deleted, 1, 'deleted');
  const o2 = (await get('/admin/whatsapp')).body.templates.find((t: any) => t.name === 'restaurant_feedback_request');
  assertEqual(o2.display, 'deleted', 'marked');
  await runWhatsAppTemplateTick(); // alerts go out with the tick (Sync now leaves them to it)
  const alerts = await alertsOf('whatsapp_template');
  assert(alerts.length === 1 && /deleted at Meta/.test(alerts[0].subject), JSON.stringify(alerts.map((x) => x.subject)));
});

await test('webhook hints: another account ignored, a repeat logged once, an unknown template makes the tick sync', async () => {
  await fresh();
  await connectAndSync();
  const v = { event: 'APPROVED', message_template_name: 'restaurant_feedback_request', message_template_language: 'en' };
  assertEqual(await noteTemplateHint('another_waba', 'message_template_status_update', v), 'ignored', 'other account');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'messages', v), 'ignored', 'not a template field');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'message_template_status_update', v), 'marked', 'known');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'message_template_status_update', v), 'marked', 'repeat');
  assertEqual((await logRows('webhook.hint')).length, 1, 'logged once');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'message_template_status_update', { ...v, message_template_name: 'made_in_manager' }), 'unknown_template', 'unknown');
  const ops = (await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).data()!;
  assert(ops.hintUnknownAt, 'the account is marked for a sync');
  await runWhatsAppTemplateTick();
  const after = (await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).data()!;
  assertEqual(after.hintUnknownAt, null, 'synced, mark cleared');
  const hinted = (await get('/admin/whatsapp')).body.templates.find((t: any) => t.name === 'restaurant_feedback_request');
  assertEqual(hinted.display, 'approved', 'nothing changed: Meta still says approved');
  assertEqual((await logRows('webhook.hint_checked')).length, 1, 'the re-read is recorded (routine)');
});

await test('two ticks at once: one sync', async () => {
  await fresh();
  await connectAndSync();
  await advance(7 * 60 * 60_000); // the 6-hour sync is due
  const before = (await logRows('sync.run')).length;
  const [a, b] = await Promise.all([runWhatsAppTemplateTick(), runWhatsAppTemplateTick()]);
  // One holds the lease; the other is refused, or runs after it and finds no sync due.
  assertEqual([a.synced === true, b.synced === true].filter(Boolean).length, 1, JSON.stringify([a, b]));
  assertEqual((await logRows('sync.run')).length, before + 1, 'one sync');
});

await test('Meta’s 100 an hour and the template limit refuse before any call (T22, T16)', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  await db.collection(COL.config).doc(WHATSAPP_DOC_ID).set({ createsHour: { key: hourKey(Date.now()), count: 100 } }, { merge: true });
  const r1 = await submit(d.id, d.version);
  assert(r1.status === 422 && r1.body.issues.some((i: any) => i.code === 'T22'), r1.text);
  await db.collection(COL.config).doc(WHATSAPP_DOC_ID).set({ createsHour: { key: '', count: 0 }, templateCount: 250 }, { merge: true });
  const r2 = await submit(d.id, d.version);
  assert(r2.status === 422 && r2.body.issues.some((i: any) => i.code === 'T16'), r2.text);
  assertEqual((await sandboxTemplates('hf_welcome_offer_1')).length, 0, 'nothing sent');
  assertEqual((await logRows('submit.blocked')).length, 2, 'refusals logged');
});

await test('a new language of the same name; linking an imported template (its broken button keeps it unusable)', async () => {
  await fresh();
  await connectAndSync();
  const de = await offerDraft();
  const en = await post('/admin/whatsapp/templates', {
    use: { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' },
    lang: 'en',
    category: 'MARKETING',
    name: de.name,
    source: { body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}}! Come back within {{offer.days | default:"14"}} days and {{offer.label | default:"a surprise"}} is waiting for you.', footer: STOP_LINES.en, button: { text: 'See your offer', field: 'link.offer' } },
  });
  assertEqual([en.status, en.body.template?.name], [200, de.name], `same name ${en.text}`);
  const dup = await post('/admin/whatsapp/templates', { use: { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' }, lang: 'de', category: 'MARKETING', name: de.name, source: DE_OFFER });
  assertEqual(dup.status, 409, 'that language exists');

  const visit = (await get('/admin/whatsapp')).body.templates.find((t: any) => t.name === 'heidifi_visit_feedback');
  const linked = await put(`/admin/whatsapp/templates/${visit.id}/link`, {
    use: { journeyKey: 'review_ask', poolKey: 'review_ask' },
    map: [{ n: 1, field: 'contact.firstName', fallback: 'there' }, { n: 2, field: 'venue.name' }],
    buttonField: 'link.rating',
    baseVersion: visit.version,
  });
  assertEqual(linked.status, 200, linked.text);
  const t = linked.body.template;
  assertEqual([t.use.kind, t.display, t.usable], ['adaptive', 'approved', false], 'linked but unusable');
  assert(t.checks.issues.some((i: any) => i.code === 'T12' && i.severity === 'error'), 'the broken button still counts');
  assertEqual((await logRows('template.linked')).length, 1, 'logged');
});

await test('review fixes: a forged notice for a draft never marks it (no sync every tick); a notice without the account is ignored', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  const v = { event: 'APPROVED', message_template_name: d.name, message_template_language: 'de' };
  assertEqual(await noteTemplateHint('', 'message_template_status_update', v), 'ignored', 'no account id');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'message_template_status_update', v), 'unknown_template', 'a draft is not marked');
  assertEqual((await view(d.id)).template.display, 'ready', 'draft unchanged');
  assertEqual(await noteTemplateHint(SANDBOX_WABA_ID, 'message_template_status_update', { ...v, message_template_name: 'Bad Name <script>' }), 'ignored', 'junk name');
  await runWhatsAppTemplateTick(); // syncs once for the unknown mark…
  const before = (await logRows('sync.run')).length;
  await advance(3 * 60_000);
  await runWhatsAppTemplateTick(); // …and not again
  assertEqual((await logRows('sync.run')).length, before, 'no sync loop');
});

await test('review fixes: Meta’s text drifting from ours (changed in WhatsApp Manager) makes an approved template unusable (T23)', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  await submit(d.id, d.version);
  await review(d.id, 'APPROVED');
  await runWhatsAppTemplateTick();
  assertEqual((await view(d.id)).template.usable, true, 'usable');
  const sbx = (await sandboxTemplates('hf_welcome_offer_1'))[0];
  const comps = JSON.parse(sbx.componentsJson);
  comps[0].text = 'Something else entirely at {{1}}, with more words added here.';
  await db.collection(COL.sandboxWhatsAppTemplates).doc(sbx.id).update({ componentsJson: JSON.stringify(comps) });
  await post('/admin/whatsapp/sync');
  const v = await view(d.id);
  assert(v.template.usable === false && v.template.checks.issues.some((i: any) => i.code === 'T23'), JSON.stringify(v.template.checks.issues));
});

await test('review fixes: an edit is not sent when Meta’s copy changed meanwhile (an appeal approved it)', async () => {
  await fresh();
  await connectAndSync();
  const d = await draft({ journeyKey: 'welcome_second_visit', poolKey: 'last_chance' }, 'de', 'MARKETING', DE_LAST);
  await submit(d.id, d.version);
  await review(d.id, 'REJECTED', { reason: 'INVALID_FORMAT' });
  await runWhatsAppTemplateTick();
  const rejected = await view(d.id);
  await review(d.id, 'APPROVED', { hint: false }); // the appeal, unseen by us yet
  const edited = await put(`/admin/whatsapp/templates/${d.id}`, { change: { source: { ...DE_LAST, body: DE_LAST.body.replace('Wir freuen uns!', 'Bis bald!') } }, baseVersion: rejected.template.version });
  const r = await submit(d.id, edited.body.template.version);
  assertEqual([r.body.outcome, r.body.template.display], ['refused', 'approved'], r.text);
  const atMeta = await sandboxTemplates(d.name);
  assertEqual(atMeta[0].status, 'APPROVED', 'still approved at Meta (nothing sent)');
});

await test('review fixes: Meta’s rate limit holds the syncs back', async () => {
  await fresh();
  await connectAndSync();
  await queueSandboxFaults([{ op: 'list', fault: 'rate_limit' }]);
  const r = await post('/admin/whatsapp/sync');
  assertEqual(r.body.sync.ok, false, 'failed');
  const ops = (await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).data()!;
  assert(typeof ops.backoffUntilMs === 'number' && ops.backoffUntilMs > Date.now(), 'backoff set');
  const before = (await logRows('sync.run')).length + (await logRows('sync.failed')).length;
  await advance(7 * 60 * 60_000);
  await runWhatsAppTemplateTick();
  assertEqual((await logRows('sync.run')).length + (await logRows('sync.failed')).length, before, 'no call during the backoff');
});

await test('review fixes: "already exists" with a failing lookup stays sending (not name-locked)', async () => {
  await fresh();
  await connectAndSync();
  const d = await offerDraft();
  await queueSandboxFaults([{ op: 'create', fault: 'exists' }, { op: 'find', fault: 'server_error' }]);
  const r = await submit(d.id, d.version);
  assertEqual([r.body.outcome, r.body.template.display], ['unknown', 'submitting'], r.text);
  assert(!r.body.template.checks.issues.some((i: any) => i.code === 'T17'), 'not locked');
});

await test('no secret in any console line', async () => {
  await fresh();
  process.env.WHATSAPP_ACCESS_TOKEN = 'EAAsecretTOKENshouldNEVERbeLOGGED123';
  const { logs } = await captureLogs(async () => {
    await connectAndSync();
    const d = await offerDraft();
    await submit(d.id, d.version);
    await runWhatsAppTemplateTick();
  });
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  assert(logs.every((l) => !l.includes('EAAsecret') && !l.includes('access_token')), logs.filter((l) => l.includes('EAA')).join('\n'));
});

await api.close();
done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
