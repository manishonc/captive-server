/**
 * The owner's results maths and "Who gets messages" counts (PR D, D-D2, D-D16, D-D17):
 * the date range (venue-local days across both DST switches of 2026, the 30-day default,
 * the 92-day cap, impossible dates), stats doc day keys, deep sums with test runs kept
 * apart, the running card and its revenue estimate; the audience class keys, the counts
 * and reachable guests under every audience choice (SMS countries, unknown countries,
 * keys without a country), and the audience reading pinned to the engine's own
 * (engine/context.ts).
 *
 * Run: npx tsx tests/adaptiveOwnerResults.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  RETURN_VISIT_GOALS,
  addDaysIso,
  addDeep,
  cardNumbers,
  dayKeyOf,
  resultsRange,
  sumStats,
  type NumMap,
  waitingByVenue,
  type FlaggedWait,
} from '../src/adaptive/core/owner/results';
import {
  DEFAULT_AUDIENCE,
  audienceCounts,
  classKey,
  classKeyWithCountry,
  effectiveAudience,
  reachableUnder,
  type Audience,
} from '../src/adaptive/core/owner/audience';
import { DAY_MS, HOUR_MS, MINUTE_MS, localDateKey } from '../src/adaptive/core/runtime/time';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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

const ZRH = 'Europe/Zurich';
const NYC = 'America/New_York';
const TODAY = '2026-09-25';
const BAD_FORMAT = 'Use real calendar dates, like 2026-09-25';

type Range = { from: string; to: string; days: string[] };

function range(from: unknown, to: unknown, today = TODAY): Range {
  const r = resultsRange(from, to, today);
  if ('error' in r) throw new Error(`unexpected error "${r.error}" for ${String(from)}…${String(to)}`);
  return r;
}

function refusal(from: unknown, to: unknown, today = TODAY): string {
  let r: ReturnType<typeof resultsRange>;
  try {
    r = resultsRange(from, to, today);
  } catch (e) {
    throw new Error(`threw ${(e as Error).name}: ${(e as Error).message} for ${String(from)}…${String(to)} (should answer an error sentence)`);
  }
  if (!('error' in r)) throw new Error(`accepted ${String(from)}…${String(to)} (${r.days.length} days)`);
  return r.error;
}

/** Consecutive calendar days, each once. */
function assertConsecutive(days: string[], msg: string) {
  assertEqual(new Set(days).size, days.length, `${msg}: no day twice`);
  for (let i = 1; i < days.length; i += 1) {
    const gap = Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`);
    assertEqual(gap, DAY_MS, `${msg}: ${days[i - 1]} → ${days[i]} is one day`);
  }
}

/** Local days of every 15-minute instant in [startMs, endMs), with how many hours each has. */
function localHours(startMs: number, endMs: number, tz: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let t = startMs; t < endMs; t += 15 * MINUTE_MS) {
    const k = localDateKey(new Date(t), tz);
    out.set(k, (out.get(k) ?? 0) + 0.25);
  }
  return out;
}

// ── Date range ───────────────────────────────────────────────────────────────

test('the range across the autumn switch (25 Oct 2026): each day once', () => {
  const r = range('2026-10-20', '2026-10-30');
  assertEqual(r.days.length, 11, 'eleven days');
  assertEqual([r.days[0], r.days[10]], ['2026-10-20', '2026-10-30'], 'ends');
  assertEqual(r.days.filter((d) => d === '2026-10-25').length, 1, '25 Oct once');
  assertConsecutive(r.days, 'autumn');
  // The switch day has 25 hours in Zurich; every one of them is filed under a day in the range.
  const hours = localHours(Date.parse('2026-10-23T22:00:00Z'), Date.parse('2026-10-26T23:00:00Z'), ZRH);
  assertEqual([...hours.keys()], range('2026-10-24', '2026-10-26').days, 'the local days are the range days');
  assertEqual([...hours.values()], [24, 25, 24], 'hours per local day');
});

test('the range across the spring switch (29 Mar 2026): each day once', () => {
  const r = range('2026-03-25', '2026-04-02');
  assertEqual(r.days, ['2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02'], 'days');
  assertConsecutive(r.days, 'spring');
  const hours = localHours(Date.parse('2026-03-27T23:00:00Z'), Date.parse('2026-03-30T22:00:00Z'), ZRH);
  assertEqual([...hours.keys()], range('2026-03-28', '2026-03-30').days, 'the local days are the range days');
  assertEqual([...hours.values()], [24, 23, 24], 'hours per local day');
});

test('a 92-day range over both switches', () => {
  const r = range('2026-03-01', '2026-05-31');
  assertEqual(r.days.length, 92, '92 days');
  assertConsecutive(r.days, 'spring quarter');
  const a = range('2026-08-26', '2026-11-25');
  assertEqual(a.days.length, 92, '92 days');
  assertConsecutive(a.days, 'autumn quarter');
  assert(a.days.includes('2026-10-25') && a.days.includes('2026-10-26'), 'the switch days are in');
});

test("'today' near the autumn switch in Zurich", () => {
  assertEqual(localDateKey(new Date('2026-10-24T22:30:00Z'), ZRH), '2026-10-25', '22:30Z is 00:30 on the 25th');
  assertEqual(localDateKey(new Date('2026-10-24T21:59:59.999Z'), ZRH), '2026-10-24', '1 ms before local midnight (CEST)');
  assertEqual(localDateKey(new Date('2026-10-24T22:00:00.000Z'), ZRH), '2026-10-25', 'local midnight (CEST)');
  assertEqual(localDateKey(new Date('2026-10-25T22:59:59.999Z'), ZRH), '2026-10-25', '1 ms before the next midnight (CET)');
  assertEqual(localDateKey(new Date('2026-10-25T23:00:00.000Z'), ZRH), '2026-10-26', 'the next midnight (CET)');
  const r = range(undefined, undefined, localDateKey(new Date('2026-10-24T22:30:00Z'), ZRH));
  assertEqual([r.from, r.to, r.days.length], ['2026-09-26', '2026-10-25', 30], 'the default range ends on the 25th');
});

test("'today' near the spring switch in Zurich", () => {
  assertEqual(localDateKey(new Date('2026-03-28T22:59:59.999Z'), ZRH), '2026-03-28', '1 ms before local midnight (CET)');
  assertEqual(localDateKey(new Date('2026-03-28T23:00:00.000Z'), ZRH), '2026-03-29', 'local midnight (CET)');
  assertEqual(localDateKey(new Date('2026-03-29T21:59:59.999Z'), ZRH), '2026-03-29', '1 ms before the next midnight (CEST)');
  assertEqual(localDateKey(new Date('2026-03-29T22:00:00.000Z'), ZRH), '2026-03-30', 'the next midnight (CEST)');
});

test("New York and Zurich have different 'today' at 2026-09-26T00:30Z", () => {
  const at = new Date('2026-09-26T00:30:00Z');
  assertEqual([localDateKey(at, NYC), localDateKey(at, ZRH)], ['2026-09-25', '2026-09-26'], 'days');
  const ny = range(undefined, undefined, localDateKey(at, NYC));
  const zh = range(undefined, undefined, localDateKey(at, ZRH));
  assertEqual([ny.from, ny.to], ['2026-08-27', '2026-09-25'], 'New York range');
  assertEqual([zh.from, zh.to], ['2026-08-28', '2026-09-26'], 'Zurich range');
  // The window where they differ: Zurich midnight (22:00Z) to New York midnight (04:00Z).
  assertEqual(localDateKey(new Date('2026-09-25T21:59:59.999Z'), ZRH), '2026-09-25', 'Zurich 1 ms before midnight');
  assertEqual(localDateKey(new Date('2026-09-26T03:59:59.999Z'), NYC), '2026-09-25', 'New York 1 ms before midnight');
  assertEqual(localDateKey(new Date('2026-09-26T04:00:00.000Z'), NYC), '2026-09-26', 'New York midnight');
});

test('exactly 92 days accepted, 93 refused', () => {
  assertEqual(MAX_RANGE_DAYS, 92, 'cap');
  const r = range('2026-06-26', TODAY);
  assertEqual([r.days.length, r.days[0], r.days[91]], [92, '2026-06-26', TODAY], '92 days');
  assertEqual(refusal('2026-06-25', TODAY), 'At most 92 days at a time', '93 days');
  assertEqual(refusal('2026-08-25', '2026-11-25'), 'At most 92 days at a time', '93 days over the autumn switch');
  assertEqual(refusal('2020-01-01', TODAY), 'At most 92 days at a time', 'years');
});

test('the default is the 30 days ending today', () => {
  assertEqual(DEFAULT_RANGE_DAYS, 30, 'default length');
  const r = range(undefined, undefined);
  assertEqual([r.from, r.to, r.days.length], ['2026-08-27', TODAY, 30], 'last 30 days');
  assertEqual(r.days[29], TODAY, 'ends today');
  assertConsecutive(r.days, 'default');
  for (const empty of [null, '', 0, 20260925, ['2026-09-01'], {}]) {
    const e = range(empty, empty);
    assertEqual([e.from, e.to], ['2026-08-27', TODAY], `non-dates are left out (${JSON.stringify(empty)})`);
  }
  assertEqual([range(undefined, '2026-03-31').from, range(undefined, '2026-03-31').to], ['2026-03-02', '2026-03-31'], '30 days ending "to"');
  assertEqual(range('2026-09-01', undefined).days.length, 25, '"from" to today');
  assertEqual(range(TODAY, TODAY).days, [TODAY], 'one day');
});

test('a start after the end is refused', () => {
  assertEqual(refusal('2026-09-26', TODAY), 'The start date is after the end date', 'one day after');
  assertEqual(refusal('2026-09-26', undefined), 'The start date is after the end date', 'after today');
  assertEqual(refusal('2027-01-01', '2026-12-31'), 'The start date is after the end date', 'over the new year');
});

test('impossible dates are refused, as start and as end', () => {
  for (const bad of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-09-00', '0050-01-01', '2026-9-1', '2026-09-25T00:00', ' 2026-09-25', 'abc']) {
    assertEqual(refusal(bad, TODAY), BAD_FORMAT, `from ${bad}`);
    assertEqual(refusal('2026-01-01', bad), BAD_FORMAT, `to ${bad}`);
    assertEqual(refusal(bad, bad), BAD_FORMAT, `both ${bad}`);
  }
});

test('an impossible end with no start is refused, not thrown', () => {
  // The route turns `{ error }` into a 400; a throw becomes a 500.
  for (const bad of ['2026-02-30', '2026-13-01', '2026-9-1', 'abc']) assertEqual(refusal(undefined, bad), BAD_FORMAT, `to ${bad}`);
});

test('29 February only in a leap year', () => {
  assertEqual(range('2028-02-29', '2028-02-29').days, ['2028-02-29'], '2028-02-29');
  assertEqual(range('2028-02-27', '2028-03-01').days, ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'], 'through the leap day');
  assertEqual(range('2026-02-27', '2026-03-01').days, ['2026-02-27', '2026-02-28', '2026-03-01'], 'no leap day in 2026');
  assertEqual(refusal('2026-02-29', '2026-03-01'), BAD_FORMAT, '2026-02-29');
  assertEqual(addDaysIso('2028-02-28', 1), '2028-02-29', 'add a day');
  assertEqual(addDaysIso('2026-10-24', 2), '2026-10-26', 'over the switch');
  assertEqual(addDaysIso('2026-01-01', -1), '2025-12-31', 'back a year');
});

test('dayKeyOf', () => {
  assertEqual(dayKeyOf('2026-09-25'), '20260925', 'stats doc day');
  assertEqual(dayKeyOf('2028-02-29'), '20280229', 'leap day');
  const keys = range('2026-08-26', '2026-11-25').days.map(dayKeyOf);
  assertEqual(new Set(keys).size, 92, 'one key per day');
  assert(keys.every((k) => /^\d{8}$/.test(k)), 'eight digits');
  assertEqual([...keys].sort(), keys, 'keys sort like the days');
});

// ── Sums ─────────────────────────────────────────────────────────────────────

test('addDeep adds numbers deeply', () => {
  const into: NumMap = { entered: 2, sends: { sms: { sent: 1 } } };
  addDeep(into, { entered: 3, sends: { sms: { sent: 2, delivered: 1 }, email: { sent: 4 } }, skipped: { 'missing_value:guestinfo.wifiName': 1 } });
  assertEqual(into, { entered: 5, sends: { sms: { sent: 3, delivered: 1 }, email: { sent: 4 } }, skipped: { 'missing_value:guestinfo.wifiName': 1 } }, 'sum');
  addDeep(into, { entered: -1, sends: { sms: { sent: 0 } } });
  assertEqual([into.entered, (into.sends as any).sms.sent], [4, 3], 'zero and negative counters add too');
});

test('addDeep ignores non-numbers, arrays and Timestamps', () => {
  const ts = { seconds: 1790000000, nanoseconds: 5, toMillis: () => 1790000000000 };
  const into: NumMap = { entered: 1 };
  const same = addDeep(into, {
    entered: '4',
    converted: true,
    ended: null,
    exited: undefined,
    nan: NaN,
    inf: Infinity,
    list: [1, 2, 3],
    at: new Date(0),
    updatedAt: ts,
    tenantUserId: 'u_owner',
    sends: { sms: { sent: 2, at: ts, tags: [5] } },
  });
  assert(same === into, 'returns the same map');
  assertEqual(into, { entered: 1, sends: { sms: { sent: 2 } } }, 'only numbers and plain maps');
  for (const junk of [null, undefined, 5, 'x', true]) assertEqual(addDeep({ a: 1 }, junk), { a: 1 }, `from ${String(junk)}`);
});

test('sumStats keeps test runs apart from live numbers', () => {
  const day1 = {
    tenantUserId: 'u_owner',
    venueId: 'v_cafe',
    day: '20261024',
    updatedAt: { toMillis: () => 1 },
    entered: 3,
    converted: 1,
    sends: { sms: { sent: 2, delivered: 2 } },
    credits: { sms: 4 },
    utility: { sends: 1, providerCostMinor: 7 },
    visits: { total: 10, first: 6, revisits: 4, captures: 8 },
    dryRun: { entered: 5, sends: { email: { sent: 3 } }, credits: { email: 3 } },
  };
  const day2 = {
    entered: 1,
    sends: { sms: { sent: 1 }, email: { sent: 2 } },
    credits: { sms: 2, email: 2 },
    skipped: { weekly_limit: 2 },
    stays: { created: 1 },
    dryRun: { entered: 2, sends: { email: { sent: 1 } } },
  };
  const { live, testRun } = sumStats([day1, undefined, day2]);
  assertEqual(
    live,
    {
      entered: 4,
      converted: 1,
      sends: { sms: { sent: 3, delivered: 2 }, email: { sent: 2 } },
      credits: { sms: 6, email: 2 },
      utility: { sends: 1, providerCostMinor: 7 },
      visits: { total: 10, first: 6, revisits: 4, captures: 8 },
      skipped: { weekly_limit: 2 },
      stays: { created: 1 },
    },
    'live',
  );
  assertEqual(testRun, { entered: 7, sends: { email: { sent: 4 } }, credits: { email: 3 } }, 'test runs');
  assert(!('dryRun' in live) && !('tenantUserId' in live) && !('updatedAt' in live), 'no other fields in live');
  assertEqual(sumStats([{ dryRun: { entered: 1 } }]), { live: {}, testRun: { entered: 1 } }, 'a test-only day adds nothing live');
  assertEqual(sumStats([]), { live: {}, testRun: {} }, 'no days');
});

// ── Running card ─────────────────────────────────────────────────────────────

const VENUE: NumMap = {
  entered: 12,
  sends: { sms: { sent: 5, delivered: 4 }, email: { sent: 7, opened: 3 }, whatsapp: { delivered: 1 } },
  credits: { sms: 10, email: 7 },
  utility: { sends: 2, providerCostMinor: 9 },
  visits: { total: 40, first: 25, revisits: 15, captures: 30 },
  stays: { created: 3, changed: 1, cancelled: 1, linked: 2, overlapFlagged: 1 },
  skipped: { weekly_limit: 2, quiet_hours: 1 },
};

test('cardNumbers adds up the card', () => {
  const c = cardNumbers({ venue: VENUE, returnConversions: 4, averageSpend: { amountMinor: 4500, currency: 'CHF' }, upcomingStays: 6 });
  assertEqual(c.guestsStarted, 12, 'guests started');
  assertEqual(c.cameBack, 4, 'came back');
  assertEqual(c.messages, { total: 12, byChannel: { sms: 5, email: 7, whatsapp: 0 }, service: 2 }, 'messages');
  assertEqual(c.creditsUsed, { total: 17, byChannel: { sms: 10, email: 7 } }, 'credits');
  assertEqual(c.visits, { total: 40, first: 25, revisits: 15, captures: 30 }, 'visits');
  assertEqual(c.stays, { syncedInRange: 3, changed: 1, cancelled: 1, linked: 2, upcoming: 6 }, 'stays, synced and upcoming apart');
  assertEqual(c.skipped, { weekly_limit: 2, quiet_hours: 1 }, 'skipped');
  assertEqual(RETURN_VISIT_GOALS, ['offer.redeemed', 'visit.revisit'], 'return-visit goals');
});

test('cardNumbers revenue is came-back × the average spend', () => {
  const c = cardNumbers({ venue: VENUE, returnConversions: 4, averageSpend: { amountMinor: 4500, currency: 'CHF' }, upcomingStays: null });
  assertEqual(c.estimatedRevenue, { amountMinor: 18000, currency: 'CHF', averageSpendMinor: 4500, basis: 'Guests who came back through a journey × the average spend per visit' }, 'estimate');
  assertEqual(cardNumbers({ venue: VENUE, returnConversions: 0, averageSpend: { amountMinor: 4500, currency: 'CHF' }, upcomingStays: null }).estimatedRevenue?.amountMinor, 0, 'nobody came back: 0, not none');
  assertEqual(cardNumbers({ venue: VENUE, returnConversions: 1, averageSpend: { amountMinor: 1, currency: 'EUR' }, upcomingStays: null }).estimatedRevenue, { amountMinor: 1, currency: 'EUR', averageSpendMinor: 1, basis: 'Guests who came back through a journey × the average spend per visit' }, 'the smallest average');
});

test('cardNumbers has no revenue without a positive average spend', () => {
  for (const averageSpend of [null, { amountMinor: 0, currency: 'CHF' }, { amountMinor: -1, currency: 'CHF' }, { amountMinor: -4500, currency: 'CHF' }, { amountMinor: NaN, currency: 'CHF' }]) {
    const c = cardNumbers({ venue: VENUE, returnConversions: 4, averageSpend, upcomingStays: null });
    assertEqual(c.estimatedRevenue, null, `no estimate for ${JSON.stringify(averageSpend)}`);
    assertEqual(c.cameBack, 4, 'came back still counted');
  }
});

test('cardNumbers on an empty venue', () => {
  const c = cardNumbers({ venue: {}, returnConversions: 0, averageSpend: null, upcomingStays: null });
  assertEqual(
    c,
    {
      guestsStarted: 0,
      cameBack: 0,
      messages: { total: 0, byChannel: {}, service: 0 },
      creditsUsed: { total: 0, byChannel: {} },
      estimatedRevenue: null,
      visits: { total: 0, first: 0, revisits: 0, captures: 0 },
      stays: { syncedInRange: 0, changed: 0, cancelled: 0, linked: 0, upcoming: null },
      skipped: {},
    },
    'zeros',
  );
});

test('the test-run card never includes live numbers', () => {
  const { live, testRun } = sumStats([{ entered: 5, sends: { sms: { sent: 5 } }, credits: { sms: 10 }, dryRun: { entered: 2, sends: { sms: { sent: 1 } }, credits: { sms: 2 } } }]);
  const liveCard = cardNumbers({ venue: live, returnConversions: 0, averageSpend: null, upcomingStays: null });
  const testCard = cardNumbers({ venue: testRun, returnConversions: 0, averageSpend: null, upcomingStays: null });
  assertEqual([liveCard.guestsStarted, liveCard.messages.total, liveCard.creditsUsed.total], [5, 5, 10], 'live');
  assertEqual([testCard.guestsStarted, testCard.messages.total, testCard.creditsUsed.total], [2, 1, 2], 'test runs');
});

// ── Audience: class keys ─────────────────────────────────────────────────────

/** [hasPhone, phoneVerified, hasEmail, emailVerified] → key. A verified flag without the address doesn't count. */
const CLASS_KEYS: Array<[[boolean, boolean, boolean, boolean], string]> = [
  [[false, false, false, false], '0000'],
  [[false, false, false, true], '0000'],
  [[false, false, true, false], '0010'],
  [[false, false, true, true], '0011'],
  [[false, true, false, false], '0000'],
  [[false, true, false, true], '0000'],
  [[false, true, true, false], '0010'],
  [[false, true, true, true], '0011'],
  [[true, false, false, false], '1000'],
  [[true, false, false, true], '1000'],
  [[true, false, true, false], '1010'],
  [[true, false, true, true], '1011'],
  [[true, true, false, false], '1100'],
  [[true, true, false, true], '1100'],
  [[true, true, true, false], '1110'],
  [[true, true, true, true], '1111'],
];

const guest = ([hasPhone, phoneVerified, hasEmail, emailVerified]: [boolean, boolean, boolean, boolean]) => ({ hasPhone, phoneVerified, hasEmail, emailVerified });

test('classKey for all 16 flag combinations', () => {
  assertEqual(CLASS_KEYS.length, 16, 'sixteen');
  for (const [f, key] of CLASS_KEYS) assertEqual(classKey(guest(f)), key, `flags ${f.map(Number).join('')}`);
});

test("classKeyWithCountry adds ':CC' only for guests with a phone", () => {
  for (const [f, key] of CLASS_KEYS) {
    const g = guest(f);
    assertEqual(classKeyWithCountry(g, 'CH'), g.hasPhone ? `${key}:CH` : key, `CH, flags ${f.map(Number).join('')}`);
    assertEqual(classKeyWithCountry(g, null), g.hasPhone ? `${key}:` : key, `unknown, flags ${f.map(Number).join('')}`);
  }
  assertEqual(classKeyWithCountry(guest([true, true, true, false]), 'GB'), '1110:GB', 'GB');
  assertEqual(classKeyWithCountry(guest([true, false, false, false]), null), '1000:', "unknown is ':' + ''");
});

// ── Audience: counts and reachable guests ────────────────────────────────────

const COUNTRIES = ['CH', 'DE'] as const;
const ALL_KEYS = Array.from({ length: 16 }, (_, i) => i.toString(2).padStart(4, '0'));
const CHOICES: Audience[] = [
  { sms: 'verified', email: 'all' },
  { sms: 'verified', email: 'verified' },
  { sms: 'all', email: 'all' },
  { sms: 'all', email: 'verified' },
];

/** Reachable phone (no suffix, :CH, :DE): per choice above, P = with phone, E = email only, - = nobody. */
const REACH_PHONE_OK: Record<string, string> = {
  '0000': '----', '0001': '----', '0010': 'E-E-', '0011': 'EEEE',
  '0100': '----', '0101': '----', '0110': 'E-E-', '0111': 'EEEE',
  '1000': '--PP', '1001': '--PP', '1010': 'E-PP', '1011': 'EEPP',
  '1100': 'PPPP', '1101': 'PPPP', '1110': 'PPPP', '1111': 'PPPP',
};
/** A phone SMS doesn't go to (:GB, or : unknown): the phone counts as none. */
const REACH_PHONE_OUT: Record<string, string> = {
  '1000': '----', '1001': '----', '1010': 'E-E-', '1011': 'EEEE',
  '1100': '----', '1101': '----', '1110': 'E-E-', '1111': 'EEEE',
};
/** [sms verified, sms unverified, email verified, email unverified] for a reachable phone. */
const COUNTS_PHONE_OK: Record<string, [number, number, number, number]> = {
  '0000': [0, 0, 0, 0], '0001': [0, 0, 0, 0], '0010': [0, 0, 0, 1], '0011': [0, 0, 1, 0],
  '0100': [0, 0, 0, 0], '0101': [0, 0, 0, 0], '0110': [0, 0, 0, 1], '0111': [0, 0, 1, 0],
  '1000': [0, 1, 0, 0], '1001': [0, 1, 0, 0], '1010': [0, 1, 0, 1], '1011': [0, 1, 1, 0],
  '1100': [1, 0, 0, 0], '1101': [1, 0, 0, 0], '1110': [1, 0, 0, 1], '1111': [1, 0, 1, 0],
};

function reachCode(key: string, audience: Audience): string {
  const r = reachableUnder({ [key]: 7 }, audience, COUNTRIES);
  assertEqual(r.optedIn, r.withPhone + r.emailOnly, `${key} optedIn = with phone + email only`);
  if (r.withPhone === 7 && r.emailOnly === 0) return 'P';
  if (r.emailOnly === 7 && r.withPhone === 0) return 'E';
  if (r.optedIn === 0) return '-';
  throw new Error(`${key} split oddly: ${JSON.stringify(r)}`);
}

test('reachableUnder for all 16 classes under the 4 choices (reachable phone)', () => {
  for (const suffix of ['', ':CH', ':DE']) {
    for (const bits of ALL_KEYS) {
      const key = bits + (bits[0] === '1' ? suffix : '');
      assertEqual(CHOICES.map((a) => reachCode(key, a)).join(''), REACH_PHONE_OK[bits], `${key || bits}`);
    }
  }
});

test("reachableUnder: a ':GB' or unknown ':' number counts as no phone", () => {
  for (const suffix of [':GB', ':', ':ch', ':US']) {
    for (const bits of ALL_KEYS.filter((k) => k[0] === '1')) {
      const key = bits + suffix;
      assertEqual(CHOICES.map((a) => reachCode(key, a)).join(''), REACH_PHONE_OUT[bits], key);
    }
  }
});

test('audienceCounts for all 16 classes (reachable phone)', () => {
  for (const suffix of ['', ':CH', ':DE']) {
    for (const bits of ALL_KEYS) {
      const key = bits + (bits[0] === '1' ? suffix : '');
      const c = audienceCounts({ [key]: 7 }, COUNTRIES);
      const [sv, su, ev, eu] = COUNTS_PHONE_OK[bits].map((x) => x * 7);
      assertEqual(c, { sms: { verified: sv, unverified: su }, email: { verified: ev, unverified: eu }, smsOtherCountries: 0 }, key);
    }
  }
});

test("audienceCounts: ':GB' and ':' go to smsOtherCountries, email only", () => {
  for (const suffix of [':GB', ':']) {
    for (const bits of ALL_KEYS.filter((k) => k[0] === '1')) {
      const key = bits + suffix;
      const c = audienceCounts({ [key]: 7 }, COUNTRIES);
      const [, , ev, eu] = COUNTS_PHONE_OK[bits].map((x) => x * 7);
      assertEqual(c, { sms: { verified: 0, unverified: 0 }, email: { verified: ev, unverified: eu }, smsOtherCountries: 7 }, key);
    }
  }
});

test('a key without a country counts as reachable (older callers)', () => {
  assertEqual(audienceCounts({ '1100': 2, '1000': 3 }, COUNTRIES).sms, { verified: 2, unverified: 3 }, 'counts');
  assertEqual(audienceCounts({ '1100': 2 }, []).sms.verified, 2, 'even with no SMS countries');
  assertEqual(reachableUnder({ '1100': 2 }, DEFAULT_AUDIENCE, []).withPhone, 2, 'reachable with no SMS countries');
  assertEqual(reachableUnder({ '1100:CH': 2 }, DEFAULT_AUDIENCE, []), { withPhone: 0, emailOnly: 0, optedIn: 0 }, 'a country with an empty SMS list is out');
});

test('counts and reach over a real mix of guests', () => {
  const guests: Array<{ f: [boolean, boolean, boolean, boolean]; cc: string | null }> = [
    { f: [true, true, true, true], cc: 'CH' },
    { f: [true, true, false, false], cc: 'CH' },
    { f: [true, false, true, false], cc: 'DE' },
    { f: [true, false, false, false], cc: 'CH' },
    { f: [true, true, true, true], cc: 'GB' },
    { f: [true, true, false, false], cc: null },
    { f: [false, false, true, true], cc: null },
    { f: [false, false, true, false], cc: 'CH' },
  ];
  const classes: Record<string, number> = {};
  for (const g of guests) {
    const k = classKeyWithCountry(guest(g.f), g.cc);
    classes[k] = (classes[k] ?? 0) + 1;
  }
  assertEqual(classes, { '1111:CH': 1, '1100:CH': 1, '1010:DE': 1, '1000:CH': 1, '1111:GB': 1, '1100:': 1, '0011': 1, '0010': 1 }, 'classes');
  assertEqual(audienceCounts(classes, COUNTRIES), { sms: { verified: 2, unverified: 2 }, email: { verified: 3, unverified: 2 }, smsOtherCountries: 2 }, 'counts');
  assertEqual(reachableUnder(classes, { sms: 'verified', email: 'all' }, COUNTRIES), { withPhone: 2, emailOnly: 4, optedIn: 6 }, 'default');
  assertEqual(reachableUnder(classes, { sms: 'verified', email: 'verified' }, COUNTRIES), { withPhone: 2, emailOnly: 2, optedIn: 4 }, 'verified only');
  assertEqual(reachableUnder(classes, { sms: 'all', email: 'all' }, COUNTRIES), { withPhone: 4, emailOnly: 3, optedIn: 7 }, 'everyone');
  assertEqual(reachableUnder(classes, { sms: 'all', email: 'verified' }, COUNTRIES), { withPhone: 4, emailOnly: 2, optedIn: 6 }, 'SMS all, email verified');
  assertEqual(audienceCounts(undefined, COUNTRIES), { sms: { verified: 0, unverified: 0 }, email: { verified: 0, unverified: 0 }, smsOtherCountries: 0 }, 'no classes');
  assertEqual(reachableUnder(undefined, DEFAULT_AUDIENCE, COUNTRIES), { withPhone: 0, emailOnly: 0, optedIn: 0 }, 'no classes');
});

// ── Audience: the saved choice ───────────────────────────────────────────────

test('effectiveAudience reads the saved choice like the engine', () => {
  assertEqual(DEFAULT_AUDIENCE, { sms: 'verified', email: 'all' }, 'default');
  assertEqual(effectiveAudience(null), DEFAULT_AUDIENCE, 'null');
  assertEqual(effectiveAudience(undefined), DEFAULT_AUDIENCE, 'undefined');
  assertEqual(effectiveAudience({}), DEFAULT_AUDIENCE, 'empty');
  assertEqual(effectiveAudience({ sms: 'x' }), { sms: 'verified', email: 'all' }, "{sms:'x'}");
  assertEqual(effectiveAudience({ email: 'verified' }), { sms: 'verified', email: 'verified' }, "{email:'verified'}");
  assertEqual(effectiveAudience({ sms: 'all', email: 'all' }), { sms: 'all', email: 'all' }, 'everyone');
  assertEqual(effectiveAudience({ sms: 'all', email: 'verified' }), { sms: 'all', email: 'verified' }, 'SMS all, email verified');
  assertEqual(effectiveAudience({ sms: 'ALL', email: 'Verified' }), DEFAULT_AUDIENCE, 'case matters');
  assertEqual(effectiveAudience({ sms: true, email: 1 } as never), DEFAULT_AUDIENCE, 'junk');
  const a = effectiveAudience(null);
  a.sms = 'all';
  assertEqual(DEFAULT_AUDIENCE.sms, 'verified', 'the default is not shared');
});

test('effectiveAudience matches the rule in engine/context.ts', () => {
  const src = readFileSync(join(__dirname, '../src/adaptive/engine/context.ts'), 'utf8');
  const rule = (field: 'sms' | 'email') => {
    const m = new RegExp(`${field}:\\s*adaptive\\.audience\\?\\.${field}\\s*===\\s*'(\\w+)'\\s*\\?\\s*'(\\w+)'\\s*:\\s*'(\\w+)'`).exec(src);
    assert(m, `context.ts derives audience.${field} with a single === test`);
    return { when: m[1], then: m[2], otherwise: m[3] };
  };
  const sms = rule('sms');
  const email = rule('email');
  assertEqual(sms, { when: 'all', then: 'all', otherwise: 'verified' }, 'engine SMS rule');
  assertEqual(email, { when: 'verified', then: 'verified', otherwise: 'all' }, 'engine email rule');
  const engine = (saved: { sms?: unknown; email?: unknown } | null | undefined) => ({
    sms: saved?.sms === sms.when ? sms.then : sms.otherwise,
    email: saved?.email === email.when ? email.then : email.otherwise,
  });
  const inputs = [null, undefined, {}, { sms: 'x' }, { email: 'verified' }, { sms: 'all' }, { sms: 'verified' }, { email: 'all' }, { sms: 'all', email: 'verified' }, { sms: 'ALL' }, { email: 'x' }, { sms: 1, email: null }];
  for (const s of inputs) assertEqual(effectiveAudience(s), engine(s), `same reading for ${JSON.stringify(s)}`);
});

// ── Purity ───────────────────────────────────────────────────────────────────

// ── Waiting for credits: one budget for the account ──────────────────────────

const fw = (venueId: string, channel: string | null, price: number | null): FlaggedWait => ({ venueId, channel, price });
const counts = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort());

test('waiting: the shared pool is counted once across channels', () => {
  // 20 shared credits; an SMS for 15 and ten emails for 1 need 25: five of the emails can't be paid.
  const flagged = [fw('v1', 'sms', 15), ...Array.from({ length: 10 }, () => fw('v1', 'email', 1))];
  const m = waitingByVenue(flagged, { own: { sms: 0, email: 0 }, shared: 20 });
  assertEqual(counts(m), { v1: 1 }, 'cheapest first: the ten emails fit, the SMS for 15 no longer does');
});

test("waiting: one budget across the account's venues", () => {
  const m = waitingByVenue([fw('a', 'sms', 15), fw('b', 'sms', 15)], { own: { sms: 0 }, shared: 15 });
  assertEqual([...m.values()].reduce((s, n) => s + n, 0), 1, 'only one of the two can be paid');
});

test("waiting: a message that doesn't fit takes nothing", () => {
  const m = waitingByVenue([fw('v', 'sms', 30), fw('v', 'sms', 15)], { own: { sms: 0 }, shared: 20 });
  assertEqual(counts(m), { v: 1 }, 'the 15-credit SMS is paid, the 30-credit one waits');
});

test("waiting: a channel's own credits first, then the shared pool", () => {
  // SMS own 10 + shared 10: the SMS for 15 takes 10 own + 5 shared; the email for 5 takes the other 5 shared.
  const m = waitingByVenue([fw('v', 'sms', 15), fw('v', 'email', 5)], { own: { sms: 10, email: 0 }, shared: 10 });
  assertEqual(counts(m), {}, 'both paid');
  const m2 = waitingByVenue([fw('v', 'sms', 15), fw('v', 'email', 6)], { own: { sms: 10, email: 0 }, shared: 10 });
  assertEqual(counts(m2), { v: 1 }, 'one short');
  // Own credits of one channel never pay another.
  assertEqual(counts(waitingByVenue([fw('v', 'email', 1)], { own: { sms: 50 }, shared: 0 })), { v: 1 }, 'SMS credits do not pay email');
});

test('waiting: unknown budget, channel or price counts as waiting; nothing flagged → nothing', () => {
  assertEqual(counts(waitingByVenue([fw('v', 'sms', 1)], null)), { v: 1 }, 'no wallet read');
  assertEqual(counts(waitingByVenue([fw('v', null, 1), fw('v', 'sms', null), fw('w', 'sms', Number.NaN)], { own: { sms: 100 }, shared: 100 })), { v: 2, w: 1 }, 'unknown values');
  assertEqual(counts(waitingByVenue([], { own: {}, shared: 0 })), {}, 'none flagged');
  assertEqual(counts(waitingByVenue([fw('v', 'sms', 15)], { own: { sms: 0 }, shared: 0 })), { v: 1 }, 'an empty (or suspended) wallet');
  assertEqual(counts(waitingByVenue([fw('v', 'sms', 0)], { own: {}, shared: 0 })), {}, 'a free message always fits');
});

test('the modules are pure: no runtime imports, firebase.ts not loaded', () => {
  for (const file of ['results.ts', 'audience.ts']) {
    const src = readFileSync(join(__dirname, '../src/adaptive/core/owner', file), 'utf8');
    const runtime = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assertEqual(runtime, [], `${file} runtime imports`);
  }
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
  assert(HOUR_MS === 60 * MINUTE_MS, 'time helpers loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
