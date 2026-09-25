/**
 * Airbnb stays, the pure parts (PR C): the iCal reader, the safe calendar fetcher,
 * stay times and moments, the poll grid and the sync rules.
 *
 * Run: npx tsx tests/adaptiveStaysCore.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials, no network: the fetcher gets a fake resolver and a fake
 * request function. The calendars are synthetic, in the shapes real Airbnb, Booking.com
 * and VRBO exports have (research/…/pr-c-maps/ical-and-fetch.md §8) — every code, UID,
 * token and name below is made up.
 */

import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { IcalParseError, isUnsupported, looksLikeIcal, parseIcal, staysHash, addDays, daysBetween, parseDuration } from '../src/adaptive/stays/ical';
import { FeedFetchError, fetchFeed, isBlockedIp, type RequestFn, type Resolve } from '../src/adaptive/stays/fetch';
import {
  DEFAULT_CHECK_IN,
  POLL_EVERY_MS,
  momentFor,
  nextPollSlot,
  planMoment,
  resolveStayTimes,
  stayInstants,
  stayTriggerKey,
  syncNowKey,
  validStayTime,
} from '../src/adaptive/stays/times';
import { decideMiss, decideUpsert, isCountable, isCurrentLinked, overlapMap, suspectState, type StaySnap } from '../src/adaptive/stays/plan';
import { maskFeedUrl } from '../src/adaptive/stays/words';
import { zonedTime } from '../src/adaptive/core/runtime/time';

let passed = 0;
let failed = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function rejectsWith(p: Promise<unknown>, code: string, msg: string): Promise<FeedFetchError> {
  try {
    await p;
  } catch (err) {
    assert(err instanceof FeedFetchError, `${msg}: not a FeedFetchError (${String(err)})`);
    assertEqual((err as FeedFetchError).code, code, msg);
    return err as FeedFetchError;
  }
  throw new Error(`${msg}: did not throw`);
}

const ZRH = 'Europe/Zurich';
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

const airbnbEvent = (uid: string, start: string, end: string, code: string, stamp = '20261001T061512Z') => [
  'BEGIN:VEVENT',
  `DTSTAMP:${stamp}`,
  `DTSTART;VALUE=DATE:${start}`,
  `DTEND;VALUE=DATE:${end}`,
  'SUMMARY:Reserved',
  `UID:1418fb94e984-${uid}@airbnb.com`,
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de',
  ` tails/${code}\\nPhone Number (Last 4 Digits): 0000`,
  'END:VEVENT',
];
const airbnbBlock = (uid: string, start: string, end: string, stamp = '20261001T061512Z') => [
  'BEGIN:VEVENT',
  `DTSTAMP:${stamp}`,
  `DTSTART;VALUE=DATE:${start}`,
  `DTEND;VALUE=DATE:${end}`,
  'SUMMARY:Airbnb (Not available)',
  `UID:7f662ec65913-${uid}@airbnb.com`,
  'END:VEVENT',
];
const AIRBNB_HEAD = ['BEGIN:VCALENDAR', 'PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN', 'CALSCALE:GREGORIAN', 'VERSION:2.0'];

const F1 = crlf([
  ...AIRBNB_HEAD,
  ...airbnbEvent('00000000000000000000000000000001', '20260927', '20261003', 'HMXXXXXXX1'),
  ...airbnbEvent('00000000000000000000000000000002', '20261003', '20261008', 'HMXXXXXXX2'),
  ...airbnbEvent('00000000000000000000000000000003', '20261220', '20261227', 'HMXXXXXXX3'),
  ...airbnbBlock('000000000000000000000000000000b1', '20261008', '20261009'),
  ...airbnbBlock('000000000000000000000000000000b2', '20261101', '20261115'),
  ...airbnbBlock('000000000000000000000000000000b3', '20270701', '20271002'),
  'END:VCALENDAR',
]);

const F2 = crlf([
  ...AIRBNB_HEAD,
  ...airbnbEvent('00000000000000000000000000000001', '20260927', '20261003', 'HMXXXXXXX1', '20261002T061733Z'),
  ...airbnbEvent('00000000000000000000000000000002', '20261003', '20261006', 'HMXXXXXXX2', '20261002T061733Z'),
  ...airbnbBlock('000000000000000000000000000000b4', '20261006', '20261007', '20261002T061733Z'),
  ...airbnbBlock('000000000000000000000000000000b2', '20261101', '20261115', '20261002T061733Z'),
  ...airbnbBlock('000000000000000000000000000000b3', '20270701', '20271003', '20261002T061733Z'),
  'END:VCALENDAR',
]);

const F5_LEGACY = crlf([
  'BEGIN:VCALENDAR',
  'PRODID;X-RICAL-TZSOURCE=TZINFO:-//Airbnb Inc//Hosting Calendar 0.8.8//EN',
  'CALSCALE:GREGORIAN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20261018',
  'DTSTART;VALUE=DATE:20261011',
  'UID:1418fb94e984-00000000000000000000000000000005@airbnb.com',
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/',
  ' details/HMXXXXXXX9\\nPhone Number (Last 4 Digits): 0000',
  'SUMMARY:Reserved',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20270930',
  'DTSTART;VALUE=DATE:20270401',
  'UID:6fec1092d3fa-000000000000000000000000000000b5@airbnb.com',
  'SUMMARY:Airbnb (Not available)',
  'END:VEVENT',
  'END:VCALENDAR',
]);

const F6_EMPTY = crlf([...AIRBNB_HEAD, 'END:VCALENDAR']);

