/**
 * The owner dashboard (spec §13, §3; 2026-11-04) — the pure parts.
 *
 * Run: npx tsx tests/adaptiveOwnerDashboard.test.ts   (from captive-server/server)
 *
 *  - moreCounts: visits per weekday × local hour, capture per visit (new / returning), credits,
 *    delivered and opened per send time, goals per last message, ratings; nothing for events
 *    from before the change; a test-run guest's numbers only under dryRun.
 *  - aggregate: the new fields land in the same docs, and the old counters are unchanged.
 *  - capture rate, heatmap and funnel maths (SMS has no opens; revenue only for visit goals;
 *    credits priced in money; goals before the split counted apart).
 *  - sumStats now keeps live referrals (the Bring-a-friend number was dropped before).
 */

import { aggregate, countsFor, moreCounts, VENUE_KEY, type RollupEvent } from '../src/adaptive/rollups/journeyStats';
import { cardNumbers, sumStats } from '../src/adaptive/core/owner/results';
import { captureNumbers, creditsValue, goalKindOf, heatmapNumbers, journeyFunnel, share, type FunnelMoney } from '../src/adaptive/core/owner/dashboard';
import { zonedTime } from '../src/adaptive/core/runtime/time';

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
// Tuesday 29 Sep 2026, 12:40 Zurich.
const T0 = zonedTime(2026, 9, 29, 12, 40, TZ).getTime();

function ev(type: string, over: Partial<RollupEvent> = {}): RollupEvent {
  return { id: `e${Math.random()}`, type, journeyKey: 'welcome_second_visit', instanceId: 'ji_1', channel: null, slot: null, variantId: null, occurredAt: T0, mode: 'live', data: {}, ...over };
}

const CHF: FunnelMoney = { averageSpend: { amountMinor: 4500, currency: 'CHF' }, creditsPerUnit: { CHF: 100 }, defaultCurrency: 'CHF' };

console.log('\nmoreCounts\n');

test('a visit: weekday × local hour, and capture when the visit says whether the guest can get offers', () => {
  const first = moreCounts(ev('visit.started', { journeyKey: null, data: { isFirstVisit: true, isRevisit: false, reachable: true } }), TZ);
  assertEqual(first, { both: null, venueOnly: { heat: { w2: { h12: 1 } }, capture: { first: { visits: 1, yes: 1 } } } }, 'first visit, yes');
  const back = moreCounts(ev('visit.started', { journeyKey: null, data: { isFirstVisit: false, isRevisit: true, reachable: false } }), TZ);
  assertEqual(back.venueOnly, { heat: { w2: { h12: 1 } }, capture: { returning: { visits: 1 } } }, 'returning, no yes');
  // A visit from before the change (no `reachable`): only the heatmap.
  assertEqual(moreCounts(ev('visit.started', { journeyKey: null, data: { isFirstVisit: true } }), TZ).venueOnly, { heat: { w2: { h12: 1 } } }, 'old visit');
  // Sunday 23:30 Zurich is w7 h23 — and the UTC day is still Sunday too; Monday 00:10 Zurich is Sunday 22:10 UTC.
  const sun = zonedTime(2026, 10, 4, 23, 30, TZ).getTime();
  const mon = zonedTime(2026, 10, 5, 0, 10, TZ).getTime();
  assertEqual(moreCounts(ev('visit.started', { occurredAt: sun, data: {} }), TZ).venueOnly, { heat: { w7: { h23: 1 } } }, 'Sunday night');
  assertEqual(moreCounts(ev('visit.started', { occurredAt: mon, data: {} }), TZ).venueOnly, { heat: { w1: { h00: 1 } } }, 'Monday just after midnight (local, not UTC)');
  // Winter time: 08:15 Zurich in January is 07:15 UTC.
  assertEqual(moreCounts(ev('visit.started', { occurredAt: zonedTime(2027, 1, 13, 8, 15, TZ).getTime(), data: {} }), TZ).venueOnly, { heat: { w3: { h08: 1 } } }, 'winter time');
  assertEqual(moreCounts(ev('visit.started', { data: {} }), null).venueOnly, null, 'no zone, no heatmap');
});

