/**
 * The weekly numbers email to the owner (spec §12 P0 interim; D6–D10 of 2026-11-04) — the pure parts.
 *
 * Run: npx tsx tests/adaptiveWeeklyEmail.test.ts   (from captive-server/server)
 *
 *  - When: Monday 08:00 in the account's zone, for the Monday-to-Sunday week before; a worker that
 *    starts on Monday morning still sends that day's; one that starts mid-week waits for next Monday;
 *    across the change to winter time.
 *  - What: §12's order (Snapshot, each journey, what happened in numbers, next) in English and
 *    German; the estimated revenue next to every credit number; last week beside this week; the
 *    spec's KPI where we count it (ratings, friends per 100 messages); credits left at this week's
 *    pace; anything waiting on the owner; a quiet week flagged; nothing unescaped in the HTML.
 */

import { fmtMoney, fmtNum, isQuietWeek, lastFullWeek, renderWeeklyEmail, venueBlock, weekRange, weeklySchedule, type WeeklyInput, type WeeklyResults } from '../src/adaptive/core/owner/weeklyEmail';
import type { JourneyFunnel } from '../src/adaptive/core/owner/dashboard';
import { localParts, zonedTime } from '../src/adaptive/core/runtime/time';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const TZ = 'Europe/Zurich';

function funnel(over: Partial<JourneyFunnel> = {}, total: Partial<JourneyFunnel['total']> = {}): JourneyFunnel {
  return {
    goal: 'visit',
    started: 40,
    total: { key: 'all', sent: 58, delivered: 55, opened: 10, clicked: 12, converted: 7, credits: 174, creditsValue: { amountMinor: 174, currency: 'CHF' }, revenue: { amountMinor: 31500, currency: 'CHF' }, ...total },
    byChannel: [],
    bySlot: [],
    convertedBeforeMessage: 0,
    convertedNotSplit: 0,
    serviceSent: 0,
    ratings: { count: 0, averageStars: null, low: 0 },
    ...over,
  };
}

function results(over: Partial<WeeklyResults['card']> = {}, more: Partial<WeeklyResults> = {}): WeeklyResults {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  cells[4][19] = 9;
  return {
    card: {
      guestsStarted: 41,
      cameBack: 7,
      messages: { total: 58, byChannel: { sms: 30, email: 28 }, service: 3 },
      creditsUsed: { total: 174, byChannel: { sms: 150, email: 24 } },
      estimatedRevenue: { amountMinor: 31500, currency: 'CHF', averageSpendMinor: 4500 },
      visits: { total: 120, first: 80, revisits: 40 },
      friendsJoined: 2,
      ...over,
    },
    capture: {
      visits: { total: 120, first: 80, returning: 40 },
      logins: 140,
      all: { visits: 100, yes: 64, rate: 0.64 },
      first: { visits: 70, yes: 49, rate: 0.7 },
      returning: { visits: 30, yes: 15, rate: 0.5 },
    },
    heatmap: { timezone: TZ, cells, total: 9, max: 9, byWeekday: [], byHour: [], busiest: { weekday: 5, hour: 19, visits: 9 }, busiestDay: { weekday: 5, visits: 9 }, busiestHour: { hour: 19, visits: 9 } },
    journeys: [
      { journeyKey: 'win_back', name: 'Win-back', goal: 'visit', funnel: funnel() },
      { journeyKey: 'review_ask', name: 'Review ask', goal: 'rating', funnel: funnel({ goal: 'rating', ratings: { count: 5, averageStars: 4.6, low: 0 } }, { converted: 0, revenue: null, credits: 20, creditsValue: { amountMinor: 20, currency: 'CHF' } }) },
      { journeyKey: 'bring_a_friend', name: 'Bring a friend', goal: 'none', funnel: funnel({ goal: 'none' }, { sent: 50, converted: 0, revenue: null, credits: 50, creditsValue: { amountMinor: 50, currency: 'CHF' } }) },
      { journeyKey: 'birthday', name: 'Birthday', goal: 'visit', funnel: funnel({ started: 0 }, { sent: 0, delivered: 0, opened: 0, clicked: 0, converted: 0, credits: 0 }) },
    ],
    waitingForCredits: { messagesWaiting: 0, lowBalance: false },
    ...more,
  };
}

