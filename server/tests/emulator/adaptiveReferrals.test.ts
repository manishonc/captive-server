/**
 * Bring a friend (PR A7) on the emulator, through the real connect hook and worker (test run:
 * nothing sent, nothing charged).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - Anna's 3rd visit → the invite the next morning, with her real code; the code works on the
 *    splash check (with the friend's offer) and nowhere else.
 *  - Ben signs up with it → counted, `referral.joined` → Anna's friend reward (offer + message),
 *    open until it ends. Cleo and Eve the same day → their rewards wait in the queue.
 *  - Anna comes back → her reward is redeemed (thank-you, converted) → Cleo's starts, Eve's still
 *    waits; back again → Eve's starts. One reward per friend.
 *  - Not counted: Anna's own code, a guest who had been here, an unknown code, a 4th friend.
 *  - A retried sign-up keeps what it decided; the splash skips guests already known here; a queued
 *    start that can't begin hands the turn on.
 */

import {
  advance,
  assert,
  assertEqual,
  COL,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
  nextTuesday1240,
  now,
  resetEmulator,
  runUntil,
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { saveSetups } from '../../src/adaptive/service/tenant';
import { attributeReferral, checkFriendCode, knownAtVenue } from '../../src/adaptive/referrals/store';
import { startNextQueued } from '../../src/adaptive/engine/enrol';
import { DAY_MS, HOUR_MS } from '../../src/adaptive/core/runtime/time';

const V: VenueFixture = { tenant: 'tenant_ref', venueId: 'venue_ref', apId: 'ap_ref', apMac: 'aa:aa:aa:aa:7e:01' };
const OWNER = { uid: 'tenant_ref_owner', kind: 'tenant_user' as const, role: 'ADMIN' as const };

async function instancesOf(guestId: string, journeyKey: string): Promise<AnyDoc[]> {
  const contactId = await contactIdFor(V.tenant, guestId);
  return (await docsWhere(COL.journeyInstances, 'contactId', contactId))
    .filter((i) => i.journeyKey === journeyKey)
    .sort((a, b) => a.startedAt.toMillis() - b.startedAt.toMillis());
}

async function sendsOf(instanceId: string): Promise<AnyDoc[]> {
  const s = await docsWhere(COL.journeySends, 'instanceId', instanceId);
  return s.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function codeEntered(guestId: string): Promise<string[]> {
  const contactId = await contactIdFor(V.tenant, guestId);
  return (await docsWhere(COL.journeyEvents, 'contactId', contactId)).filter((e) => e.type === 'referral.code_entered').map((e) => String(e.data.result));
}

async function main() {
  console.log('\nBring a friend (emulator)');

  await test('invite on the 3rd visit; friends who sign up with the code count; rewards one by one', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(V);
    await saveSetups(V.tenant, { playbookKey: 'restaurant_growth', venueIds: [V.venueId], journeys: { bring_a_friend: { enabled: true, slots: {} } } as never }, OWNER);
    await setLaunch({ [V.tenant]: 'test' });
    const t0 = nextTuesday1240();
    await setClock(t0);

    // Anna: three visits, a day apart.
    const anna = await connect({ venue: V, firstName: 'Anna', email: 'anna@ref.test', consent: true });
    await runUntil(now() + HOUR_MS);
    for (let visit = 2; visit <= 3; visit += 1) {
      await setClock(t0 + (visit - 1) * DAY_MS);
      await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@ref.test', consent: true });
      await runUntil(now() + HOUR_MS);
    }
    const invites = await instancesOf(anna, 'bring_a_friend');
    assertEqual(invites.length, 1, 'one invite journey, started by the 3rd visit');
    await runUntil(t0 + 3 * DAY_MS); // the next morning's slot
    const inviteSends = await sendsOf(invites[0].id);
    assertEqual(inviteSends.map((s) => [s.nodeId, s.status, s.channel]), [['s', 'dry_run', 'email']], 'the invite, by email (test run)');
    const codes = await docsWhere(COL.referralCodes, 'instanceId', invites[0].id);
    assertEqual(codes.length, 1, 'one code minted for the invite');
    const code = String(codes[0].id);
    assert(/^ANNA-[A-Z0-9]{4}$/.test(code), `Anna's code: ${code}`);
    const preview = JSON.stringify(inviteSends[0].content);
    assert(preview.includes(code), `the invite names the code: ${preview.slice(0, 300)}`);
    assert(preview.includes('10% off'), 'and what a friend gets (the default 10% off)');

    // The splash check: works here (with the friend's offer), typed any way; not elsewhere.
    const check = await checkFriendCode(V.venueId, code.toLowerCase().replace('-', ' '), now());
    assertEqual([check.ok, check.friendOffer?.kind, check.friendOffer?.value], [true, 'percent', 10], 'works here: 10% off');
    assertEqual((await checkFriendCode('another_venue', code, now())).ok, false, 'not at another venue');

    // Ben signs up with it: counted, Anna's reward starts.
    const ben = await connect({ venue: V, firstName: 'Ben', email: 'ben@ref.test', consent: true, friendCode: code.toLowerCase() });
    await runUntil(now() + 10 * 60_000);
    assertEqual(await codeEntered(ben), ['ok'], "Ben's code counted");
    let rewards = await instancesOf(anna, 'friend_reward');
    assertEqual(rewards.length, 1, 'one reward for Anna');
    assertEqual([rewards[0].status, rewards[0].cursor.nodeId], ['active', 'w_offer'], 'open until the reward ends');
    const rewardSends = await sendsOf(rewards[0].id);
    assertEqual(rewardSends.map((s) => [s.nodeId, s.status]), [['s', 'dry_run']], 'the reward message (test run)');

    // Ben again on a later visit (he had been here): counted once only.
    await advance(9 * HOUR_MS);
    await connect({ venue: V, guestId: ben, firstName: 'Ben', email: 'ben@ref.test', consent: true, friendCode: code });
    await runUntil(now() + 10 * 60_000);
    assertEqual((await codeEntered(ben)).sort(), ['already_counted', 'ok'], 'Ben only counts once');

    // Cleo and Eve sign up with it the same day: both counted, both rewards wait for Anna's open one.
    await advance(2 * HOUR_MS);
    const cleo = await connect({ venue: V, firstName: 'Cleo', email: 'cleo@ref.test', consent: true, friendCode: code });
    await runUntil(now() + 10 * 60_000);
    const eve = await connect({ venue: V, firstName: 'Eve', email: 'eve@ref.test', consent: true, friendCode: code });
    await runUntil(now() + 10 * 60_000);
    assertEqual([await codeEntered(cleo), await codeEntered(eve)], [['ok'], ['ok']], 'Cleo and Eve counted');
    assertEqual((await instancesOf(anna, 'friend_reward')).length, 1, 'still one reward running');
    const annaContact = await contactIdFor(V.tenant, anna);
    const queuedOf = async () => ((await db.collection(COL.contactVenues).doc(`${annaContact}_${V.venueId}`).get()).data()!.journeys.friend_reward.queued ?? []) as string[];
    assertEqual((await queuedOf()).length, 2, 'two rewards queued');

    // Anna comes back (a revisit): her reward is redeemed, then Cleo's starts — Eve's still waits.
    // (Late in the evening: the thank-you waits for the morning — quiet hours — so run past it.)
    await advance(DAY_MS);
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@ref.test', consent: true });
    await runUntil(now() + 12 * HOUR_MS);
    rewards = await instancesOf(anna, 'friend_reward');
    assertEqual(rewards[0].status, 'converted', 'the first reward converted');
    assert((await sendsOf(rewards[0].id)).some((s) => s.nodeId === 'thanks' && s.purpose === 'service'), 'with a thank-you');
    assertEqual(rewards.length, 2, "Cleo's reward started after it");
    assertEqual([rewards[1].status, rewards[1].cursor.nodeId], ['active', 'w_offer'], 'the second reward is open');
    assertEqual((await queuedOf()).length, 1, "Eve's reward is still queued (starting Cleo's kept the queue)");

    // Back again: the second reward is redeemed, then Eve's starts.
    await advance(DAY_MS);
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@ref.test', consent: true });
    await runUntil(now() + 12 * HOUR_MS);
    rewards = await instancesOf(anna, 'friend_reward');
    assertEqual(rewards.map((r) => r.status), ['converted', 'converted', 'active'], 'three rewards, one per friend');
    assertEqual(await queuedOf(), [], 'the queue is empty');

    // Not counted: an unknown code, a 4th friend, and Anna's own code (a full code says "full"
    // first; her own code with room left is covered by tests/adaptiveReferralsCore.test.ts).
    await advance(DAY_MS);
    const dan = await connect({ venue: V, firstName: 'Dan', email: 'dan@ref.test', consent: true, friendCode: 'NOPE-AAAA' });
    await runUntil(now() + HOUR_MS);
    const finn = await connect({ venue: V, firstName: 'Finn', email: 'finn@ref.test', consent: true, friendCode: code });
    await runUntil(now() + HOUR_MS);
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@ref.test', consent: true, friendCode: code });
    await runUntil(now() + HOUR_MS);
    assertEqual(await codeEntered(dan), ['unknown'], 'an unknown code');
    assertEqual(await codeEntered(finn), ['full'], 'Finn is one too many');
    assertEqual(await codeEntered(anna), ['full'], "Anna's own code doesn't count");
    const stored = (await db.collection(COL.referralCodes).doc(code).get()).data()!;
    assertEqual(stored.friendsCredited, 3, 'three friends on the code');
    assertEqual((await checkFriendCode(V.venueId, code, now())).ok, false, 'the splash stops offering it');

    // The daily numbers count the friends (the spec's KPI), apart as a test run.
    const joined = (await docsWhere(COL.journeyEvents, 'type', 'referral.joined')).filter((e) => e.venueId === V.venueId);
    assertEqual(joined.length, 3, 'three referral.joined events');
  });

  await test('a retried sign-up keeps what it decided; the splash skips guests known here', async () => {
    // A code with room, written directly; the same sign-up handled twice (a retried connect task).
    const at = now();
    await db.collection(COL.referralCodes).doc('ZOE-TEST').set({
      code: 'ZOE-TEST', tenantUserId: V.tenant, venueId: V.venueId, contactId: 'c_zoe', instanceId: 'i_zoe', mode: 'test',
      friendOffer: null, createdAt: new Date(at), expiresAt: new Date(at + 30 * DAY_MS), friendsCredited: 2, maxFriends: 3,
      friendContactIds: ['a', 'b'], lastFriendAt: null, expireAt: new Date(at + 400 * DAY_MS),
    });
    const args = { raw: 'zoe-test', tenantUserId: V.tenant, venueId: V.venueId, friendContactId: 'c_friend', friendGuestId: 'g_friend', isFirstVisit: true, visitId: 'vi_retry', at, mode: 'test' as const };
    assertEqual(await attributeReferral(args), 'ok', 'counted the first time');
    assertEqual(await attributeReferral(args), 'ok', 'the retry keeps "ok" (not "already counted")');
    const doc = (await db.collection(COL.referralCodes).doc('ZOE-TEST').get()).data()!;
    assertEqual(doc.friendsCredited, 3, 'counted once');
    const entered = (await docsWhere(COL.journeyEvents, 'contactId', 'c_friend')).filter((e) => e.type === 'referral.code_entered');
    assertEqual(entered.map((e) => e.data.result), ['ok'], 'one record, still "ok"');

    // knownAtVenue: Anna (a guest here, by email) is known; a new email isn't.
    assertEqual(await knownAtVenue({ tenantUserId: V.tenant, venueId: V.venueId, email: 'anna@ref.test', phoneE164: null }), true, 'Anna is known here');
    assertEqual(await knownAtVenue({ tenantUserId: V.tenant, venueId: V.venueId, email: 'new@ref.test', phoneE164: null }), false, 'a new guest is not');
    assertEqual(await knownAtVenue({ tenantUserId: V.tenant, venueId: 'another_venue', email: 'anna@ref.test', phoneE164: null }), false, 'not at another venue');
  });

  await test('a queued start that can no longer begin hands the turn to the next one', async () => {
    const cvId = `c_q_${V.venueId}`;
    await db.collection(COL.contactVenues).doc(cvId).set({
      tenantUserId: V.tenant, venueId: V.venueId, contactId: 'c_q',
      journeys: { friend_reward: { activeInstanceId: null, entries: 1, lastEnteredAt: null, lastExitAt: null, lastExitReason: null, queued: ['ev_a', 'ev_b'] } },
    });
    await startNextQueued({ contactId: 'c_q', venueId: V.venueId, journeyKey: 'friend_reward', tenantUserId: V.tenant, now: now() });
    const cv = (await db.collection(COL.contactVenues).doc(cvId).get()).data()!;
    assertEqual(cv.journeys.friend_reward.queued, ['ev_b'], 'the first one is taken off the queue');
    const tasks = (await docsWhere(COL.journeyTasks, 'kind', 'event_route')).filter((t) => t.payload?.eventId === 'ev_a');
    assertEqual(tasks.map((t) => t.payload.requeue?.journeyKey), ['friend_reward'], 'and routed again for this journey');
    // With a run open, nothing is taken.
    await db.collection(COL.contactVenues).doc(cvId).update({ 'journeys.friend_reward.activeInstanceId': 'i_open' });
    await startNextQueued({ contactId: 'c_q', venueId: V.venueId, journeyKey: 'friend_reward', tenantUserId: V.tenant, now: now() });
    assertEqual((await db.collection(COL.contactVenues).doc(cvId).get()).data()!.journeys.friend_reward.queued, ['ev_b'], 'kept while a run is open');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
