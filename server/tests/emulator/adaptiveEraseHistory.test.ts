/**
 * Erase step 3 (2026-10-30) on the emulator: Remove guest also deletes the person's Adaptive history.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - The forget queues the erase with the contact's delete, 20 minutes on. The erase deletes their
 *    messages, journeys, visits, events and rating alert, clears their message links' ids, and keeps
 *    the consent ledger; the numbers and the credit ledger don't move; another guest is untouched.
 *  - Through the worker: it waits while the numbers haven't counted their newest events, then finishes.
 *  - A contact that exists is never erased; a running journey fails the erase and erases nothing.
 *  - Their bring-a-friend codes go and their id leaves other guests' codes; a big history continues
 *    over several runs.
 *  - The admin's sweep finds a guest removed before step 3 and queues the erase, skips one whose
 *    erase is on its way, and runs one at a time.
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
  ledger,
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
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { ERASE_DELAY_MS, eraseHistory } from '../../src/adaptive/erase/history';

const RS: VenueFixture = { tenant: 'tenant_eh', venueId: 'venue_eh', apId: 'ap_eh', apMac: 'aa:ee:ee:ee:ef:01' };
const XX: VenueFixture = { tenant: 'tenant_eh_other', venueId: 'venue_eh_x', apId: 'ap_eh_x', apMac: 'aa:ee:ee:ee:ef:02' };

const forget = (tenant: string, guestId: string) => `/tenants/${tenant}/guests/by-guest/${guestId}/forget`;
/** The erase run as the tests do: the numbers may count everything up to now. */
const eraseNow = (contactId: string, opts: { pageSize?: number; maxBatches?: number } = {}) => eraseHistory(RS.tenant, contactId, { cutoffMs: Date.now() + 1000, ...opts });
const eraseTask = (contactId: string) => db.collection(COL.journeyTasks).doc(taskIdFor(`erase_history:${contactId}`));

async function start(): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(RS);
  await setupVenue(XX);
  const t0 = nextTuesday1240();
  await setClock(t0);
  await seedWallet(RS.tenant, 5000);
  await setLaunch({ [RS.tenant]: 'live', [XX.tenant]: 'live' }, { paused: false });
  return t0;
}

/** Everything of one contact in the history collections, by collection. */
async function historyOf(contactId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of [COL.journeyEvents, COL.journeySends, COL.journeyInstances, COL.visits, COL.consentEvents]) out[c] = (await docsWhere(c, 'contactId', contactId)).length;
  return out;
}

/** A venue's numbers (every JourneyStats doc), as JSON, to compare before and after. */
async function numbers(venueId: string): Promise<string> {
  const docs = await docsWhere(COL.journeyStats, 'venueId', venueId);
  return JSON.stringify(docs.sort((a, b) => a.id.localeCompare(b.id)));
}

