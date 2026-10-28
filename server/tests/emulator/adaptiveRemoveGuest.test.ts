/**
 * Remove guest, erase step 2 (2026-10-28) on the emulator, through the real router: the account
 * forgets the person before the CMS deletes the guest row.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - The contact and its venue rows are deleted, the account's key comes off their points (with a
 *    removal stamp), their runs end first; the next login is a new guest (visit 1, Welcome again).
 *  - A STOP on their number stays (it is the number's, for every owner); another owner's contact
 *    and link are untouched.
 *  - A login still queued at the removal is cancelled with its details; a late retry is dropped.
 *  - A login being processed answers busy (409) and nothing is removed.
 *  - Their stays are unlinked and their bring-a-friend codes expire.
 *  - A spam complaint about an old message still blocks the address afterwards.
 *  - A run whose venue row is gone still ends (it used to fail and stay active).
 *  - Another owner's guest is a 404; twice is safe.
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
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  withoutReviewAsk,
  type VenueFixture,
} from './helpers';
import { OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { DAY_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { applyEmailRevoke, applyPhoneStop } from '../../src/adaptive/engine/optouts';

const RS: VenueFixture = { tenant: 'tenant_rg', venueId: 'venue_rg', apId: 'ap_rg', apMac: 'aa:ee:ee:ee:ee:01' };
const XX: VenueFixture = { tenant: 'tenant_rg_other', venueId: 'venue_rg_x', apId: 'ap_rg_x', apMac: 'aa:ee:ee:ee:ee:02' };

const forget = (tenant: string, guestId: string) => `/tenants/${tenant}/guests/by-guest/${guestId}/forget`;

async function start(): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(RS);
  await setupVenue(XX);
  await setClock(nextTuesday1240());
  await seedWallet(RS.tenant, 5000);
  await setLaunch({ [RS.tenant]: 'live', [XX.tenant]: 'live' }, { paused: false });
}

/** The queued login tasks (raw guest details in the payload). */
async function queuedLogins() {
  const snap = await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').where('status', '==', 'queued').get();
  return snap.docs.filter((d) => d.get('payload.guest'));
}

