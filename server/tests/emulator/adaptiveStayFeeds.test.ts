/**
 * Airbnb calendar feeds on the Firestore emulator (PR C): saving, polling and the
 * sync's safety rules.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - **Stage 0**: an account that was never on writes nothing (no poll tasks, no feed
 *    writes, no stays). After on → off, a due poll does nothing — unless a guest is
 *    linked to a stay that isn't over: that feed keeps syncing, and a checkout moved while
 *    off still moves the Stay guide's checkout message.
 *  - **One chain**: two saves at once give one feed and one pending poll; the watchdog
 *    restarts a stopped chain exactly once.
 *  - **Robustness**: a failing link keeps its chain and turns `failing` (owner email after
 *    24 h); concurrent polls count one miss; two bookings vanishing at once are held 24 h
 *    (then cancelled, even on 304s), unless the owner saved a different link; Booking.com
 *    is unsupported (a warning, not an error); a VRBO feed's last booking can be cancelled;
 *    a delete and re-save during a linked stay keeps the same stay.
 *  - **LEAKCHECK**: a malformed link never reaches a response, a log line, a feed field
 *    or a task error.
 *  - **Numbers**: `_venue.stays` equals the stay events.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import { COL, assert, assertEqual, connect, db, docsWhere, done, now, resetEmulator, runDue, runUntil, seedCatalogue, setClock, setLaunch, setupVenue, test } from './helpers';
import { stayFeedId } from '../../src/adaptive/store/collections';
import { readEngineSettingsStrict } from '../../src/adaptive/store/engineSettings';
import { pollFeed, stayFeedWatchdog } from '../../src/adaptive/stays/sync';
import { putSandboxCalendar } from '../../src/adaptive/stays/source';
import { checkStayFeed, deleteStayFeed, getStayFeed, normalizeFeedUrl, saveStayFeed } from '../../src/adaptive/service/stays';
import { devClock, getEngineStatus } from '../../src/adaptive/service/engine';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { checkIndexes } from '../../src/adaptive/worker/indexCheck';
import adaptiveRouter from '../../src/adaptive/api/router';
import { ACTOR, R, at, day, freshStay, instancesAt, sendLog, staysAt, sync, tasksOfKind, writeCalendar, writeGuestInfo } from './stayFixtures';

const FEED = stayFeedId(R.venueId);
const feedDoc = async () => (await db.collection(COL.stayFeeds).doc(FEED).get()).data() as Record<string, any> | undefined;
const queued = async (kind: string) => (await tasksOfKind(kind)).filter((t) => t.status === 'queued');
const TOM = { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true };

async function main() {
  console.log('\nLaunch modes');

  await test('an account that was never on writes nothing: no poll tasks, no feed writes, no stays', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(R);
    await writeGuestInfo();
    await setClock(at(0, '09:00'));
    await writeCalendar('r', [{ checkIn: day(0), checkOut: day(5) }]);
    // Like the demo data: a feed doc with no nextPollAt.
    await db.collection(COL.stayFeeds).doc(FEED).set({ tenantUserId: R.tenant, venueId: R.venueId, kind: 'ical', url: 'sandbox:calendar/r', status: 'active' });
    const feedRef = db.collection(COL.stayFeeds).doc(FEED);
    const before = (await feedRef.get()).updateTime!;
    assertEqual(await stayFeedWatchdog({ now: now(), settings: await readEngineSettingsStrict() }), 0, 'the watchdog arms nothing');
    assert((await feedRef.get()).updateTime!.isEqual(before), 'the watchdog wrote nothing to the feed');
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', ACTOR); // the owner's own setting is kept…
    const saved = (await feedRef.get()).updateTime!;
    await runDue();
    await stayFeedWatchdog({ now: now(), settings: await readEngineSettingsStrict() });
    assertEqual((await tasksOfKind('stay_poll')).length, 0, '…but nothing is scheduled');
    assertEqual((await staysAt()).length, 0, 'no stays');
    assert((await feedRef.get()).updateTime!.isEqual(saved) && !(await feedDoc())?.lastPolledAt, 'never polled: nothing wrote to the feed after the save');
    await setClock(at(0, '15:10'));
    await connect(TOM);
    assertEqual((await docsWhere(COL.journeyEvents, 'venueId', R.venueId)).length, 0, 'the connect hook writes nothing either');
  });

  await test('after on → off: a due poll with no linked stay fetches nothing and re-arms nothing', async () => {
    await freshStay([{ checkIn: day(2), checkOut: day(5) }]);
    const polled = (await feedDoc())!.lastPolledAt.toMillis();
    assertEqual((await queued('stay_poll')).length, 1, 'the chain is armed');
    await setLaunch({ [R.tenant]: 'off' });
    await runUntil(at(0, '13:30')); // past the next grid slot
    assertEqual((await feedDoc())!.lastPolledAt.toMillis(), polled, 'no fetch, no feed write');
    assertEqual((await queued('stay_poll')).length, 0, 'the chain stopped');
    assert((await tasksOfKind('stay_poll')).every((t) => t.status === 'done'), 'its task completed');
    // On again: the watchdog restarts exactly one chain.
    await setLaunch({ [R.tenant]: 'test' });
    await setClock(at(0, '15:00'));
    const settings = await readEngineSettingsStrict();
    await stayFeedWatchdog({ now: now(), settings });
    await stayFeedWatchdog({ now: now(), settings });
    assertEqual((await queued('stay_poll')).length, 1, 'one chain, however often it runs');
  });

  await test('a feed with a current linked stay keeps syncing while off; a checkout moved then moves the checkout message', async () => {
    await freshStay([{ uid: 'tom@x', checkIn: day(0), checkOut: day(5) }]);
    await setClock(at(0, '15:10'));
    await connect(TOM);
    await runUntil(at(1, '12:00'));
    await setLaunch({ [R.tenant]: 'off' });
    await writeCalendar('r', [{ uid: 'tom@x', checkIn: day(0), checkOut: day(6) }]);
    await runUntil(at(6, '12:00'));
    const stay = (await staysAt())[0];
    assertEqual([stay.checkOut, stay.datesVersion], [day(6), 2], 'the chain synced the change while off');
    const log = await sendLog();
    assert(log.includes('stay_guide/co @ D+5 17:00') && !log.includes('stay_guide/co @ D+4 17:00'), `the running Stay guide moved: ${log.join(', ')}`);
    assert(!(await instancesAt()).some((i) => i.journeyKey === 'stay_review'), 'no new journeys start while off');
  });

  console.log('\nOne feed, one chain');

  await test('two saves at once → one feed doc, one Sync now, one chain task', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(R);
    await setClock(at(0, '09:00'));
    await setLaunch({ [R.tenant]: 'test' });
    await writeCalendar('r', [{ checkIn: day(1), checkOut: day(3) }]);
    await Promise.all([saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', ACTOR), saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', ACTOR)]);
    assertEqual((await docsWhere(COL.stayFeeds, 'venueId', R.venueId)).map((d) => d.id), [FEED], 'one feed, id venue_{venueId}');
    const polls = await queued('stay_poll');
    assertEqual(polls.map((t) => Boolean(t.payload.manual)).sort(), [false, true], 'one Sync now + one grid-slot poll');
    await runDue();
    assertEqual((await staysAt()).length, 1, 'one stay per booking');
  });

  await test('a delete and re-save during a linked stay keeps the same stay, still linked, no overlap', async () => {
    await freshStay([
      { uid: 'tom@x', checkIn: day(0), checkOut: day(4) },
      { uid: 'later@x', checkIn: day(6), checkOut: day(8) },
    ]);
    await setClock(at(0, '15:10'));
    await connect(TOM);
    await runDue();
    const before = Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    const del = await deleteStayFeed(R.tenant, R.venueId, ACTOR);
    assertEqual([del.deleted, del.cancelled], [true, 1], 'the unlinked future stay is cancelled; the linked one runs on');
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/r', ACTOR);
    await runDue();
    const after = Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    assertEqual(Object.keys(after).sort(), ['later@x', 'tom@x'], 'the same stays');
    assertEqual([after['tom@x'].id, after['tom@x'].status, after['tom@x'].contactId], [before['tom@x'].id, 'confirmed', before['tom@x'].contactId], 'Tom: same stay, still linked');
    assertEqual([after['later@x'].status, after['later@x'].datesVersion], ['confirmed', 2], 'the other one is back (a new dates version)');
  });

  console.log('\nThe sync');

  await test('a failing link keeps its chain, turns failing after 3 errors, and emails the owner once a day after 24 h', async () => {
    await freshStay([]);
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/missing', ACTOR);
    await runDue();
    await runUntil(at(0, '09:00') + 9 * 3_600_000); // two more grid polls
    const f = (await feedDoc())!;
    assertEqual([f.lastError, f.consecutiveErrors >= 3, f.status], ['LINK_INVALID', true, 'failing'], 'failing, as a code');
    assertEqual((await queued('stay_poll')).length, 1, 'the chain goes on');
    assertEqual((await getEngineStatus()).feeds, { total: 1, failing: 1 }, 'on the admin status');
    await runUntil(at(2, '09:00'));
    const alerts = await docsWhere(COL.alerts, 'kind', 'stay_feed_failing');
    assert(alerts.length >= 1 && alerts.length <= 2, `one email per day (${alerts.length})`);
    assert(alerts.every((a) => a.audience === 'owner' && !String(a.text).includes('sandbox:')), 'to the owner, without the link');
  });

  await test('concurrent polls count one miss; a poll holding the feed makes the others wait', async () => {
    await freshStay([{ checkIn: day(2), checkOut: day(5) }]);
    await writeCalendar('r', []);
    const [a, b] = await Promise.all([sync(), sync()]);
    assert([a.outcome, b.outcome].every((o) => o === 'synced' || o === 'busy'), `outcomes ${a.outcome} ${b.outcome}`);
    assertEqual((await staysAt())[0].missingCount, 1, 'one miss');
    await db.collection(COL.stayFeeds).doc(FEED).update({ pollLease: { owner: 'another-poll', until: new Date(Date.now() + 60_000) } });
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).outcome, 'busy', 'held by another poll');
    assertEqual((await staysAt())[0].missingCount, 1, 'nothing counted');
  });

  await test('a guest linked between a poll\'s read and its writes keeps the link; the new dates reach his moments', async () => {
    await freshStay([{ uid: 'tom@x', checkIn: day(0), checkOut: day(5) }]);
    await setClock(at(0, '15:10'));
    await runDue(); // anything due first, so only the connect runs inside the poll
    await writeCalendar('r', [{ uid: 'tom@x', checkIn: day(0), checkOut: day(6) }]);
    let linkedInside: unknown = null;
    const r = await pollFeed(FEED, { now: now(), settings: await readEngineSettingsStrict() }, {
      kind: 'manual',
      owner: 'test:link-race',
      onRead: async () => {
        await connect(TOM);
        await runDue(); // the link commits while the poll holds its (stale) read
        linkedInside = (await staysAt())[0].contactId;
      },
    });
    assert(linkedInside, 'linked inside the poll');
    assertEqual([r.outcome, r.changed], ['synced', 1], 'the date change applied');
    const stay = (await staysAt())[0];
    assertEqual([stay.contactId, stay.linkMode, stay.checkOut, stay.datesVersion], [linkedInside, 'test', day(6), 2], 'still linked, new dates');
    await runDue(); // the change's route task
    const v2 = (await tasksOfKind('stay_trigger')).filter((t) => t.payload.datesVersion === 2);
    assertEqual(v2.length, 5, 'every moment again at the new dates version');
    await runUntil(at(9, '12:00'));
    const log = (await sendLog()).filter((l) => !l.startsWith('wifi'));
    assert(log.includes('stay_guide/co @ D+5 17:00') && log.includes('stay_review/s1 @ D+6 15:00'), `moved: ${log.join(', ')}`);
    assertEqual(log.filter((l) => l.startsWith('stay_guide/welcome')).length, 1, 'the welcome once');
  });

  await test('a delete during a poll: no stay is created, changed or brought back; the poll is superseded', async () => {
    await freshStay([
      { uid: 'a@x', checkIn: day(1), checkOut: day(3) },
      { uid: 'b@x', checkIn: day(6), checkOut: day(8) },
    ]);
    await writeCalendar('r', [
      { uid: 'a@x', checkIn: day(1), checkOut: day(4) },
      { uid: 'b@x', checkIn: day(6), checkOut: day(8) },
      { uid: 'c@x', checkIn: day(10), checkOut: day(12) },
    ]);
    const r = await pollFeed(FEED, { now: now(), settings: await readEngineSettingsStrict() }, {
      kind: 'manual',
      owner: 'test:delete-race',
      onRead: async () => {
        const del = await deleteStayFeed(R.tenant, R.venueId, ACTOR);
        assertEqual([del.deleted, del.cancelled], [true, 2], 'the delete cancels both');
      },
    });
    assertEqual(r.outcome, 'superseded', 'superseded');
    const stays = Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    assertEqual(Object.keys(stays).sort(), ['a@x', 'b@x'], 'no new stay');
    assertEqual([stays['a@x'].status, stays['a@x'].checkOut, stays['b@x'].status], ['cancelled', day(3), 'cancelled'], 'the cancels stand, the old dates too');
    assertEqual(await feedDoc(), undefined, 'the feed stays deleted');
  });

  await test('another link saved during a poll: the old poll writes nothing back; the save\'s sync waits for it, then reads the new link', async () => {
    await freshStay([{ uid: 'a@x', checkIn: day(1), checkOut: day(3) }]);
    await writeCalendar('r', [{ uid: 'a@x', checkIn: day(1), checkOut: day(4) }]);
    await writeCalendar('s', [{ uid: 'b@x', checkIn: day(2), checkOut: day(5) }]);
    let waiting: Array<Record<string, any>> = [];
    const r = await pollFeed(FEED, { now: now(), settings: await readEngineSettingsStrict() }, {
      kind: 'manual',
      owner: 'test:save-race',
      onRead: async () => {
        await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/s', ACTOR);
        await runDue(); // the save's own sync finds the feed held → back in 60 s
        waiting = (await queued('stay_poll')).filter((t) => t.payload.manual === true);
      },
    });
    assertEqual(r.outcome, 'superseded', 'the old poll is superseded');
    assertEqual(waiting.length, 1, "the save's sync was put back, not dropped");
    let f = (await feedDoc())!;
    assertEqual([f.url, f.etag, f.reservedSeen, f.lastContentHash, f.pollLease], ['sandbox:calendar/s', null, false, null, null], "the save's reset stands, the lease is free");
    assertEqual((await staysAt()).map((s) => [s.externalUid, s.checkOut]), [['a@x', day(3)]], "the old link's date change was not applied");
    await setClock(now() + 61_000);
    await runDue();
    f = (await feedDoc())!;
    const stays = Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    assertEqual([Boolean(stays['b@x']), stays['a@x'].missingCount, f.reservedSeen, Boolean(f.etag)], [true, 1, true, true], 'the new link read: its booking in, the old one missing once');
  });

  await test('a cancel-and-rebook of the same dates is no overlap: the old booking just goes', async () => {
    await freshStay([{ uid: 'old@x', checkIn: day(1), checkOut: day(4) }]);
    await writeCalendar('r', [{ uid: 'new@x', checkIn: day(1), checkOut: day(4) }]);
    const r = await sync();
    assertEqual([r.created, r.missed, r.overlapsFlagged], [1, 1, 0], 'one new, one missing, no overlap');
    const byUid = async () => Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    let s = await byUid();
    assertEqual([s['old@x'].status, s['new@x'].status], ['confirmed', 'confirmed'], 'neither flagged');
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).cancelled, 1, 'the old one cancelled 30 min later');
    s = await byUid();
    assertEqual([s['old@x'].status, s['new@x'].status, (await feedDoc())!.overlapCount], ['cancelled', 'confirmed', 0], 'the new one is clear');
    assertEqual((await docsWhere(COL.alerts, 'kind', 'stay_overlap')).length, 0, 'no overlap alert');
  });

  await test('after a cancel-and-rebook the arriving guest is linked to the new booking, never the old one still in progress', async () => {
    // The old booking is in progress (from yesterday), so it would come first among the candidates.
    await freshStay([{ uid: 'old@x', checkIn: day(-1), checkOut: day(4) }], { start: at(0, '09:00') });
    await writeCalendar('r', [{ uid: 'new@x', checkIn: day(0), checkOut: day(4) }]);
    const r = await sync();
    assertEqual([r.created, r.missed, r.upcoming], [1, 1, 1], 'the new one created, the old one missing once, one upcoming');
    assertEqual((await feedDoc())!.upcomingCount, 1, 'the owner sees one upcoming booking');
    await setClock(at(0, '09:20')); // before the second miss
    await connect(TOM);
    await runDue();
    const byUid = Object.fromEntries((await staysAt()).map((s) => [s.externalUid, s]));
    assertEqual([byUid['old@x'].contactId, byUid['old@x'].status, Boolean(byUid['new@x'].contactId)], [null, 'confirmed', true], 'linked to the new booking');
  });

  await test('a known stay extended past 90 nights stays as it was (not missing, never cancelled)', async () => {
    await freshStay([{ uid: 'long@x', checkIn: day(1), checkOut: day(61) }]);
    await writeCalendar('r', [{ uid: 'long@x', checkIn: day(1), checkOut: day(101) }]);
    for (let i = 0; i < 3; i += 1) {
      const r = await sync();
      assertEqual([r.outcome, r.missed, r.cancelled], ['synced', 0, 0], `poll ${i + 1}: nothing missing`);
      await setClock(now() + 31 * 60_000);
    }
    const st = (await staysAt())[0];
    assertEqual([st.status, st.checkOut, st.missingCount], ['confirmed', day(61), 0], 'confirmed, at the dates it had');
    await writeCalendar('r', []);
    assertEqual((await sync()).missed, 1, 'when it really leaves the calendar, it is missed');
  });

  await test('a suspect parse still resets the misses of the stays that are in it', async () => {
    const A = { uid: 'a@x', checkIn: day(1), checkOut: day(3) };
    const B = { uid: 'b@x', checkIn: day(4), checkOut: day(6) };
    const X = { uid: 'x@x', checkIn: day(8), checkOut: day(10) };
    await freshStay([A, B, X]);
    const x = async () => (await staysAt()).find((st) => st.externalUid === 'x@x')!;
    await writeCalendar('r', [A, B]);
    assertEqual((await sync()).missed, 1, 'X missing once');
    await setClock(now() + 31 * 60_000);
    await writeCalendar('r', [X]);
    const r = await sync();
    assertEqual([r.feedWarning, r.missed, (await x()).missingCount], ['mass_missing', 0, 0], 'A and B gone at once: held; X is in it → its miss is reset');
    await setClock(now() + 31 * 60_000);
    await writeCalendar('r', [A, B]);
    assertEqual((await sync()).cancelled, 0, 'X gone alone again: a first miss, not a cancellation');
    assertEqual([(await x()).status, (await x()).missingCount], ['confirmed', 1], 'still confirmed');
  });

  await test('a PMS feed with a Booking.com closure: its reservation is a stay; once only the closure is left it is missed and cancelled', async () => {
    const pms = (withBooking: boolean) =>
      [
        'BEGIN:VCALENDAR',
        'PRODID:-//Some PMS//EN',
        ...(withBooking ? ['BEGIN:VEVENT', 'UID:res-1@pms.test', `DTSTART;VALUE=DATE:${day(2).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${day(5).replace(/-/g, '')}`, 'SUMMARY:Reserved - GUESTNAME', 'END:VEVENT'] : []),
        'BEGIN:VEVENT',
        'UID:8736@booking.com',
        `DTSTART;VALUE=DATE:${day(9).replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${day(11).replace(/-/g, '')}`,
        'SUMMARY:CLOSED - Not available',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n') + '\r\n';
    await freshStay([]);
    await putSandboxCalendar('pms', pms(true));
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/pms', ACTOR);
    await runDue();
    assertEqual((await staysAt()).map((st) => st.status), ['confirmed'], 'a stay from the reservation');
    await putSandboxCalendar('pms', pms(false));
    const first = await sync();
    assertEqual([first.outcome, first.missed], ['synced', 1], 'not unsupported: the miss counts');
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).cancelled, 1, 'cancelled');
    assertEqual((await feedDoc())!.feedWarning, null, 'no unsupported warning');
  });

  await test('two bookings vanishing at once: held 24 h (mass_missing, one alert, new stays still apply), then cancelled on 304s', async () => {
    await freshStay([
      { uid: 'a@x', checkIn: day(1), checkOut: day(3) },
      { uid: 'b@x', checkIn: day(4), checkOut: day(6) },
    ]);
    await writeCalendar('r', [{ uid: 'c@x', checkIn: day(8), checkOut: day(9) }]);
    const r = await sync();
    assertEqual([r.missed, r.created, r.feedWarning], [0, 1, 'mass_missing'], 'no miss, the new one created');
    const f = (await feedDoc())!;
    assertEqual([f.feedWarning, f.lastError, f.consecutiveErrors], ['mass_missing', null, 0], 'a warning, not an error');
    assertEqual((await docsWhere(COL.alerts, 'kind', 'stay_feed_suspect')).length, 1, 'one HeidiFi alert');
    await setClock(now() + 3_600_000);
    assertEqual([(await sync()).missed, (await docsWhere(COL.alerts, 'kind', 'stay_feed_suspect')).length], [0, 1], 'an hour later: still held (a 304), no new alert');
    await setClock(now() + 23 * 3_600_000);
    assertEqual((await sync()).missed, 2, 'after 24 h the misses count (a 304)');
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).cancelled, 2, 'and cancel');
    await setClock(now() + 31 * 60_000);
    await sync();
    assertEqual((await feedDoc())!.feedWarning, null, 'back to normal');
  });

  await test('a different link lifts the hold at once: its missing bookings cancel after two polls', async () => {
    await freshStay([
      { uid: 'a@x', checkIn: day(1), checkOut: day(3) },
      { uid: 'b@x', checkIn: day(4), checkOut: day(6) },
    ]);
    await putSandboxCalendar('other', 'BEGIN:VCALENDAR\r\nPRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN\r\nEND:VCALENDAR\r\n');
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/other', ACTOR);
    assertEqual((await sync()).missed, 2, 'no hold');
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).cancelled, 2, 'cancelled');
    assertEqual((await docsWhere(COL.alerts, 'kind', 'stay_feed_suspect')).length, 0, 'no alert: the owner did it');
  });

  await test('Booking.com: unsupported — a warning, no stays, no error, never failing, the chain goes on; Check link says so', async () => {
    await freshStay([]);
    await putSandboxCalendar(
      'booking',
      'BEGIN:VCALENDAR\r\nPRODID:-//admin.booking.com\\\\\\, b.v.//NONSGML v1.0//EN\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:' + day(2).replace(/-/g, '') + '\r\nDTEND;VALUE=DATE:' + day(4).replace(/-/g, '') + '\r\nUID:x1@booking.com\r\nSUMMARY:CLOSED - Not available\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const check = await checkStayFeed(R.tenant, R.venueId, 'sandbox:calendar/booking');
    assertEqual([check.ok, check.errorCode], [false, 'unsupported_source'], 'Check link');
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/booking', ACTOR);
    await runDue();
    await runUntil(at(0, '09:00') + 5 * 3_600_000);
    const f = (await feedDoc())!;
    assertEqual([f.feedWarning, f.lastError, f.consecutiveErrors, f.status], ['unsupported_source', null, 0, 'active'], 'a warning only');
    assertEqual((await staysAt()).length, 0, 'no stays');
    assertEqual((await queued('stay_poll')).length, 1, 'the chain goes on');
  });

  await test('VRBO: "Reserved - <name>" gives a stay; its only booking removed later is cancelled (not unsupported)', async () => {
    const vrbo = (withBooking: boolean) =>
      [
        'BEGIN:VCALENDAR',
        'PRODID:-//HomeAway.com, Inc.//EN',
        ...(withBooking ? ['BEGIN:VEVENT', 'UID:vrbo-1', `DTSTART;VALUE=DATE:${day(2).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${day(5).replace(/-/g, '')}`, 'SUMMARY:Reserved - GUESTNAME', 'END:VEVENT'] : []),
        'BEGIN:VEVENT',
        'UID:vrbo-2',
        `DTSTART;VALUE=DATE:${day(9).replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${day(10).replace(/-/g, '')}`,
        'SUMMARY:Blocked',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\n');
    await freshStay([]);
    await putSandboxCalendar('vrbo', vrbo(true));
    await saveStayFeed(R.tenant, R.venueId, 'sandbox:calendar/vrbo', ACTOR);
    await runDue();
    assertEqual((await staysAt()).length, 1, 'a stay');
    assert(!JSON.stringify(await staysAt()).includes('GUESTNAME'), 'no name stored');
    await putSandboxCalendar('vrbo', vrbo(false));
    assertEqual((await sync()).missed, 1, 'missing once');
    await setClock(now() + 31 * 60_000);
    assertEqual((await sync()).cancelled, 1, 'cancelled');
    assertEqual((await feedDoc())!.feedWarning, null, 'never unsupported (it gave a stay before)');
  });

  console.log('\nNever leaks the link');

  await test('the same link typed differently is the same link; the dev clock moves forward only', async () => {
    const plain = normalizeFeedUrl('https://www.airbnb.com/calendar/ical/1.ics?s=abc');
    assertEqual(normalizeFeedUrl('HTTPS://WWW.AIRBNB.COM:443/calendar/ical/1.ics?s=abc'), plain, 'scheme, host case and :443');
    assertEqual(normalizeFeedUrl('webcal://www.airbnb.com/calendar/ical/1.ics?s=abc'), plain, 'webcal://');
    let refused = '';
    try {
      await devClock({ at: new Date(Date.now() - 3_600_000).toISOString() });
    } catch (err) {
      refused = String((err as Error).message);
    }
    assert(refused.includes('earlier than the real time'), `an \`at\` in the past is refused: ${refused}`);
  });

  await test('LEAKCHECK: a malformed link reaches no response, log line, feed field or task error', async () => {
    await freshStay([]);
    const logs: string[] = [];
    const orig = { error: console.error, warn: console.warn, log: console.log };
    const capture = (...a: unknown[]) => logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const app = express();
    app.use(express.json());
    app.use('/internal/adaptive', adaptiveRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/adaptive`;
    const bad = 'https://www.airbnb.com:99999/x.ics?s=LEAKCHECK';
    const bodies: string[] = [];
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    try {
      for (const path of ['/dev/stay-feed', '/dev/stay-check']) {
        const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': String(process.env.INTERNAL_API_SECRET) }, body: JSON.stringify({ venueId: R.venueId, url: bad }) });
        bodies.push(`${res.status} ${await res.text()}`);
      }
      // A feed that somehow holds a malformed link (stored before validation, say): the poll records a code.
      await db.collection(COL.stayFeeds).doc(FEED).update({ url: bad });
      await sync();
      await runUntil(at(0, '09:00') + 5 * 3_600_000); // the chain's own task too
    } finally {
      Object.assign(console, orig);
      server.close();
    }
    assert(bodies.every((b) => b.startsWith('400 ') && !b.includes('LEAKCHECK')), `responses: ${bodies.join(' | ')}`);
    assert(!logs.some((l) => l.includes('LEAKCHECK')), `a log line leaks it: ${logs.find((l) => l.includes('LEAKCHECK'))}`);
    const f = (await feedDoc())!;
    assertEqual(f.lastError, 'BAD_URL', 'a code');
    const { url: _url, ...rest } = f;
    assert(!JSON.stringify(rest).includes('LEAKCHECK'), 'no other feed field has it');
    const tasks = await tasksOfKind('stay_poll');
    assert(tasks.length > 0 && !JSON.stringify(tasks).includes('LEAKCHECK'), 'no task has it');
    const view = await getStayFeed(R.tenant, R.venueId);
    assert(!JSON.stringify(view).includes('LEAKCHECK'), `the owner view masks it: ${view.feed?.url}`);
  });

  console.log('\nNumbers and indexes');

  await test('`_venue.stays` equals the stay events; every new query has an index probe', async () => {
    await freshStay([
      { uid: 'a@x', checkIn: day(0), checkOut: day(3) },
      { uid: 'b@x', checkIn: day(5), checkOut: day(7) },
    ]);
    await setClock(at(0, '15:10'));
    await connect(TOM);
    await runDue();
    await writeCalendar('r', [
      { uid: 'a@x', checkIn: day(0), checkOut: day(4) },
      { uid: 'c@x', checkIn: day(3), checkOut: day(6) },
    ]);
    await sync();
    await setClock(now() + 31 * 60_000);
    await sync();
    await runDue();
    await rollupVenue(R.venueId, { cutoffMs: Date.now() + 1000 });
    const stats = (await docsWhere(COL.journeyStats, 'venueId', R.venueId)).filter((d) => d.journeyKey === '_venue');
    const counted: Record<string, number> = {};
    for (const d of stats) for (const [k, v] of Object.entries((d.stays ?? {}) as Record<string, number>)) counted[k] = (counted[k] ?? 0) + v;
    const events = (await docsWhere(COL.journeyEvents, 'venueId', R.venueId)).filter((e) => String(e.type).startsWith('stay.') && e.type !== 'stay.moment');
    const expected: Record<string, number> = {};
    const name: Record<string, string> = { 'stay.created': 'created', 'stay.changed': 'changed', 'stay.cancelled': 'cancelled', 'stay.linked': 'linked', 'stay.overlap_flagged': 'overlapFlagged', 'stay.moment_skipped': 'momentsSkipped' };
    for (const e of events) expected[name[e.type]] = (expected[name[e.type]] ?? 0) + 1;
    const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    assertEqual(sorted(counted), sorted(expected), 'counts = events');
    // a overlaps c: two flags. b (missing from the content, cancelled on the next poll) is on its way out, not an overlap.
    assert(expected.created === 3 && expected.changed === 1 && expected.cancelled === 1 && expected.linked === 1 && expected.overlapFlagged === 2, `the mix: ${JSON.stringify(expected)}`);
    assert(!stats.some((d) => d.dryRun?.stays), 'never under dryRun');
    const idx = await checkIndexes();
    assertEqual(idx, { ok: true, missing: [] }, 'the probes run');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
