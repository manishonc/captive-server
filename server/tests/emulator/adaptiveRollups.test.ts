/**
 * PR B2 — the daily numbers (CaptivePortal_JourneyStats) on the emulator.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - A test run: every number sits under `dryRun`; nothing in sends or credits.
 *  - Live: sends, delivered, clicks per channel / slot / variant; credits equal the ledger.
 *  - The counts equal the events, and re-running a rollup changes nothing.
 *  - A page boundary inside one commit (same recordedAt), an event recorded days after
 *    it happened counted on its own day, a reason with dots, three rollups at once.
 *  - The worker arms the venue's rollup after a task and its rollup_venue task counts
 *    the venue's events; the index probes run.
 */

import {
  COL,
  advance,
  assert,
  assertEqual,
  connect,
  db,
  done,
  ledger,
  nextTuesday1240,
  now,
  resetEmulator,
  runDue,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  TZ,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { ensureRollup, rollupVenue, rollupStateId, ROLLUP_BUCKET_MS } from '../../src/adaptive/rollups/rollup';
import { ensureSentEvent } from '../../src/adaptive/send/dispatch';
import { firestoreScheduler } from '../../src/adaptive/queue/firestoreQueue';
import { dayId, VENUE_KEY } from '../../src/adaptive/rollups/journeyStats';
import { eventDoc, eventRef } from '../../src/adaptive/engine/events';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { eventIdFor, taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { checkIndexes } from '../../src/adaptive/worker/indexCheck';
import { DAY_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const A: VenueFixture = { tenant: 'tenant_r', venueId: 'venue_r', apId: 'ap_r', apMac: 'aa:aa:aa:aa:aa:31' };
const A1 = 'welcome_second_visit';

async function fresh(mode: 'test' | 'live'): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(A);
  const t0 = nextTuesday1240();
  await setClock(t0);
  if (mode === 'live') await seedWallet(A.tenant, 5000);
  await setLaunch({ [A.tenant]: mode }, { paused: false });
  return t0;
}

/** Rolls up everything written so far (the lag is for production; the tests don't wait). */
async function rollupNow(venueId = A.venueId, opts: { pageSize?: number } = {}) {
  return rollupVenue(venueId, { cutoffMs: Date.now() + 1000, ...opts });
}

async function stats(venueId: string, journeyKey: string, day: string): Promise<AnyDoc> {
  const snap = await db.collection(COL.journeyStats).doc(`${venueId}_${journeyKey}_${day}`).get();
  return { ...((snap.data() ?? {}) as Record<string, any>), id: snap.id };
}

async function eventsOf(venueId: string): Promise<AnyDoc[]> {
  const snap = await db.collection(COL.journeyEvents).where('venueId', '==', venueId).get();
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, any>), id: d.id }));
}

const count = (events: AnyDoc[], type: string, pred: (e: AnyDoc) => boolean = () => true) => events.filter((e) => e.type === type && pred(e)).length;
const sum = (o: Record<string, any> | undefined, leaf: string) => Object.values(o ?? {}).reduce((n: number, c: any) => n + Number(c?.[leaf] ?? 0), 0);

/** Writes synthetic events in ONE commit, so they share one recordedAt. */
async function writeEvents(list: Array<Record<string, any>>): Promise<void> {
  const batch = db.batch();
  for (const e of list) batch.create(eventRef(), eventDoc({ occurredAt: Date.now(), tenantUserId: A.tenant, venueId: 'venue_syn', ...e } as any));
  await batch.commit();
}