test('sends: credits per send time (marketing only), delivered and opened per send time', () => {
  assertEqual(moreCounts(ev('message.sent', { channel: 'sms', slot: 'evening', data: { purpose: 'marketing', credits: 15 } }), TZ), { both: { funnel: { slot: { evening: { credits: 15 } } } }, venueOnly: null }, 'marketing');
  assertEqual(moreCounts(ev('message.sent', { channel: 'email', slot: 'now', data: { purpose: 'service', credits: 0 } }), TZ), { both: null, venueOnly: null }, 'service');
  assertEqual(moreCounts(ev('message.delivered', { channel: 'sms', slot: 'evening' }), TZ).both, { funnel: { slot: { evening: { delivered: 1 } } } }, 'delivered');
  assertEqual(moreCounts(ev('message.opened', { channel: 'email', slot: 'morning' }), TZ).both, { funnel: { slot: { morning: { opened: 1 } } } }, 'opened');
  assertEqual(moreCounts(ev('message.delivered', { channel: 'sms', slot: null }), TZ).both, null, 'no slot, nothing');
  assertEqual(moreCounts(ev('credits.refunded', { channel: 'whatsapp', slot: 'afternoon', data: { credits: 12 } }), TZ).both, { funnel: { slot: { afternoon: { credits: -12 } } } }, 'refund');
  const dry = moreCounts(ev('send.dry_run', { mode: 'test', channel: 'sms', slot: 'now', data: { decision: { purpose: 'marketing', credits: { price: 30 }, slot: { picked: 'now' } } } }), TZ);
  assertEqual(dry.both, { dryRun: { funnel: { slot: { now: { credits: 30 } } } } }, 'dry run under dryRun');
});

test('a goal reached: credited to the last message; none before any message; not split before the change', () => {
  assertEqual(
    moreCounts(ev('journey.converted', { data: { goalEvent: 'visit.started', lastTouch: { channel: 'sms', slot: 'evening', purpose: 'marketing' } } }), TZ).both,
    { funnel: { channel: { sms: { converted: 1 } }, slot: { evening: { converted: 1 } } } },
    'last message',
  );
  assertEqual(moreCounts(ev('journey.converted', { data: { lastTouch: null } }), TZ).both, { funnel: { channel: { none: { converted: 1 } }, slot: { none: { converted: 1 } } } }, 'before any message');
  assertEqual(moreCounts(ev('journey.converted', { data: { goalEvent: 'visit.started' } }), TZ).both, null, 'old conversion');
  assertEqual(moreCounts(ev('journey.converted', { mode: 'test', data: { lastTouch: null } }), TZ).both, { dryRun: { funnel: { channel: { none: { converted: 1 } }, slot: { none: { converted: 1 } } } } }, 'test run');
  // The old counter is unchanged.
  assertEqual(countsFor(ev('journey.converted', { data: { lastTouch: null } })).both, { converted: 1 }, 'converted still 1');
});

test('ratings: count, stars, low; nonsense stars count nothing', () => {
  assertEqual(moreCounts(ev('rating.submitted', { journeyKey: 'review_ask', data: { stars: 2 } }), TZ).both, { ratings: { count: 1, stars: 2, low: 1 } }, 'low');
  assertEqual(moreCounts(ev('rating.submitted', { journeyKey: 'review_ask', data: { stars: 5 } }), TZ).both, { ratings: { count: 1, stars: 5 } }, 'five');
  for (const stars of [0, 6, 2.5, '4', null]) assertEqual(moreCounts(ev('rating.submitted', { data: { stars } as any }), TZ).both, typeof stars === 'string' ? { ratings: { count: 1, stars: 4 } } : null, `stars ${stars}`);
});

test('aggregate: new fields in the same docs, old counters unchanged', () => {
  const deltas = aggregate('v1', TZ, [
    ev('visit.started', { journeyKey: null, data: { isFirstVisit: true, reachable: true } }),
    ev('message.sent', { channel: 'sms', slot: 'now', data: { purpose: 'marketing', credits: 15 } }),
    ev('rating.submitted', { journeyKey: 'review_ask', data: { stars: 4 } }),
  ]);
  const byId = Object.fromEntries(deltas.map((d) => [d.docId, d.counts as any]));
  assertEqual(Object.keys(byId).sort(), ['v1__venue_20260929', 'v1_review_ask_20260929', 'v1_welcome_second_visit_20260929'], 'docs');
  const venue = byId[`v1_${VENUE_KEY}_20260929`];
  assertEqual(venue.visits, { total: 1, first: 1 }, 'visits as before');
  assertEqual(venue.heat, { w2: { h12: 1 } }, 'heat');
  assertEqual(venue.capture, { first: { visits: 1, yes: 1 } }, 'capture');
  assertEqual(venue.credits, { sms: 15 }, 'credits as before');
  assertEqual(venue.funnel, { slot: { now: { credits: 15 } } }, 'funnel on _venue');
  assertEqual(byId['v1_welcome_second_visit_20260929'].funnel, { slot: { now: { credits: 15 } } }, 'funnel on the journey');
  assertEqual(byId['v1_review_ask_20260929'].ratings, { count: 1, stars: 4 }, 'ratings on the journey');
  assert(!byId['v1_welcome_second_visit_20260929'].heat, 'no heat on a journey doc');
});

