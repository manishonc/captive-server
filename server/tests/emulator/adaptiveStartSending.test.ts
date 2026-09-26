/**
 * PR D — Start sending (D-D1) and the launch-aware `sendingLive` (D-D11), on the emulator,
 * through the real router and the admin launch card's own function.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - A venue turned on while the account was in a test run; the account goes live through
 *    `PUT /admin/launch` (typed phrase, an alive worker on this code) → the overview says
 *    `sendingLive: true` and the venue `needsStartSending: true`; a new guest starts nothing
 *    (no contact, no event from the login hook, no journey, no credits); a test-run guest from
 *    before carries on as a test run; a routine setup save doesn't lift the hold.
 *  - `POST …/start-sending` → the next new guest gets a live SMS and one ledger line; the guest
 *    from before is not backfilled; the click is idempotent and writes no `updatedAt`.
 *  - A test-run visit whose end falls after going live (Start sending clicked inside her 3 h
 *    window, or not at all): judged at the visit start → no review ask (live or dry run), no
 *    live send, no ledger line. A confirmed venue back in a test run, then live again: a visit
 *    started in the test run (or an older one without `startMode`, before "live since") ends as
 *    a test run (a dry-run review ask).
 *  - A venue turned on after going live isn't held; a live account without `liveSince` holds;
 *    Start sending before live is a 409; an old doc's first turn-on is backfilled, not moved.
 *  - A held Airbnb venue keeps syncing its calendar, but links nobody and starts no stay moments.
 *  - A guest linked in the test run who checked out before the Start sending click gets no
 *    review ask / book direct after it (`moment.passed`, once per stay and journey; the owner
 *    timeline says why); one who checks out after the click still gets them.
 *  - The `sendingLive` matrix: off / test / live+paused / live+released; another account stays false.
 */

import { FieldValue } from 'firebase-admin/firestore';
import {
  COL,
  TZ,
  advance,
  assert,
  assertEqual,
  clearCaches,
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
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, MCP_ACTOR, OWNER_ACTOR, clearEngineStatus, mountApi, seedWorkerHeartbeat, type Api } from './ownerApiHelpers';
import { ACTOR as STAY_ACTOR, R, at, day, eventsOf, instancesAt, sendLog, staysAt, sync, tasksOfKind, writeCalendar, writeGuestInfo } from './stayFixtures';
import { adaptiveVenueId, CONFIG_DOC_ID } from '../../src/adaptive/store/collections';
import { saveSetups } from '../../src/adaptive/service/tenant';
import { saveStayFeed } from '../../src/adaptive/service/stays';
import { applyLaunchChange } from '../../src/adaptive/service/launch';
import { readEngineSettings, venueHeld } from '../../src/adaptive/store/engineSettings';
import { sendKeyFor, taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../../src/adaptive/core/runtime/time';

const A: VenueFixture = { tenant: 'tenant_ss', venueId: 'venue_ss', apId: 'ap_ss', apMac: 'aa:aa:aa:aa:aa:61' };
const B: VenueFixture = { tenant: 'tenant_ss', venueId: 'venue_ss2', apId: 'ap_ss2', apMac: 'aa:aa:aa:aa:aa:62' };
const OTHER: VenueFixture = { tenant: 'tenant_other', venueId: 'venue_other', apId: 'ap_other', apMac: 'aa:aa:aa:aa:aa:63' };
const A1 = 'welcome_second_visit';
const SANDBOX = { actor: { uid: 'sandbox', kind: 'seed' as const }, sandbox: true };

const avRef = (venueId: string) => db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
const configRef = () => db.collection(COL.config).doc(CONFIG_DOC_ID);

async function eventsAt(venueId: string) {
  return docsWhere(COL.journeyEvents, 'venueId', venueId);
}

async function overviewVenue(api: Api, tenant: string, venueId: string) {
  const res = await api.get(`/tenants/${tenant}/overview`);
  assertEqual(res.status, 200, 'GET overview');
  return { body: res.body, venue: (res.body.venues as any[]).find((v) => v.venueId === venueId) };
}

/** The account goes live through the admin card (check → the phrase → PUT), with a worker on this code. */
async function goLiveThroughAdminCard(api: Api, tenant: string): Promise<void> {
  await seedWorkerHeartbeat();
  const change = { accounts: { [tenant]: 'live' }, paused: false };
  const check = await api.call('POST', '/admin/launch/check', { change, actor: ADMIN_ACTOR });
  assertEqual([check.status, check.body.blockers], [200, []], `check: ${check.text.slice(0, 300)}`);
  const phrase = check.body.summary.confirmPhrase as string;
  assert(phrase && phrase.includes('GO LIVE'), `a phrase to type: ${phrase}`);
  const card = await api.get('/admin/launch');
  const res = await api.call('PUT', '/admin/launch', { change, baseVersion: card.body.version, confirm: phrase.toLowerCase(), actor: ADMIN_ACTOR });
  assertEqual(res.status, 200, `PUT /admin/launch: ${res.text.slice(0, 300)}`);
  assert(res.body.launch.liveSince.accounts[tenant], 'live since is stamped for the account');
  clearCaches();
}

/** Fresh emulator: venue A turned on (real time), the engine clock on a Tuesday 12:40 ahead, account in a test run. */
async function heldSetup(): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(A);
  const t0 = nextTuesday1240();
  await setClock(t0);
  await seedWallet(A.tenant, 5000);
  await applyLaunchChange({ change: { accounts: { [A.tenant]: 'test' } } }, SANDBOX);
  clearCaches();
  return t0;
}