const bookingEvent = (uid: string, start: string, end: string) => [
  'BEGIN:VEVENT',
  'DTSTAMP:20261001T010203Z',
  `DTSTART;VALUE=DATE:${start}`,
  `DTEND;VALUE=DATE:${end}`,
  `UID:${uid}@booking.com`,
  'SUMMARY:CLOSED - Not available',
  'ORGANIZER:mailto:noreply@booking.com',
  'END:VEVENT',
];
const F8_BOOKING = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//admin.booking.com\\\\\\, b.v.//NONSGML v1.0//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  ...bookingEvent('00000000000000000000000000000b01', '20261001', '20261004'),
  ...bookingEvent('00000000000000000000000000000b02', '20261010', '20261011'),
  ...bookingEvent('00000000000000000000000000000b03', '20261011', '20261012'),
  ...bookingEvent('00000000000000000000000000000b04', '20270103', '20280401'),
  'END:VCALENDAR',
]);

const vrboEvent = (n: string, start: string, end: string, summary: string) => [
  'BEGIN:VEVENT',
  `UID:00000000-0000-4000-8000-00000000000${n}`,
  'DTSTAMP:20261001T060000Z',
  `DTSTART;VALUE=DATE:${start}`,
  `DTEND;VALUE=DATE:${end}`,
  `SUMMARY:${summary}`,
  'END:VEVENT',
];
const VRBO_HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'PRODID:-//HomeAway.com, Inc.//EN'];
// LF only, like the one sample.
const F10_VRBO = [
  ...VRBO_HEAD,
  ...vrboEvent('1', '20260612', '20260615', 'Reserved - GUESTNAME1'),
  ...vrboEvent('2', '20261009', '20261012', 'Reserved - GUESTNAME2'),
  ...vrboEvent('3', '20261020', '20261021', 'Blocked'),
  'END:VCALENDAR',
].join('\n');
const F10_VRBO_LATER = [...VRBO_HEAD, ...vrboEvent('3', '20261020', '20261021', 'Blocked'), 'END:VCALENDAR'].join('\n');

const F12_NAMES = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example PMS//Names In Summary 1.0//EN',
  ...['names-1|20261009|20261012|GUESTNAME3', 'names-2|20261015|20261018|GUESTNAME4 (2 guests)', 'names-3|20261020|20261023|GUESTNAME5 - Reserved', 'names-4|20261101|20261102|Blocked'].flatMap((row) => {
    const [uid, s, e, summary] = row.split('|');
    return ['BEGIN:VEVENT', `UID:${uid}@example-pms.test`, 'DTSTAMP:20261001T080000Z', `DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${e}`, `SUMMARY:${summary}`, 'END:VEVENT'];
  }),
  'END:VCALENDAR',
]);

const F4_DUPLICATES = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example PMS//Defensive Duplicates 1.0//EN',
  ...['dup-1|20261015|20261026', 'dup-1|20261026|20261030', 'dup-2|20261102|20261109', 'dup-2|20261102|20261104'].flatMap((row) => {
    const [uid, s, e] = row.split('|');
    return ['BEGIN:VEVENT', `UID:${uid}@example-pms.test`, 'DTSTAMP:20261001T080000Z', `DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${e}`, 'SUMMARY:Reserved', 'END:VEVENT'];
  }),
  'END:VCALENDAR',
]);

/** F11 edge cases, built as bytes: a UTF-8 BOM, a TAB fold, a fold inside "ü". */
function f11(): Buffer {
  const s = (t: string) => Buffer.from(t, 'utf8');
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    s(
      crlf([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Example PMS//Edge Cases 1.0//EN',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Zurich',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'END:STANDARD',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:edge-1@example-pms.test',
        'DTSTAMP:20261001T080000Z',
        'DTSTART;TZID="Europe/Zurich":20261012T150000',
        'DTEND;TZID=Europe/Zurich:20261015T100000',
        'SUMMARY:Müller\\, Anna \\; 2 guests',
        'DESCRIPTION:Line one\\nLine two with a backslash \\\\ and a long tail that',
        '\tgets folded with a TAB',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:ALARM TEXT MUST NOT OVERWRITE THE EVENT DESCRIPTION',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'uid:edge-2@example-pms.test',
        'dtstart:20261019T230000Z',
        'dtend:20261022T090000Z',
        'summary:Reserved - Jonas',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:edge-3@example-pms.test',
        'DTSTART;VALUE=DATE:20261101',
        'SUMMARY:Blocked',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:edge-4@example-pms.test',
        'DTSTART;VALUE=DATE:20261105',
        'DURATION:P3D',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:edge-5@example-pms.test',
        'DTSTART;VALUE=DATE:20261110',
        'DTEND;VALUE=DATE:20261113',
        'STATUS:CANCELLED',
        'SEQUENCE:2',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:edge-6@example-pms.test',
        'DTSTART;VALUE=DATE:20261201',
        'DTEND;VALUE=DATE:20261202',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:edge-7@example-pms.test',
        'DTSTART;VALUE=DATE:20261220',
        'DTEND;VALUE=DATE:20261218',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20261224',
        'DTEND;VALUE=DATE:20261226',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'BEGIN:VEVENT',
      ]),
    ),
    // A UID with an "ü" folded between its two bytes.
    s('UID:m'),
    Buffer.from([0xc3]),
    s('\r\n '),
    Buffer.from([0xbc]),
    s('ller-8@example-pms.test\r\n'),
    s(crlf(['DTSTART;VALUE=DATE:20261228', 'DTEND;VALUE=DATE:20261230', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'])),
  ]);
}

// ── Fake network for the fetcher ─────────────────────────────────────────────

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string; drip?: boolean; never?: boolean };