function input(over: Partial<WeeklyInput> = {}): WeeklyInput {
  return {
    lang: 'en',
    weekStart: '2026-10-26',
    weekEnd: '2026-11-01',
    venues: [{ venueId: 'v1', name: 'Indian Gourmet', week: results(), prev: results({ cameBack: 4, visits: { total: 100, first: 70, revisits: 30 } }), status: 'on' }],
    creditsLeft: 2088,
    creditsPerUnit: { CHF: 100 },
    defaultCurrency: 'CHF',
    dashboardUrl: 'https://portal.heidifi.ai/captive-venue?view=campaigns&section=adaptive',
    ...over,
  };
}

console.log('\nWhen it goes out\n');

test('Monday 08:00 in the account zone, for the week before', () => {
  // Wednesday 4 Nov 2026 → next Monday 9 Nov, covering 2–8 Nov.
  const s = weeklySchedule(zonedTime(2026, 11, 4, 15, 0, TZ).getTime(), TZ);
  assertEqual([s.sendDate, s.weekStart, s.weekEnd], ['2026-11-09', '2026-11-02', '2026-11-08'], 'mid-week');
  const p = localParts(new Date(s.dueAt), TZ);
  assertEqual([p.weekday, p.hour, p.minute], [1, 8, 0], 'Monday 08:00 local');
});

test('a worker that starts on Monday morning still sends that day; Tuesday waits for next Monday', () => {
  assertEqual(weeklySchedule(zonedTime(2026, 11, 9, 9, 30, TZ).getTime(), TZ).sendDate, '2026-11-09', 'Monday 09:30 → today');
  assertEqual(weeklySchedule(zonedTime(2026, 11, 9, 7, 0, TZ).getTime(), TZ).sendDate, '2026-11-09', 'Monday 07:00 → today at 08:00');
  assertEqual(weeklySchedule(zonedTime(2026, 11, 9, 19, 59, TZ).getTime(), TZ).sendDate, '2026-11-09', 'Monday 19:59 (< 12 h late) → today');
  assertEqual(weeklySchedule(zonedTime(2026, 11, 10, 9, 0, TZ).getTime(), TZ).sendDate, '2026-11-16', 'Tuesday → next Monday');
  assertEqual(weeklySchedule(zonedTime(2026, 11, 8, 23, 0, TZ).getTime(), TZ).sendDate, '2026-11-09', 'Sunday night → tomorrow');
});

test('the change to winter time and another zone', () => {
  // Winter time starts Sunday 25 Oct 2026 in Zurich: Monday 26 Oct 08:00 is 07:00 UTC.
  const s = weeklySchedule(zonedTime(2026, 10, 24, 12, 0, TZ).getTime(), TZ);
  assertEqual([s.sendDate, new Date(s.dueAt).toISOString()], ['2026-10-26', '2026-10-26T07:00:00.000Z'], 'after the clock change');
  const ny = weeklySchedule(Date.UTC(2026, 10, 4, 12), 'America/New_York');
  assertEqual([ny.sendDate, new Date(ny.dueAt).toISOString()], ['2026-11-09', '2026-11-09T13:00:00.000Z'], 'New York 08:00');
});