/**
 * The Airbnb venue R turned on while its account was in a test run; Tom (D+0 → D+5, checkout
 * 10:00) connects at D+0 15:10 and is linked in that test run; then the account goes live
 * through the admin card, so R waits for Start sending.
 */
async function heldStayWithTom(api: Api): Promise<{ contactId: string; stayId: string }> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(R);
  await writeGuestInfo();
  await setClock(at(0, '09:00'));
  await applyLaunchChange({ change: { accounts: { [R.tenant]: 'test' } } }, SANDBOX);
  clearCaches();
  await writeCalendar('r', [{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
  await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', STAY_ACTOR);
  await runDue();
  await setClock(at(0, '15:10'));
  const guestId = await connect({ venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true });
  await runDue();
  const contactId = await contactIdFor(R.tenant, guestId);
  const stay = (await staysAt())[0];
  assertEqual([stay.contactId, stay.linkMode], [contactId, 'test'], 'Tom linked in the test run');
  await goLiveThroughAdminCard(api, R.tenant);
  assertEqual((await overviewVenue(api, R.tenant, R.venueId)).venue.adaptive.needsStartSending, true, 'R waits for Start sending');
  return { contactId, stayId: stay.id };
}

/** The owner's click on R at engine time `atMs` (everything due before it runs first); the stamp, in ms. */
async function startSendingAt(api: Api, atMs: number): Promise<number> {
  await runUntil(atMs);
  const res = await api.call('POST', `/tenants/${R.tenant}/venues/${R.venueId}/start-sending`, { actor: OWNER_ACTOR });
  assertEqual([res.status, res.body.needsStartSending], [200, false], `Start sending: ${res.text.slice(0, 200)}`);
  return (await avRef(R.venueId).get()).get('sendingConfirmedAt').toMillis();
}

async function main() {
  console.log('\nStart sending (PR D, D-D1)\n');
  const api = await mountApi();
  try {
    await test('held after going live: nothing starts for a new guest (no contact, event, journey, credits); a test-run guest carries on; a routine save keeps the hold', async () => {
      await heldSetup();
      // A test-run guest before the launch.
      const early = await connect({ venue: A, firstName: 'Tess', email: 'tess@test.local', consent: true });
      await runDue();
      const tessId = await contactIdFor(A.tenant, early);
      const tessA1 = (await docsWhere(COL.journeyInstances, 'contactId', tessId)).find((i) => i.journeyKey === A1)!;
      assertEqual(tessA1.mode, 'test', 'a test-run journey');

      await goLiveThroughAdminCard(api, A.tenant);
      const ov = await overviewVenue(api, A.tenant, A.venueId);
      assertEqual([ov.body.sendingLive, ov.body.sendingPaused, ov.body.launchMode], [true, false, 'live'], 'the account is live');
      assertEqual([ov.venue.adaptive.needsStartSending, ov.venue.adaptive.sendingConfirmedAt], [true, null], 'the venue waits for Start sending');
      const card = await api.get('/admin/launch');
      assertEqual(card.body.waitingForStartSending, { [A.tenant]: 1 }, 'the admin card counts it');

      const eventsBefore = (await eventsAt(A.venueId)).length;
      const tasksBefore = (await db.collection(COL.journeyTasks).get()).size;
      const held = await connect({ venue: A, firstName: 'Hana', email: 'hana@test.local', phone: '791234001', phoneCountryCode: '+41', phoneVerified: true, consent: true, guestId: 'g_held' });
      assertEqual((await eventsAt(A.venueId)).length, eventsBefore, 'the login hook wrote no event');
      assertEqual((await db.collection(COL.journeyTasks).get()).size, tasksBefore, '…and no task carrying her details');
      await runUntil(now() + 30 * MINUTE_MS);
      const contacts = await docsWhere(COL.contacts, 'tenantUserId', A.tenant);
      assert(!contacts.some((c) => (c.guestIds ?? []).includes(held)), 'no contact for her');
      assertEqual((await ledger(A.tenant)).length, 0, 'no credits moved');
      assertEqual((await outbox()).length, 0, 'nothing sent');
      // Tess's test run carried on (a dry run, not live, not held).
      const tessSend = (await db.collection(COL.journeySends).doc(sendKeyFor(tessA1.id, 's1')).get()).data();
      assertEqual([tessSend?.status, tessSend?.mode], ['dry_run', 'test'], 'the test-run guest stays a test run');

      // The worker agrees (authoritative), also for a connect task that got through somehow.
      const settings = await readEngineSettings();
      assert(venueHeld(settings, (await avRef(A.venueId).get()).data()!, now()), 'venueHeld');

      // A routine save (the wizard again, Guest info on, activate): the hold stays.
      const firstOn = (await avRef(A.venueId).get()).get('firstOnAt').toMillis();
      await saveSetups(
        A.tenant,
        { playbookKey: 'restaurant_growth', venueIds: [A.venueId], journeys: {}, timezones: { [A.venueId]: TZ }, overlapAck: { [A.venueId]: true }, guestInfo: true, activate: true },
        { uid: 'owner_uid', kind: 'tenant_user', role: 'ADMIN' },
      );
      clearCaches();
      const av = (await avRef(A.venueId).get()).data()!;
      assertEqual(av.firstOnAt.toMillis(), firstOn, 'firstOnAt never moves');
      assert(av.activatedAt.toMillis() > firstOn, 'activatedAt moved (so it cannot be the basis)');
      assertEqual((await overviewVenue(api, A.tenant, A.venueId)).venue.adaptive.needsStartSending, true, 'still waiting after a routine save');
      const beforeSave = (await eventsAt(A.venueId)).map((e) => e.id);
      await connect({ venue: A, email: 'after-save@test.local', consent: true });
      const added = (await eventsAt(A.venueId)).filter((e) => !beforeSave.includes(e.id));
      assertEqual(added.map((e) => `${e.type}:${e.guestId ?? ''}`), [], 'still nothing recorded');
    });

    await test('Start sending: the next new guest gets a live SMS and one ledger line; the guest from before is not backfilled; idempotent', async () => {
      await heldSetup();
      await goLiveThroughAdminCard(api, A.tenant);
      const before = await connect({ venue: A, email: 'before@test.local', consent: true, guestId: 'g_before' }); // held (caches the venue in the hook)
      const updatedAt = (await avRef(A.venueId).get()).get('updatedAt').toMillis();

      // Guards first: no actor → 400; the MCP → 403; another account's venue → 403.
      assertEqual((await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, {})).status, 400, 'no actor');
      assertEqual((await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: MCP_ACTOR })).status, 403, 'the MCP may not');
      assertEqual((await api.call('POST', `/tenants/tenant_nobody/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR })).status, 403, 'not this account');

      await advance(MINUTE_MS);
      const clickFrom = now();
      const res = await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR });
      const clickTo = now();
      assertEqual(res.status, 200, `start-sending: ${res.text.slice(0, 200)}`);
      assertEqual([res.body.alreadyConfirmed, res.body.needsStartSending, res.body.sendingConfirmedBy], [false, false, OWNER_ACTOR.uid], 'confirmed');
      const av = (await avRef(A.venueId).get()).data()!;
      const confirmedAt = av.sendingConfirmedAt.toMillis();
      assert(confirmedAt >= clickFrom - 1000 && confirmedAt <= clickTo + 1000, `stamped on the engine clock (${new Date(confirmedAt).toISOString()})`);
      assertEqual(av.updatedAt.toMillis(), updatedAt, 'updatedAt untouched');
      const again = await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR });
      assertEqual([again.status, again.body.alreadyConfirmed, again.body.sendingConfirmedAt], [200, true, res.body.sendingConfirmedAt], 'a second click changes nothing');
      const ov = await overviewVenue(api, A.tenant, A.venueId);
      assertEqual([ov.venue.adaptive.needsStartSending, ov.venue.adaptive.sendingConfirmedAt], [false, res.body.sendingConfirmedAt], 'the overview');

      // No clearCaches(): the click itself evicted the venue from the hook's 60 s cache.
      const guestId = await connect({ venue: A, firstName: 'Lena', email: 'lena@test.local', phone: '791234002', phoneCountryCode: '+41', phoneVerified: true, consent: true, guestId: 'g_after' });
      assert((await eventsAt(A.venueId)).some((e) => e.type === 'wifi.connected' && e.guestId === guestId), 'the hook records her at once');
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const contactId = await contactIdFor(A.tenant, guestId);
      const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1)!;
      assertEqual(a1.mode, 'live', 'a live journey');
      const key = sendKeyFor(a1.id, 's1');
      const send = (await db.collection(COL.journeySends).doc(key).get()).data()!;
      assertEqual([send.status, send.mode, send.channel], ['sent', 'live', 'sms'], 'a live SMS');
      assert((await outbox()).some((o) => o.id === key && o.channel === 'sms'), 'in the sandbox outbox');
      const debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
      assertEqual(debits.map((d) => d.id), [`debit_auto_${key}`], 'one ledger line');

      // The guest from before the click: nothing, now or later.
      await runUntil(now() + 2 * DAY_MS);
      const contacts = await docsWhere(COL.contacts, 'tenantUserId', A.tenant);
      assert(!contacts.some((c) => (c.guestIds ?? []).includes(before)), 'not backfilled');

      // Off for a while, a venue turned on during the gap, live again: the confirmed venue stays
      // confirmed; the new one waits (the go-live date moved).
      await applyLaunchChange({ change: { accounts: { [A.tenant]: 'off' } } }, SANDBOX);
      await setupVenue(B);
      await new Promise((r) => setTimeout(r, 20)); // real time moves on: B's first turn-on is before the next go-live
      await applyLaunchChange({ change: { accounts: { [A.tenant]: 'live' } } }, SANDBOX);
      clearCaches();
      assertEqual((await overviewVenue(api, A.tenant, A.venueId)).venue.adaptive.needsStartSending, false, 'A stays confirmed');
      assertEqual((await overviewVenue(api, A.tenant, B.venueId)).venue.adaptive.needsStartSending, true, 'B (turned on while off) waits');
    });

    // A guest who connected in the test run, before the account went live: her visit's end is
    // judged at the visit's START (route.ts handleVisitEnd). The venue was held then, so her
    // visit end starts nothing — no live review ask, and no dry-run one either (map E11 check
    // note: the visit-start hold alone) — with or without a Start sending click inside her window.
    for (const click of [true, false]) {
      await test(`a test-run visit that ends after going live (${click ? 'Start sending clicked inside her 3 h window' : 'no click'}): no review ask, nothing live, no credits`, async () => {
        await heldSetup();
        const guestId = await connect({ venue: A, firstName: 'Vera', email: 'vera@test.local', phone: '791234010', phoneCountryCode: '+41', phoneVerified: true, consent: true, guestId: 'g_vera' });
        await runDue();
        const contactId = await contactIdFor(A.tenant, guestId);
        const visits = await docsWhere(COL.visits, 'contactId', contactId);
        assertEqual(visits.map((v) => [v.startMode, v.status]), [['test', 'open']], 'one visit, started in the test run');
        const visit = visits[0];
        const endTaskId = taskIdFor(`visit_end:${visit.id}:${visit.lastSeenAt.toMillis()}`);
        const endTask = (await db.collection(COL.journeyTasks).doc(endTaskId).get()).data()!;
        assert(endTask && endTask.kind === 'visit_end' && endTask.status === 'queued', 'her visit end is armed');
        const endDue = endTask.dueAt.toMillis();
        assertEqual(endDue - visit.startedAt.toMillis(), 3 * HOUR_MS, 'due 3 h after she connected');

        await goLiveThroughAdminCard(api, A.tenant);
        if (click) {
          await advance(30 * MINUTE_MS);
          const res = await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR });
          assertEqual([res.status, res.body.needsStartSending], [200, false], `Start sending: ${res.text.slice(0, 200)}`);
          const confirmedAt = Date.parse(res.body.sendingConfirmedAt);
          assert(confirmedAt > visit.startedAt.toMillis() && confirmedAt < endDue, 'clicked after she connected, before her visit end is due');
        } else {
          assertEqual((await overviewVenue(api, A.tenant, A.venueId)).venue.adaptive.needsStartSending, true, 'still waiting for Start sending');
        }
        await runUntil(now() + 4 * HOUR_MS);

        assertEqual((await db.collection(COL.journeyTasks).doc(endTaskId).get()).get('status'), 'done', 'her visit end ran');
        const ended = (await docsWhere(COL.journeyEvents, 'contactId', contactId)).filter((e) => e.type === 'visit.ended');
        assertEqual(ended.length, 0, 'judged at the visit start (held then): no visit.ended is recorded');
        const insts = await docsWhere(COL.journeyInstances, 'contactId', contactId);
        assertEqual(insts.filter((i) => i.journeyKey === 'review_ask').map((i) => i.mode), [], 'no review ask: not live, and not a dry run either');
        assertEqual(insts.map((i) => `${i.journeyKey}:${i.mode}`), [`${A1}:test`], 'only her test-run welcome');
        const sends = await docsWhere(COL.journeySends, 'contactId', contactId);
        assert(sends.length > 0 && sends.every((s) => s.mode === 'test' && s.status === 'dry_run'), `only dry runs: ${sends.map((s) => `${s.journeyKey}/${s.nodeId}:${s.mode}:${s.status}`)}`);
        assertEqual((await ledger(A.tenant)).length, 0, 'no credit ledger line');
        assertEqual((await outbox()).length, 0, 'nothing sent');
        assertEqual((await db.collection(COL.visits).doc(visit.id).get()).get('startMode'), 'test', 'the visit still says test');
      });
    }

    await test('a confirmed venue, back in a test run, then live again: a visit that started in the test run ends as a test run (dry-run review ask, no credits); an older visit without startMode too', async () => {
      await heldSetup();
      await goLiveThroughAdminCard(api, A.tenant);
      await advance(MINUTE_MS);
      assertEqual((await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR })).status, 200, 'Start sending');
      await applyLaunchChange({ change: { accounts: { [A.tenant]: 'test' } } }, SANDBOX);
      clearCaches();
      await advance(MINUTE_MS);
      const veraGuest = await connect({ venue: A, firstName: 'Vera', email: 'vera.cycle@test.local', consent: true });
      const leoGuest = await connect({ venue: A, firstName: 'Leo', email: 'leo.cycle@test.local', consent: true });
      await runDue();
      const vera = await contactIdFor(A.tenant, veraGuest);
      const leo = await contactIdFor(A.tenant, leoGuest);
      const visitOf = async (c: string) => (await docsWhere(COL.visits, 'contactId', c))[0];
      assertEqual([(await visitOf(vera)).startMode, (await visitOf(leo)).startMode], ['test', 'test'], 'both visits started in the test run');

      await advance(MINUTE_MS);
      await applyLaunchChange({ change: { accounts: { [A.tenant]: 'live' } } }, SANDBOX);
      clearCaches();
      assertEqual((await overviewVenue(api, A.tenant, A.venueId)).venue.adaptive.needsStartSending, false, 'the confirmed venue stays confirmed');
      // Leo's visit as stored before PR D (no startMode); "live since" on the engine clock, after his visit began.
      await db.collection(COL.visits).doc((await visitOf(leo)).id).update({ startMode: FieldValue.delete() });
      await configRef().update({ [`launch.liveSince.accounts.${A.tenant}`]: new Date(now()) });
      clearCaches();

      await runUntil(now() + 8 * HOUR_MS);
      for (const [who, c] of [
        ['Vera (startMode test)', vera],
        ['Leo (no startMode, started before live)', leo],
      ] as const) {
        const ended = (await docsWhere(COL.journeyEvents, 'contactId', c)).filter((e) => e.type === 'visit.ended');
        assertEqual(ended.length, 1, `${who}: her visit end is recorded`);
        const asks = (await docsWhere(COL.journeyInstances, 'contactId', c)).filter((i) => i.journeyKey === 'review_ask');
        assertEqual(asks.map((i) => i.mode), ['test'], `${who}: the review ask runs as a test run`);
        const sends = await docsWhere(COL.journeySends, 'contactId', c);
        assert(sends.some((s) => s.journeyKey === 'review_ask'), `${who}: the review ask step ran (${sends.map((s) => s.journeyKey)})`);
        assert(sends.every((s) => s.mode === 'test' && s.status === 'dry_run'), `${who}: only dry runs: ${sends.map((s) => `${s.journeyKey}/${s.nodeId}:${s.mode}:${s.status}`)}`);
      }
      assertEqual((await ledger(A.tenant)).length, 0, 'no credit ledger line');
      assertEqual((await outbox()).length, 0, 'nothing sent');
    });

    await test('a venue turned on after going live is not held; a stray click stores nothing; missing liveSince holds; before live → 409', async () => {
      await heldSetup();
      // Before the account is live: 409.
      const early = await api.call('POST', `/tenants/${A.tenant}/venues/${A.venueId}/start-sending`, { actor: OWNER_ACTOR });
      assertEqual([early.status, early.body.code], [409, 'conflict'], 'not live yet → 409');

      await goLiveThroughAdminCard(api, A.tenant);
      await setupVenue(B); // turned on now, after the account went live
      const ov = await overviewVenue(api, A.tenant, B.venueId);
      assertEqual(ov.venue.adaptive.needsStartSending, false, 'B is not held');
      const stray = await api.call('POST', `/tenants/${A.tenant}/venues/${B.venueId}/start-sending`, { actor: OWNER_ACTOR });
      assertEqual([stray.status, stray.body.needsStartSending, stray.body.sendingConfirmedAt], [200, false, null], 'a stray click answers not needed');
      assertEqual((await avRef(B.venueId).get()).get('sendingConfirmedAt'), undefined, '…and stores nothing');
      const g = await connect({ venue: B, email: 'b-guest@test.local', consent: true });
      await runDue();
      const inB = (await docsWhere(COL.journeyInstances, 'venueId', B.venueId)).filter((i) => i.journeyKey === A1);
      assertEqual(inB.map((i) => i.mode), ['live'], `B's guest starts live (${g})`);

      // A live account whose "live since" is missing (edited by hand): held, whatever was turned on when.
      await configRef().update({ 'launch.liveSince': FieldValue.delete() });
      clearCaches();
      const settings = await readEngineSettings();
      assert(venueHeld(settings, (await avRef(B.venueId).get()).data()!, now()), 'B is held without a live-since date');
      const eventsBefore = (await eventsAt(B.venueId)).length;
      await connect({ venue: B, email: 'b-guest-2@test.local', consent: true });
      assertEqual((await eventsAt(B.venueId)).length, eventsBefore, 'nothing recorded');
      const card = await api.get('/admin/launch');
      assert(card.body.warnings.some((w: string) => w.includes('without a "live since" date')), `the card warns: ${card.body.warnings}`);
    });

    await test('an older AdaptiveVenues doc without firstOnAt: the first save backfills its earliest turn-on (it does not move to now)', async () => {
      await heldSetup();
      const old = new Date(Date.now() - 40 * DAY_MS);
      await avRef(A.venueId).update({ firstOnAt: FieldValue.delete(), activatedAt: old, 'utility.enabledAt': null });
      await saveSetups(
        A.tenant,
        { playbookKey: 'restaurant_growth', venueIds: [A.venueId], journeys: {}, timezones: { [A.venueId]: TZ }, overlapAck: { [A.venueId]: true }, activate: true },
        { uid: 'owner_uid', kind: 'tenant_user', role: 'ADMIN' },
      );
      assertEqual((await avRef(A.venueId).get()).get('firstOnAt').toMillis(), old.getTime(), 'backfilled from the old activation');
    });

    await test('a held Airbnb venue: its calendar keeps syncing, but nobody is linked and no stay moment starts', async () => {
      // Linked in a test run first, so its later moments are due while the venue is held.
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(R);
      await writeGuestInfo();
      await setClock(at(0, '09:00'));
      await applyLaunchChange({ change: { accounts: { [R.tenant]: 'test' } } }, SANDBOX);
      clearCaches();
      await writeCalendar('r', [
        { uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) },
        { uid: 'next@airbnb.test', checkIn: day(6), checkOut: day(8) },
      ]);
      await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', STAY_ACTOR);
      await runDue();
      await setClock(at(0, '15:10'));
      await connect({ venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true });
      await runDue();
      const tomStay = (await staysAt()).find((s) => s.checkIn === day(0))!;
      assert(tomStay.contactId, 'Tom linked in the test run');
      const beforeLive = (await instancesAt()).length;

      await goLiveThroughAdminCard(api, R.tenant);
      const liveAt = now();
      await runUntil(at(2, '12:00')); // the welcome (D+0 17:00), local tips (D+1 10:00), mid-stay (D+2 11:00) fall while held
      assertEqual((await instancesAt()).length, beforeLive, 'no stay journey started while held');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'stay.moment')).length, 0, 'no stay.moment recorded');
      const feed = (await db.collection(COL.stayFeeds).doc(`venue_${R.venueId}`).get()).data()!;
      assert(feed.lastSuccessAt && feed.lastSuccessAt.toMillis() > liveAt, 'the feed kept syncing while held');

      // A guest in the next stay's window: not linked (the hook writes nothing).
      await setClock(at(6, '15:00'));
      await connect({ venue: R, firstName: 'Nora', email: 'nora@test.local', consent: true });
      await runDue();
      const next = (await staysAt()).find((s) => s.checkIn === day(6))!;
      assertEqual(next.contactId, null, 'nobody linked while held');
      // …and the owner can't link by hand while held.
      const link = await api.call('POST', `/tenants/${R.tenant}/venues/${R.venueId}/stays/${next.id}/link`, { contactId: tomStay.contactId, actor: OWNER_ACTOR });
      assertEqual(link.status, 409, `link by hand while held: ${link.text.slice(0, 200)}`);
    });

    // Nobody is backfilled (D-D1), also through a stay link made in the test run: a guest who had
    // checked out before the owner's Start sending gets none of the post-checkout stay journeys
    // whose moments come after the click (stays/moments.ts handleStayTrigger) — recorded as
    // `moment.passed`, not counted as missed. The control: a click before his checkout.
    await test('a held Airbnb venue: a test-run guest who checked out before Start sending gets no review ask or book direct after the click (moment.passed once per journey; the timeline says why); checking out after the click, he still gets them', async () => {
      const POST_CHECKOUT = ['stay_book_direct', 'stay_review'];
      const postCheckoutLines = async () => (await sendLog()).filter((l) => POST_CHECKOUT.some((k) => l.startsWith(`${k}/`)));

      // Clicked on his checkout day at 12:00: two hours after he left (10:00), three before the review ask (15:00).
      const tom = await heldStayWithTom(api);
      const confirmedAt = await startSendingAt(api, at(5, '12:00'));
      assert(confirmedAt > at(5, '10:00') && confirmedAt < at(5, '15:00'), `clicked after his checkout, before the review ask (${new Date(confirmedAt).toISOString()})`);
      await runUntil(at(5, '16:00'));
      assertEqual((await eventsOf('moment.passed')).map((e) => e.data.journeyKey), ['stay_review'], 'the review ask passed at its moment');
      // His dates re-read after that (checkout 11:00, still before the click): the review moment
      // is scheduled again at the new dates version and handled again — still recorded once.
      await writeGuestInfo(R, { checkOutTime: '11:00' });
      await setClock(at(5, '16:30'));
      assertEqual((await sync()).changed, 1, 're-dated (checkout 11:00)');
      await runUntil(at(9, '12:00'));

      const reviewRuns = (await tasksOfKind('stay_trigger')).filter((t) => t.payload.journeyKey === 'stay_review');
      assertEqual(reviewRuns.map((t) => [t.payload.datesVersion, t.status]).sort(), [[1, 'done'], [2, 'done']], 'the review moment was handled twice (both dates versions)');
      const passed = (await eventsOf('moment.passed')).filter((e) => e.contactId === tom.contactId);
      assertEqual(passed.map((e) => [e.data.journeyKey, e.data.reason]).sort(), POST_CHECKOUT.map((k) => [k, 'checked_out_before_start_sending']), 'moment.passed once per stay and journey');
      for (const e of passed) {
        assertEqual([e.journeyKey, e.data.stayId, e.data.liveSince], [e.data.journeyKey, tom.stayId, confirmedAt], `${e.data.journeyKey}: this stay, the click's time`);
      }
      assert(!(await instancesAt()).some((i) => POST_CHECKOUT.includes(i.journeyKey)), 'neither journey started');
      assertEqual(await postCheckoutLines(), [], 'nothing sent for them (not even a dry run)');
      const moments = (await eventsOf('stay.moment')).filter((e) => POST_CHECKOUT.includes(e.data.journeyKey));
      assertEqual(moments.length, 0, 'no stay.moment for them');
      const skipped = (await eventsOf('stay.moment_skipped')).filter((e) => POST_CHECKOUT.includes(e.data.journeyKey));
      assertEqual(skipped.length, 0, 'not counted as missed');
      // The moments that fell while the venue waited aren't "missed" either when the dates are re-read.
      const allSkipped = await eventsOf('stay.moment_skipped');
      assertEqual(allSkipped.map((e) => `${e.data.journeyKey}:${e.data.reason}`), [], 'no stay moment of a guest who left before the click counts as missed');
      assertEqual((await outbox()).length, 0, 'nothing sent');
      assertEqual((await ledger(R.tenant)).length, 0, 'no credit ledger line');

      const tl = await api.get(`/tenants/${R.tenant}/venues/${R.venueId}/guests/${tom.contactId}?lang=en`);
      assertEqual(tl.status, 200, `GET guest: ${tl.text.slice(0, 200)}`);
      const sentences = (tl.body.timeline as any[]).filter((i) => i.kind === 'moment.passed').map((i) => i.sentence as string);
      assert(
        sentences.length === 2 && sentences.every((s) => /^Journey .+ didn't run: the guest had checked out before you started sending\.$/.test(s)),
        `the owner timeline says why: ${(tl.body.timeline as any[]).map((i) => i.sentence).join(' | ')}`,
      );

      // The control: clicked the day before his checkout → both run (a test run: he was linked in one).
      await heldStayWithTom(api);
      await startSendingAt(api, at(4, '12:00'));
      await runUntil(at(9, '12:00'));
      assertEqual((await eventsOf('moment.passed')).length, 0, 'control: nothing passed');
      const insts = (await instancesAt()).filter((i) => POST_CHECKOUT.includes(i.journeyKey));
      assertEqual(insts.map((i) => `${i.journeyKey}:${i.mode}`).sort(), ['stay_book_direct:test', 'stay_review:test'], 'control: both start, as a test run');
      assertEqual(await postCheckoutLines(), ['stay_review/s1 @ D+5 15:00', 'stay_book_direct/s @ D+8 10:00'], 'control: at their moments');
      const sends = await docsWhere(COL.journeySends, 'venueId', R.venueId);
      assert(
        sends.filter((s) => POST_CHECKOUT.includes(s.journeyKey)).every((s) => s.mode === 'test' && s.status === 'dry_run'),
        `control: dry runs only: ${sends.map((s) => `${s.journeyKey}/${s.nodeId}:${s.mode}:${s.status}`)}`,
      );
      assertEqual((await outbox()).length, 0, 'control: nothing sent');
    });

    console.log('\nsendingLive (PR D, D-D11)\n');

    await test('sendingLive: off / test / live+paused / live+released; another account stays false', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(A);
      await setupVenue(OTHER);
      const read = async (tenant: string) => {
        const res = await api.get(`/tenants/${tenant}/overview`);
        assertEqual(res.status, 200, 'overview');
        return [res.body.sendingLive, res.body.sendingPaused, res.body.launchMode];
      };
      assertEqual(await read(A.tenant), [false, true, 'off'], 'off (the seed: paused)');
      await setLaunch({ [A.tenant]: 'test' }, { paused: false });
      assertEqual(await read(A.tenant), [false, false, 'test'], 'test');
      await setLaunch({ [A.tenant]: 'live' }, { paused: true });
      assertEqual(await read(A.tenant), [true, true, 'live'], 'live + paused');
      await setLaunch({ [A.tenant]: 'live' }, { paused: false });
      assertEqual(await read(A.tenant), [true, false, 'live'], 'live + released');
      assertEqual(await read(OTHER.tenant), [false, false, 'off'], 'another account follows the default (off)');
      const venue = (await overviewVenue(api, A.tenant, A.venueId)).venue;
      assertEqual(venue.adaptive.needsStartSending, false, 'setLaunch stamps an epoch liveSince: not held');
    });

    await test('going live refuses without an alive worker on this code; the brake (pause) needs nothing', async () => {
      await heldSetup();
      await clearEngineStatus();
      const change = { accounts: { [A.tenant]: 'live' } };
      const card = await api.get('/admin/launch');
      const noWorker = await api.call('PUT', '/admin/launch', { change, baseVersion: card.body.version, confirm: 'GO LIVE', actor: ADMIN_ACTOR });
      assertEqual([noWorker.status, noWorker.body.code], [409, 'engine_not_ready'], 'no worker → refused');
      await seedWorkerHeartbeat({ version: '2020-01-01.a' });
      const oldWorker = await api.call('PUT', '/admin/launch', { change, baseVersion: card.body.version, confirm: 'GO LIVE', actor: ADMIN_ACTOR });
      assertEqual([oldWorker.status, oldWorker.body.code], [409, 'engine_not_ready'], 'an old worker → refused');
      assert(oldWorker.body.blockers.some((b: string) => b.includes('different code')), `says why: ${oldWorker.body.blockers}`);
      await clearEngineStatus();
      await seedWorkerHeartbeat({ keyFingerprint: 'ffffffffffff' });
      const otherKey = await api.call('PUT', '/admin/launch', { change, baseVersion: card.body.version, confirm: 'GO LIVE', actor: ADMIN_ACTOR });
      assertEqual([otherKey.status, otherKey.body.code], [409, 'engine_not_ready'], 'a worker with another identity key → refused');
      await clearEngineStatus();
      await seedWorkerHeartbeat({ ageMs: 10 * MINUTE_MS });
      const dead = await api.call('PUT', '/admin/launch', { change, baseVersion: card.body.version, confirm: 'GO LIVE', actor: ADMIN_ACTOR });
      assertEqual(dead.status, 409, 'a worker not seen for 10 minutes → refused');
      const brake = await api.call('PUT', '/admin/launch', { change: { paused: true }, actor: ADMIN_ACTOR });
      assertEqual([brake.status, brake.body.paused], [200, true], 'pause all: one click, no worker needed');
      assertEqual((await readEngineSettings()).launch.accounts[A.tenant], 'test', 'still a test run');
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
