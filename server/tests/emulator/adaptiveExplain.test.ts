/**
 * PR D — the plan's "Explain" test (plan §10; PRD §11.7; spec E1) on the emulator, through the
 * real router: the owner sentence, the admin checklist and Replay reach the same decision.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 * One live guest, Anna, at a restaurant:
 *  - she connects at 20:50 → her welcome SMS is held for quiet hours at 21:05 (`send.deferred`);
 *  - it goes out live the next morning (`message.sent`, credits, ledger);
 *  - three marketing messages from "another place" land in her weekly window → the 48 h
 *    follow-up is skipped by the weekly limit (`send.skipped` / `weekly_limit`).
 * Then:
 *  - the owner timeline (`GET …/guests/:contactId`, EN and DE) words each of the three with
 *    exactly `explainDecision(stored record)` in the venue's zone, and shows nothing of the
 *    other place;
 *  - the admin record (`GET /admin/guests/:contactId`) carries all 10 rule checks with a fact
 *    each, for each of the three; admin search finds her by email and by phone;
 *  - Replay (`POST /admin/decisions/replay`) answers `same: true` for all three (sendKey for the
 *    send, eventId for the deferral and the skip); a tampered snapshot answers `same: false`,
 *    a record without one `replayable: false`.
 */

import {
  COL,
  TZ,
  advance,
  assert,
  clearCaches,
  assertEqual,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
  ledger,
  nextTuesday1240,
  now,
  outbox,
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, mountApi, type Api } from './ownerApiHelpers';
import { pauseVenue } from '../../src/adaptive/service/tenant';
import { explainDecision, type DecisionRecord } from '../../src/adaptive/core/runtime/decision';
import { GATE_RULE_ORDER } from '../../src/adaptive/core/runtime/gate';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const E: VenueFixture = { tenant: 'tenant_x', venueId: 'venue_x', apId: 'ap_x', apMac: 'aa:aa:aa:aa:aa:51' };
const A1 = 'welcome_second_visit';
const OTHER = { tenant: 'tenant_elsewhere', venue: 'venue_elsewhere' };
const OTHER_KEYS = ['js_' + 'a'.repeat(32), 'js_' + 'b'.repeat(32), 'js_' + 'c'.repeat(32)];
const ANNA = { venue: E, firstName: 'Anna', email: 'anna.explain@test.local', phone: '791234567', phoneCountryCode: '+41', phoneVerified: true, consent: true, language: 'en' };

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: any): number => (typeof v === 'number' ? v : v.toMillis());

interface Story {
  contactId: string;
  a1: AnyDoc;
  send: AnyDoc; // the live welcome (JourneySends)
  sentEvent: AnyDoc; // its message.sent
  deferred: AnyDoc; // send.deferred (quiet hours)
  skipped: AnyDoc; // send.skipped (weekly limit)
}

async function annaStory(): Promise<Story> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(E);
  await seedWallet(E.tenant, 5000);
  await setLaunch({ [E.tenant]: 'live' }, { paused: false });
  const tue = nextTuesday1240();
  const p = localParts(new Date(tue), TZ);
  await setClock(zonedTime(p.year, p.month, p.day, 20, 50, TZ).getTime());

  const guestId = await connect(ANNA);
  await runDue();
  await advance(15 * MINUTE_MS); // 21:05: quiet hours
  await runDue();
  const contactId = await contactIdFor(E.tenant, guestId);
  const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1);
  assert(a1, 'Anna is in the welcome journey');
  const deferred = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((e) => e.type === 'send.deferred');
  assertEqual(deferred.map((e) => e.data?.decision?.rule), ['quiet_hours'], 'one deferral, for quiet hours');

  // The next morning it goes out, live.
  await runUntil(zonedTime(p.year, p.month, p.day + 1, 9, 45, TZ).getTime());
  const key = sendKeyFor(a1.id, 's1');
  const sendSnap = await db.collection(COL.journeySends).doc(key).get();
  assert(sendSnap.exists, 'the welcome send record');
  const send: AnyDoc = { ...(sendSnap.data() as Record<string, any>), id: key };
  assertEqual([send.status, send.mode, send.channel], ['sent', 'live', 'sms'], 'sent live by SMS');
  assert((await outbox()).some((o) => o.id === key), 'the sandbox provider got it');
  assertEqual((await ledger(E.tenant)).filter((l) => l.id === `debit_auto_${key}`).length, 1, 'charged once');
  const sentEvent = (await docsWhere(COL.journeyEvents, 'sendKey', key)).find((e) => e.type === 'message.sent');
  assert(sentEvent, 'message.sent recorded');

  // Three marketing messages from another place in her weekly window: the 48 h follow-up is skipped.
  const contact = (await db.collection(COL.contacts).doc(contactId).get()).data()!;
  const np = db.collection(COL.networkPeople).doc(contact.networkId);
  const touches = ((await np.get()).get('recentMarketingTouches') ?? []) as unknown[];
  await np.update({
    recentMarketingTouches: [
      ...touches,
      ...OTHER_KEYS.map((sendKey) => ({ at: new Date(now()), channel: 'email', tenantUserId: OTHER.tenant, venueId: OTHER.venue, sendKey })),
    ],
  });
  await runUntil(now() + 3 * DAY_MS);
  const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((e) => e.type === 'send.skipped' && e.data?.decision?.reason === 'weekly_limit');
  assertEqual(skipped.length, 1, 'the follow-up was skipped by the weekly limit');
  return { contactId, a1, send, sentEvent: sentEvent!, deferred: deferred[0], skipped: skipped[0] };
}

