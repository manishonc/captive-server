/**
 * The Adaptive engine end to end on the Firestore emulator (PR A: test runs only).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server — starts a throwaway emulator)
 *
 * What these prove, with the real hook, the real PR 1 activation path and the
 * real worker, on a fake clock:
 *
 *  - **Launch off writes nothing** — the default after deploy.
 *  - **The Anna trace (test run)**: welcome by SMS 15 min after connect, email with
 *    new wording in the afternoon after 48 h without a reaction, exhausted after the
 *    last wait — every "send" a dry run with a full 10-rule "why" record, no credits.
 *  - **A second visit redeems the offer** → thank-you (info message) → converted;
 *    a reconnect 4 h later is the same visit.
 *  - **Idempotent**: the UniFi double call and a replayed task give one contact,
 *    one visit, one journey.
 *  - **Quiet hours**: a 21:05 welcome waits until 09:00–09:20.
 *  - **An old STOP** blocks SMS for good; the welcome goes by email.
 *  - **Only guests after activation** start journeys.
 *  - **Wi-Fi card**: blocked without Guest info, sent (dry run) with it.
 *  - **A paused venue** stops its guests at their next send (suppressed).
 *  - **A test-run guest stays a test run** after the account goes live.
 *  - **Restart**: 1,000 guests, three workers, one "crashed" worker's leases
 *    reclaimed → every guest gets exactly one welcome, none twice.
 *  - Review fixes: a malformed launch entry, old opt-outs on other guest docs,
 *    per-login phone verification, visits handled out of order or after the TTL,
 *    guest details dropped from tasks + the identity-key guard, a late revisit,
 *    a resumed send keeping its ladder position.
 */

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
  nextTuesday1240,
  now,
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  seedWallet,
  setSafety,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type VenueFixture,
} from './helpers';
import { AdaptiveWorker } from '../../src/adaptive/worker/worker';
import { claimDue, failTask, reclaimExpiredLeases } from '../../src/adaptive/queue/firestoreQueue';
import { recordConnect } from '../../src/adaptive/identity/visits';
import { modeFor, parseEngineSettings } from '../../src/adaptive/store/engineSettings';
import { keyFingerprint } from '../../src/adaptive/identity/key';
import { ENGINE_STATUS_DOC_ID } from '../../src/adaptive/store/collections';
import { FieldValue } from 'firebase-admin/firestore';
import { pauseVenue } from '../../src/adaptive/service/tenant';
import { HOUR_MS, MINUTE_MS, DAY_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';
import { devGuestLog } from '../../src/adaptive/service/engine';

const A: VenueFixture = { tenant: 'tenant_a', venueId: 'venue_a', apId: 'ap_a', apMac: 'aa:aa:aa:aa:aa:01' };

async function fresh(venues: VenueFixture[] = [A]) {
  await resetEmulator();
  await seedCatalogue();
  for (const v of venues) await setupVenue(v);
}

async function instancesAt(venueId: string) {
  return docsWhere(COL.journeyInstances, 'venueId', venueId);
}

async function sendsFor(instanceId: string) {
  const s = await docsWhere(COL.journeySends, 'instanceId', instanceId);
  return s.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function main() {
  console.log('\nAdaptive engine on the emulator\n');

  await test('launch off (the default) → the login hook writes nothing', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await connect({ venue: A, email: 'off@test.local', consent: true });
    const events = await db.collection(COL.journeyEvents).get();
    const tasks = await db.collection(COL.journeyTasks).get();
    assertEqual([events.size, tasks.size], [0, 0], 'nothing written');
  });

  let annaA1 = '';
  await test('Anna (test run): SMS welcome at +15 min → email with new wording after 48 h → exhausted', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({ venue: A, firstName: 'Anna', email: 'anna@test.local', phone: '1512345678', phoneCountryCode: '+49', phoneVerified: true, consent: true, language: 'de' });
    await runDue();

    const contactId = await contactIdFor(A.tenant, guestId);
    const contact = (await db.collection(COL.contacts).doc(contactId).get()).data()!;
    assertEqual(contact.marketingConsent[`venue:${A.venueId}`].sms.state, 'granted', 'SMS consent recorded');
    assertEqual(contact.marketingConsent[`venue:${A.venueId}`].email.state, 'granted', 'email consent recorded');
    const consentEvents = await docsWhere(COL.consentEvents, 'contactId', contactId);
    assertEqual(consentEvents.length, 3, 'three grants (email, sms, whatsapp) in the ledger');

    const inst = (await instancesAt(A.venueId)).filter((i) => i.journeyKey === 'welcome_second_visit');
    assertEqual(inst.length, 1, 'one A1 journey');
    annaA1 = inst[0].id;
    assertEqual(inst[0].mode, 'test', 'frozen as a test run');
    assertEqual(inst[0].cursor.nodeId, 'd1', 'waiting 15 min');
    assertEqual(inst[0].vars.offerKey, 'dessert', 'offer issued');

    await advance(15 * MINUTE_MS);
    await runDue();
    let sends = await sendsFor(annaA1);
    assertEqual(sends.length, 1, 'one send');
    const s1 = sends[0];
    assertEqual([s1.status, s1.channel, s1.mode, s1.nodeId], ['dry_run', 'sms', 'test', 's1'], 'SMS welcome as a dry run');
    assertEqual(s1.decision.result, 'allow', 'gate allowed');
    assertEqual(s1.decision.checks.length, 10, 'ten rules recorded');
    assert(s1.credits.amount > 0 && s1.credits.amount % 15 === 0, `priced per SMS segment (${s1.credits.amount})`);
    assertEqual(s1.credits.ledgerId, null, 'nothing charged');
    assert(String(s1.content.preview).includes('Anna'), `rendered in German with her name: ${s1.content.preview}`);

    await runUntil(t0 + 4 * DAY_MS);
    sends = await sendsFor(annaA1);
    assertEqual(sends.length, 2, 'second touch');
    const s2 = sends[1];
    assertEqual([s2.channel, s2.nodeId], ['email', 's2_next'], 'next channel on the ladder');
    assert(s2.variantId !== s1.variantId, 'different wording');
    const hour = localParts(s2.createdAt.toDate(), TZ).hour;
    assert(hour >= 14 && hour < 17, `afternoon slot (got ${hour}:00)`);

    await runUntil(t0 + 8 * DAY_MS);
    const after = (await db.collection(COL.journeyInstances).doc(annaA1).get()).data()!;
    assertEqual(after.status, 'exhausted', 'no click → exhausted');
    const cv = (await db.collection(COL.contactVenues).doc(`${contactId}_${A.venueId}`).get()).data()!;
    assertEqual(cv.journeys.welcome_second_visit.activeInstanceId, null, 'free for a later journey');

    const wallets = await db.collection(COL.creditWallets).get();
    assertEqual(wallets.size, 0, 'no credits touched');

    const log = await devGuestLog({ email: 'anna@test.local' });
    const why = log.contacts[0].timeline.filter((e: any) => e.type === 'send.dry_run' && e.journeyKey === 'welcome_second_visit').map((e: any) => e.why);
    assert(why.length === 2 && why.every((w: string) => w.startsWith('Test run: would have sent')), `owner sentences: ${JSON.stringify(why)}`);
    // A2 (review ask) also ran for her visit — 3 h after it "ended", then one retry on the next channel.
    const a2 = (await instancesAt(A.venueId)).filter((i) => i.journeyKey === 'review_ask');
    assertEqual(a2.length, 1, 'the review ask started once for her visit');
  });

  await test('a test-run guest stays a test run after going live; a new guest is sent for real (sandbox)', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'early-bird@test.local', phone: '791234500', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    await seedWallet(A.tenant, 1000);
    await setLaunch({ [A.tenant]: 'live' }, { paused: false });
    await connect({ venue: A, email: 'live-guest@test.local', consent: true });
    await runUntil(t0 + 4 * DAY_MS);
    const a1s = (await instancesAt(A.venueId)).filter((i) => i.journeyKey === 'welcome_second_visit');
    const testInst = a1s.find((i) => i.mode === 'test')!;
    assert(testInst, 'the test-run journey is there');
    assert((await sendsFor(testInst.id)).length >= 2, 'it carried on after the account went live');
    assert((await sendsFor(testInst.id)).every((s) => s.status === 'dry_run'), 'the test-run guest only ever gets dry runs');
    const liveInst = a1s.find((i) => i.mode === 'live');
    assert(liveInst, 'the new guest started a live journey');
    const liveSends = await sendsFor(liveInst.id);
    assert(liveSends.length >= 1 && liveSends.every((x) => x.mode === 'live' && x.status === 'sent'), `live sends went out: ${liveSends.map((x) => x.status)}`);
    await setLaunch({ [A.tenant]: 'test' }, { paused: true });
  });

  await test('a second visit with the offer still valid → thank-you → converted; +4 h is the same visit', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({ venue: A, firstName: 'Ben', email: 'ben@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    assertEqual((await sendsFor(a1.id)).map((s) => s.channel), ['email'], 'welcome by email (no phone)');

    await advance(4 * HOUR_MS);
    await connect({ venue: A, guestId, firstName: 'Ben', email: 'ben@test.local', consent: true });
    await runDue();
    const contactId = await contactIdFor(A.tenant, guestId);
    let cv = (await db.collection(COL.contactVenues).doc(`${contactId}_${A.venueId}`).get()).data()!;
    assertEqual(cv.visitCount, 1, '+4 h is the same visit');

    // Back the next morning at 10:00 (more than 8 h after he was last seen): a new visit.
    const p0 = localParts(new Date(t0), TZ);
    await setClock(zonedTime(p0.year, p0.month, p0.day + 1, 10, 0, TZ).getTime());
    await connect({ venue: A, guestId, firstName: 'Ben', email: 'ben@test.local', consent: true });
    await runDue();
    cv = (await db.collection(COL.contactVenues).doc(`${contactId}_${A.venueId}`).get()).data()!;
    assertEqual(cv.visitCount, 2, 'a new visit after the gap');
    const inst = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    if (inst.status !== 'converted') {
      const evs = (await docsWhere(COL.journeyEvents, 'contactId', contactId)).map((e) => `${e.type}${e.instanceId ? '@' + e.instanceId.slice(0, 8) : ''}`);
      console.error('    DEBUG instance', JSON.stringify({ status: inst.status, cursor: inst.cursor, waiting: inst.waiting, vars: inst.vars, goal: inst.goal, startedAt: inst.startedAt }), '\n    events', evs.join(', '));
    }
    assertEqual(inst.status, 'converted', 'converted');
    const sends = await sendsFor(a1.id);
    const thanks = sends.find((s) => s.nodeId === 'thanks');
    assert(thanks && thanks.purpose === 'service', 'thank-you sent as an info message');
    const redeemed = await docsWhere(COL.journeyEvents, 'type', 'offer.redeemed');
    assertEqual(redeemed.length, 1, 'offer redeemed once');
  });

  await test('the UniFi double call and a replayed task give one contact, one visit, one journey', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({ venue: A, email: 'double@test.local', consent: true });
    await connect({ venue: A, guestId, email: 'double@test.local', consent: true });
    const connects = await docsWhere(COL.journeyEvents, 'type', 'wifi.connected');
    assertEqual(connects.length, 1, 'one connect event in the same minute');
    await runDue();
    // Replay the routing task as if a worker crashed after doing the work.
    const task = (await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').get()).docs[0];
    await task.ref.update({ status: 'queued', leaseOwner: null });
    await runDue();
    const contacts = await docsWhere(COL.contacts, 'tenantUserId', A.tenant);
    const visits = await docsWhere(COL.visits, 'venueId', A.venueId);
    const a1 = (await instancesAt(A.venueId)).filter((i) => i.journeyKey === 'welcome_second_visit');
    assertEqual([contacts.length, visits.length, a1.length], [1, 1, 1], 'nothing doubled');
  });

  await test('quiet hours: a welcome due at 21:05 waits until 09:00–09:20 the next morning', async () => {
    await fresh();
    const tue = nextTuesday1240();
    const p = localParts(new Date(tue), TZ);
    const evening = zonedTime(p.year, p.month, p.day, 20, 50, TZ).getTime();
    await setClock(evening);
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'night@test.local', phone: '791234567', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    assertEqual((await sendsFor(a1.id)).length, 0, 'nothing at 21:05');
    const inst = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    assertEqual(inst.waiting.lastDeferReason, 'quiet_hours', 'held for quiet hours');
    const deferred = await docsWhere(COL.journeyEvents, 'type', 'send.deferred');
    assert(deferred.some((e) => e.data.decision.rule === 'quiet_hours'), 'the why record says quiet hours');
    const nine = zonedTime(p.year, p.month, p.day + 1, 9, 0, TZ).getTime();
    await runUntil(nine + HOUR_MS);
    const sent = (await sendsFor(a1.id))[0];
    const at = sent.createdAt.toMillis();
    assert(at >= nine && at < nine + 21 * MINUTE_MS, `sent 09:00–09:20 (got ${new Date(at).toISOString()})`);
  });

  await test('an old STOP blocks SMS for good; the welcome goes by email', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({
      venue: A,
      email: 'stopped@test.local',
      phone: '791112233',
      phoneCountryCode: '+41',
      phoneVerified: true,
      consent: true,
      legacy: { smsOptOut: true },
    });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    assertEqual((await sendsFor(a1.id)).map((s) => s.channel), ['email'], 'email, not SMS');
    const contactId = await contactIdFor(A.tenant, guestId);
    const contact = (await db.collection(COL.contacts).doc(contactId).get()).data()!;
    assertEqual(contact.marketingConsent[`venue:${A.venueId}`].sms.state, 'revoked', 'SMS revoked (import_legacy)');
    const cp = (await db.collection(COL.contactPoints).doc(contact.phonePointId).get()).data()!;
    assertEqual(cp.suppression.sms.reason, 'stop', 'the number is blocked for SMS everywhere');
  });

  await test('only guests who connect after the venue was turned on start journeys', async () => {
    await fresh();
    await setClock(Date.now() - DAY_MS); // before the activation stamp
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'early@test.local', consent: true });
    await runDue();
    assertEqual((await instancesAt(A.venueId)).length, 0, 'no journeys for a guest before activation');
  });

  await test('Wi-Fi card: blocked without Guest info, a dry run with it', async () => {
    const G: VenueFixture = { tenant: 'tenant_g', venueId: 'venue_g', apId: 'ap_g', apMac: 'aa:aa:aa:aa:aa:07', guestInfo: true };
    await fresh([G]);
    await setClock(nextTuesday1240());
    await setLaunch({ [G.tenant]: 'test' });
    await connect({ venue: G, email: 'nocontent@test.local', consent: false });
    await runDue();
    const blocked = await docsWhere(COL.journeyEvents, 'type', 'send.skipped');
    assert(blocked.some((e) => e.data.decision.reason === 'guest_info_missing'), 'blocked: Guest info missing');
    assertEqual((await instancesAt(G.venueId)).filter((i) => i.journeyKey === 'welcome_second_visit').length, 0, 'no A1 without consent');

    await db.collection(COL.venueGuestInfo).doc(`venue_${G.venueId}`).set({ tenantUserId: G.tenant, venueId: G.venueId, locales: { en: { wifiName: 'Madras Guest' } } });
    await connect({ venue: G, email: 'content@test.local', consent: false });
    await runDue();
    const card = (await instancesAt(G.venueId)).find((i) => i.journeyKey === 'wifi_info_card' && i.status === 'completed' && i.trail?.some((t: any) => t.outcome === 'sent'));
    assert(card, 'a Wi-Fi card went out (dry run)');
    const s = (await sendsFor(card!.id))[0];
    assert(String(s.content.preview).includes('Madras Guest'), `with the Wi-Fi name: ${s.content.preview}`);
    assertEqual(s.credits, null, 'info messages are free');
  });

  await test('no late messages: after a week with the worker stopped, the welcome is skipped as stale', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'late@test.local', consent: true });
    await runDue(); // enrolled, waiting 15 min
    await advance(7 * DAY_MS); // the worker was "down" for a week
    await runDue();
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    assertEqual((await sendsFor(a1.id)).length, 0, 'no welcome a week late');
    const skipped = await docsWhere(COL.journeyEvents, 'type', 'send.skipped');
    assert(skipped.some((e) => e.instanceId === a1.id && e.data.decision.reason === 'stale'), 'skipped with the reason "stale"');
  });

  await test('a paused venue stops its guests at their next send (suppressed)', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'pause@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    await pauseVenue(A.tenant, A.venueId, { uid: 'owner', kind: 'tenant_user', role: 'ADMIN' });
    clearCaches();
    await runUntil(t0 + 3 * DAY_MS);
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    assertEqual(a1.status, 'suppressed', 'suppressed at the next send');
    assertEqual((await sendsFor(a1.id)).length, 1, 'no second message');
  });

  await test('launch: a malformed account entry turns only that account off, never another one back on', async () => {
    const s = parseEngineSettings({ launch: { default: 'test', accounts: { tenant_off: 'off', tenant_typo: 'Test', tenant_null: null } } });
    assertEqual([modeFor(s, 'tenant_off'), modeFor(s, 'tenant_typo'), modeFor(s, 'tenant_null'), modeFor(s, 'tenant_other')], ['off', 'off', 'off', 'test'], 'per-entry fallback');
    assertEqual(parseEngineSettings({ launch: { default: 'test', accounts: 'nonsense' } }).launch.accounts, {}, 'a non-map reads as no overrides');
  });

  await test('old opt-outs on other guest docs: a STOP saved without phoneE164, an unsubscribe at another AP of the venue', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    await db.collection(COL.accessPoints).doc('ap_a_second').set({ venueId: A.venueId, tenantUserId: A.tenant, vendor: 'aruba' });
    await db.collection(COL.accessPoints).doc('ap_elsewhere').set({ venueId: 'venue_elsewhere', tenantUserId: 'tenant_x', vendor: 'aruba' });
    // Written before July 2026: raw phone only, flagged by an old STOP.
    await db.collection(COL.guests).doc('legacy_stop').set({ phone: '791112299', phoneCountryCode: '+41', smsOptOut: true, captivePortalAccessPointId: 'ap_a_second' });
    // Unsubscribed through a link sent to their doc at the venue's other AP …
    await db.collection(COL.guests).doc('legacy_unsub').set({ email: 'unsub@test.local', unsubscribed: true, captivePortalAccessPointId: 'ap_a_second' });
    // … and, for contrast, someone who unsubscribed at another owner's venue.
    await db.collection(COL.guests).doc('legacy_elsewhere').set({ email: 'fine@test.local', unsubscribed: true, captivePortalAccessPointId: 'ap_elsewhere' });
    // Typed with spaces, and with the country code twice: only a digit comparison finds these.
    await db.collection(COL.guests).doc('legacy_spaces').set({ phone: '79 111 22 88', phoneCountryCode: '+41', smsOptOut: true, captivePortalAccessPointId: 'ap_a_second' });
    await db.collection(COL.guests).doc('legacy_double').set({ phone: '41791112277', phoneCountryCode: '+41', whatsappOptOut: true, captivePortalAccessPointId: 'ap_a_second' });
    // Unsubscribed as "Casey.Case@Test.local"; connects now as lower case.
    await db.collection(COL.guests).doc('legacy_case').set({ email: 'Casey.Case@Test.local', unsubscribed: true, captivePortalAccessPointId: 'ap_a_second' });
    clearCaches();

    const g1 = await connect({ venue: A, email: 'unsub@test.local', phone: '791112299', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    const g2 = await connect({ venue: A, email: 'fine@test.local', consent: true });
    const g3 = await connect({ venue: A, email: 'casey.case@test.local', phone: '791112288', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    const g4 = await connect({ venue: A, email: 'double@test.local', phone: '791112277', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runDue();
    const c1 = (await db.collection(COL.contacts).doc(await contactIdFor(A.tenant, g1)).get()).data()!;
    const consent1 = c1.marketingConsent[`venue:${A.venueId}`];
    assertEqual([consent1.sms.state, consent1.email.state], ['revoked', 'revoked'], 'the old STOP and the old unsubscribe both carried over');
    const c2 = (await db.collection(COL.contacts).doc(await contactIdFor(A.tenant, g2)).get()).data()!;
    assertEqual(c2.marketingConsent[`venue:${A.venueId}`].email.state, 'granted', 'an unsubscribe at another venue does not count here');
    const consent3 = (await db.collection(COL.contacts).doc(await contactIdFor(A.tenant, g3)).get()).data()!.marketingConsent[`venue:${A.venueId}`];
    assertEqual([consent3.sms.state, consent3.email.state], ['revoked', 'revoked'], 'a STOP typed with spaces and an unsubscribe in other letter case both carried over');
    const consent4 = (await db.collection(COL.contacts).doc(await contactIdFor(A.tenant, g4)).get()).data()!.marketingConsent[`venue:${A.venueId}`];
    assertEqual(consent4.whatsapp.state, 'revoked', 'a WhatsApp STOP on a number saved with the country code twice carried over');
  });

  await test('phone verified comes from this login, not an older flag on the guest doc', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({ venue: A, email: 'switch@test.local', phone: '791115555', phoneCountryCode: '+41', phoneVerified: false, consent: true, legacy: { phoneVerified: true } });
    await runDue();
    const c = (await db.collection(COL.contacts).doc(await contactIdFor(A.tenant, guestId)).get()).data()!;
    assertEqual(c.phoneVerified, false, 'not verified by a flag that may belong to another number');
  });

  await test('visits: a retry after later connects, older connects, and a visit doc already removed by the TTL', async () => {
    await fresh();
    const base = { tenantUserId: A.tenant, venueId: A.venueId, contactId: 'c_visits', guestId: 'g_visits', apId: A.apId, gapHours: 8 };
    const t = nextTuesday1240();
    const a = await recordConnect({ ...base, connectEventId: 'ev_a', occurredAt: t });
    assert(a.isNew && a.visitNumber === 1, 'the first connect opens visit 1');
    const b = await recordConnect({ ...base, connectEventId: 'ev_b', occurredAt: t + 2 * MINUTE_MS });
    assert(!b.isNew && b.visitId === a.visitId, 'two minutes later: the same visit');
    const retry = await recordConnect({ ...base, connectEventId: 'ev_a', occurredAt: t });
    assert(retry.isNew && retry.visitId === a.visitId, 'a retry of the first connect still answers "new visit" (its journeys start)');
    await recordConnect({ ...base, connectEventId: 'ev_c', occurredAt: t + 2 * HOUR_MS });
    const older = await recordConnect({ ...base, connectEventId: 'ev_d', occurredAt: t - 30 * MINUTE_MS });
    const ancient = await recordConnect({ ...base, connectEventId: 'ev_e', occurredAt: t - 20 * HOUR_MS });
    const cvRef = db.collection(COL.contactVenues).doc(`c_visits_${A.venueId}`);
    let cv = (await cvRef.get()).data()!;
    assert(!older.isNew && !ancient.isNew, 'older connects never open a visit');
    assertEqual([cv.visitCount, cv.lastSeenAt.toMillis()], [1, t + 2 * HOUR_MS], 'still visit 1, last seen not moved back');
    // The 25-month TTL removed the visit doc; the guest comes back.
    await db.collection(COL.visits).doc(a.visitId).delete();
    const back = await recordConnect({ ...base, connectEventId: 'ev_f', occurredAt: t + 12 * HOUR_MS });
    assert(back.isNew && back.visitNumber === 2, 'a new visit opens instead of failing on the missing doc');
    await db.collection(COL.visits).doc(back.visitId).delete();
    const again = await recordConnect({ ...base, connectEventId: 'ev_g', occurredAt: t + 13 * HOUR_MS });
    cv = (await cvRef.get()).data()!;
    assert(again.isNew && cv.visitCount === 3, 'within the gap but the visit doc is gone: a new visit, no error');
  });

  await test('tasks drop the guest details when done or dead; the identity key is pinned and guarded', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'pii@test.local', consent: true });
    // A fresh worker: the shared one remembers the key it confirmed before this test's reset.
    await new AdaptiveWorker().runDue();
    const done = (await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').get()).docs[0];
    assertEqual([done.get('status'), done.get('payload.guest')], ['done', undefined], 'done: raw details removed');
    const status = await db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get();
    assertEqual(status.get('identity.keyFingerprint'), keyFingerprint(), 'the agreed key is pinned');

    // A task that fails for good.
    await connect({ venue: A, email: 'dead@test.local', consent: true, guestId: 'g_dead' });
    const queued = (await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').where('status', '==', 'queued').get()).docs[0];
    await queued.ref.update({ maxAttempts: 1 });
    const leased = (await claimDue('test-worker', now(), 10)).find((t) => t.id === queued.id)!;
    assert(leased && leased.payload.guest, 'claimed with the guest details');
    await failTask(leased.id, 'test-worker', 'boom', now());
    const dead = (await queued.ref.get()).data()!;
    assert(dead.status === 'dead' && dead.payload.guest === undefined, 'dead: raw details removed');
    assert(dead.expireAt.toMillis() > Date.now() + 29 * DAY_MS, 'dead tasks expire (kept 30 days)');

    // A connect written by an API with another key, while this worker's key is the pinned one: handled.
    const g3 = await connect({ venue: A, email: 'otherapi@test.local', consent: true });
    await db.collection(COL.journeyTasks).where('status', '==', 'queued').get().then((q) => Promise.all(q.docs.map((d) => d.ref.update({ 'payload.keyFingerprint': 'aaaaaaaaaaaa' }))));
    await runDue();
    await contactIdFor(A.tenant, g3);

    // Nothing pinned yet and the keys disagree: the connect is held, not handled.
    await status.ref.update({ identity: FieldValue.delete() });
    const w = new AdaptiveWorker();
    const g4 = await connect({ venue: A, email: 'held@test.local', consent: true });
    await db.collection(COL.journeyTasks).where('status', '==', 'queued').get().then((q) => Promise.all(q.docs.map((d) => d.ref.update({ 'payload.keyFingerprint': 'aaaaaaaaaaaa' }))));
    await w.runDue(3);
    let held = false;
    try {
      await contactIdFor(A.tenant, g4);
    } catch {
      held = true;
    }
    assert(held, 'no contact made with a key nobody agreed on');
    const heldTask = (await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').where('status', '==', 'queued').get()).docs;
    assertEqual(heldTask.length, 1, 'the connect waits in the queue');

    // The pepper changed: this worker's key is not the pinned one → it stays idle.
    await status.ref.set({ identity: { keyFingerprint: 'bbbbbbbbbbbb' } }, { merge: true });
    const problem = await (new AdaptiveWorker() as any).identityCheck();
    assert(typeof problem === 'string' && problem.includes('pinned'), `idle with a reason: ${problem}`);
  });

  await test('a revisit handled hours late still converts, but the thank-you is skipped as stale', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    const guestId = await connect({ venue: A, firstName: 'Lena', email: 'lena@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    const p0 = localParts(new Date(t0), TZ);
    await setClock(zonedTime(p0.year, p0.month, p0.day + 1, 10, 0, TZ).getTime());
    await connect({ venue: A, guestId, firstName: 'Lena', email: 'lena@test.local', consent: true });
    await advance(7 * HOUR_MS); // the worker was down
    await runDue();
    const inst = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    assertEqual(inst.status, 'converted', 'the revisit still counts');
    const thanks = (await sendsFor(a1.id)).filter((s) => s.nodeId === 'thanks');
    assertEqual(thanks.length, 0, 'no thank-you seven hours after the visit');
  });

  await test('a resumed send keeps its ladder position, so the follow-up moves to the next channel', async () => {
    await fresh();
    const t0 = nextTuesday1240();
    await setClock(t0);
    await setLaunch({ [A.tenant]: 'test' });
    await connect({ venue: A, email: 'ladder@test.local', phone: '791117777', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    const a1 = (await instancesAt(A.venueId)).find((i) => i.journeyKey === 'welcome_second_visit')!;
    const before = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    await runDue();
    const after = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    assertEqual(after.counters.ladderPos, 0, 'SMS is position 0');
    // Crash after the send record was written but before the journey moved on: roll the
    // journey back (keeping the rev the send bumped) and run the same timer again.
    const { id: _id, ...rest } = before as any;
    await db.collection(COL.journeyInstances).doc(a1.id).set({ ...rest, rev: after.rev });
    const timer = (await db.collection(COL.journeyTasks).where('kind', '==', 'node_run').get()).docs.find((d) => d.get('payload.nodeId') === 'd1')!;
    await timer.ref.update({ status: 'queued', leaseOwner: null, leaseUntil: null });
    await runDue();
    const resumed = (await db.collection(COL.journeyInstances).doc(a1.id).get()).data()!;
    assertEqual([resumed.cursor.nodeId, resumed.counters.ladderPos], [after.cursor.nodeId, 0], 'resumed from the send record with the ladder position');
    assertEqual((await sendsFor(a1.id)).length, 1, 'still one send');
  });

  await test('restart: 1,000 guests, three workers, a crashed worker → exactly one welcome each', async () => {
    await fresh();
    await setClock(nextTuesday1240());
    await setLaunch({ [A.tenant]: 'test' });
    await setSafety({ maxNewContactsPerApPerHour: 100_000 }); // 1,000 new guests at one AP would trip the sign-up breaker
    const n = Number(process.env.ADAPTIVE_RESTART_N || 1000);
    for (let i = 0; i < n; i += 50) {
      await Promise.all(Array.from({ length: Math.min(50, n - i) }, (_, k) => connect({ venue: A, email: `bulk${i + k}@test.local`, consent: true })));
    }
    const workers = [new AdaptiveWorker(), new AdaptiveWorker(), new AdaptiveWorker()];
    await Promise.all(workers.map((w) => w.runDue()));
    await advance(15 * MINUTE_MS);
    // A worker takes 100 due tasks and dies: its leases run out and go back to the queue.
    const stolen = await claimDue('crashed-worker', now(), 100);
    for (const t of stolen) await db.collection(COL.journeyTasks).doc(t.id).update({ leaseUntil: new Date(Date.now() - 1000) });
    await reclaimExpiredLeases(200);
    await Promise.all(workers.map((w) => w.runDue()));
    await Promise.all(workers.map((w) => w.runDue()));

    const sends = (await db.collection(COL.journeySends).where('nodeId', '==', 's1').get()).docs;
    const perInstance = new Map<string, number>();
    for (const d of sends) perInstance.set(d.get('instanceId'), (perInstance.get(d.get('instanceId')) ?? 0) + 1);
    assertEqual(perInstance.size, n, `every guest got a welcome (${perInstance.size}/${n})`);
    assert([...perInstance.values()].every((c) => c === 1), 'nobody got two');
    const failedInst = (await db.collection(COL.journeyInstances).where('status', '==', 'failed').get()).size;
    assertEqual(failedInst, 0, 'no failed journeys');
    const dead = (await db.collection(COL.journeyTasks).where('status', '==', 'dead').get()).size;
    assertEqual(dead, 0, 'no dead tasks');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
