/**
 * Airbnb stays end to end on the Firestore emulator (PR C): a stay from the sandbox
 * calendar, the guest who connects linked to it, every stay moment at its local time.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 * What these prove, with the real hook, the real activation path and the real worker,
 * on a fake clock:
 *  - **Tom** (plan §3.4, §10): a 5-night stay; he connects at 15:10 on arrival day and is
 *    linked; welcome 17:00, local tips day 2 10:00, mid-stay day 3 11:00, checkout
 *    instructions the day before checkout 17:00, review checkout day 15:00, book direct
 *    +3 days 10:00 — test-run records at those local times; no Checkout reminder.
 *  - **A date change** moves the later messages and writes no `stay.moment_skipped`.
 *  - **Tom live**: the same timeline through the sandbox provider — real emails in the
 *    outbox, one ledger line each.
 *  - **A cancellation** (his only booking removed, two polls 30 min apart — the second a
 *    304, or a 200 with the same bookings) stops the rest; a send already due is skipped
 *    by gate rule 1 (`send.skipped` / `stay_cancelled`), also when the booking is
 *    cancelled between the first look and the live claim.
 *  - **Go-live timing** (D-C33): turned on at 18:00, linked at 19:00 → the welcome runs;
 *    a later re-save doesn't stop the later moments.
 *  - **Linking**: first guest wins, the window, overlaps, turnover day, a crash after the
 *    link, a link racing a date change, late links.
 *  - **A paused or not yet active stay playbook** at link time: the moments that come
 *    while it is on still run.
 *  - **The checkout overlap rule** (D-C16) and **modes** (a test run stays a test run).
 */

import { COL, TZ, assert, assertEqual, connect, contactIdFor, db, docsWhere, done, ledger, now, outbox, runDue, runUntil, seedWallet, setClock, setLaunch, test } from './helpers';
import { firestoreScheduler, type TaskSpec } from '../../src/adaptive/queue/firestoreQueue';
import { pauseVenue, resumeVenue } from '../../src/adaptive/service/tenant';
import { adaptiveVenueId, venuePlaybookId } from '../../src/adaptive/store/collections';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { ACTOR, D0, R, at, day, eventsOf, freshStay, instancesAt, label, sendLog, sendsFor, staysAt, sync, tasksOfKind, writeCalendar } from './stayFixtures';

const TOM = { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true };

async function tomLinked(start = at(0, '15:10')): Promise<{ contactId: string; stayId: string }> {
  await setClock(start);
  const guestId = await connect(TOM);
  await runDue();
  const contactId = await contactIdFor(R.tenant, guestId);
  const stay = (await staysAt())[0];
  return { contactId, stayId: stay.id };
}

function journeysOf(instances: Array<Record<string, any>>, contactId?: string): string[] {
  return instances.filter((i) => !contactId || i.contactId === contactId).map((i) => i.journeyKey).sort();
}