async function main() {
  console.log('\nJourneyStats rollups (PR B2) on the emulator\n');

  await test('test run: the numbers equal the events, all under dryRun (no sends, no credits); re-running changes nothing', async () => {
    const t0 = await fresh('test');
    for (const [i, phone] of ['791110201', '791110202', '791110203'].entries()) {
      await connect({ venue: A, email: `dry${i}@test.local`, phone, phoneCountryCode: '+41', phoneVerified: true, consent: true });
    }
    await connect({ venue: A, email: 'noconsent@test.local', consent: false });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();

    const r = await rollupNow();
    assert(r.events > 0 && !r.more, `rolled up ${r.events} events`);
    const events = await eventsOf(A.venueId);
    const day = dayId(t0, TZ);
    const venue = await stats(A.venueId, VENUE_KEY, day);
    const a1 = await stats(A.venueId, A1, day);

    assertEqual(venue.dryRun?.entered, count(events, 'journey.entered'), 'dryRun.entered = journey.entered events');
    assertEqual(a1.dryRun?.entered, count(events, 'journey.entered', (e) => e.journeyKey === A1), 'A1 entries');
    assertEqual(sum(venue.dryRun?.sends, 'sent'), count(events, 'send.dry_run'), 'dry-run sends = send.dry_run events');
    assert(count(events, 'send.dry_run') >= 3, 'three welcome dry runs');
    assert((venue.dryRun?.credits?.sms ?? 0) > 0, `would-be credits recorded under dryRun: ${JSON.stringify(venue.dryRun?.credits)}`);
    assertEqual([venue.sends, venue.credits, venue.entered, a1.sends, a1.credits], [undefined, undefined, undefined, undefined, undefined], 'nothing live');
    assertEqual(venue.visits?.total, count(events, 'visit.started'), 'visits');
    assertEqual(venue.visits?.captures, count(events, 'wifi.connected'), 'captures (Wi-Fi sign-ins)');
    assertEqual(venue.visits?.first, 4, 'four first visits');
    assert(a1.visits === undefined, 'visits only on _venue');
    assertEqual([venue.tenantUserId, venue.venueId, venue.journeyKey, venue.date], [A.tenant, A.venueId, VENUE_KEY, `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`], 'identity fields');
    assert(venue.rollupWatermark?.eventId, 'watermark on the doc');

    const before = JSON.stringify([await stats(A.venueId, VENUE_KEY, day), await stats(A.venueId, A1, day)]);
    const again = await rollupNow();
    assertEqual(again.events, 0, 'nothing new');
    assertEqual(JSON.stringify([await stats(A.venueId, VENUE_KEY, day), await stats(A.venueId, A1, day)]), before, 'unchanged');
    const state = (await db.collection(COL.journeyStats).doc(rollupStateId(A.venueId)).get()).data()!;
    assertEqual(state.eventsCounted, events.length, 'every event counted once');
  });

  await test('live: sends, delivered and clicks per channel, slot and variant; credits equal the ledger', async () => {
    const t0 = await fresh('live');
    for (const [i, phone] of ['791110301', '791110302'].entries()) {
      await connect({ venue: A, email: `live${i}@test.local`, phone, phoneCountryCode: '+41', phoneVerified: true, consent: true });
    }
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const sends: AnyDoc[] = (await db.collection(COL.journeySends).where('venueId', '==', A.venueId).get()).docs.map((d) => ({ ...(d.data() as Record<string, any>), id: d.id }));
    const live = sends.filter((s) => s.status === 'sent');
    assertEqual(live.length, 2, 'two welcomes sent');
    await devProviderEvent({ sendKey: live[0].id, event: 'delivered' });
    await devProviderEvent({ sendKey: live[0].id, event: 'click' });
    await devProviderEvent({ sendKey: live[0].id, event: 'click' }); // a second click on the same message: one "clicked"
    await runDue();
    // The second send's recording transaction "failed": no message.sent. Its send_sweep repair task,
    // run by the worker, writes it once (credits then still equal the ledger).
    const sentRef = eventRef(eventIdFor('engine', `${live[1].id}:message.sent`));
    await sentRef.delete();
    await firestoreScheduler.schedule({ dedupeKey: `test-repair:${live[1].id}`, kind: 'send_sweep', dueAt: now(), payload: { action: 'charge', sendKey: live[1].id } });
    await runDue();
    assertEqual((await sentRef.get()).get('data.repaired'), true, 'repaired by the worker task');
    assertEqual(await ensureSentEvent(live[1].id), 'nothing', 'only once');

    await rollupNow();
    const day = dayId(t0, TZ);
    const venue = await stats(A.venueId, VENUE_KEY, day);
    const a1 = await stats(A.venueId, A1, day);
    for (const doc of [venue, a1]) {
      assertEqual([doc.sends?.sms?.sent, doc.sends?.sms?.delivered, doc.sends?.sms?.clicked], [2, 1, 1], `${doc.journeyKey}: sms sent / delivered / clicked`);
      assertEqual(doc.bySlot?.now?.sent, 2, 'slot');
      assertEqual(sum(doc.byVariant, 'sent'), 2, 'variants');
      assertEqual(sum(doc.byVariant, 'clicked'), 1, 'clicks per variant');
    }
    const debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    assertEqual(venue.credits?.sms, debits.reduce((n, l) => n - Number(l.credits), 0), 'credits = the ledger');
    assert(!venue.dryRun?.sends, 'no dry runs');
    assertEqual(venue.entered, 2, 'two live entries');
  });

  await test('a page boundary inside one commit, an event recorded late on its own day, a reason with dots, three rollups at once', async () => {
    await resetEmulator();
    const t0 = nextTuesday1240();
    const day = dayId(t0, TZ);
    // Seven events committed together share one recordedAt; pages of three must not skip or repeat any.
    await writeEvents(Array.from({ length: 7 }, () => ({ type: 'journey.entered', journeyKey: 'j', mode: 'live', occurredAt: t0 })));
    await rollupVenue('venue_syn', { cutoffMs: Date.now() + 1000, pageSize: 3 });
    assertEqual((await stats('venue_syn', 'j', day)).entered, 7, 'seven entries across three pages');

    // An event recorded days after it happened (e.g. a connect the worker handled late) counts on its own day.
    const earlier = t0 - 2 * DAY_MS;
    await writeEvents([
      { type: 'message.delivered', journeyKey: 'j', channel: 'email', mode: 'live', occurredAt: earlier, data: { mode: 'live' } },
      { type: 'send.skipped', journeyKey: 'j', mode: 'live', occurredAt: t0, data: { decision: { reason: 'missing_value:guestinfo.wifiName' } } },
    ]);
    await rollupVenue('venue_syn', { cutoffMs: Date.now() + 1000 });
    const old = await stats('venue_syn', 'j', dayId(earlier, TZ));
    assertEqual(old.sends?.email?.delivered, 1, 'counted on its day');
    const today = await stats('venue_syn', 'j', day);
    assertEqual(today.entered, 7, 'today unchanged');
    assertEqual(Object.keys(today.skipped ?? {}), ['missing_value:guestinfo.wifiName'], 'the reason stays one key');
    assertEqual(today.skipped['missing_value:guestinfo.wifiName'], 1, 'counted');

    // Three rollups of the same venue at once: each event is counted exactly once.
    for (let i = 0; i < 6; i += 1) await writeEvents(Array.from({ length: 5 }, () => ({ type: 'journey.converted', journeyKey: 'j', mode: 'live', occurredAt: t0 })));
    await Promise.all([1, 2, 3].map(() => rollupVenue('venue_syn', { cutoffMs: Date.now() + 1000, pageSize: 4 })));
    assertEqual((await stats('venue_syn', 'j', day)).converted, 30, 'thirty conversions, once each');
    assertEqual((await stats('venue_syn', VENUE_KEY, day)).converted, 30, 'venue total');

    // Events newer than the cutoff wait for the next run.
    await writeEvents([{ type: 'journey.entered', journeyKey: 'j', mode: 'live', occurredAt: t0 }]);
    await rollupVenue('venue_syn'); // real now − 2 min: too recent
    assertEqual((await stats('venue_syn', 'j', day)).entered, 7, 'not yet');
    await rollupVenue('venue_syn', { cutoffMs: Date.now() + 1000 });
    assertEqual((await stats('venue_syn', 'j', day)).entered, 8, 'picked up late, once');
  });

  await test('the worker arms the venue rollup after a task; the index probes run', async () => {
    await fresh('test');
    const first = Math.floor(Date.now() / ROLLUP_BUCKET_MS);
    await connect({ venue: A, email: 'arm@test.local', consent: true });
    await runDue();
    const last = Math.floor(Date.now() / ROLLUP_BUCKET_MS);
    const ids = Array.from({ length: last - first + 1 }, (_, k) => taskIdFor(`rollup:${A.venueId}:${first + k}`));
    const tasks = (await db.getAll(...ids.map((id) => db.collection(COL.journeyTasks).doc(id)))).filter((s) => s.exists);
    // One per 15-minute bucket the run touched (normally exactly one).
    assert(tasks.length >= 1 && tasks.every((t) => t.get('kind') === 'rollup_venue' && t.get('venueId') === A.venueId), 'a rollup task for the venue');
    assertEqual((await db.collection(COL.journeyTasks).where('kind', '==', 'rollup_venue').get()).size, tasks.length, 'and no other');
    const result = await checkIndexes();
    assert(result.ok, `index probes: ${JSON.stringify(result.missing)}`);
  });

  await test('the rollup_venue task, run by the worker, counts events older than the 2-minute lag', async () => {
    const t0 = await fresh('test');
    const recorded = new Date(Date.now() - 3 * MINUTE_MS);
    const batch = db.batch();
    for (let i = 0; i < 3; i += 1) {
      batch.create(db.collection(COL.journeyEvents).doc(), { type: 'journey.entered', tenantUserId: A.tenant, venueId: 'venue_w', journeyKey: 'j', mode: 'live', occurredAt: new Date(t0), recordedAt: recorded, data: {} });
    }
    batch.create(db.collection(COL.journeyEvents).doc(), { type: 'journey.entered', tenantUserId: A.tenant, venueId: 'venue_w', journeyKey: 'j', mode: 'live', occurredAt: new Date(t0), recordedAt: new Date(), data: {} });
    await batch.commit();
    await ensureRollup('venue_w', A.tenant);
    await runDue(); // its real due time has passed under the fake clock: the worker runs it now
    const bucket = Math.floor(Date.now() / ROLLUP_BUCKET_MS);
    const task = (await db.getAll(...[bucket, bucket - 1].map((b) => db.collection(COL.journeyTasks).doc(taskIdFor(`rollup:venue_w:${b}`))))).find((s) => s.exists)!;
    assertEqual([task.get('kind'), task.get('status')], ['rollup_venue', 'done'], 'run and done');
    assertEqual((await stats('venue_w', 'j', dayId(t0, TZ))).entered, 3, 'the three older events; the newest waits for the next run');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
