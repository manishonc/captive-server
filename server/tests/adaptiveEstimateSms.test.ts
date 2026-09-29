/**
 * PR F0 — the owner estimate prices SMS the way the engine sends it.
 *
 * Run: npx tsx tests/adaptiveEstimateSms.test.ts   (from captive-server/server)
 *
 * No Firestore. What these pin:
 *  - `firstMarketingPool` / `journeySmsParts` measure the journey's FIRST marketing SMS: the
 *    welcome's is 2 parts with a long venue name, the review ask's 1; a journey without
 *    marketing SMS counts 1; a curly apostrophe in the venue name costs nothing (still 1 part).
 *  - `withSmsSteps`: for a guest with a phone, an SMS-first journey's first message costs its real
 *    parts and the follow-ups the email price (an SMS is never "opened", so a follow-up moves down
 *    the ladder) — hand-computed below. Email-first and info journeys are left alone. An
 *    approximation: after a tap on the SMS link the welcome's last reminder goes by SMS again
 *    (`same_as_last_click`); it is priced as email (docs/adaptive-engine.md).
 */

import { SEED } from '../src/adaptive/seed/definitions';
import { buildSeedPlan } from '../src/adaptive/seed/buildSeed';
import { COL } from '../src/adaptive/store/collections';
import { journeyDefinitionSchema, type JourneyDefinition } from '../src/adaptive/core/schemas';
import { estimateMonthly, type EstimateJourneyInput, type EstimatePrices } from '../src/adaptive/core/estimate';
import { firstMarketingPool, journeySmsParts, withSmsSteps } from '../src/adaptive/service/estimateSms';

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const definition = (key: string): JourneyDefinition => journeyDefinitionSchema.parse(SEED.journeys.find((j) => j.header.key === key)!.definition);
const variants = buildSeedPlan()
  .units.flatMap((u) => u.docs)
  .filter((d) => d.path[0] === COL.variants)
  .map((d) => d.data as any);
const restaurant = SEED.playbooks.find((p) => p.key === 'restaurant_growth')!;
const offers = restaurant.content.offerMenuDefaults as any[];
const LINK = 'https://visit.askheidi.app/s/xxxxxxxx';

console.log('\nEstimate: SMS as sent');

test("the first marketing send's pool: welcome_offer, review_ask; none for the Wi-Fi card", () => {
  assertEqual(firstMarketingPool(definition('welcome_second_visit')), 'welcome_offer', 'welcome');
  assertEqual(firstMarketingPool(definition('review_ask')), 'review_ask', 'review ask');
  assertEqual(firstMarketingPool(definition('wifi_info_card')), null, 'Wi-Fi card (service only)');
});

test('its parts: welcome 2 with a long name, review ask 1, none → 1; a curly apostrophe in the name costs nothing', () => {
  const long = 'Indian Gourmet Restaurant Interlaken';
  assertEqual(journeySmsParts({ definition: definition('welcome_second_visit'), variants, venueName: long, slots: { offer: 'dessert' }, offers, link: LINK }), 2, 'welcome');
  assertEqual(journeySmsParts({ definition: definition('review_ask'), variants, venueName: long, slots: {}, offers, link: LINK }), 1, 'review ask');
  assertEqual(journeySmsParts({ definition: definition('wifi_info_card'), variants, venueName: long, slots: {}, offers, link: LINK }), 1, 'no marketing SMS');
  const curly = journeySmsParts({ definition: definition('review_ask'), variants, venueName: 'Luigi’s', slots: {}, offers, link: LINK });
  const straight = journeySmsParts({ definition: definition('review_ask'), variants, venueName: "Luigi's", slots: {}, offers, link: LINK });
  assertEqual([straight, curly], [1, 1], "measured with its own name: a curly apostrophe doesn't make it Unicode");
});

test('first SMS at its parts, follow-ups by email, per venue (a clicked SMS\'s last reminder is priced as email too)', () => {
  const prices: EstimatePrices = { email: 1, sms: 15, creditsPerUnit: 100, currency: 'CHF' };
  const venues = [
    { venueId: 'v1', captures30d: 150, optedIn30d: 100, withPhone: 60, emailOnly: 40 },
    { venueId: 'v2', captures30d: 50, optedIn30d: 10, withPhone: 10, emailOnly: 0 },
  ];
  const journeys: Array<EstimateJourneyInput & { smsParts: Record<string, number> }> = [
    { journeyKey: 'welcome_second_visit', purpose: 'marketing', avgTouchesPerGuest: 2.4, ladder: ['sms', 'email', 'whatsapp'], smsParts: { v1: 2, v2: 1 } },
    { journeyKey: 'win_back', purpose: 'marketing', avgTouchesPerGuest: 1.5, ladder: ['email', 'sms'], smsParts: { v1: 3, v2: 3 } },
    { journeyKey: 'wifi_info_card', purpose: 'service', avgTouchesPerGuest: 1, ladder: ['sms', 'email'], smsParts: { v1: 2, v2: 2 } },
  ];
  const base = estimateMonthly(venues, journeys, prices, { returnRate: 0.12, avgSpendMinor: 4500 });
  const priced = withSmsSteps(base, venues, journeys, prices);
  // v1 welcome: phone guests 60 × (2 × 15 + 1.4 × 1) = 1884; email-only 40 × 2.4 × 1 = 96 → 1980.
  // v2 welcome: 10 × (1 × 15 + 1.4 × 1) = 164. win_back starts by email: 100 × 1.5 × (0.6 × 1 + 0.4 × 1) = 150 and 10 × 1.5 = 15.
  assertEqual(priced.perVenue.map((v) => [v.venueId, v.credits]), [['v1', 1980 + 150], ['v2', 164 + 15]], 'per venue');
  assertEqual(priced.perJourney.find((j) => j.journeyKey === 'welcome_second_visit')!.credits, 1980 + 164, 'welcome');
  assertEqual(priced.perJourney.find((j) => j.journeyKey === 'win_back')!.credits, 165, 'email first: unchanged');
  assertEqual([priced.creditsPerMonth, priced.costPerMonthMinor], [2309, 2309], 'total and CHF 23.09');
  assertEqual(priced.revenuePerMonthMinor, base.revenuePerMonthMinor, 'revenue unchanged');
});

test('one touch, one part: exactly the old estimate', () => {
  const prices: EstimatePrices = { email: 1, sms: 15, creditsPerUnit: 100, currency: 'CHF' };
  const venues = [{ venueId: 'v1', captures30d: 150, optedIn30d: 100, withPhone: 60, emailOnly: 40 }];
  const journeys = [{ journeyKey: 'stay_review', purpose: 'marketing' as const, avgTouchesPerGuest: 1, ladder: ['sms', 'email'] as any, smsParts: { v1: 1 } }];
  const base = estimateMonthly(venues, journeys, prices, { returnRate: 0, avgSpendMinor: 0 });
  assertEqual(withSmsSteps(base, venues, journeys, prices), base, 'unchanged');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