test('the preview: the last complete Monday-to-Sunday week', () => {
  assertEqual(lastFullWeek(zonedTime(2026, 11, 4, 15, 0, TZ).getTime(), TZ), { weekStart: '2026-10-26', weekEnd: '2026-11-01' }, 'Wednesday');
  assertEqual(lastFullWeek(zonedTime(2026, 11, 2, 0, 30, TZ).getTime(), TZ), { weekStart: '2026-10-26', weekEnd: '2026-11-01' }, 'Monday just after midnight');
  assertEqual(lastFullWeek(zonedTime(2026, 11, 1, 23, 0, TZ).getTime(), TZ), { weekStart: '2026-10-19', weekEnd: '2026-10-25' }, 'Sunday night: that week is not over');
});

console.log('\nWhat it says\n');

test('formatting: Swiss grouping, money, the week in both languages', () => {
  assertEqual([fmtNum(12345.4), fmtMoney(31500, 'CHF'), fmtMoney(174, 'CHF'), fmtMoney(450, 'CHF')], ["12'345", 'CHF 315', 'CHF 1.74', 'CHF 4.50'], 'numbers');
  assertEqual(weekRange('2026-10-26', '2026-11-01', 'en'), '26 Oct – 1 Nov 2026', 'en');
  assert(/^26\. Okt\.? – 1\. Nov\.? 2026$/.test(weekRange('2026-10-26', '2026-11-01', 'de')), `de: ${weekRange('2026-10-26', '2026-11-01', 'de')}`);
});

test("a venue block: snapshot with revenue next to credits, each journey vs last week, what happened, nothing to do", () => {
  const b = venueBlock(input().venues[0], input());
  assertEqual(
    b.snapshot.map((s) => [s.label, s.value, s.note ?? null]),
    [
      ['Guests reached', '41', 'journeys started'],
      ['Messages', '58', '30 SMS · 28 email — incl. 3 free info'],
      ['Credits used', '174', 'credits cost CHF 1.74'],
      ['Est. revenue', '≈ CHF 315', null],
    ],
    'snapshot',
  );
  assertEqual(b.kpis.map((k) => k.journey), ['Win-back', 'Review ask', 'Bring a friend'], 'quiet journeys left out');
  assertEqual(b.kpis[0], { journey: 'Win-back', now: 'came back: 7', before: 'came back: 7', money: '174 credits (credits cost CHF 1.74) · ≈ CHF 315 est. revenue · 25 credits per guest who came back' }, 'win-back');
  assertEqual(b.kpis[1].now, 'ratings: 5 · ★ 4.6 average', 'review ask: ratings');
  assertEqual(b.kpis[1].money, '20 credits (credits cost CHF 0.20)', 'no revenue line for a rating goal');
  assertEqual(b.kpis[2].now, '4 friends per 100 messages (2)', 'bring a friend: friends per 100 messages (the spec KPI)');
  assertEqual(
    b.happened,
    [
      'Wi-Fi visits: 120 (80 new · 40 returning) · last week 100',
      'Capture rate: 64% (new guests 70% · returning 50%)',
      'Busiest: Friday 19:00–20:00 · busiest day Friday',
      'Came back through a journey: 7 · last week 4',
      'Friends who came with a regular’s code: 2',
    ],
    'what happened',
  );
  assertEqual(b.next, [], 'nothing waits');
});

test('next: paused, Start sending, waiting for credits, low balance', () => {
  const v = { ...input().venues[0], status: 'paused', needsStartSending: true, week: results({}, { waitingForCredits: { messagesWaiting: 3, lowBalance: true } }) };
  const b = venueBlock(v, input());
  assertEqual(
    b.next,
    ['Paused: no messages go out until you resume.', 'Waiting for you to start sending.', '3 waiting for credits', 'Your credits can’t pay the next message. Add credits so journeys keep going.'],
    'next',
  );
});