async function main() {
  console.log('\nExplain: owner sentence = admin checklist = Replay (PR D)\n');

  const api = await mountApi();
  let story: Story | null = null;
  try {
    await test('the story: a quiet-hours deferral, a live SMS the next morning, a weekly-limit skip', async () => {
      story = await annaStory();
      const d = story.deferred.data.decision as DecisionRecord;
      assert(d.until !== null && d.until > ms(story.deferred.occurredAt), 'held back until later');
      assert(story.deferred.data.replay && story.send.replay && story.skipped.data.replay, 'every decision keeps its replay snapshot');
      assert(story.send.decision.versions?.runtime, 'the decision names the runtime version');
      // The owner reads the decision's price: it must be what the ledger charged.
      const send = story.send;
      const debit = (await ledger(E.tenant)).find((l) => l.id === `debit_auto_${send.id}`)!;
      assertEqual([send.decision.credits.price, -debit.credits], [send.credits.amount, send.credits.amount], 'explained credits = priced = charged');
    });

    await test('owner timeline (EN + DE): the three sentences are explainDecision of the stored records, in the venue zone', async () => {
      const s = story!;
      assert(s, 'story');
      for (const lang of ['en', 'de'] as const) {
        const res = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/guests/${s.contactId}?lang=${lang}`);
        assertEqual(res.status, 200, `GET guest (${lang})`);
        const tl = res.body.timeline as Array<Record<string, any>>;
        const find = (kind: string, at: number) => tl.find((i) => i.kind === kind && i.at === iso(at) && i.journeyKey === A1);
        const sent = find('message.sent', ms(s.sentEvent.occurredAt));
        const deferred = find('send.deferred', ms(s.deferred.occurredAt));
        const skipped = find('send.skipped', ms(s.skipped.occurredAt));
        assert(sent && deferred && skipped, `all three on the timeline (${lang}): ${tl.map((i) => i.kind).join(', ')}`);
        assertEqual(sent.sentence, explainDecision(s.send.decision, lang, TZ), `sent (${lang})`);
        assertEqual(deferred.sentence, explainDecision(s.deferred.data.decision, lang, TZ), `deferred (${lang})`);
        assertEqual(skipped.sentence, explainDecision(s.skipped.data.decision, lang, TZ), `skipped (${lang})`);
        assert(sent.credits > 0 && sent.mode === 'live', 'the live send shows its credits');
        assert(/09:|9:/.test(deferred.sentence), `the deferral names the morning time in Zurich: ${deferred.sentence}`);
        if (lang === 'en') {
          assert(deferred.sentence.includes('quiet hours') && skipped.sentence.includes('in the last 7 days'), `plain words: ${deferred.sentence} / ${skipped.sentence}`);
        }
        const all = JSON.stringify(res.body);
        for (const secret of [OTHER.tenant, OTHER.venue, ...OTHER_KEYS, ANNA.email, '791234567']) {
          assert(!all.includes(secret), `the owner answer never shows ${secret}`);
        }
        assert(tl.every((i) => i.detail === undefined), 'no admin detail for owners');
      }
    });

    await test('admin: search by email and phone; the guest record has all 10 rule checks with a fact for each of the three', async () => {
      const s = story!;
      for (const by of [{ email: ANNA.email.toUpperCase() }, { phone: '+41 79 123 45 67' }]) {
        const res = await api.call('POST', '/admin/guests/search', { ...by, actor: ADMIN_ACTOR });
        assertEqual(res.status, 200, `search ${JSON.stringify(by)}`);
        assertEqual(res.body.results.map((r: any) => [r.contactId, r.tenantUserId]), [[s.contactId, E.tenant]], `found by ${Object.keys(by)[0]}`);
        assertEqual(res.body.results[0].venues.map((v: any) => v.venueId), [E.venueId], 'with her venue');
      }
      const res = await api.get(`/admin/guests/${s.contactId}`);
      assertEqual(res.status, 200, 'GET /admin/guests/:contactId');
      const g = res.body;
      const rulesOf = (d: any) => (d?.checks ?? []).map((c: any) => c.rule);
      const factsOk = (d: any) => (d?.checks ?? []).every((c: any) => typeof c.fact === 'string' && c.fact.trim().length > 0);

      const send = g.sends.find((x: any) => x.sendKey === s.send.id);
      assert(send, 'the send is listed');
      assertEqual(rulesOf(send.decision), GATE_RULE_ORDER, 'send: the 10 rules in order');
      assert(factsOk(send.decision) && send.decision.checks.every((c: any) => c.ok), 'send: every rule passed, each with a fact');
      assert(send.statusHistory.some((h: any) => h.type === 'message.sent'), 'send: provider status history from message.* events');

      for (const [label, ev, failing] of [
        ['deferred', s.deferred, 'quiet_hours'],
        ['skipped', s.skipped, 'weekly_limit'],
      ] as const) {
        const e = g.events.find((x: any) => x.id === ev.id);
        assert(e, `${label}: the event is listed`);
        assertEqual(rulesOf(e.data.decision), GATE_RULE_ORDER, `${label}: the 10 rules in order`);
        assert(factsOk(e.data.decision), `${label}: a fact for each rule`);
        assertEqual(e.data.decision.checks.filter((c: any) => !c.ok).map((c: any) => c.rule)[0], failing, `${label}: the first failing rule`);
        const item = g.timeline.find((i: any) => i.detail?.eventId === ev.id);
        assertEqual(rulesOf(item?.detail?.decision), GATE_RULE_ORDER, `${label}: the timeline detail carries the checklist`);
      }
      const weekly = g.events.find((x: any) => x.id === s.skipped.id).data.decision.checks.find((c: any) => c.rule === 'weekly_limit');
      assert(/^\d+ of 3/.test(weekly.fact), `the weekly fact: ${weekly.fact}`);
      assert(g.consentLedger.length >= 3 && g.instances.some((i: any) => i.id === s.a1.id), 'consent ledger and instances');
      assert(Array.isArray(g.weeklyWindow) && g.weeklyWindow.length >= 4, 'the cross-owner weekly window (HeidiFi sees it)');
    });

    await test('Replay: same:true for the send (sendKey), the deferral and the skip (eventId); tampered → same:false; no snapshot → not replayable', async () => {
      const s = story!;
      const replay = async (body: Record<string, unknown>) => {
        const res = await api.call('POST', '/admin/decisions/replay', { ...body, actor: ADMIN_ACTOR });
        assertEqual(res.status, 200, `replay ${JSON.stringify(body)}: ${res.text.slice(0, 200)}`);
        return res.body.replay;
      };
      for (const [label, body] of [
        ['send (sendKey)', { sendKey: s.send.id }],
        ['send (its message.sent eventId)', { eventId: s.sentEvent.id }],
        ['deferral (eventId)', { eventId: s.deferred.id }],
        ['skip (eventId)', { eventId: s.skipped.id }],
      ] as const) {
        const r = await replay(body);
        assert(r.replayable === true, `${label}: replayable`);
        assert(r.same === true, `${label}: same (differences: ${JSON.stringify(r.differences)})`);
        assertEqual([r.stage, r.engine.sameCode], ['gate', true], `${label}: gate stage, same code`);
      }
      const de = await replay({ eventId: s.deferred.id, lang: 'de' });
      assertEqual(de.sentence.stored, explainDecision(s.deferred.data.decision, 'de', TZ), 'the stored sentence in German, venue zone');

      // Tampered: the weekly count the rules read → the replay lets it through.
      const ref = db.collection(COL.journeyEvents).doc(s.skipped.id);
      await ref.update({ 'data.replay.gate.weekly.count': 0 });
      const t = await replay({ eventId: s.skipped.id });
      assert(t.same === false && t.differences.some((d: any) => d.field === 'checks.weekly_limit.ok'), `a changed input shows as a difference: ${JSON.stringify(t.differences)}`);
      // An older record without a snapshot: explained, not replayed.
      const { FieldValue } = await import('firebase-admin/firestore');
      await ref.update({ 'data.replay': FieldValue.delete() });
      const old = await replay({ eventId: s.skipped.id });
      assertEqual([old.replayable, old.consistency?.firstFailingCheckIsRule], [false, true], 'not replayable; consistent');

      // Guards: an unknown id is a 404; both or neither id is a 400; a non-admin actor is a 403.
      assertEqual((await api.call('POST', '/admin/decisions/replay', { sendKey: 'js_' + '0'.repeat(32), actor: ADMIN_ACTOR })).status, 404, 'unknown send');
      assertEqual((await api.call('POST', '/admin/decisions/replay', { actor: ADMIN_ACTOR })).status, 400, 'no id');
      assertEqual((await api.call('POST', '/admin/decisions/replay', { sendKey: s.send.id, eventId: s.skipped.id, actor: ADMIN_ACTOR })).status, 400, 'both ids');
      assertEqual((await api.call('POST', '/admin/decisions/replay', { sendKey: s.send.id, actor: { uid: 'o', kind: 'tenant_user' } })).status, 403, 'an owner');
    });

    await test('the messages list words each line from the send status, then the same explanation', async () => {
      const s = story!;
      const res = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/messages?days=10&lang=en&limit=100`);
      assertEqual(res.status, 200, 'GET messages');
      const lines = res.body.messages as Array<Record<string, any>>;
      // Two sends can share an instant (the review ask went out in the same run): match the journey too.
      const sent = lines.find((m) => m.type === 'message.sent' && m.at === iso(ms(s.sentEvent.occurredAt)) && m.journeyKey === A1);
      const skip = lines.find((m) => m.type === 'send.skipped' && m.at === iso(ms(s.skipped.occurredAt)) && m.journeyKey === A1);
      assert(sent && skip, `both listed: ${lines.map((m) => m.type).join(', ')}`);
      assertEqual([sent.line, sent.status, sent.to], [explainDecision(s.send.decision, 'en', TZ), 'sent', s.send.toMasked], 'the send line');
      assertEqual(skip.line, explainDecision(s.skipped.data.decision, 'en', TZ), 'the skip line');
      assert(!JSON.stringify(res.body).includes(ANNA.email) && !JSON.stringify(res.body).includes('791234567'), 'no raw address');
      const only = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/messages?days=10&kind=skips`);
      assert(only.body.messages.every((m: any) => ['send.skipped', 'send.blocked', 'send.deferred'].includes(m.type)), 'kind=skips');
      const paged = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/messages?days=10&limit=1`);
      assert(paged.body.messages.length === 1 && paged.body.nextCursor, 'a page of one with a cursor');
      const next = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/messages?days=10&limit=1&cursor=${encodeURIComponent(paged.body.nextCursor)}`);
      assertEqual(next.status, 200, 'the next page');
      assert(next.body.messages.length === 1 && next.body.messages[0].at <= paged.body.messages[0].at, 'older on the next page');
      void HOUR_MS;
    });

    await test('a paused venue (rule 1, test run): the owner sentence is explainDecision; Replay same:true at the system stage', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(E);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await setLaunch({ [E.tenant]: 'test' });
      const guestId = await connect({ venue: E, firstName: 'Paul', email: 'paul.pause@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      await pauseVenue(E.tenant, E.venueId, { uid: 'owner', kind: 'tenant_user', role: 'ADMIN' });
      clearCaches();
      await runUntil(t0 + 3 * DAY_MS);
      const contactId = await contactIdFor(E.tenant, guestId);
      const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1)!;
      const stop = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).find((e) => e.data?.decision?.rule === 'system');
      assert(stop, `a rule-1 decision: ${(await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).map((e) => e.type).join(', ')}`);
      assertEqual(stop.data.decision.checks.map((c: any) => c.rule), ['system'], 'one check (rule 1)');
      const res = await api.get(`/tenants/${E.tenant}/venues/${E.venueId}/guests/${contactId}?lang=en`);
      const item = res.body.timeline.find((i: any) => i.kind === stop.type && i.at === iso(ms(stop.occurredAt)));
      const said = explainDecision(stop.data.decision, 'en', TZ);
      // English goes on in lower case after "Test run:".
      assertEqual(item?.sentence, `Test run: ${said[0].toLowerCase()}${said.slice(1)}`, 'the owner sentence (a test run says so)');
      const r = await api.call('POST', '/admin/decisions/replay', { eventId: stop.id, actor: ADMIN_ACTOR });
      assertEqual([r.status, r.body.replay?.replayable, r.body.replay?.same, r.body.replay?.stage], [200, true, true, 'system'], `replay: ${r.text.slice(0, 300)}`);
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