async function main() {
  const api = await mountApi();
  try {
    console.log('\nErase step 3: Remove guest also deletes their history\n');

    await test('the erase deletes their history and alert, clears their links, keeps consent; numbers, credits and another guest stay', async () => {
      const t0 = await start();
      const anna = await connect({ venue: RS, firstName: 'Anna', email: 'anna.eh@test.local', phone: '791119001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      const ben = await connect({ venue: RS, firstName: 'Ben', email: 'ben.eh@test.local', consent: true });
      await runUntil(t0 + 7 * HOUR_MS); // the welcome, then the review ask ~6 h after the visit
      const contact = await contactIdFor(RS.tenant, anna);
      const benContact = await contactIdFor(RS.tenant, ben);
      const sends = await docsWhere(COL.journeySends, 'contactId', contact);
      const ask = sends.find((s) => s.journeyKey === 'review_ask' && s.status === 'sent');
      assert(ask, `the review ask went out: ${JSON.stringify(sends.map((s) => [s.journeyKey, s.status]))}`);
      await devProviderEvent({ sendKey: ask.id, event: 'rating', stars: 2, text: 'cold food' });
      await runDue();
      await new Promise((r) => setTimeout(r, 200)); // alerts are fire-and-forget
      assertEqual((await docsWhere(COL.alerts, 'kind', 'low_rating')).length, 1, 'the owner got the low-rating alert');
      const codes: string[] = sends.flatMap((s) => s.shortCodes ?? []);
      assert(codes.length > 0, 'their messages have links');

      const res = await api.call('POST', forget(RS.tenant, anna), { actor: OWNER_ACTOR });
      assertEqual(res.status, 200, `forget: ${res.text}`);
      const task = (await eraseTask(contact).get()).data();
      assert(task, 'the forget queued the erase');
      assertEqual([task.kind, task.status, task.payload.contactId, task.tenantUserId], ['erase_history', 'queued', contact, RS.tenant], 'the erase task');
      assert(Math.abs(task.dueAt.toMillis() - (now() + ERASE_DELAY_MS)) < MINUTE_MS, 'due 20 minutes on');
      const before = await historyOf(contact);
      assert(before[COL.journeyEvents] > 0 && before[COL.journeySends] >= 2 && before[COL.journeyInstances] > 0 && before[COL.visits] > 0, `history kept until the erase: ${JSON.stringify(before)}`);

      await rollupVenue(RS.venueId, { cutoffMs: Date.now() + 1000 }); // everything counted, the forget's own events too
      const counted = await numbers(RS.venueId);
      const credits = (await ledger(RS.tenant)).length;
      const benBefore = await historyOf(benContact);

      const r = await eraseNow(contact);
      assertEqual(r.outcome, 'done', `erased: ${JSON.stringify(r)}`);
      assertEqual([r.counts.alerts, r.counts.links >= codes.length], [1, true], `the alert and the links: ${JSON.stringify(r.counts)}`);
      const after = await historyOf(contact);
      assertEqual(
        [after[COL.journeyEvents], after[COL.journeySends], after[COL.journeyInstances], after[COL.visits]],
        [0, 0, 0, 0],
        `nothing of theirs left: ${JSON.stringify(after)}`,
      );
      assertEqual(after[COL.consentEvents], before[COL.consentEvents], 'the consent ledger stays');
      assert(after[COL.consentEvents] > 0, 'they had consent entries');
      assertEqual((await docsWhere(COL.alerts, 'kind', 'low_rating')).length, 0, 'the alert with their feedback is gone');
      for (const code of codes) {
        const link = (await db.collection('CaptivePortal_ShortLinks').doc(code).get()).data();
        assert(link, `link ${code} still redirects`);
        assertEqual([link.contactId, link.wifiGuestId, link.instanceId, link.lastClickIpHash ?? null], [null, null, null, null], `link ${code} lost their ids`);
      }
      assertEqual(await numbers(RS.venueId), counted, 'the numbers did not move');
      assertEqual((await ledger(RS.tenant)).length, credits, 'the credit ledger did not move');
      assertEqual(JSON.stringify(await historyOf(benContact)), JSON.stringify(benBefore), 'another guest is untouched');

      const again = await eraseNow(contact);
      assertEqual([again.outcome, Object.values(again.counts).every((n) => n === 0)], ['done', true], 'twice is safe');
    });

    await test('through the worker: due 20 minutes on, it waits for the numbers, then finishes', async () => {
      await start();
      const cara = await connect({ venue: RS, firstName: 'Cara', email: 'cara.eh@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue(); // the welcome goes
      const contact = await contactIdFor(RS.tenant, cara);
      assertEqual((await api.call('POST', forget(RS.tenant, cara), { actor: OWNER_ACTOR })).status, 200, 'forget');

      await advance(10 * MINUTE_MS);
      await runDue();
      assertEqual((await eraseTask(contact).get()).get('status'), 'queued', 'not yet: it is due 20 minutes after the removal');

      await advance(11 * MINUTE_MS);
      await runDue(); // its newest events are seconds old: the numbers haven't counted them
      const waiting = (await eraseTask(contact).get()).data()!;
      assertEqual(waiting.status, 'queued', 'back in the queue');
      assert(waiting.dueAt.toMillis() > now(), 'tries again a little later');
      assert((await historyOf(contact))[COL.journeySends] > 0, 'nothing erased while waiting');

      assertEqual((await eraseNow(contact)).outcome, 'done', 'counted now: erased');
      await advance(4 * MINUTE_MS);
      await runDue();
      assertEqual((await eraseTask(contact).get()).get('status'), 'done', 'its next run finds nothing left');
      assertEqual((await db.collection(COL.journeyTasks).where('status', '==', 'dead').get()).size, 0, 'no task died');
    });

    await test('a contact that exists is never erased; a running journey fails the erase and erases nothing', async () => {
      await start();
      const dan = await connect({ venue: RS, firstName: 'Dan', email: 'dan.eh@test.local', consent: true });
      await runDue();
      const contact = await contactIdFor(RS.tenant, dan);
      const before = await historyOf(contact);
      assertEqual((await eraseNow(contact)).outcome, 'kept', 'kept');
      assertEqual(JSON.stringify(await historyOf(contact)), JSON.stringify(before), 'nothing erased');

      // Never expected (the forget cancels first): the contact gone, a journey still running.
      await db.collection(COL.contacts).doc(contact).delete();
      let failed = '';
      await eraseNow(contact).catch((err: Error) => (failed = err.message));
      assert(failed.includes('still running'), `the erase fails: ${failed}`);
      assertEqual(JSON.stringify(await historyOf(contact)), JSON.stringify(before), 'and erases nothing');
    });

    await test('their bring-a-friend codes go and their id leaves other codes; a big history continues over several runs', async () => {
      const t0 = await start();
      const eva = await connect({ venue: RS, firstName: 'Eva', email: 'eva.eh@test.local', phone: '791119002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runUntil(t0 + 7 * HOUR_MS);
      const contact = await contactIdFor(RS.tenant, eva);
      const codes = db.collection(COL.referralCodes);
      await codes.doc('EVA-EHEH').set({ contactId: contact, tenantUserId: RS.tenant, venueId: RS.venueId, expiresAt: new Date(now() + 30 * DAY_MS), friendContactIds: [] });
      await codes.doc('ZOE-EHEH').set({ contactId: 'c_zoe', tenantUserId: RS.tenant, venueId: RS.venueId, expiresAt: new Date(now() + 30 * DAY_MS), friendContactIds: ['c_other', contact] });
      assertEqual((await api.call('POST', forget(RS.tenant, eva), { actor: OWNER_ACTOR })).status, 200, 'forget');

      const runs: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const r = await eraseNow(contact, { pageSize: 2, maxBatches: 2 });
        runs.push(r.outcome);
        if (r.outcome === 'done') break;
      }
      assert(runs.length > 2 && runs.slice(0, -1).every((o) => o === 'more') && runs[runs.length - 1] === 'done', `several runs: ${runs.join(',')}`);
      const left = await historyOf(contact);
      assertEqual([left[COL.journeyEvents], left[COL.journeySends], left[COL.journeyInstances], left[COL.visits]], [0, 0, 0, 0], `all gone: ${JSON.stringify(left)}`);
      assert(!(await codes.doc('EVA-EHEH').get()).exists, 'their code is gone');
      assertEqual((await codes.doc('ZOE-EHEH').get()).get('friendContactIds'), ['c_other'], 'their id left the friend list');
    });

    await test('the sweep queues the erase of a guest removed before step 3, skips one on its way, runs one at a time', async () => {
      await start();
      const fay = await connect({ venue: RS, firstName: 'Fay', email: 'fay.eh@test.local', consent: true });
      const gus = await connect({ venue: RS, firstName: 'Gus', email: 'gus.eh@test.local', consent: true });
      const hal = await connect({ venue: RS, firstName: 'Hal', email: 'hal.eh@test.local', consent: true });
      await runDue();
      const fayC = await contactIdFor(RS.tenant, fay);
      const gusC = await contactIdFor(RS.tenant, gus);
      const halC = await contactIdFor(RS.tenant, hal);
      assertEqual((await api.call('POST', forget(RS.tenant, fay), { actor: OWNER_ACTOR })).status, 200, 'Fay removed now (her erase is on its way)');
      // Gus was removed before step 3: forgotten the same way, but no erase was queued then.
      assertEqual((await api.call('POST', forget(RS.tenant, gus), { actor: OWNER_ACTOR })).status, 200, 'Gus removed');
      await eraseTask(gusC).delete();

      assert((await api.call('POST', '/admin/erase-sweep', { actor: OWNER_ACTOR })).status >= 400, 'an owner may not start it');
      const started = await api.call('POST', '/admin/erase-sweep', { actor: ADMIN_ACTOR });
      assertEqual([started.status, started.body?.eraseSweep?.state], [200, 'queued'], `started: ${started.text}`);
      assertEqual((await api.call('POST', '/admin/erase-sweep', { actor: ADMIN_ACTOR })).status, 409, 'one at a time');

      await runDue(); // the sweep, then Gus's erase (which waits: his newest events are seconds old)
      const sweep = (await api.get('/admin/engine')).body.eraseSweep;
      assertEqual(
        [sweep.state, sweep.found, sweep.queued, sweep.alreadyQueued, sweep.contacts],
        ['done', 2, 1, 1, 3],
        `the sweep: ${JSON.stringify(sweep)}`,
      );
      assertEqual(sweep.pending, 2, "Fay's and Gus's erases are on their way");
      const gusTasks = (await db.collection(COL.journeyTasks).where('kind', '==', 'erase_history').get()).docs.filter((d) => d.get('payload.contactId') === gusC);
      assertEqual(gusTasks.length, 1, 'one erase queued for Gus');

      assertEqual((await eraseNow(gusC)).outcome, 'done', "Gus's history erased");
      assertEqual((await historyOf(gusC))[COL.journeySends] + (await historyOf(gusC))[COL.journeyEvents], 0, 'nothing of Gus left');
      assert((await historyOf(fayC))[COL.journeyEvents] > 0, "Fay's erase keeps its own time");
      assert((await historyOf(halC))[COL.journeyEvents] > 0, 'Hal, still a guest, is untouched');
      const next = await api.call('POST', '/admin/erase-sweep', { actor: ADMIN_ACTOR });
      assertEqual(next.status, 200, 'another sweep can start once the first is done');
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