/** A fake https.request: calls the real `lookup` hook first (as Node would), then replies. */
function fakeRequest(route: (host: string, pathAndQuery: string, headers: Record<string, string>) => Reply, seen: { lookups: Array<{ host: string; addrs: unknown }>; requests: number } = { lookups: [], requests: 0 }): RequestFn {
  return ((opts: any, cb: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = () => undefined;
    opts.signal?.addEventListener('abort', () => req.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })));
    req.end = () => {
      seen.requests += 1;
      opts.lookup(opts.hostname, { all: true }, (err: unknown, addrs: unknown) => {
        if (err) return req.emit('error', err);
        seen.lookups.push({ host: opts.hostname, addrs });
        const r = route(opts.hostname, opts.path, opts.headers ?? {});
        if (r.never) return;
        const res = new PassThrough() as any;
        res.statusCode = r.status;
        res.headers = r.headers ?? {};
        cb(res);
        if (r.drip) {
          const t = setInterval(() => res.write('X'), 20);
          res.on('close', () => clearInterval(t));
          opts.signal?.addEventListener('abort', () => clearInterval(t));
          return;
        }
        res.end(r.body ?? '');
      });
    };
    return req;
  }) as unknown as RequestFn;
}

const publicDns: Resolve = (_host, _opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
const dnsTo = (...ips: string[]): Resolve => (_host, _opts, cb) => cb(null, ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

function noLeak(err: unknown, token = 'LEAKCHECK') {
  const texts = [String((err as Error).message), String((err as Error).stack), inspect(err, { showHidden: true, depth: 5 }), JSON.stringify(err)];
  for (const t of texts) assert(!t.includes(token), `the error leaks the token: ${t.slice(0, 200)}`);
}

// ── Sync rules ───────────────────────────────────────────────────────────────

function snap(over: Partial<StaySnap> = {}): StaySnap {
  const checkIn = over.checkIn ?? '2026-10-10';
  const checkOut = over.checkOut ?? '2026-10-15';
  const inst = stayInstants(checkIn, checkOut, ZRH, { checkIn: null, checkOut: null });
  return {
    id: 'st_1',
    status: 'confirmed',
    checkIn,
    checkOut,
    checkInAt: inst.checkInAt,
    checkOutAt: inst.checkOutAt,
    nights: inst.nights,
    datesVersion: 1,
    missingCount: 0,
    lastMissAt: null,
    contactId: null,
    linkedAt: null,
    linkMode: null,
    overlapWith: [],
    lastSeenInFeedAt: Date.UTC(2026, 9, 1),
    ...over,
  };
}

async function main() {
  console.log('\niCal reader');

  await test('Airbnb (current format): 3 reservations, back-to-back kept apart, blocks ignored', () => {
    const p = parseIcal(F1, ZRH);
    assertEqual(p.source, 'airbnb', 'source');
    assertEqual(p.stays.map((s) => [s.checkIn, s.checkOut, s.nights]), [['2026-09-27', '2026-10-03', 6], ['2026-10-03', '2026-10-08', 5], ['2026-12-20', '2026-12-27', 7]], 'stays');
    assertEqual(p.stays[0].uid, '1418fb94e984-00000000000000000000000000000001@airbnb.com', 'the UID, unfolded');
    assertEqual([p.counts.ignored, p.counts.skippedLong], [2, 1], 'blocks ignored (the year-long tail is also over 90 nights)');
    assertEqual(isUnsupported(p, false), false, 'supported');
    assertEqual(Object.keys(p.stays[0]).sort(), ['checkIn', 'checkOut', 'nights', 'uid'], 'only uid and dates — no text, no code, no phone digits');
  });

  await test('the next day: the same UID with new dates, one booking gone; the hash ignores DTSTAMP', () => {
    const a = parseIcal(F1, ZRH);
    const b = parseIcal(F2, ZRH);
    const two = b.stays.find((s) => s.uid.includes('0002'))!;
    assertEqual([two.checkIn, two.checkOut], ['2026-10-03', '2026-10-06'], 'new dates, same UID');
    assert(!b.stays.some((s) => s.uid.includes('0003')), 'HMXXXXXXX3 is gone');
    assert(staysHash(a.stays) !== staysHash(b.stays), 'a change changes the hash');
    const restamped = F1.replace(/DTSTAMP:20261001T061512Z/g, 'DTSTAMP:20261001T101010Z');
    assertEqual(staysHash(parseIcal(restamped, ZRH).stays), staysHash(a.stays), 'a new DTSTAMP alone is the same content');
  });

  await test('legacy Airbnb 0.8.8: PRODID parameter, no DTSTAMP, DTEND first, folded at 73', () => {
    const p = parseIcal(F5_LEGACY, ZRH);
    assertEqual(p.source, 'airbnb', 'source');
    assertEqual(p.stays.map((s) => [s.checkIn, s.checkOut]), [['2026-10-11', '2026-10-18']], 'one stay');
  });

  await test('an Airbnb feed with no reservations, and an empty feed: normal, 0 stays, supported', () => {
    const p = parseIcal(F6_EMPTY, ZRH);
    assertEqual([p.source, p.stays.length, isUnsupported(p, false)], ['airbnb', 0, false], 'empty Airbnb');
    const onlyBlocks = parseIcal(crlf([...AIRBNB_HEAD, ...airbnbBlock('b', '20261101', '20261105'), 'END:VCALENDAR']), ZRH);
    assertEqual([onlyBlocks.stays.length, isUnsupported(onlyBlocks, false)], [0, false], 'blocks only');
    const generic = parseIcal(crlf(['BEGIN:VCALENDAR', 'PRODID:-//X//Y//EN', 'END:VCALENDAR']), ZRH);
    assertEqual([generic.source, isUnsupported(generic, false)], ['generic', false], 'an empty generic feed is fine');
  });

  await test('Booking.com: no stays, unsupported (its bookings and closures look the same)', () => {
    const p = parseIcal(F8_BOOKING, ZRH);
    assertEqual([p.source, p.stays.length, isUnsupported(p, false)], ['booking', 0, true], 'booking');
    assertEqual(isUnsupported(p, true), false, 'but a feed that gave a stay stays supported, whatever it looks like now');
    const noProdid = parseIcal(F8_BOOKING.replace(/PRODID:[^\r]*\r\n/, 'PRODID:-//Other//EN\r\n').replace(/@booking\.com/g, '@x.test'), ZRH);
    assertEqual(noProdid.source, 'booking', 'recognised by its "CLOSED - Not available" events too');
  });

  await test('a Guesty-style feed (names in SUMMARY): 0 stays, unsupported until it ever gave a stay', () => {
    const p = parseIcal(F12_NAMES, ZRH);
    assertEqual([p.source, p.stays.length, p.hasReservedEvent], ['generic', 0, false], '"GUESTNAME5 - Reserved" is not a reservation (anchored)');
    assertEqual(isUnsupported(p, false), true, 'unsupported');
    assertEqual(isUnsupported(p, true), false, 'a feed that once gave a stay stays supported');
  });

  await test('VRBO: "Reserved - <name>" is a stay (LF only); later without it, still supported once it gave one', () => {
    const p = parseIcal(F10_VRBO, ZRH);
    assertEqual(p.source, 'generic', 'VRBO is generic');
    assertEqual(p.stays.map((s) => [s.checkIn, s.checkOut]), [['2026-06-12', '2026-06-15'], ['2026-10-09', '2026-10-12']], 'both reservations (the sync skips the ended one)');
    assertEqual(isUnsupported(p, false), false, 'supported');
    const later = parseIcal(F10_VRBO_LATER, ZRH);
    assertEqual([later.stays.length, isUnsupported(later, false), isUnsupported(later, true)], [0, true, false], 'after its only booking went: supported because reservedSeen');
  });

  await test('a PMS feed passing Booking.com events through: its "Reserved" events are stays; with only a closure left, its misses still count', () => {
    const head = VRBO_HEAD.map((l) => (l.startsWith('PRODID') ? 'PRODID:-//Some PMS//EN' : l));
    const closure = ['BEGIN:VEVENT', 'UID:8736@booking.com', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261022', 'SUMMARY:CLOSED - Not available', 'END:VEVENT'];
    const p = parseIcal([...head, ...vrboEvent('1', '20261009', '20261012', 'Reserved - GUESTNAME1'), ...closure, 'END:VCALENDAR'].join('\n'), ZRH);
    assertEqual([p.source, p.stays.length, isUnsupported(p, false)], ['generic', 1, false], 'a Booking.com UID and closure next to a reservation: generic, 1 stay');
    // Tom's booking is cancelled: only the Booking.com closure is left.
    const later = parseIcal([...head, ...closure, 'END:VCALENDAR'].join('\n'), ZRH);
    assertEqual([later.source, later.stays.length], ['booking', 0], 'now it looks like Booking.com');
    assertEqual([isUnsupported(later, true), isUnsupported(later, false)], [false, true], 'supported because it gave a stay (so the sync counts the miss); unsupported for a feed that never did');
  });

  await test('generic duplicate UIDs merge (earliest start, latest end); no overlap', () => {
    const p = parseIcal(F4_DUPLICATES, ZRH);
    assertEqual(p.stays.map((s) => [s.uid, s.checkIn, s.checkOut, s.nights]), [['dup-1@example-pms.test', '2026-10-15', '2026-10-30', 15], ['dup-2@example-pms.test', '2026-11-02', '2026-11-09', 7]], 'merged');
    assertEqual(p.counts.duplicateUid, 2, 'counted');
  });

  await test('edge cases: BOM, TAB fold, a fold inside "ü", quoted TZID, lower-case names, UTC, DURATION, CANCELLED, RRULE, end<start, no UID', () => {
    const p = parseIcal(f11(), ZRH);
    assertEqual(
      p.stays.map((s) => [s.uid, s.checkIn, s.checkOut]),
      [['edge-2@example-pms.test', '2026-10-20', '2026-10-22'], ['edge-4@example-pms.test', '2026-11-05', '2026-11-08'], ['müller-8@example-pms.test', '2026-12-28', '2026-12-30']],
      'stays',
    );
    assertEqual(p.counts.cancelled, 1, 'STATUS:CANCELLED dropped');
    assertEqual(p.counts.skippedRecurring, 1, 'RRULE skipped');
    assertEqual(p.counts.skippedInvalid, 2, 'end before start + no UID (never a made-up UID)');
    assertEqual(p.counts.ignored, 2, 'a guest name and "Blocked" are not stays');
    assertEqual(p.source, 'generic', 'generic');
  });

  await test('a VALARM description never counts as the event\'s', () => {
    const cal = crlf([
      ...AIRBNB_HEAD,
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20261101',
      'DTEND;VALUE=DATE:20261103',
      'SUMMARY:Something else',
      'UID:x-1@airbnb.com',
      'BEGIN:VALARM',
      'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMX',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    assertEqual(parseIcal(cal, ZRH).stays.length, 0, 'no stay from the alarm text');
  });

  await test('longer than 90 nights is skipped, from any source; floating and Windows-zone times use the venue zone', () => {
    const long = parseIcal(crlf([...AIRBNB_HEAD, ...airbnbEvent('9', '20261001', '20270105', 'HMX'), 'END:VCALENDAR']), ZRH);
    assertEqual([long.stays.length, long.counts.skippedLong], [0, 1], 'Airbnb, 96 nights');
    assertEqual(long.skippedLongUids, ['1418fb94e984-9@airbnb.com'], 'its UID is kept: a known stay extended past 90 nights is seen, not missing');
    assertEqual(staysHash(long.stays, long.skippedLongUids) === staysHash([], []), false, 'and it counts in the hash (its leaving is a change)');
    assertEqual(staysHash([], []), staysHash([]), 'no over-long ones: the same hash as before');
    const block = parseIcal(crlf([...AIRBNB_HEAD, 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20270105', 'SUMMARY:Airbnb (Not available)', 'UID:blk@airbnb.com', 'END:VEVENT', 'END:VCALENDAR']), ZRH);
    assertEqual(block.skippedLongUids, [], 'a long block is not a reservation');
    const tz = parseIcal(
      crlf([
        'BEGIN:VCALENDAR',
        'PRODID:-//X//Y//EN',
        'BEGIN:VEVENT',
        'UID:w@x.test',
        'DTSTART;TZID=W. Europe Standard Time:20261012T233000',
        'DTEND:20261014T100000',
        'SUMMARY:Reserved',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
      'America/New_York',
    );
    assertEqual([tz.stays[0].checkIn, tz.stays[0].checkOut], ['2026-10-12', '2026-10-14'], 'venue-local dates');
  });

  await test('not a calendar, or cut off: an error (never "all bookings are gone")', () => {
    assert(looksLikeIcal(Buffer.from('﻿  BEGIN:VCALENDAR\r\n')), 'BOM + whitespace');
    assert(!looksLikeIcal('<!DOCTYPE html><html>Not Found</html>'), 'HTML');
    for (const [body, code] of [['<html></html>', 'NOT_ICAL'], [F1.slice(0, F1.length - 40), 'TRUNCATED']] as const) {
      try {
        parseIcal(body, ZRH);
        throw new Error('did not throw');
      } catch (err) {
        assert(err instanceof IcalParseError && err.code === code, `${code}: ${String(err)}`);
      }
    }
  });

  await test('date helpers', () => {
    assertEqual([addDays('2026-10-31', 1), addDays('2026-03-01', -1), daysBetween('2026-10-23', '2026-10-27')], ['2026-11-01', '2026-02-28', 4], 'calendar days');
    assertEqual([parseDuration('P3D'), parseDuration('P1W'), parseDuration('PT36H'), parseDuration('-P1D'), parseDuration('P')], [3 * 86_400_000, 7 * 86_400_000, 36 * 3_600_000, null, null], 'durations');
  });

  // ===========================================================================
  console.log('\nSafe fetcher');

  await test('refuses http, other schemes, credentials, other ports, IP literals and local names — before any request', async () => {
    const seen = { lookups: [] as any[], requests: 0 };
    const request = fakeRequest(() => ({ status: 200, body: 'BEGIN:VCALENDAR' }), seen);
    const cases: Array<[string, string]> = [
      ['http://www.airbnb.com/calendar/ical/1.ics?s=abc', 'NOT_HTTPS'],
      ['sandbox:calendar/retreat', 'NOT_HTTPS'],
      ['ftp://x.test/a.ics', 'NOT_HTTPS'],
      ['https://user:pw@www.airbnb.com/a.ics', 'CREDENTIALS_IN_URL'],
      ['https://www.airbnb.com:8443/a.ics', 'BAD_PORT'],
      ['https://169.254.169.254/latest/meta-data', 'IP_LITERAL'],
      ['https://[fd00:ec2::254]/', 'IP_LITERAL'],
      ['https://0x7f.1/', 'IP_LITERAL'],
      ['https://2130706433/', 'IP_LITERAL'],
      ['https://[::ffff:7f00:1]/', 'IP_LITERAL'],
      ['https://localhost/a.ics', 'BLOCKED_HOST'],
      ['https://metadata.google.internal/computeMetadata/v1/', 'BLOCKED_HOST'],
      ['https://intranet/a.ics', 'BLOCKED_HOST'],
    ];
    for (const [url, code] of cases) await rejectsWith(fetchFeed(url, { resolve: publicDns, request }), code, url);
    assertEqual(seen.requests, 0, 'no request was made');
  });

  await test('refuses private, loopback, link-local, metadata, CGNAT, NAT64 and IPv4-mapped addresses (the real https.request + lookup)', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.17.0.2', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'fd00:ec2::254', 'fe80::1', '64:ff9b::a9fe:a9fe']) {
      assert(isBlockedIp(ip), `${ip} is blocked`);
      await rejectsWith(fetchFeed('https://calendar.example.test/a.ics?s=LEAKCHECK', { resolve: dnsTo(ip), timeoutMs: 3000 }), 'BLOCKED_ADDRESS', ip);
    }
    await rejectsWith(fetchFeed('https://calendar.example.test/a.ics', { resolve: dnsTo('93.184.216.34', '10.0.0.5'), timeoutMs: 3000 }), 'BLOCKED_ADDRESS', 'a public + private mix');
    assert(!isBlockedIp('93.184.216.34') && !isBlockedIp('2606:4700::6810:84e5'), 'public addresses pass');
    assert(isBlockedIp('::7f00:1') && isBlockedIp('::a9fe:a9fe') && isBlockedIp('::'), 'IPv4-compatible ::a.b.c.d (::/96) and :: are blocked');
  });

  await test('a public https host: 200 with the body, the checked IP pinned, no final URL in the result', async () => {
    const seen = { lookups: [] as any[], requests: 0 };
    let sentHeaders: Record<string, string> = {};
    const r = await fetchFeed('https://www.airbnb.com/calendar/ical/1.ics?s=abc', {
      resolve: publicDns,
      etag: '"v1"',
      request: fakeRequest((_h, _p, headers) => {
        sentHeaders = headers;
        return { status: 200, headers: { etag: '"v2"' }, body: F1 };
      }, seen),
    });
    assertEqual([r.status, r.etag, r.body?.toString('utf8') === F1], [200, '"v2"', true], 'the answer');
    assertEqual(Object.keys(r).sort(), ['body', 'etag', 'status'], 'nothing else — no finalUrl');
    assertEqual((seen.lookups[0].addrs as any[])[0].address, '93.184.216.34', 'the socket gets the checked address');
    assertEqual([sentHeaders['if-none-match'], sentHeaders['accept-encoding']], ['"v1"', 'identity'], 'conditional GET, no compression asked');
  });

  await test('redirects: each hop re-checked (http, IP literal, private DNS); malformed Location → BAD_REDIRECT without the token; at most 3', async () => {
    const hop = (location: string) => fakeRequest((host) => (host === 'admin.booking.com' ? { status: 302, headers: { location } } : { status: 200, body: 'BEGIN:VCALENDAR' }));
    await rejectsWith(fetchFeed('https://admin.booking.com/ical.html?t=x', { resolve: publicDns, request: hop('http://ical.booking.com/v1/export') }), 'NOT_HTTPS', 'to http');
    await rejectsWith(fetchFeed('https://admin.booking.com/ical.html?t=x', { resolve: publicDns, request: hop('https://127.0.0.1/x') }), 'IP_LITERAL', 'to an IP');
    const privateSecondHop: Resolve = (host, _o, cb) => cb(null, [{ address: host === 'admin.booking.com' ? '93.184.216.34' : '10.0.0.7', family: 4 }]);
    await rejectsWith(fetchFeed('https://admin.booking.com/ical.html?t=x', { resolve: privateSecondHop, request: hop('https://ical.booking.com/v1/export?t=x') }), 'BLOCKED_ADDRESS', 'to a private address');
    const bad = await rejectsWith(fetchFeed('https://admin.booking.com/ical.html?t=LEAKCHECK', { resolve: publicDns, request: hop('https://ical.booking.com:99999/v1/export') }), 'BAD_REDIRECT', 'malformed Location');
    noLeak(bad);
    const ok = await fetchFeed('https://admin.booking.com/ical.html?t=x', { resolve: publicDns, request: hop('https://ical.booking.com/v1/export?t=x') });
    assertEqual(ok.status, 200, 'a good redirect is followed');
    const loop = fakeRequest(() => ({ status: 301, headers: { location: 'https://www.airbnb.com/next' } }));
    await rejectsWith(fetchFeed('https://www.airbnb.com/a', { resolve: publicDns, request: loop }), 'TOO_MANY_REDIRECTS', 'loop');
    await rejectsWith(fetchFeed('https://www.airbnb.com/a', { resolve: publicDns, request: fakeRequest(() => ({ status: 302 })) }), 'REDIRECT_WITHOUT_LOCATION', 'no Location');
  });

  await test('a malformed link → BAD_URL, and LEAKCHECK is in no error text', async () => {
    const err = await rejectsWith(fetchFeed('https://www.airbnb.com:99999/x.ics?s=LEAKCHECK'), 'BAD_URL', 'bad port number');
    noLeak(err);
  });

  await test('1 MB cap: by Content-Length, while streaming, and after decompressing', async () => {
    const big = Buffer.alloc(1_100_000, 65);
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 200, headers: { 'content-length': String(big.length) }, body: big })) }), 'TOO_LARGE', 'content-length');
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 200, body: big })) }), 'TOO_LARGE', 'streamed');
    const bomb = gzipSync(Buffer.alloc(3_000_000, 66));
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: bomb })) }), 'TOO_LARGE', 'gzip bomb');
    const small = await fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(F6_EMPTY)) })) });
    assertEqual(small.body?.toString('utf8'), F6_EMPTY, 'a gzipped calendar is decoded');
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 200, headers: { 'content-encoding': 'br' }, body: 'x' })) }), 'BAD_ENCODING', 'unknown encoding');
  });

  await test('one deadline for the whole chain: a silent server and a dripping body both stop at the deadline', async () => {
    const t0 = Date.now();
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, timeoutMs: 300, request: fakeRequest(() => ({ status: 200, never: true })) }), 'TIMEOUT', 'no answer');
    await rejectsWith(fetchFeed('https://a.example.test/', { resolve: publicDns, timeoutMs: 300, request: fakeRequest(() => ({ status: 200, drip: true })) }), 'TIMEOUT', 'dripping body');
    assert(Date.now() - t0 < 2000, 'both ended near the deadline');
  });

  await test('status codes pass through (304, 404) with no body', async () => {
    const r = await fetchFeed('https://a.example.test/', { resolve: publicDns, etag: '"x"', request: fakeRequest(() => ({ status: 304, headers: { etag: '"x"' } })) });
    assertEqual([r.status, r.etag, r.body], [304, '"x"', undefined], '304');
    const nf = await fetchFeed('https://a.example.test/', { resolve: publicDns, request: fakeRequest(() => ({ status: 404, body: '<html>Not Found</html>' })) });
    assertEqual([nf.status, nf.body], [404, undefined], '404');
  });

  await test('an env proxy (NODE_USE_ENV_PROXY + HTTPS_PROXY) never skips the address check', async () => {
    const script = `
      const { fetchFeed } = require(${JSON.stringify(path.resolve(__dirname, '../src/adaptive/stays/fetch.ts'))});
      let calls = 0;
      fetchFeed('https://calendar.example.test/a.ics', { timeoutMs: 3000, resolve: (h, o, cb) => { calls += 1; cb(null, [{ address: '10.0.0.1', family: 4 }]); } })
        .then(() => console.log('RESULT ok ' + calls), (e) => console.log('RESULT ' + e.code + ' ' + calls));`;
    // The same node + tsx loader this test runs under.
    const out = spawnSync(process.execPath, [...process.execArgv, '-e', script], { env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 20_000 });
    const line = (out.stdout || '').split('\n').find((l) => l.startsWith('RESULT')) ?? `(no result) ${out.stderr?.slice(0, 300)}`;
    assertEqual(line.trim(), 'RESULT BLOCKED_ADDRESS 1', 'the resolver ran and refused the private address');
  });

  // ===========================================================================
  console.log('\nStay times, moments and the poll grid');

  await test('valid times are HH:MM between 06:00 and 22:00; en first, then the others alphabetically', () => {
    assertEqual(['15:00', '06:00', '22:00', '9:00', '25:00', '23:30', '05:59', '22:01', '10 Uhr', null].map(validStayTime), ['15:00', '06:00', '22:00', null, null, null, null, null, null, null], 'validity');
    assertEqual(resolveStayTimes({ locales: { en: { checkInTime: '4pm', checkOutTime: '10:00' }, fr: { checkInTime: '17:00' }, de: { checkInTime: '16:00' } } }), { checkIn: '16:00', checkOut: '10:00' }, 'en, then de before fr');
    assertEqual(resolveStayTimes({ locales: { de: { checkOutTime: '10 Uhr' } } }), { checkIn: null, checkOut: null }, 'none valid');
    assertEqual(resolveStayTimes(null), { checkIn: null, checkOut: null }, 'no Guest info');
  });

  await test('stay instants across the DST change (23 → 27 Oct 2026, checkout 10:00 CET)', () => {
    const i = stayInstants('2026-10-23', '2026-10-27', ZRH, { checkIn: null, checkOut: null });
    assertEqual([new Date(i.checkInAt).toISOString(), new Date(i.checkOutAt).toISOString(), i.nights], ['2026-10-23T13:00:00.000Z', '2026-10-27T09:00:00.000Z', 4], 'CEST check-in, CET checkout');
    assertEqual(DEFAULT_CHECK_IN, '15:00', 'default check-in');
  });

  await test('moments for the five trigger configs, from local dates (Tom: 5 nights from 12 Oct)', () => {
    const i = stayInstants('2026-10-12', '2026-10-17', ZRH, { checkIn: '15:00', checkOut: '10:00' });
    const local = (y: number, mo: number, d: number, h: number) => zonedTime(y, mo, d, h, 0, ZRH).getTime();
    assertEqual(momentFor(i.checkInAt, ZRH, '17:00', 0), local(2026, 10, 12, 17), 'stay guide: arrival day 17:00');
    assertEqual(momentFor(i.checkInAt, ZRH, '10:00', 1), local(2026, 10, 13, 10), 'local tips: day 2 10:00');
    assertEqual(momentFor(i.checkOutAt, ZRH, '17:00', -1), local(2026, 10, 16, 17), 'checkout reminder: the day before 17:00');
    assertEqual(momentFor(i.checkOutAt, ZRH, '15:00', 0), local(2026, 10, 17, 15), 'review: checkout day 15:00');
    assertEqual(momentFor(i.checkOutAt, ZRH, '10:00', 3), local(2026, 10, 20, 10), 'book direct: +3 days 10:00');
    const dst = stayInstants('2026-10-23', '2026-10-28', ZRH, { checkIn: null, checkOut: null });
    assertEqual(momentFor(dst.checkInAt, ZRH, '10:00', 2), local(2026, 10, 25, 10), 'across the DST night: still 10:00 local');
  });

  await test('late moments: up to 12 h late runs now, later is skipped', () => {
    const m = Date.UTC(2026, 9, 12, 15);
    assertEqual([planMoment(m, m - 1).kind, planMoment(m, m).kind, planMoment(m, m + 12 * 3_600_000).kind, planMoment(m, m + 12 * 3_600_000 + 1).kind], ['later', 'now', 'now', 'too_late'], 'plans');
    assert(stayTriggerKey('st_1', 'stay_guide', 1, m) !== stayTriggerKey('st_1', 'stay_guide', 3, m), 'dates A → B → A get a new key (datesVersion)');
  });

  await test('the poll grid: every restart lands on the same next slot; Sync now has its own key', () => {
    const feed = 'venue_venue_retreat';
    const t = Date.UTC(2026, 9, 12, 9, 0);
    const a = nextPollSlot(feed, t);
    const b = nextPollSlot(feed, t + 60_000);
    const c = nextPollSlot(feed, a.dueAt - 1);
    assertEqual([a.key, b.key], [c.key, c.key], 'a save, the watchdog and Sync now in the same slot share one key');
    assert(a.dueAt > t && a.dueAt - t <= POLL_EVERY_MS, 'due within the next 4 h');
    const afterRun = nextPollSlot(feed, a.dueAt);
    assertEqual([afterRun.slot, afterRun.dueAt - a.dueAt], [a.slot + 1, POLL_EVERY_MS], 'the chain re-arms exactly one slot on');
    assert(nextPollSlot('venue_other', t).dueAt !== a.dueAt, 'feeds are spread over the cycle');
    assertEqual(syncNowKey(feed, t), syncNowKey(feed, t + 59_000), 'clicks in the same minute share one Sync now');
  });

  // ===========================================================================
  console.log('\nSync rules');

  const today = '2026-10-12';
  const now = Date.UTC(2026, 9, 12, 8);
  const inst = (s: StaySnap) => ({ checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, nights: s.nights });

  await test('upserts: new, changed dates, back after a cancel, the same (reset or not on a suspect parse), already over', () => {
    const s = snap();
    assertEqual(decideUpsert(null, { checkIn: '2026-10-10', checkOut: '2026-10-15' }, inst(s), { today, now, resetMisses: true }).kind, 'create', 'new');
    assertEqual(decideUpsert(null, { checkIn: '2026-10-01', checkOut: '2026-10-11' }, inst(s), { today, now, resetMisses: true }).kind, 'none', 'already over: not created');
    const moved = stayInstants('2026-10-10', '2026-10-16', ZRH, { checkIn: null, checkOut: null });
    assertEqual(decideUpsert(s, { checkIn: '2026-10-10', checkOut: '2026-10-16' }, moved, { today, now, resetMisses: true }).kind, 'change', 'new dates');
    const newTime = stayInstants('2026-10-10', '2026-10-15', ZRH, { checkIn: null, checkOut: '11:00' });
    assertEqual(decideUpsert(s, { checkIn: '2026-10-10', checkOut: '2026-10-15' }, newTime, { today, now, resetMisses: true }).kind, 'change', 'a new Guest info time is a change too');
    assertEqual(decideUpsert(snap({ status: 'cancelled' }), { checkIn: '2026-10-10', checkOut: '2026-10-15' }, inst(s), { today, now, resetMisses: true }).kind, 'reinstate', 'back after a cancel (same dates)');
    const missed = snap({ missingCount: 1, lastMissAt: now - 3_600_000 });
    assertEqual(decideUpsert(missed, { checkIn: '2026-10-10', checkOut: '2026-10-15' }, inst(s), { today, now, resetMisses: true }).kind, 'reset', 'seen again → reset');
    // The sync always resets a stay that is in the content (also on a suspect parse); the flag stays for callers that don't.
    assert(decideUpsert(missed, { checkIn: '2026-10-10', checkOut: '2026-10-15' }, inst(s), { today, now, resetMisses: false }).kind !== 'reset', 'with resetMisses off nothing is reset');
  });

  await test('misses: 30 min apart on the engine clock, cancelled at 2, never once checkout day has come', () => {
    assertEqual(decideMiss(snap(), { today, now }), { kind: 'miss', count: 1 }, 'first miss');
    assertEqual(decideMiss(snap({ missingCount: 1, lastMissAt: now - 10 * 60_000 }), { today, now }), { kind: 'none', why: 'too_soon' }, 'two syncs back to back count one');
    assertEqual(decideMiss(snap({ missingCount: 1, lastMissAt: now - 30 * 60_000 }), { today, now }), { kind: 'cancel', count: 2 }, '30 min later: cancelled');
    assertEqual(decideMiss(snap({ checkOut: today }), { today, now }), { kind: 'none', why: 'frozen' }, 'checkout day: frozen');
    assertEqual(decideMiss(snap({ status: 'cancelled' }), { today, now }), { kind: 'none', why: 'cancelled' }, 'already cancelled');
    assert(isCountable(snap(), today) && !isCountable(snap({ checkOut: today }), today) && isCountable(snap({ status: 'overlap_flagged' }), today), 'countable');
  });

  await test('the suspect-parse guard: 2+ absent holds misses for 24 h, one absent never does', () => {
    assertEqual(suspectState(1, null, now), { suspect: false, warning: null, suspectSince: null, raise: false }, 'one missing: the plain rule');
    assertEqual(suspectState(2, null, now), { suspect: true, warning: 'mass_missing', suspectSince: now, raise: true }, 'two missing: suspect, one alert');
    assertEqual(suspectState(3, now - 23 * 3_600_000, now), { suspect: true, warning: 'mass_missing', suspectSince: now - 23 * 3_600_000, raise: false }, 'still inside 24 h: no new alert');
    assertEqual(suspectState(2, now - 24 * 3_600_000, now).suspect, false, 'after 24 h the misses count');
    assertEqual(suspectState(0, now - 3_600_000, now).warning, null, 'a normal parse clears it');
  });

  await test('overlaps: half-open ranges (back-to-back is not one); cancelled and ended stays ignored', () => {
    const a = snap({ id: 'a', checkIn: '2026-10-10', checkOut: '2026-10-15' });
    const b = snap({ id: 'b', checkIn: '2026-10-15', checkOut: '2026-10-18' });
    const c = snap({ id: 'c', checkIn: '2026-10-14', checkOut: '2026-10-16' });
    const d = snap({ id: 'd', checkIn: '2026-10-14', checkOut: '2026-10-16', status: 'cancelled' });
    const m = overlapMap([a, b, c, d], today);
    assertEqual([m.get('a'), m.get('b'), m.get('c'), m.has('d')], [['c'], ['c'], ['a', 'b'], false], 'overlaps');
    assertEqual(overlapMap([a, b], today).get('a'), [], 'back to back');
  });

  await test('a feed keeps syncing while off only for a linked stay not over (checkout + 3 days)', () => {
    assert(isCurrentLinked(snap({ contactId: 'c1', checkOut: '2026-10-09' }), today), 'checkout 3 days ago: still current (book direct)');
    assert(!isCurrentLinked(snap({ contactId: 'c1', checkOut: '2026-10-08' }), today), '4 days ago: over');
    assert(!isCurrentLinked(snap(), today) && !isCurrentLinked(snap({ contactId: 'c1', status: 'cancelled' }), today), 'unlinked or cancelled');
  });

  console.log('\nThe saved link as shown');
  await test('the owner sees the host and ".ics" only — no path character, no query (the secret)', () => {
    assertEqual(maskFeedUrl('https://www.airbnb.com/calendar/ical/12345678.ics?s=abcdefLEAKCHECK'), 'https://www.airbnb.com/….ics', 'Airbnb');
    assertEqual(maskFeedUrl('https://www.vrbo.com/icalendar/0a1b2c3dLEAKCHECK9f8e.ics'), 'https://www.vrbo.com/….ics', 'a secret in the path');
    assertEqual(maskFeedUrl('https://admin.booking.com/hotel/hoteladmin/ical.html?t=LEAKCHECK'), 'https://admin.booking.com/…', 'not .ics');
    assertEqual(maskFeedUrl('https://calendar.example/LEAKCHECK.ICS'), 'https://calendar.example/….ics', 'upper-case .ICS');
    assertEqual(maskFeedUrl('not a link LEAKCHECK'), '(hidden)', 'unparseable');
    assertEqual(maskFeedUrl('sandbox:calendar/retreat'), 'sandbox:calendar/retreat', 'a sandbox name holds no secret');
  });

  console.log('\nHygiene');
  await test('no unhandled rejections escaped', async () => {
    await new Promise((r) => setTimeout(r, 400));
    assertEqual(unhandled.length, 0, 'unhandled rejections');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
