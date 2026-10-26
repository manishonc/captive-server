/**
 * Guest full view, "What will happen": a running journey's next step in the owner's terms
 * (`journeyAhead`), its goal (`journeyGoal`) and the step names (`stepNamesOf`), on the real
 * seeded Welcome → come back v2 and Wi-Fi & info card definitions.
 *
 * Run: npx tsx tests/adaptiveOwnerAhead.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { journeyDefinitionSchema, type JourneyDefinition } from '../src/adaptive/core/schemas';
import { goalStillOpen, journeyAhead, journeyGoal, stepNamesOf, waitsForOfferEnd } from '../src/adaptive/core/owner/journeyAhead';
import { welcomeSecondVisitV2 } from '../src/adaptive/seed/definitions/journeysWelcomeV2';
import { welcomeSecondVisit } from '../src/adaptive/seed/definitions/journeysRestaurant';
import { wifiInfoCard } from '../src/adaptive/seed/definitions/journeysGuestInfo';

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const welcome = journeyDefinitionSchema.parse(welcomeSecondVisitV2.definition);
const wifi = journeyDefinitionSchema.parse(wifiInfoCard.definition);
const EN = stepNamesOf(welcome, 'en');
const DE = stepNamesOf(welcome, 'de');

const waiting = (kind: 'timer' | 'events' | 'send_due', nodeId: string) => ({ status: 'active', waiting: { kind, nodeId }, cursor: { nodeId } });

test('send steps are named after their message, in English and German; other steps have no name', () => {
  assertEqual([EN.s1, EN.s2_next, EN.last, EN.thanks], ['Welcome offer', 'Welcome offer', 'Last chance', 'Thank you'], 'English');
  assertEqual([DE.s1, DE.last, DE.thanks], ['Willkommensangebot', 'Letzte Chance', 'Dankeschön'], 'German');
  assertEqual(['d1', 'w1', 'w_redeem', 'w_offer', 'x_exhausted', 'offer'].map((k) => EN[k] ?? null), [null, null, null, null, null, null], 'no names for waits, offers and ends');
  assertEqual(stepNamesOf(wifi, 'en'), { s: 'Wi-Fi & info card' }, 'the Wi-Fi card');
});

test('a send waiting for its time is the next message itself, with no wait before it', () => {
  assertEqual(journeyAhead(welcome, waiting('send_due', 'last'), EN), { kind: 'message', step: { key: 'last', name: 'Last chance' }, afterWait: false, ifNoReaction: false }, 'last chance due');
});

test('a delay leads to the message after it (the 15 minutes before the welcome, the 3 days before the last chance)', () => {
  assertEqual(journeyAhead(welcome, waiting('timer', 'd1'), EN), { kind: 'message', step: { key: 's1', name: 'Welcome offer' }, afterWait: true, ifNoReaction: false }, 'after d1');
  assertEqual(journeyAhead(welcome, waiting('timer', 'w_redeem'), DE), { kind: 'message', step: { key: 'last', name: 'Letzte Chance' }, afterWait: true, ifNoReaction: false }, 'after w_redeem (German)');
});

test('waiting for a reaction says what comes if none does', () => {
  assertEqual(journeyAhead(welcome, waiting('events', 'w1'), EN), { kind: 'message', step: { key: 's2_next', name: 'Welcome offer' }, afterWait: true, ifNoReaction: true }, 'no reaction to the welcome');
  assertEqual(journeyAhead(welcome, waiting('events', 'w2'), EN), { kind: 'end', step: null, afterWait: true, ifNoReaction: true }, 'no click on the follow-up: wait for the offer to end, then end');
});

test('waiting until the offer runs out ends the journey', () => {
  assertEqual(journeyAhead(welcome, waiting('timer', 'w_offer'), EN), { kind: 'end', step: null, afterWait: true, ifNoReaction: false }, 'w_offer');
});

test('nothing ahead for an ended journey, one that waits for nothing, an unknown step or a branch that depends on the guest', () => {
  assertEqual(journeyAhead(welcome, { status: 'converted', waiting: { kind: 'timer', nodeId: 'w_offer' } }, EN), null, 'ended');
  assertEqual(journeyAhead(welcome, { status: 'active', waiting: null }, EN), null, 'not waiting');
  assertEqual(journeyAhead(welcome, waiting('timer', 'gone'), EN), null, 'unknown step');
  const branchy: JourneyDefinition = {
    ...welcome,
    nodes: {
      d: { type: 'delay', config: { for: '1h' }, edges: { done: 'b' } },
      b: { type: 'branch', config: {}, edges: { vip: 's1', default: 'x' } },
      s1: welcome.nodes.s1,
      x: { type: 'exit', config: { status: 'completed' }, edges: {} },
    },
  };
  assertEqual(journeyAhead(branchy, waiting('timer', 'd'), EN), null, 'a branch ahead');
});

test("the goal: Welcome → come back ends early when the offer is used, with a thank-you; the Wi-Fi card has none", () => {
  assertEqual(journeyGoal(welcome, EN), { event: 'offer.redeemed', step: { key: 'thanks', name: 'Thank you' } }, 'welcome');
  assertEqual(journeyGoal(wifi, stepNamesOf(wifi, 'en')), null, 'Wi-Fi card');
});

test('the offer’s end is the journey’s end only where the journey waits for it (v2), never on v1 or after the wait', () => {
  const v1 = journeyDefinitionSchema.parse(welcomeSecondVisit.definition);
  assertEqual(['w1', 'w2', 'w_redeem', 'w_offer', 'last'].map((k) => waitsForOfferEnd(welcome, k)), [true, true, true, true, true], 'v2 waits for the offer from every step before it');
  assertEqual(['w1', 'w2', 'w_redeem', 'last'].map((k) => waitsForOfferEnd(v1, k)), [false, false, false, false], 'v1 ends earlier whatever the offer');
  assertEqual([waitsForOfferEnd(welcome, 'x_exhausted'), waitsForOfferEnd(welcome, null), waitsForOfferEnd(welcome, 'gone')], [false, false, false], 'from an end, nothing or an unknown step');
});

test('the goal is open until it is reached or its window is over', () => {
  const start = Date.UTC(2026, 9, 20, 17, 42);
  const day = 24 * 3600 * 1000;
  assertEqual(goalStillOpen(welcome, { goal: null, startedAtMs: start }, start + day), true, 'open');
  assertEqual(goalStillOpen(welcome, { goal: { reachedAt: start + day, eventId: 'ev' }, startedAtMs: start }, start + day), false, 'reached: the thank-you is on its way');
  assertEqual(goalStillOpen(welcome, { goal: null, startedAtMs: start }, start + 91 * day), false, 'past its 90-day window');
  assertEqual(goalStillOpen(welcome, { goal: null, startedAtMs: null }, start + 91 * day), true, 'no start time: kept');
  assertEqual(goalStillOpen(wifi, { goal: null, startedAtMs: start }, start), false, 'no goal');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
