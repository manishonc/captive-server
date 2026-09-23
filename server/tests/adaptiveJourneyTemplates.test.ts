/**
 * Tests for adaptive/core/validateJourneyTemplate and describeJourney.
 *
 * Run: npx tsx tests/adaptiveJourneyTemplates.test.ts   (from captive-server/server)
 *
 * No Firestore. Starts from the A1 "Welcome → come back" JSON of
 * 03-playbook-format §13.1 and breaks one thing at a time:
 *
 *  - **V01 graph rules:** a missing target, an unreachable step, a dead end and
 *    a loop are each rejected — and the thank-you step, reached only through the
 *    goal's `onReach`, does NOT count as unreachable.
 *  - **V16:** unknown step and trigger types are rejected (the engine would not
 *    know them).
 *  - **V02/V03/V14:** pools must be declared with a matching purpose, caps stay
 *    under the platform maxima, and info journeys can't give offers.
 *  - **describeJourneySteps** numbers steps in the order a guest meets them, so
 *    "→ step 7" in one step matches the list.
 */

import { validateJourneyTemplate } from '../src/adaptive/core/validateJourneyTemplate';
import { describeJourneySteps } from '../src/adaptive/core/describeJourney';
import { journeyDefinitionSchema } from '../src/adaptive/core/schemas';
import { welcomeSecondVisit, reviewAsk } from '../src/adaptive/seed/definitions/journeysRestaurant';
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
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function check(mutate: (def: any, header: any) => void, base = welcomeSecondVisit) {
  const def = clone(base.definition);
  const header = clone(base.header);
  mutate(def, header);
  const report = validateJourneyTemplate({ header, definition: def });
  return { report, errors: report.issues.filter((i) => i.severity === 'error') };
}

test('A1 as specified passes, including the goal-only thank-you step', () => {
  const { report } = check(() => {});
  assert(report.ok, JSON.stringify(report.issues));
});

test('V01: an edge to a missing step is an error', () => {
  const { errors } = check((d) => { d.nodes.d1.edges.done = 'nowhere'; });
  assert(errors.some((e) => e.code === 'V01' && /missing step/.test(e.message)), JSON.stringify(errors));
});

test('V01: an unreachable step is an error', () => {
  const { errors } = check((d) => { d.nodes.orphan = { type: 'delay', config: { for: '1h' }, edges: { done: 'x_done' } }; });
  assert(errors.some((e) => e.code === 'V01' && /orphan/.test(e.message)), JSON.stringify(errors));
});

test('V01: without the goal, the thank-you step becomes unreachable', () => {
  const { errors } = check((d) => { delete d.goal; });
  assert(errors.some((e) => e.code === 'V01' && /thanks/.test(e.message)), JSON.stringify(errors));
});

test('V01: a missing outcome path is an error', () => {
  const { errors } = check((d) => { delete d.nodes.s1.edges.skipped; });
  assert(errors.some((e) => e.code === 'V01' && /no path for “skipped”/.test(e.message)), JSON.stringify(errors));
});

test('V01: a loop is an error', () => {
  const { errors } = check((d) => { d.nodes.w_redeem.edges.done = 'd1'; });
  assert(errors.some((e) => e.code === 'V01' && /loop/.test(e.message)), JSON.stringify(errors));
});

test('V16: an unknown step type or trigger is an error', () => {
  const a = check((d) => { d.nodes.d1.type = 'teleport'; });
  assert(a.errors.some((e) => e.code === 'V16'), 'unknown step');
  const b = check((d) => { d.entry.trigger.type = 'moon.phase'; });
  assert(b.errors.some((e) => e.code === 'V16'), 'unknown trigger');
});

test('V06: incomplete trigger config is an error', () => {
  const { errors } = check((d) => { d.entry.trigger = { type: 'days_since_visit', config: {} }; });
  assert(errors.some((e) => e.code === 'V06'), JSON.stringify(errors));
});

test('V02: sending from an undeclared pool, or with the wrong purpose, is an error', () => {
  const a = check((d) => { d.nodes.s1.config.pool = 'nope'; });
  assert(a.errors.some((e) => e.code === 'V02'), 'undeclared pool');
  const b = check((d) => { d.nodes.thanks.config.purpose = 'marketing'; });
  assert(b.errors.some((e) => e.code === 'V02'), 'purpose mismatch');
});

test('V03: caps above the platform maxima are an error', () => {
  const { errors } = check((d) => { d.caps = { maxTouches: 7, stopAfterClicks: 4 }; });
  assert(errors.filter((e) => e.code === 'V03').length === 2, JSON.stringify(errors));
});

test('V08: "differ in channel" with a one-channel ladder is an error', () => {
  const { errors } = check((d) => { d.channelLadder = ['sms']; }, reviewAsk);
  assert(errors.some((e) => e.code === 'V08'), JSON.stringify(errors));
});

test('V14: an info journey that gives an offer or sends marketing is an error', () => {
  const { errors } = check((d, h) => {
    h.purpose = 'service';
  });
  assert(errors.some((e) => e.code === 'V14'), JSON.stringify(errors));
});

test('the Wi-Fi card (a one-step info journey) passes', () => {
  const { report } = check(() => {}, wifiInfoCard);
  assert(report.ok, JSON.stringify(report.issues));
});

test('steps are numbered in the order a guest meets them, with End last', () => {
  const def = journeyDefinitionSchema.parse(welcomeSecondVisit.definition);
  const steps = describeJourneySteps(def);
  assert(steps[0].nodeId === 'offer' && steps[1].nodeId === 'd1' && steps[2].nodeId === 's1', steps.map((s) => s.nodeId).join(','));
  assert(steps[steps.length - 1].type === 'exit', 'ends with an exit');
  const wait = steps.find((s) => s.nodeId === 'w1')!;
  const redeem = steps.find((s) => s.nodeId === 'w_redeem')!;
  assert(wait.branches.some((b) => b.label === 'Clicked' && b.to === `step ${redeem.number}`), JSON.stringify(wait.branches));
  const thanks = steps.find((s) => s.nodeId === 'thanks')!;
  assert(thanks.viaGoal && /Info message/.test(thanks.detail), JSON.stringify(thanks));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
