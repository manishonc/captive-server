/**
 * "Cancel journeys" for one CMS guest (2026-10-27) on the emulator, through the real router.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - GET lists the guest's running journeys by name; POST cancel ends each as `cancelled` /
 *    `guest_cancelled` with a `journey.exited` event, cancels its queued timer task, frees the
 *    venue slot — and nothing more reaches the outbox for that guest while another guest's
 *    journeys go on.
 *  - Cancel after the first message (the journey parked on a wait) works the same.
 *  - The guest is held: the visit end of the same visit (and any scan) starts nothing, until the
 *    guest's next Wi-Fi login lifts it; a login queued from before the cancel doesn't.
 *  - Twice is safe: the second call cancels nothing. Nothing about the person is deleted.
 *  - Another owner's guest is a 404; a guest Adaptive never saw has nothing running.
 *  - The owner's timeline says the owner cancelled it.
 */

import {
  COL,
  advance,
  assert,
  assertEqual,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
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
import { OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { DAY_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { taskIdFor } from '../../src/adaptive/core/runtime/ids';

const RS: VenueFixture = { tenant: 'tenant_cg', venueId: 'venue_cg', apId: 'ap_cg', apMac: 'aa:dd:dd:dd:dd:01' };
const XX: VenueFixture = { tenant: 'tenant_cg_other', venueId: 'venue_cg_x', apId: 'ap_cg_x', apMac: 'aa:dd:dd:dd:dd:02' };

const path = (tenant: string, guestId: string) => `/tenants/${tenant}/guests/by-guest/${guestId}/journeys`;

async function start(): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(RS);
  await setupVenue(XX);
  await setClock(nextTuesday1240());
  await seedWallet(RS.tenant, 5000);
  await setLaunch({ [RS.tenant]: 'live' }, { paused: false });
}

const sentTo = async (to: string) => (await outbox()).filter((o) => o.to === to).length;

async function main() {
  const api = await mountApi();
  try {
    console.log('\nCancel journeys for one guest\n');

    await test('cancel before the first message: every journey ends, no message goes, another guest goes on', async () => {
      await start();
      const anna = await connect({ venue: RS, firstName: 'Anna', email: 'anna.cg@test.local', phone: '791117001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      const ben = await connect({ venue: RS, firstName: 'Ben', email: 'ben.cg@test.local', phone: '791117002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const annaContact = await contactIdFor(RS.tenant, anna);

      const before = await api.get(path(RS.tenant, anna));
      assertEqual(before.status, 200, `GET: ${before.text}`);
      assertEqual(before.body.contactId, annaContact, 'the guest matched to their contact');
      assert(before.body.running.length >= 1, `running journeys: ${before.text}`);
      assert(before.body.running.every((j: any) => j.name && j.name !== j.journeyKey && j.venueId === RS.venueId), `named: ${before.text}`);
      assert(!('instanceId' in before.body.running[0]), 'instance ids stay inside');

      const res = await api.call('POST', `${path(RS.tenant, anna)}/cancel`, { actor: OWNER_ACTOR });
      assertEqual(res.status, 200, `cancel: ${res.text}`);
      assertEqual(res.body.cancelled, before.body.running.length, 'all of them cancelled');
      assertEqual(res.body.journeys.map((j: any) => j.journeyKey).sort(), before.body.running.map((j: any) => j.journeyKey).sort(), 'the same journeys');
      assertEqual(res.body.running, [], 'nothing left running');

      const insts = await docsWhere(COL.journeyInstances, 'contactId', annaContact);
      for (const i of insts) {
        assertEqual(i.status, 'cancelled', `instance ${i.journeyKey} status`);
        assertEqual(i.exitReason, 'guest_cancelled', 'reason');
        assertEqual(i.waiting, null, 'no wait left');
        assert(i.endedAt && i.expireAt, 'ended and given a retention date');
        const startTask = await db.collection(COL.journeyTasks).doc(taskIdFor(`node:${i.id}:start`)).get();
        assert(!startTask.exists || startTask.get('status') !== 'queued', `start task not left queued (${startTask.get('status')})`);
      }
      const exits = (await docsWhere(COL.journeyEvents, 'contactId', annaContact)).filter((e) => e.type === 'journey.exited');
      assertEqual(exits.length, insts.length, 'one journey.exited per journey');
      assert(exits.every((e) => e.data?.reason === 'guest_cancelled' && e.data?.by === OWNER_ACTOR.uid), 'reason + who');
      const cv = (await db.collection(COL.contactVenues).where('contactId', '==', annaContact).get()).docs[0].data();
      for (const j of Object.values<any>(cv.journeys ?? {})) assertEqual(j.activeInstanceId ?? null, null, 'venue slot freed');

      await runUntil(now() + 10 * DAY_MS);
      assertEqual(await sentTo('anna.cg@test.local') + (await sentTo('+41791117001')), 0, 'nothing sent to the cancelled guest');
      assert((await sentTo('ben.cg@test.local')) + (await sentTo('+41791117002')) >= 1, 'the other guest still got messages');
      assert(ben, 'ben');

      // Nothing about the person is deleted.
      assert((await db.collection(COL.contacts).doc(annaContact).get()).exists, 'contact kept');

      const held = await api.get(path(RS.tenant, anna));
      assert(held.body.cancelledAt, 'GET shows the hold');
      const startedAfter = (await docsWhere(COL.journeyInstances, 'contactId', annaContact)).filter((i) => i.status !== 'cancelled');
      assertEqual(startedAfter.map((i) => i.journeyKey), [], 'no journey started after the cancel (visit end held)');

      const again = await api.call('POST', `${path(RS.tenant, anna)}/cancel`, { actor: OWNER_ACTOR });
      assertEqual(again.status, 200, 'second call ok');
      assertEqual(again.body.cancelled, 0, 'second call cancels nothing');
      assertEqual((await api.get(path(RS.tenant, anna))).body.running, [], 'GET agrees');

      const guest = await api.get(`/tenants/${RS.tenant}/venues/${RS.venueId}/guests/${annaContact}`);
      assert(JSON.stringify(guest.body.timeline).includes('you cancelled this guest'), `timeline sentence: ${JSON.stringify(guest.body.timeline).slice(0, 400)}`);
    });

    await test('the next Wi-Fi login lifts the hold and journeys start again', async () => {
      await start();
      const dan = await connect({ venue: RS, firstName: 'Dan', email: 'dan.cg@test.local', consent: true });
      await runDue();
      const contactId = await contactIdFor(RS.tenant, dan);
      // A login still queued when the owner cancels doesn't lift the hold.
      await advance(MINUTE_MS);
      await connect({ venue: RS, firstName: 'Dan', email: 'dan.cg@test.local', consent: true, guestId: dan });
      await advance(MINUTE_MS);
      assertEqual((await api.call('POST', `${path(RS.tenant, dan)}/cancel`, { actor: OWNER_ACTOR })).status, 200, 'cancel');
      await runDue();
      assert((await db.collection(COL.contacts).doc(contactId).get()).get('journeysCancelled.at'), 'a login from before the cancel keeps the hold');
      await runUntil(now() + 3 * DAY_MS);
      assertEqual((await docsWhere(COL.journeyInstances, 'contactId', contactId)).filter((i) => i.status !== 'cancelled').length, 0, 'held');
      await connect({ venue: RS, firstName: 'Dan', email: 'dan.cg@test.local', consent: true, guestId: dan });
      await runDue();
      const contact = (await db.collection(COL.contacts).doc(contactId).get()).data()!;
      assertEqual(contact.journeysCancelled ?? null, null, 'the login lifted the hold');
      assertEqual((await api.get(path(RS.tenant, dan))).body.cancelledAt, null, 'GET agrees');
      await runUntil(now() + 1 * DAY_MS);
      const after = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).filter((i) => i.status !== 'cancelled');
      assert(after.length >= 1, `journeys start again after the login: ${JSON.stringify(after.map((i) => i.journeyKey))}`);
    });

    await test('cancel after the first message: the parked journey ends and its timer task is cancelled', async () => {
      await start();
      const cara = await connect({ venue: RS, firstName: 'Cara', email: 'cara.cg@test.local', phone: '791117003', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const sentBefore = (await sentTo('cara.cg@test.local')) + (await sentTo('+41791117003'));
      assert(sentBefore >= 1, 'the first message went');
      const contactId = await contactIdFor(RS.tenant, cara);
      const parked = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).filter((i) => i.status === 'active' && i.waiting?.token);
      assert(parked.length >= 1, 'a journey waiting on its next step');

      const res = await api.call('POST', `${path(RS.tenant, cara)}/cancel`, { actor: OWNER_ACTOR });
      assertEqual(res.status, 200, res.text);
      for (const p of parked) {
        const t = await db.collection(COL.journeyTasks).doc(taskIdFor(`node:${p.id}:${p.waiting.token}`)).get();
        if (t.exists) assertEqual(t.get('status'), 'cancelled', 'its timer task cancelled');
      }
      await runUntil(now() + 30 * DAY_MS);
      assertEqual((await sentTo('cara.cg@test.local')) + (await sentTo('+41791117003')), sentBefore, 'no message after the cancel');
    });

    await test("another owner's guest is a 404; a guest Adaptive never saw has nothing running; a bad id is a 400", async () => {
      await start();
      const anna = await connect({ venue: RS, email: 'anna2.cg@test.local', consent: true });
      await runDue();
      const foreign = await api.get(path(XX.tenant, anna));
      assertEqual(foreign.status, 404, `foreign: ${foreign.text}`);
      const foreignCancel = await api.call('POST', `${path(XX.tenant, anna)}/cancel`, { actor: OWNER_ACTOR });
      assertEqual(foreignCancel.status, 404, 'foreign cancel');
      assert((await api.get(path(RS.tenant, anna))).body.running.length >= 1, 'still running after the foreign attempt');

      const unseen = db.collection(COL.guests).doc();
      await unseen.set({ firstName: 'Nobody', email: '', phone: '', captivePortalAccessPointId: RS.apId });
      const none = await api.get(path(RS.tenant, unseen.id));
      assertEqual(none.status, 200, none.text);
      assertEqual(none.body.contactId, null, 'no contact');
      assertEqual(none.body.running, [], 'nothing running');
      assertEqual((await api.call('POST', `${path(RS.tenant, unseen.id)}/cancel`, { actor: OWNER_ACTOR })).body.cancelled, 0, 'cancel is a no-op');

      assertEqual((await api.get(path(RS.tenant, 'no.such'))).status, 400, 'bad id');
      assertEqual((await api.get(path(RS.tenant, 'missingGuest'))).status, 404, 'missing guest');
      const noActor = await api.call('POST', `${path(RS.tenant, anna)}/cancel`, {});
      assert(noActor.status >= 400, 'a cancel needs a person');
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