test('the email: subject, both formats, credits left at this pace, the off switch, escaped', () => {
  const e = renderWeeklyEmail(input({ venues: [{ ...input().venues[0], name: 'Rösti & <Co>' }] }));
  assertEqual(e.subject, 'Your week at Rösti & <Co>: 7 came back, ≈ CHF 315', 'subject');
  assert(e.html.includes('Rösti &amp; &lt;Co&gt;') && !e.html.includes('<Co>'), 'escaped in the HTML');
  assert(e.html.includes('Snapshot') && e.html.includes('Each journey') && e.html.includes('What happened, in numbers') && e.html.includes('Next'), '§12 sections');
  assert(e.text.includes('Credits left: 2\'088 — about 12 weeks at this week’s pace'), `credits left: ${e.text.split('\n').find((l) => l.includes('Credits left'))}`);
  assert(e.text.includes('Nothing needs you. Your journeys keep running.'), 'nothing needed');
  assert(e.text.includes('switch off “Weekly numbers email” in Campaign Manager → Adaptive'), 'where to turn it off');
  assert(e.text.includes('an estimate, not measured takings'), 'the estimate is called one');
  assert(e.html.includes('href="https://portal.heidifi.ai/captive-venue?view=campaigns&amp;section=adaptive"'), 'the link');
  assertEqual(e.quiet, false, 'not quiet');
  assert(!/\b(undefined|NaN|null)\b/.test(e.text), 'no undefined/NaN/null in the text');
});

test('German', () => {
  const e = renderWeeklyEmail(input({ lang: 'de', venues: [{ ...input().venues[0], journeyNames: { win_back: 'Zurückgewinnen' } }] }));
  assertEqual(e.subject, 'Ihre Woche bei Indian Gourmet: 7 wiedergekommen, ≈ CHF 315', 'subject');
  assert(e.text.includes('Überblick') && e.text.includes('Was passiert ist, in Zahlen') && e.text.includes('Als Nächstes'), 'sections');
  assert(e.text.includes('Zurückgewinnen — diese Woche: wiedergekommen: 7'), 'journey name and KPI in German');
  assert(e.text.includes('Am meisten los: Freitag 19:00–20:00'), 'weekday in German');
  assert(e.text.includes('Erfassungsrate: 64%'), 'capture rate');
  assert(e.text.includes('Verbleibende Credits: 2\'088 — etwa 12 Wochen'), 'credits left');
  assert(e.text.includes('«Wöchentliche Zahlen per E-Mail»') && !e.text.includes('ß'), 'Swiss spelling, the switch named');
});

test('several venues: one email, a block each; subject for the account; no revenue → credits', () => {
  const two = input({ venues: [input().venues[0], { venueId: 'v2', name: 'Pizza', week: results({ cameBack: 1, estimatedRevenue: null }), prev: null, status: 'on' }] });
  const e = renderWeeklyEmail(two);
  assertEqual(e.subject, 'Your week at your 2 venues: 8 came back, 348 credits', 'mixed revenue → credits in the subject');
  assert(e.html.includes('>Indian Gourmet<') && e.html.includes('>Pizza<'), 'venue names as headings');
  const pizza = venueBlock(two.venues[1], two);
  assertEqual(pizza.snapshot[3], { label: 'Est. revenue', value: '—', note: 'no average spend saved' }, 'no average spend');
  assertEqual(pizza.kpis[0].before, null, 'no last week read');
});

test('a quiet week: no visits and no messages anywhere', () => {
  const quiet = input({ venues: [{ ...input().venues[0], week: results({ visits: { total: 0, first: 0, revisits: 0 }, messages: { total: 0, byChannel: {}, service: 0 } }) }] });
  assertEqual(isQuietWeek(quiet), true, 'quiet');
  assertEqual(renderWeeklyEmail(quiet).quiet, true, 'flagged');
  assertEqual(isQuietWeek(input()), false, 'busy');
  const noCredits = renderWeeklyEmail(input({ creditsLeft: 500, venues: [{ ...input().venues[0], week: results({ creditsUsed: { total: 0, byChannel: {} } }) }] }));
  assert(noCredits.text.includes('Credits left: 500') && !noCredits.text.includes('at this week’s pace'), 'no pace without credits used');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