console.log('\nCapture, heatmap, funnel\n');

test('capture rate per visit, new and returning apart; old visits only in the totals', () => {
  const c = captureNumbers({ visits: { total: 12, first: 8, revisits: 4, captures: 15 }, capture: { first: { visits: 6, yes: 4 }, returning: { visits: 3, yes: 2 } } });
  assertEqual(c.visits, { total: 12, first: 8, returning: 4 }, 'visits');
  assertEqual(c.logins, 15, 'logins');
  assertEqual(c.first, { visits: 6, yes: 4, rate: 0.6667 }, 'new');
  assertEqual(c.returning, { visits: 3, yes: 2, rate: 0.6667 }, 'returning');
  assertEqual(c.all, { visits: 9, yes: 6, rate: 0.6667 }, 'all');
  assertEqual(captureNumbers({}).all, { visits: 0, yes: 0, rate: null }, 'nothing yet');
  assertEqual(captureNumbers({ capture: { first: { visits: 1, yes: 3 } } }).first.yes, 1, 'never more yes than visits');
  assertEqual([share(1, 3), share(0, 0), share(2, 2)], [0.3333, null, 1], 'share');
});

test('heatmap: Monday first, 24 hours, totals and the busiest day and hour', () => {
  const h = heatmapNumbers({ heat: { w1: { h12: 2, h19: 1 }, w5: { h19: 4 }, w7: { h00: 1 } } }, TZ);
  assertEqual(h.cells.length, 7, '7 days');
  assert(h.cells.every((r) => r.length === 24), '24 hours');
  assertEqual([h.cells[0][12], h.cells[4][19], h.cells[6][0]], [2, 4, 1], 'cells');
  assertEqual([h.total, h.max], [8, 4], 'total, max');
  assertEqual(h.byWeekday, [3, 0, 0, 0, 4, 0, 1], 'per weekday');
  assertEqual(h.byHour[19], 5, 'per hour');
  assertEqual(h.busiest, { weekday: 5, hour: 19, visits: 4 }, 'busiest hour of the week');
  assertEqual(h.busiestDay, { weekday: 5, visits: 4 }, 'busiest day');
  assertEqual(h.busiestHour, { hour: 19, visits: 5 }, 'busiest hour');
  const empty = heatmapNumbers({}, TZ);
  assertEqual([empty.total, empty.busiest, empty.busiestDay, empty.busiestHour], [0, null, null, null], 'empty');
});

test('goal kinds', () => {
  assertEqual(
    [goalKindOf('offer.redeemed'), goalKindOf('visit.revisit'), goalKindOf('booking.direct'), goalKindOf(null, true), goalKindOf(null), goalKindOf('x.y')],
    ['visit', 'visit', 'booking', 'rating', 'none', 'other'],
    'kinds',
  );
});