async function main() {
  console.log(`\nAirbnb stays (arrival day ${D0})`);

  await test('Tom: linked at 15:10, every stay message at its local time, no checkout reminder', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
    const stays = await staysAt();
    assertEqual(stays.map((s) => [s.checkIn, s.checkOut, s.nights, s.status, s.contactId]), [[day(0), day(5), 5, 'confirmed', null]], 'the stay from the calendar');
    const { contactId } = await tomLinked();
    const stay = (await staysAt())[0];
    assertEqual([stay.contactId, stay.linkMode, label(stay.linkedAt.toMillis())], [contactId, 'test', 'D+0 15:10'], 'linked, test run');
    assertEqual((await eventsOf('stay.linked')).length, 1, 'stay.linked once');
    assertEqual((await tasksOfKind('stay_trigger')).length, 5, 'a moment task per stay journey (4 + checkout reminder)');

    await runUntil(at(9, '12:00'));
    assertEqual(
      await sendLog(),
      [
        'wifi_info_card/s @ D+0 15:10',
        'stay_guide/welcome @ D+0 17:00',
        'stay_local_tips/s @ D+1 10:00',
        'stay_guide/mid @ D+2 11:00',
        'stay_guide/co @ D+4 17:00',
        'stay_review/s1 @ D+5 15:00',
        'stay_book_direct/s @ D+8 10:00',
      ],
      'the Tom timeline',
    );
    const sends = await docsWhere(COL.journeySends, 'venueId', R.venueId);
    assert(sends.every((s) => s.status === 'dry_run' && s.mode === 'test'), 'all test-run records');
    const co = sends.find((s) => s.nodeId === 'co')!;
    assert(String(co.content.preview).includes('10:00') && String(co.content.preview).includes('CHF 30'), `checkout message: ${co.content.preview}`);
    const welcome = sends.find((s) => s.nodeId === 'welcome')!;
    assert(String(welcome.content.preview).includes('[info page link]'), 'the welcome links the info page');
    const bd = sends.find((s) => s.journeyKey === 'stay_book_direct')!;
    assert(String(bd.content.preview).includes('[booking link]') && String(bd.content.preview).includes('12%'), 'book direct with the offer and link');
    const inst = await instancesAt();
    assert(!inst.some((i) => i.journeyKey === 'checkout_reminder'), 'Stay guide covers the guest: no Checkout reminder');
    assertEqual(inst.filter((i) => i.context?.stayId === stay.id).length, 4, 'four stay journeys for this stay');

    // The numbers (D-C26): `_venue.stays` for the day.
    await rollupVenue(R.venueId, { cutoffMs: Date.now() + 1000 });
    const venueDay = (await db.collection(COL.journeyStats).doc(`${R.venueId}__venue_${D0.replace(/-/g, '')}`).get()).data() ?? {};
    assertEqual(venueDay.stays, { created: 1, linked: 1 }, 'arrival day: synced in the morning, linked in the afternoon');
    const created = await eventsOf('stay.created');
    assertEqual(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(created[0].occurredAt.toDate()), D0, 'created counted on the day it happened');
  });

  await test('Tom live (sandbox provider): every stay email reaches the outbox at its local time, charged once each', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }], { launch: 'live' });
    await seedWallet(R.tenant, 5000);
    await setLaunch({ [R.tenant]: 'live' }, { paused: false });
    await tomLinked();
    assertEqual((await staysAt())[0].linkMode, 'live', 'linked in a live run');
    await runUntil(at(9, '12:00'));
    assertEqual(
      await sendLog(),
      [
        'wifi_info_card/s @ D+0 15:10',
        'stay_guide/welcome @ D+0 17:00',
        'stay_local_tips/s @ D+1 10:00',
        'stay_guide/mid @ D+2 11:00',
        'stay_guide/co @ D+4 17:00',
        'stay_review/s1 @ D+5 15:00',
        'stay_book_direct/s @ D+8 10:00',
      ],
      'the Tom timeline, live',
    );
    const sends = await docsWhere(COL.journeySends, 'venueId', R.venueId);
    assert(sends.every((x) => x.status === 'sent' && x.mode === 'live' && x.channel === 'email'), `all sent live by email: ${sends.map((x) => `${x.nodeId}:${x.status}`).join(', ')}`);
    const ob = await outbox();
    assertEqual(ob.map((o) => o.id).sort(), sends.map((x) => x.id).sort(), 'each one in the sandbox outbox, once');
    assert(ob.every((o) => o.to === 'tom@test.local'), 'to Tom');
    const text = (nodeId: string) => String(ob.find((o) => o.id === sends.find((x) => x.nodeId === nodeId)!.id)!.text);
    assert(text('co').includes('10:00') && text('co').includes('CHF 30'), `checkout email: ${text('co')}`);
    assert(ob.every((o) => !/\[[a-z ]+link\]/.test(String(o.text))), `real links, no placeholders: ${ob.map((o) => String(o.text).match(/\[[a-z ]+link\]/)?.[0]).filter(Boolean)}`);
    // Service messages (the Wi-Fi card, Stay guide) are free; each marketing email is charged once.
    const charged = sends.filter((x) => (x.credits?.amount ?? 0) > 0);
    assertEqual(charged.map((x) => x.journeyKey).sort(), ['stay_book_direct', 'stay_local_tips', 'stay_review'], 'the marketing emails carry a price');
    const debits = (await ledger(R.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    assertEqual(debits.map((d) => d.id).sort(), charged.map((x) => `debit_auto_${x.id}`).sort(), 'one ledger line per charged email');
  });

  await test('a checkout moved by one day moves the later messages; no moment_skipped for journeys that ran', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(1, '12:00'));
    await writeCalendar('r', [{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(6) }]);
    const r = await sync();
    assertEqual([r.outcome, r.changed], ['synced', 1], 'a date change');
    const stay = (await staysAt())[0];
    assertEqual([stay.checkOut, stay.nights, stay.datesVersion], [day(6), 6, 2], 'new dates, version 2');
    await runUntil(at(10, '12:00'));
    const log = await sendLog();
    assertEqual(
      log.filter((l) => !l.startsWith('wifi')),
      [
        'stay_guide/welcome @ D+0 17:00',
        'stay_local_tips/s @ D+1 10:00',
        'stay_guide/mid @ D+2 11:00',
        'stay_guide/co @ D+5 17:00',
        'stay_review/s1 @ D+6 15:00',
        'stay_book_direct/s @ D+9 10:00',
      ],
      'moved',
    );
    assertEqual((await eventsOf('stay.moment_skipped')).length, 0, 'no moment_skipped');
    assertEqual((await instancesAt()).filter((i) => i.journeyKey === 'stay_review').length, 1, 'the old review task did nothing');
  });

  await test('cancelled: his only booking removed, two polls 30 min apart (the second a 304) → the rest stops', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(2, '12:00'));
    await writeCalendar('r', []);
    const first = await sync();
    assertEqual([first.missed, first.cancelled, first.unchanged], [1, 0, false], 'first miss');
    await setClock(now() + 10 * 60_000);
    assertEqual((await sync()).missed, 0, 'ten minutes later: the same miss (a 304)');
    await setClock(now() + 21 * 60_000);
    const third = await sync();
    assertEqual([third.cancelled, third.unchanged], [1, true], 'a 304 at least 30 min after the first miss cancels');
    const stay = (await staysAt())[0];
    assertEqual([stay.status, stay.cancelReason, stay.contactId !== null], ['cancelled', 'missing', true], 'cancelled, still linked');
    await runUntil(at(9, '12:00'));
    const guide = (await instancesAt()).find((i) => i.journeyKey === 'stay_guide')!;
    assertEqual([guide.status, guide.exitReason], ['cancelled', 'stay_cancelled'], 'Stay guide ended as cancelled');
    const log = (await sendLog()).filter((l) => !l.startsWith('wifi'));
    assertEqual(log, ['stay_guide/welcome @ D+0 17:00', 'stay_local_tips/s @ D+1 10:00', 'stay_guide/mid @ D+2 11:00'], 'nothing after the cancellation');
    assert(!(await instancesAt()).some((i) => ['stay_review', 'stay_book_direct', 'checkout_reminder'].includes(i.journeyKey)), 'later journeys never started');
  });

  await test('cancelled by identical content (a new DTSTAMP, same stays: a 200, not a 304) 30 min later', async () => {
    // A later booking stays in the calendar, so every write has events and a DTSTAMP.
    const later = { uid: 'later@airbnb.test', checkIn: day(40), checkOut: day(42) };
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }, later]);
    await tomLinked();
    await runUntil(at(4, '16:00'));
    await writeCalendar('r', [later]);
    assertEqual((await sync()).missed, 1, 'miss 1');
    await setClock(now() + 31 * 60_000);
    await writeCalendar('r', [later]); // same bookings, a new DTSTAMP → a 200 with the same hash
    const r = await sync();
    assertEqual([r.fetchStatus, r.unchanged, r.cancelled], [200, true, 1], 'a 200 with the same content cancels');
    const tom = (await staysAt()).find((x) => x.externalUid === 'tom@airbnb.test')!;
    assertEqual([tom.status, tom.cancelReason], ['cancelled', 'missing'], 'cancelled');
  });

  await test('a send already due on a cancelled stay: gate rule 1 skips it (send.skipped / stay_cancelled) and the journey ends', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
    const { stayId } = await tomLinked();
    await runUntil(at(4, '16:59'));
    // Cancelled right before the checkout message is due, its event not delivered yet.
    await db.collection(COL.stays).doc(stayId).update({ status: 'cancelled' });
    await runUntil(at(4, '17:05'));
    const guide = (await instancesAt()).find((i) => i.journeyKey === 'stay_guide')!;
    assertEqual([guide.status, guide.exitReason], ['cancelled', 'stay_cancelled'], 'the journey ended as cancelled');
    const skipped = (await eventsOf('send.skipped')).filter((e) => e.instanceId === guide.id);
    assertEqual(skipped.map((e) => [e.nodeId, e.data?.decision?.rule, e.data?.decision?.reason]), [['co', 'system', 'stay_cancelled']], 'recorded as skipped by rule 1');
    assert(!(await sendLog()).some((l) => l.startsWith('stay_guide/co')), 'no checkout message');
  });

  await test('live: the booking cancelled between the first look and the claim → the claim\'s gate skips it: nothing sent, nothing charged', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }], { launch: 'live' });
    await seedWallet(R.tenant, 5000);
    await setLaunch({ [R.tenant]: 'live' }, { paused: false });
    const { stayId } = await tomLinked();
    await runUntil(at(1, '09:59'));
    // Local tips (day 2, 10:00) is a marketing email: charged when it goes.
    const sentBefore = (await outbox()).length;
    const ledgerBefore = (await ledger(R.tenant)).map((l) => l.id).sort();
    const original = db.runTransaction;
    let armed = true;
    // The claim's transaction is the one called from claimSend: cancel the booking right before it.
    (db as any).runTransaction = async function (fn: any, opts?: any) {
      if (armed && /claimSend/.test(new Error().stack ?? '')) {
        armed = false;
        await db.collection(COL.stays).doc(stayId).update({ status: 'cancelled' });
      }
      return original.call(db, fn, opts);
    };
    try {
      await runUntil(at(1, '10:05'));
    } finally {
      (db as any).runTransaction = original;
    }
    assert(!armed, 'the claim ran');
    const tips = (await instancesAt()).find((i) => i.journeyKey === 'stay_local_tips')!;
    assertEqual([tips.status, tips.exitReason], ['cancelled', 'stay_cancelled'], 'the journey ended as cancelled');
    const skipped = (await eventsOf('send.skipped')).filter((e) => e.instanceId === tips.id);
    assertEqual(skipped.map((e) => [e.nodeId, e.data?.decision?.reason]), [['s', 'stay_cancelled']], 'skipped by rule 1 in the claim');
    assertEqual((await outbox()).length, sentBefore, 'no email');
    assertEqual((await ledger(R.tenant)).map((l) => l.id).sort(), ledgerBefore, 'nothing charged: the ledger is unchanged');
    assertEqual((await db.collection(COL.journeySends).doc(sendKeyFor(tips.id, 's')).get()).exists, false, 'no send record was claimed');
  });

  await test('go-live timing (D-C33): on at 18:00, linked at 19:00 → the welcome runs; a later re-save keeps the later moments', async () => {
    await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
    const avRef = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(R.venueId));
    await avRef.update({ activatedAt: new Date(at(0, '18:00')), 'utility.enabledAt': new Date(at(0, '18:00')) });
    await tomLinked(at(0, '19:00'));
    await runUntil(at(1, '12:00'));
    // A re-save on day 2 resets liveSince (activatedAt, Guest info's enabledAt).
    await avRef.update({ activatedAt: new Date(at(1, '12:00')), 'utility.enabledAt': new Date(at(1, '12:00')) });
    await runUntil(at(9, '12:00'));
    assertEqual(
      (await sendLog()).filter((l) => !l.startsWith('wifi')),
      [
        'stay_guide/welcome @ D+0 19:00',
        'stay_local_tips/s @ D+1 10:00',
        'stay_guide/mid @ D+2 11:00',
        'stay_guide/co @ D+4 17:00',
        'stay_review/s1 @ D+5 15:00',
        'stay_book_direct/s @ D+8 10:00',
      ],
      'every message',
    );
    const moment = (await eventsOf('stay.moment')).find((e) => e.data.journeyKey === 'stay_guide')!;
    assertEqual([label(moment.occurredAt.toMillis()), label(moment.data.momentAt)], ['D+0 19:00', 'D+0 17:00'], 'occurredAt = the link, momentAt = the moment');
  });

  console.log('\nLinking');

  await test('the first guest wins; a second guest gets only the Wi-Fi card', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    const { contactId: tom } = await tomLinked();
    await setClock(at(0, '15:20'));
    const annaGuest = await connect({ venue: R, firstName: 'Anna', email: 'anna@test.local', consent: true });
    await runUntil(at(1, '12:00'));
    const anna = await contactIdFor(R.tenant, annaGuest);
    assertEqual((await staysAt())[0].contactId, tom, 'still Tom');
    const inst = await instancesAt();
    assertEqual(journeysOf(inst, anna), ['wifi_info_card'], 'Anna: the Wi-Fi card only');
    assertEqual(journeysOf(inst, tom), ['stay_guide', 'stay_local_tips', 'wifi_info_card'], 'Tom: his stay journeys');
  });

  await test('13 h before check-in: not linked; a later connect on the same visit, inside the window: linked', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(3) }], { start: at(0, '01:00') });
    await setClock(at(0, '02:00'));
    await connect(TOM);
    await runDue();
    assertEqual((await staysAt())[0].contactId, null, '02:00: the window opens at 03:00');
    await setClock(at(0, '04:00'));
    await connect(TOM);
    await runDue();
    assert((await staysAt())[0].contactId, 'linked on the next connect (same visit)');
    assertEqual((await docsWhere(COL.visits, 'venueId', R.venueId)).length, 1, 'one visit');
  });

  await test('after checkout: not linked', async () => {
    await freshStay([{ checkIn: day(-2), checkOut: day(0) }], { start: at(0, '08:00') });
    await setClock(at(0, '10:30'));
    await connect(TOM);
    await runDue();
    assertEqual((await staysAt())[0].contactId, null, 'checkout 10:00 has passed');
  });

  await test('overlapping bookings link nobody and warn the owner; a linked stay that gets flagged keeps its moments', async () => {
    await freshStay([
      { uid: 'a@x', checkIn: day(0), checkOut: day(3) },
      { uid: 'b@x', checkIn: day(2), checkOut: day(5) },
    ]);
    assertEqual((await staysAt()).map((s) => s.status).sort(), ['overlap_flagged', 'overlap_flagged'], 'both flagged');
    assertEqual((await docsWhere(COL.alerts, 'kind', 'stay_overlap')).length, 1, 'one owner alert for the pair');
    await setClock(at(0, '15:10'));
    await connect(TOM);
    await runDue();
    assert((await staysAt()).every((s) => !s.contactId), 'nobody linked');

    await freshStay([{ uid: 'a@x', checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(0, '18:00'));
    await writeCalendar('r', [
      { uid: 'a@x', checkIn: day(0), checkOut: day(5) },
      { uid: 'b@x', checkIn: day(3), checkOut: day(6) },
    ]);
    const r = await sync();
    assertEqual(r.overlapsFlagged, 2, 'flagged');
    await runUntil(at(1, '12:00'));
    assert((await sendLog()).includes('stay_local_tips/s @ D+1 10:00'), 'the linked, flagged stay still sends its next moment');
  });

  await test('turnover day: the previous party (companion 08:00 / 11:00, linked guest 11:30) is never linked; a new guest at 15:10 is', async () => {
    await freshStay(
      [
        { uid: 'prev@x', checkIn: day(-5), checkOut: day(0) },
        { uid: 'next@x', checkIn: day(0), checkOut: day(4) },
      ],
      { start: at(-5, '09:00') },
    );
    const byUid = async () => Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    await setClock(at(-5, '15:30'));
    const annGuest = await connect({ venue: R, firstName: 'Ann', email: 'ann@test.local', consent: true });
    await runUntil(at(-5, '16:00'));
    const a = await contactIdFor(R.tenant, annGuest);
    await connect({ venue: R, firstName: 'Ben', email: 'ben@test.local', consent: true });
    await runDue();
    assertEqual([(await byUid())['prev@x'].contactId, (await byUid())['next@x'].contactId], [a, null], 'Ann has the previous stay');

    for (const [time, who] of [['08:00', 'ben'], ['11:00', 'ben'], ['11:30', 'ann']] as const) {
      await runUntil(at(0, time));
      await connect({ venue: R, firstName: who, email: `${who}@test.local`, consent: true });
      await runDue();
      assertEqual((await byUid())['next@x'].contactId, null, `${who} at ${time}: not linked`);
    }
    await runUntil(at(0, '15:10'));
    const caraGuest = await connect({ venue: R, firstName: 'Cara', email: 'cara@test.local', consent: true });
    await runDue();
    assertEqual((await byUid())['next@x'].contactId, await contactIdFor(R.tenant, caraGuest), 'the new guest is linked');
  });

  await test('a crash after the link commits (schedule throws) is repaired by the retry: stay.linked and each moment once', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    const original = firestoreScheduler.schedule;
    let calls = 0;
    firestoreScheduler.schedule = async (t: TaskSpec) => {
      if (t.kind === 'stay_trigger' && ++calls === 2) throw new Error('simulated crash');
      return original.call(firestoreScheduler, t);
    };
    try {
      await setClock(at(0, '15:10'));
      await connect(TOM);
      await runDue();
    } finally {
      firestoreScheduler.schedule = original;
    }
    assert((await staysAt())[0].contactId, 'the link committed');
    assertEqual((await eventsOf('stay.linked')).length, 0, 'the follow-up did not finish');
    await runUntil(at(0, '15:20')); // the connect task is retried after its backoff
    assertEqual((await eventsOf('stay.linked')).length, 1, 'stay.linked once');
    const triggers = await tasksOfKind('stay_trigger');
    assertEqual(triggers.map((t) => t.payload.journeyKey).sort(), ['checkout_reminder', 'stay_book_direct', 'stay_guide', 'stay_local_tips', 'stay_review'], 'each moment once');
  });

  await test('a link racing a date change keeps the guest and gets the moments at the new dates version', async () => {
    await freshStay([{ uid: 'x@x', checkIn: day(0), checkOut: day(5) }]);
    await writeCalendar('r', [{ uid: 'x@x', checkIn: day(0), checkOut: day(6) }]);
    await setClock(at(0, '15:10'));
    await sync(); // the change + its event_route task are written; the task hasn't run
    await connect(TOM);
    await runDue(); // the connect (link) and the change's route task, together
    const stay = (await staysAt())[0];
    assert(stay.contactId && stay.datesVersion === 2, 'linked, version 2');
    const triggers = await tasksOfKind('stay_trigger');
    assert(triggers.length === 5 && triggers.every((t) => t.payload.datesVersion === 2), `moments at version 2: ${triggers.map((t) => t.payload.datesVersion)}`);
    // Linked first, dates changed after: the sync's update keeps the link.
    await writeCalendar('r', [{ uid: 'x@x', checkIn: day(0), checkOut: day(4) }]);
    await setClock(at(0, '16:00'));
    await sync();
    const after = (await staysAt())[0];
    assertEqual([after.contactId, after.linkMode, after.datesVersion], [stay.contactId, 'test', 3], 'the link survives the change');
  });

  await test('late links: at 20:00 the welcome goes at once; on day 2 09:00 it is skipped and the Checkout reminder covers him', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await tomLinked(at(0, '20:00'));
    await runDue();
    assert((await sendLog()).includes('stay_guide/welcome @ D+0 20:00'), 'welcome at 20:00 (12 h grace)');

    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await tomLinked(at(1, '09:00'));
    const skipped = await eventsOf('stay.moment_skipped');
    assertEqual(skipped.map((e) => [e.data.journeyKey, e.data.reason]), [['stay_guide', 'too_late']], 'the welcome moment is skipped, once');
    await runUntil(at(5, '12:00'));
    const log = (await sendLog()).filter((l) => !l.startsWith('wifi'));
    assertEqual(log, ['stay_local_tips/s @ D+1 10:00', 'checkout_reminder/s @ D+4 17:00'], 'tips, then the Checkout reminder (no Stay guide for him)');
    assert(!(await instancesAt()).some((i) => i.journeyKey === 'stay_guide'), 'no Stay guide instance');
  });

  console.log('\nA stay playbook not running at link time');

  await test('paused when he is linked, resumed the next morning: the stay journeys whose moments come after run', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await pauseVenue(R.tenant, R.venueId, ACTOR);
    await tomLinked();
    assertEqual((await tasksOfKind('stay_trigger')).length, 5, 'every stay moment is scheduled, paused or not');
    await runUntil(at(1, '08:00'));
    await resumeVenue(R.tenant, R.venueId, ACTOR);
    await runUntil(at(9, '12:00'));
    assertEqual(
      (await sendLog()).filter((l) => !l.startsWith('wifi')),
      ['stay_local_tips/s @ D+1 10:00', 'checkout_reminder/s @ D+4 17:00', 'stay_review/s1 @ D+5 15:00', 'stay_book_direct/s @ D+8 10:00'],
      'tips, the Checkout reminder (no Stay guide), review, book direct',
    );
    assertEqual((await eventsOf('stay.moment_skipped')).map((e) => [e.data.journeyKey, e.data.reason]), [['stay_guide', 'switched_off']], 'the welcome moment passed while paused');
  });

  await test('the stay playbook turned on after the link (16:00): every moment from then on runs, none recorded as missed', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    const avRef = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(R.venueId));
    const installRef = db.collection(COL.venuePlaybooks).doc(venuePlaybookId(R.venueId, 'str_stay'));
    // Only Guest info on: the stay playbook is set up, not active.
    await avRef.update({ status: 'off', activeInstallId: null, activePlaybookKey: null });
    await installRef.update({ state: 'setup' });
    await tomLinked();
    assertEqual((await tasksOfKind('stay_trigger')).length, 5, "the catalogue's stay journeys are scheduled too");
    await runUntil(at(0, '16:00'));
    await installRef.update({ state: 'active' });
    await avRef.update({ status: 'on', activeInstallId: installRef.id, activePlaybookKey: 'str_stay', activatedAt: new Date(at(0, '16:00')) });
    await runUntil(at(9, '12:00'));
    assertEqual(
      (await sendLog()).filter((l) => !l.startsWith('wifi')),
      [
        'stay_guide/welcome @ D+0 17:00',
        'stay_local_tips/s @ D+1 10:00',
        'stay_guide/mid @ D+2 11:00',
        'stay_guide/co @ D+4 17:00',
        'stay_review/s1 @ D+5 15:00',
        'stay_book_direct/s @ D+8 10:00',
      ],
      'the whole stay, no Checkout reminder',
    );
    assertEqual((await eventsOf('stay.moment_skipped')).length, 0, 'nothing recorded as missed');
  });

  await test('a stay playbook never turned on: its moments pass quietly (no moment_skipped), Guest info still reminds', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    const avRef = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(R.venueId));
    await avRef.update({ status: 'off', activeInstallId: null, activePlaybookKey: null });
    await db.collection(COL.venuePlaybooks).doc(venuePlaybookId(R.venueId, 'str_stay')).delete();
    await tomLinked();
    await runUntil(at(9, '12:00'));
    assertEqual((await sendLog()).filter((l) => !l.startsWith('wifi')), ['checkout_reminder/s @ D+4 17:00'], 'only the reminder');
    assertEqual((await eventsOf('stay.moment_skipped')).length, 0, 'no moment_skipped for journeys the venue never set up');
  });

  console.log('\nThe checkout overlap rule (D-C16)');

  await test('Guest info only (the stay playbook paused before the link) → the reminder at checkout −1 day 17:00', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await pauseVenue(R.tenant, R.venueId, ACTOR);
    await tomLinked();
    await runUntil(at(5, '12:00'));
    assertEqual((await sendLog()).filter((l) => !l.startsWith('wifi')), ['checkout_reminder/s @ D+4 17:00'], 'only the reminder');
  });

  await test('a 1-night stay with both on → welcome and reminder at arrival 17:00, every run', async () => {
    for (let run = 0; run < 2; run += 1) {
      await freshStay([{ checkIn: day(0), checkOut: day(1) }]);
      await tomLinked();
      await runUntil(at(1, '12:00'));
      const log = await sendLog();
      assert(log.includes('stay_guide/welcome @ D+0 17:00') && log.includes('checkout_reminder/s @ D+0 17:00'), `run ${run + 1}: ${log.join(', ')}`);
      assert(!log.some((l) => l.startsWith('stay_guide/co')), 'Stay guide sends no checkout message for 1 night');
    }
  });

  await test('Stay guide paused mid-stay → the reminder; paused inside the freeze window → Stay guide\'s own message, no reminder', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(2, '12:00'));
    await pauseVenue(R.tenant, R.venueId, ACTOR);
    await runUntil(at(5, '12:00'));
    const log = (await sendLog()).filter((l) => !l.startsWith('wifi'));
    assert(log.includes('checkout_reminder/s @ D+4 17:00') && !log.some((l) => l.startsWith('stay_guide/co')), `paused on day 3: ${log.join(', ')}`);

    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(4, '16:30'));
    await pauseVenue(R.tenant, R.venueId, ACTOR);
    await runUntil(at(5, '12:00'));
    const late = (await sendLog()).filter((l) => !l.startsWith('wifi'));
    assert(late.includes('stay_guide/co @ D+4 17:00') && !late.some((l) => l.startsWith('checkout_reminder')), `paused 30 min before: ${late.join(', ')}`);
  });

  console.log('\nModes');

  await test('a guest linked in a test run stays a test run after the account goes live', async () => {
    await freshStay([{ checkIn: day(0), checkOut: day(5) }]);
    await tomLinked();
    await runUntil(at(0, '18:00'));
    await seedWallet(R.tenant, 5000);
    await setLaunch({ [R.tenant]: 'live' }, { paused: false });
    await runUntil(at(1, '12:00'));
    const tips = (await instancesAt()).find((i) => i.journeyKey === 'stay_local_tips')!;
    assertEqual(tips.mode, 'test', 'the day-2 journey starts as a test run');
    assertEqual((await sendsFor(tips.id))[0]?.status, 'dry_run', 'nothing real sent');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