async function main() {
  const api = await mountApi();
  try {
    console.log('\nRemove guest: the account forgets the person\n');

    await test('the next login after a removal is a new guest: visit 1, Welcome again', async () => {
      await start();
      const anna = await connect({ venue: RS, firstName: 'Anna', email: 'anna.rg@test.local', phone: '791118001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const old = await contactIdFor(RS.tenant, anna);
      const before = (await db.collection(COL.contacts).doc(old).get()).data()!;
      const pointIds = [before.emailPointId, before.phonePointId].filter(Boolean) as string[];
      assert((await docsWhere(COL.journeyInstances, 'contactId', old)).some((i) => i.status === 'active' && i.journeyKey === 'welcome_second_visit'), 'Welcome running');

      const res = await api.call('POST', forget(RS.tenant, anna), { actor: OWNER_ACTOR });
      assertEqual(res.status, 200, `forget: ${res.text}`);
      assertEqual([res.body.contactId, res.body.forgotten], [old, true], 'forgotten');
      assert(res.body.cancelled >= 1, 'their runs are cancelled first');
      assert(!(await db.collection(COL.contacts).doc(old).get()).exists, 'contact deleted');
      assertEqual((await docsWhere(COL.contactVenues, 'contactId', old)).length, 0, 'venue rows deleted');
      assert((await docsWhere(COL.journeyInstances, 'contactId', old)).every((i) => i.status !== 'active'), 'no run left active (kept as history)');
      for (const id of pointIds) {
        const p = (await db.collection(COL.contactPoints).doc(id).get()).data()!;
        assertEqual(p.tenantContacts?.[RS.tenant], undefined, `point ${id} no longer names the account`);
        assert(p.forgottenAt?.[RS.tenant], 'the removal is stamped on the point');
      }
      assertEqual((await api.get(`/tenants/${RS.tenant}/guests/by-guest/${anna}/journeys`)).body.contactId, null, 'the guest list finds no Adaptive record');
      assertEqual((await api.get(`/tenants/${RS.tenant}/venues/${RS.venueId}/guests/${old}`)).status, 404, 'the drawer has nobody');
      const again = await api.call('POST', forget(RS.tenant, anna), { actor: OWNER_ACTOR });
      assertEqual([again.status, again.body.forgotten], [200, false], 'twice is safe');

      // They come back (the CMS deleted their row, so it's a new one): a brand-new guest.
      await advance(MINUTE_MS);
      const back = await connect({ venue: RS, firstName: 'Anna', email: 'anna.rg@test.local', phone: '791118001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const fresh = await contactIdFor(RS.tenant, back);
      assert(fresh !== old, 'a new contact');
      assertEqual((await docsWhere(COL.contactVenues, 'contactId', fresh))[0]?.visitCount, 1, 'visit 1');
      assert((await docsWhere(COL.journeyInstances, 'contactId', fresh)).some((i) => i.status === 'active' && i.journeyKey === 'welcome_second_visit'), 'Welcome starts again');
    });

    await test("a STOP on their number stays; another owner's contact and link are untouched", async () => {
      await start();
      const ben = await connect({ venue: RS, firstName: 'Ben', email: 'ben.rg@test.local', phone: '791118002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      const benThere = await connect({ venue: XX, firstName: 'Ben', email: 'ben.rg@test.local', phone: '791118002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const contact = await contactIdFor(RS.tenant, ben);
      const theirs = await contactIdFor(XX.tenant, benThere);
      const phonePoint = (await db.collection(COL.contacts).doc(contact).get()).get('phonePointId') as string;
      await applyPhoneStop(phonePoint, 'sms_keyword', now());

      assertEqual((await api.call('POST', forget(RS.tenant, ben), { actor: OWNER_ACTOR })).status, 200, 'forget');
      const p = (await db.collection(COL.contactPoints).doc(phonePoint).get()).data()!;
      assertEqual(p.suppression?.sms?.reason, 'stop', 'the STOP stays on the number');
      assertEqual(p.tenantContacts?.[XX.tenant], theirs, "the other owner's link stays");
      assertEqual(p.forgottenAt?.[XX.tenant], undefined, 'only this owner forgot them');
      assert((await db.collection(COL.contacts).doc(theirs).get()).exists, "the other owner's contact stays");
      assertEqual((await api.call('POST', forget(XX.tenant, ben), { actor: OWNER_ACTOR })).status, 404, "another owner can't remove this guest row");
    });

    await test('a login still queued at the removal is cancelled with its details; a late retry is dropped', async () => {
      await start();
      const cara = await connect({ venue: RS, firstName: 'Cara', email: 'cara.rg@test.local', consent: true });
      await runDue();
      await advance(MINUTE_MS);
      await connect({ venue: RS, firstName: 'Cara', email: 'cara.rg@test.local', consent: true, guestId: cara }); // waits in the queue
      const [waiting] = await queuedLogins();
      assert(waiting, 'a login waiting');
      const copy = waiting.data();
      await advance(MINUTE_MS);

      assertEqual((await api.call('POST', forget(RS.tenant, cara), { actor: OWNER_ACTOR })).status, 200, 'forget');
      const after = (await waiting.ref.get()).data()!;
      assertEqual(after.status, 'cancelled', 'the waiting login is cancelled');
      assertEqual(after.payload?.guest, undefined, 'and its copy of their details is gone');
      await runDue();
      assertEqual((await docsWhere(COL.contacts, 'tenantUserId', RS.tenant)).length, 0, 'nobody came back');

      // A retry of that same login (e.g. it was being processed during the removal): the stamp drops it.
      await waiting.ref.set({ ...copy, status: 'queued' });
      await runDue();
      assertEqual((await docsWhere(COL.contacts, 'tenantUserId', RS.tenant)).length, 0, 'the old login is dropped');
    });

    await test('a login being processed answers busy and removes nothing', async () => {
      await start();
      const dan = await connect({ venue: RS, firstName: 'Dan', email: 'dan.rg@test.local', consent: true });
      await runDue();
      await advance(MINUTE_MS);
      await connect({ venue: RS, firstName: 'Dan', email: 'dan.rg@test.local', consent: true, guestId: dan });
      const [waiting] = await queuedLogins();
      await waiting.ref.update({ status: 'leased', leaseOwner: 'another-worker', leaseUntil: new Date(Date.now() + 60_000) });

      const res = await api.call('POST', forget(RS.tenant, dan), { actor: OWNER_ACTOR });
      assertEqual(res.status, 409, `busy: ${res.text}`);
      assert((await db.collection(COL.contacts).doc(await contactIdFor(RS.tenant, dan)).get()).exists, 'nothing removed');
    });

    await test('their stays are unlinked and their bring-a-friend codes stop working', async () => {
      await start();
      const eva = await connect({ venue: RS, firstName: 'Eva', email: 'eva.rg@test.local', consent: true });
      await runDue();
      const contact = await contactIdFor(RS.tenant, eva);
      const stays = db.collection(COL.stays);
      await stays.doc('stay_rg_1').set({ tenantUserId: RS.tenant, venueId: RS.venueId, feedId: 'feed_rg', status: 'confirmed', contactId: contact, linkSeq: 2, unlinkedContactIds: [], linkedBy: 'guest' });
      await stays.doc('stay_rg_2').set({ tenantUserId: RS.tenant, venueId: RS.venueId, feedId: 'feed_rg', status: 'confirmed', contactId: null, linkSeq: 1, unlinkedContactIds: ['c_other', contact] });
      await db.collection(COL.referralCodes).doc('EVA-AAAA').set({ contactId: contact, tenantUserId: RS.tenant, venueId: RS.venueId, expiresAt: new Date(now() + 30 * DAY_MS) });

      assertEqual((await api.call('POST', forget(RS.tenant, eva), { actor: OWNER_ACTOR })).status, 200, 'forget');
      const linked = (await stays.doc('stay_rg_1').get()).data()!;
      assertEqual([linked.contactId, linked.linkSeq, linked.unlinkedBy], [null, 3, OWNER_ACTOR.uid], 'the linked stay is unlinked (new link generation)');
      assertEqual((await stays.doc('stay_rg_2').get()).get('unlinkedContactIds'), ['c_other'], 'their id leaves the never-again list');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'stay.unlinked')).filter((e) => e.data?.stayId === 'stay_rg_1').length, 1, 'stay.unlinked logged');
      assert((await db.collection(COL.referralCodes).doc('EVA-AAAA').get()).get('expiresAt').toMillis() <= now(), 'the code expired');
    });

    await test('a spam complaint about an old message still blocks the address after the removal', async () => {
      await start();
      const fay = await connect({ venue: RS, firstName: 'Fay', email: 'fay.rg@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const contact = await contactIdFor(RS.tenant, fay);
      const send = (await docsWhere(COL.journeySends, 'contactId', contact))[0];
      assert(send?.toPointId, 'a message went out');

      assertEqual((await api.call('POST', forget(RS.tenant, fay), { actor: OWNER_ACTOR })).status, 200, 'forget');
      await applyEmailRevoke({ contactId: contact, venueId: RS.venueId, source: 'brevo_spam', at: now(), ref: { sendKey: send.id }, pointId: send.toPointId });
      const p = (await db.collection(COL.contactPoints).doc(send.toPointId).get()).data()!;
      assertEqual(p.suppression?.email?.reason, 'spam_complaint', 'blocked for every owner');
    });

    await test('a run whose venue row is gone still ends', async () => {
      await start();
      await withoutReviewAsk(RS);
      const gus = await connect({ venue: RS, firstName: 'Gus', email: 'gus.rg@test.local', consent: true });
      await runDue();
      const contact = await contactIdFor(RS.tenant, gus);
      for (const cv of await docsWhere(COL.contactVenues, 'contactId', contact)) await db.collection(COL.contactVenues).doc(cv.id).delete();
      await runUntil(now() + 40 * DAY_MS);
      const runs = await docsWhere(COL.journeyInstances, 'contactId', contact);
      assert(runs.length >= 1 && runs.every((i) => i.status !== 'active'), `every run ended: ${JSON.stringify(runs.map((i) => [i.journeyKey, i.status]))}`);
      assertEqual((await db.collection(COL.journeyTasks).where('status', '==', 'dead').get()).size, 0, 'no task died');
    });

    await test("another owner's guest is a 404; a bad id is a 400; a removal needs a person", async () => {
      await start();
      const hana = await connect({ venue: RS, email: 'hana.rg@test.local', consent: true });
      await runDue();
      assertEqual((await api.call('POST', forget(XX.tenant, hana), { actor: OWNER_ACTOR })).status, 404, 'foreign');
      assertEqual((await api.call('POST', forget(RS.tenant, 'no.such'), { actor: OWNER_ACTOR })).status, 400, 'bad id');
      assertEqual((await api.call('POST', forget(RS.tenant, 'missingGuest'), { actor: OWNER_ACTOR })).status, 404, 'missing guest');
      assert((await api.call('POST', forget(RS.tenant, hana), {})).status >= 400, 'a removal needs a person');
      assert((await db.collection(COL.contacts).doc(await contactIdFor(RS.tenant, hana)).get()).exists, 'still there');
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