test('funnel: per channel and send time; SMS has no opens; revenue next to credits for visit goals', () => {
  const stats = {
    entered: 20,
    converted: 4,
    sends: { sms: { sent: 10, delivered: 9, clicked: 3 }, email: { sent: 6, delivered: 6, opened: 4, clicked: 1 } },
    credits: { sms: 150, email: 6 },
    bySlot: { evening: { sent: 9, clicked: 3 }, morning: { sent: 7, clicked: 1 } },
    funnel: {
      channel: { sms: { converted: 2 }, email: { converted: 1 } },
      slot: { evening: { delivered: 8, credits: 135, converted: 2 }, morning: { delivered: 7, opened: 4, credits: 21, converted: 1 } },
    },
  };
  const f = journeyFunnel(stats, 'visit', CHF);
  assertEqual(f.byChannel.map((r) => r.key), ['sms', 'email'], 'channel order');
  assertEqual(f.byChannel[0], { key: 'sms', sent: 10, delivered: 9, opened: null, clicked: 3, converted: 2, credits: 150, creditsValue: { amountMinor: 150, currency: 'CHF' }, revenue: { amountMinor: 9000, currency: 'CHF' } }, 'sms row');
  assertEqual(f.byChannel[1].opened, 4, 'email opens');
  assertEqual(f.bySlot.map((r) => r.key), ['morning', 'evening'], 'slot order');
  assertEqual(f.bySlot[1], { key: 'evening', sent: 9, delivered: 8, opened: 0, clicked: 3, converted: 2, credits: 135, creditsValue: { amountMinor: 135, currency: 'CHF' }, revenue: { amountMinor: 9000, currency: 'CHF' } }, 'evening row');
  assertEqual(
    [f.total.sent, f.total.delivered, f.total.opened, f.total.clicked, f.total.converted, f.total.credits],
    [16, 15, 4, 4, 4, 156],
    'journey line',
  );
  assertEqual(f.total.revenue, { amountMinor: 18000, currency: 'CHF' }, '4 × CHF 45');
  assertEqual([f.convertedNotSplit, f.convertedBeforeMessage, f.started], [1, 0, 20], 'one from before the split');
});

test('funnel: no revenue for other goals or without an average spend; credits priced in the default currency', () => {
  const stats = { converted: 3, sends: { email: { sent: 5 } }, credits: { email: 5 }, utility: { sends: 2 }, funnel: { channel: { none: { converted: 1 }, email: { converted: 2 } } } };
  const review = journeyFunnel(stats, 'rating', CHF);
  assertEqual([review.total.revenue, review.byChannel[0].revenue], [null, null], 'no revenue for a review ask');
  assertEqual([review.convertedBeforeMessage, review.convertedNotSplit], [1, 0], 'before any message');
  assertEqual(review.serviceSent, 2, 'free info messages counted apart');
  assert(!review.byChannel.some((r) => r.key === 'none'), 'no "none" row');
  const noAvg = journeyFunnel(stats, 'visit', { averageSpend: null, creditsPerUnit: { CHF: 100 }, defaultCurrency: 'CHF' });
  assertEqual([noAvg.total.revenue, noAvg.total.creditsValue], [null, { amountMinor: 5, currency: 'CHF' }], 'no average spend');
  assertEqual(creditsValue(1234, { averageSpend: { amountMinor: 1000, currency: 'EUR' }, creditsPerUnit: { CHF: 100 }, defaultCurrency: 'CHF' }), null, 'a currency without a credit price');
  assertEqual(creditsValue(250, CHF), { amountMinor: 250, currency: 'CHF' }, '250 credits = CHF 2.50');
});

test('funnel: ratings average; a test run has only sends and credits', () => {
  const f = journeyFunnel({ ratings: { count: 3, stars: 13, low: 1 } }, 'rating', CHF);
  assertEqual(f.ratings, { count: 3, averageStars: 4.3, low: 1 }, 'ratings');
  assertEqual(journeyFunnel({}, 'rating', CHF).ratings, { count: 0, averageStars: null, low: 0 }, 'no ratings');
  const dry = journeyFunnel({ entered: 2, sends: { sms: { sent: 2 } }, credits: { sms: 30 }, bySlot: { now: { sent: 2 } }, funnel: { slot: { now: { credits: 30 } } } }, 'visit', CHF);
  assertEqual([dry.total.sent, dry.total.delivered, dry.total.credits, dry.bySlot[0].credits], [2, 0, 30, 30], 'test run');
});

test('sumStats keeps live referrals now (Bring a friend on the card)', () => {
  const { live, testRun } = sumStats([{ referrals: { joined: 2 }, dryRun: { referrals: { joined: 1 } } }, { referrals: { joined: 1 }, heat: { w1: { h09: 1 } } }]);
  assertEqual(live.referrals, { joined: 3 }, 'live referrals');
  assertEqual(testRun.referrals, { joined: 1 }, 'test run apart');
  assertEqual(live.heat, { w1: { h09: 1 } }, 'heat summed');
  assertEqual(cardNumbers({ venue: live, returnConversions: 0, averageSpend: null, upcomingStays: null }).friendsJoined, 3, 'friends on the card');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
