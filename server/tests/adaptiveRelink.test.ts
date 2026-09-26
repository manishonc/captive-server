/**
 * The owner links a guest back to a stay (PR D, D-D8), the pure part: what the interpreter does
 * with `stay.relinked`. A wait anchored on the stay's dates is entered again when the dates moved
 * while the guest was unlinked (a new target and token, or `past`); when the anchor didn't move,
 * nothing happens — the kept wait runs at its own time off the task stays/link.ts re-arms, so the
 * gate's stale rule sees how late it is. `stay.changed` keeps its PR C behaviour, and waits that
 * aren't anchored on the stay ignore the re-link.
 *
 * Run: npx tsx tests/adaptiveRelink.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { SEED } from '../src/adaptive/seed/definitions';
import { journeyDefinitionSchema, type JourneyDefinition } from '../src/adaptive/core/schemas';
import { factsFrom } from '../src/adaptive/core/runtime/conditions';
import { step, type InterpreterContext } from '../src/adaptive/core/runtime/interpreter';
import { freshState, type InstanceState, type RuntimeInput } from '../src/adaptive/core/runtime/types';
import { HOUR_MS, zonedTime } from '../src/adaptive/core/runtime/time';

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

const TZ = 'Europe/Zurich';
const iso = (ms: number) => new Date(ms).toISOString();
const at = (d: number, h: number, m = 0) => zonedTime(2026, 10, d, h, m, TZ).getTime();

function seedDefinition(key: string): Record<string, any> {
  const seed = SEED.journeys.find((j) => j.header.key === key);
  if (!seed) throw new Error(`no seed journey ${key}`);
  return seed.definition as Record<string, any>;
}

function journey(key: string): JourneyDefinition {
  return journeyDefinitionSchema.parse(seedDefinition(key));
}

/** The seeded journey with one node swapped (still checked by the schema). */
function withNode(key: string, nodeId: string, node: Record<string, unknown>): JourneyDefinition {
  const d = seedDefinition(key);
  return journeyDefinitionSchema.parse({ ...d, nodes: { ...d.nodes, [nodeId]: node } });
}

function run(def: JourneyDefinition, state: InstanceState, input: RuntimeInput, now: number, stay: InterpreterContext['stay']) {
  return step(state, input, { now, definition: def, venueTz: TZ, slots: {}, offers: [], facts: factsFrom({ stay: stay ? { nights: stay.nights } : {} }), stay });
}

const event = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, occurredAt: 0, data });
/** The event stays/link.ts writes: eventIdFor('cms', 'stay:<stayId>:relinked:<linkSeq>'), delivered to every active instance. */
const relinked = (linkSeq = 3) => ({ kind: 'event' as const, event: event(`ev_relinked_${linkSeq}`, 'stay.relinked', { stayId: 'st_tom', linkSeq, by: 'uid_owner' }) });
const changed = () => ({ kind: 'event' as const, event: event('ev_changed', 'stay.changed', { stayId: 'st_tom', datesVersion: 2 }) });

// Tom: 5 nights, 12 → 17 Oct 2026 (check-in 15:00, checkout 10:00).
const tom = { checkInAt: at(12, 15), checkOutAt: at(17, 10), nights: 5 };
/** Stay guide's checkout wait: checkout − 1 day at 17:00 → Fri 16 Oct 17:00. */
const CO_TARGET = at(16, 17);

/** Stay guide walked to its checkout wait (co_w: anchor stay.checkOutAt, offset −1d, at 17:00). */
function atCheckoutWait(def: JourneyDefinition = journey('stay_guide')): InstanceState {
  const t0 = at(12, 17);
  let s = run(def, freshState(def.start, t0), { kind: 'start' }, t0, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, t0, tom).state;
  assertEqual(s.cursor.nodeId, 'mid_w', '5 nights → mid-stay wait');
  const mid = at(14, 11);
  s = run(def, s, { kind: 'wake', nodeId: 'mid_w' }, mid, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'mid', outcome: 'sent', touch: null }, mid, tom).state;
  assertEqual(s.cursor.nodeId, 'co_w', 'waiting before the checkout message');
  return s;
}

/** As stays/link.ts leaves it: active again, the wait kept, its token suffixed `:relink<seq>`. */
function resumed(s: InstanceState, linkSeq = 3): InstanceState {
  return { ...s, status: 'active', exitReason: null, waiting: { ...s.waiting!, token: `${s.waiting!.token}:relink${linkSeq}` }, rev: s.rev + 1 };
}

// ── Anchored wait, the anchor didn't move ────────────────────────────────────

console.log('\nstay.relinked on an anchored wait_until');

test('unchanged dates, before the wait is due: nothing happens (no effects, same token, same state)', () => {
  const s = resumed(atCheckoutWait());
  assertEqual(iso(s.waiting!.untilAt!), iso(CO_TARGET), 'checkout − 1 day, 17:00');
  const r = run(journey('stay_guide'), s, relinked(), at(15, 9), tom);
  assert(r.unchanged, 'unchanged');
  assertEqual(r.effects, [], 'no effects');
  assertEqual(r.state.waiting!.token, s.waiting!.token, 'the resume token is kept (link.ts re-arms it)');
  assert(r.state.waiting!.token.endsWith(':relink3'), 'still the resume token');
  assertEqual([r.state.cursor.nodeId, r.state.waiting!.untilAt, r.state.rev], [s.cursor.nodeId, s.waiting!.untilAt, s.rev], 'same wait, no new revision');
});

test('unchanged dates, the wait already due (or long overdue): still nothing — not `done`, not `past`', () => {
  const s = resumed(atCheckoutWait());
  for (const now of [CO_TARGET, at(16, 17, 2), at(16, 23), at(17, 9, 30), at(18, 12)]) {
    const r = run(journey('stay_guide'), s, relinked(), now, tom);
    assert(r.unchanged, `unchanged at ${iso(now)}`);
    assertEqual(r.effects, [], `no effects at ${iso(now)}`);
    assertEqual([r.state.cursor.nodeId, r.state.waiting!.token, r.state.status], ['co_w', s.waiting!.token, 'active'], `kept at ${iso(now)}`);
  }
});

test('only the other date moved, or the checkout hour on the same day: the anchor target is the same → nothing', () => {
  const s = resumed(atCheckoutWait());
  const arrivalMoved = { ...tom, checkInAt: at(13, 15), nights: 4 };
  const laterHour = { ...tom, checkOutAt: at(17, 11) };
  for (const [name, stay] of [['arrival moved', arrivalMoved], ['checkout 11:00 instead of 10:00', laterHour]] as const) {
    for (const now of [at(15, 9), at(16, 17, 2)]) {
      const r = run(journey('stay_guide'), s, relinked(), now, stay);
      assert(r.unchanged && r.effects.length === 0, `${name} at ${iso(now)}: unchanged`);
    }
  }
});

test('after the re-link the re-armed wake runs the kept wait at its own time → the checkout message', () => {
  const def = journey('stay_guide');
  const s = resumed(atCheckoutWait());
  const kept = run(def, s, relinked(), at(15, 9), tom).state;
  const r = run(def, kept, { kind: 'wake', nodeId: 'co_w' }, CO_TARGET, tom);
  assertEqual([r.state.status, r.state.cursor.nodeId], ['active', 'co'], 'on to the checkout message');
  assert(r.effects.some((e) => e.type === 'send' && e.nodeId === 'co'), 'a send');
  assert(r.state.trail.some((t) => t.nodeId === 'co_w' && t.outcome === 'done'), 'co_w left by `done`');
});

// ── Anchored wait, the anchor moved ──────────────────────────────────────────

test('moved checkout (later): re-entered — a new token (no longer the resume token) and a timer at the new target', () => {
  const def = journey('stay_guide');
  const s = resumed(atCheckoutWait());
  const later = { ...tom, checkOutAt: at(18, 10), nights: 6 };
  for (const now of [at(15, 9), at(16, 17, 2)]) {
    const r = run(def, s, relinked(), now, later);
    assertEqual([r.state.status, r.state.cursor.nodeId], ['active', 'co_w'], `still the checkout wait (${iso(now)})`);
    assertEqual(iso(r.state.waiting!.untilAt!), iso(at(17, 17)), `the new checkout − 1 day 17:00 (${iso(now)})`);
    assertEqual(r.state.waiting!.token, `co_w@${now}`, `a fresh token (${iso(now)})`);
    assert(!r.state.waiting!.token.endsWith(':relink3'), 'link.ts does not re-arm it: the interpreter scheduled it');
    assertEqual(r.effects, [{ type: 'timer', nodeId: 'co_w', at: at(17, 17), token: `co_w@${now}` }], `one timer (${iso(now)})`);
    assertEqual([r.state.cursor.enteredAt, r.state.rev], [now, s.rev + 1], 'entered again');
  }
});

test('moved checkout (earlier) to a target already gone by: the `past` edge (no checkout message)', () => {
  const def = journey('stay_guide');
  const s = resumed(atCheckoutWait());
  const earlier = { ...tom, checkOutAt: at(15, 10), nights: 3 };
  const now = at(15, 9); // the new target (14 Oct 17:00) has passed
  const r = run(def, s, relinked(), now, earlier);
  assertEqual([r.state.status, r.state.exitReason, r.state.waiting], ['completed', 'exit:x', null], 'past → exit');
  assert(r.state.trail.some((t) => t.nodeId === 'co_w' && t.outcome === 'past'), 'co_w left by `past`');
  assert(!r.effects.some((e) => e.type === 'send' || e.type === 'timer'), 'no send, no timer');
  assert(r.effects.some((e) => e.type === 'emit' && e.eventType === 'journey.exited'), 'journey.exited');
});

test('moved checkout (earlier) to a target still ahead: re-entered at it', () => {
  const s = resumed(atCheckoutWait());
  const earlier = { ...tom, checkOutAt: at(16, 10), nights: 4 };
  const r = run(journey('stay_guide'), s, relinked(), at(15, 9), earlier);
  assertEqual([r.state.cursor.nodeId, iso(r.state.waiting!.untilAt!)], ['co_w', iso(at(15, 17))], '15 Oct 17:00');
  assert(r.effects.some((e) => e.type === 'timer' && e.at === at(15, 17)), 'a timer there');
});

test('a mid-stay wait (counted from arrival) after a re-link that shortened the stay: `past`, never a message after the guest left', () => {
  // The owner unlinked Tom on the 12th; while unlinked the booking was cut to 12 → 14 Oct 10:00, so the
  // mid-stay moment (14 Oct 11:00) is after checkout. Arrival didn't move, so the wait's own target didn't either.
  const def = journey('stay_guide');
  const t0 = at(12, 17);
  let s = run(def, freshState(def.start, t0), { kind: 'start' }, t0, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, t0, tom).state;
  assertEqual([s.cursor.nodeId, iso(s.waiting!.untilAt!)], ['mid_w', iso(at(14, 11))], 'waiting for the mid-stay message');
  const short = { ...tom, checkOutAt: at(14, 10), nights: 2 };
  const now = at(12, 20);
  // stay.changed (PR C) sends it past the mid-stay message:
  const viaChanged = run(def, s, changed(), now, short);
  assertEqual([viaChanged.state.cursor.nodeId, iso(viaChanged.state.waiting!.untilAt!)], ['co_w', iso(at(13, 17))], 'stay.changed: on to the checkout wait');
  // A re-link with the same dates must do the same.
  const r = run(def, resumed(s), relinked(), now, short);
  assertEqual(r.state.cursor.nodeId, 'co_w', 'stay.relinked: on to the checkout wait (not kept at 14 Oct 11:00, after checkout)');
  assert(!r.effects.some((e) => e.type === 'send'), 'no mid-stay send');
});

// ── stay.changed keeps its PR C behaviour ────────────────────────────────────

console.log('\nstay.changed is unchanged');

test('stay.changed, anchor unchanged and already due: fires `done` (where stay.relinked does nothing)', () => {
  const def = journey('stay_guide');
  const s = atCheckoutWait();
  const due = at(16, 17, 2);
  const r = run(def, s, changed(), due, { ...tom, checkInAt: at(12, 16) });
  assertEqual([r.state.status, r.state.cursor.nodeId], ['active', 'co'], 'on to the checkout message');
  assert(r.state.trail.some((t) => t.nodeId === 'co_w' && t.outcome === 'done'), 'co_w left by `done`');
  assert(r.effects.some((e) => e.type === 'send'), 'a send');
  assert(run(def, s, relinked(), due, { ...tom, checkInAt: at(12, 16) }).unchanged, 'the same facts as a re-link: nothing');
});

test('stay.changed reaching a wait a re-link resumed (overdue, anchor unchanged): nothing — its own timer runs it, so the stale rule sees how late', () => {
  const def = journey('stay_guide');
  const s = resumed(atCheckoutWait(), 3);
  const due = at(16, 17, 2);
  assert(run(def, s, changed(), due, { ...tom, checkInAt: at(12, 16) }).unchanged, 'unchanged');
});

test('stay.changed, anchor unchanged and not yet due: entered again (same target, new token) — as before', () => {
  const def = journey('stay_guide');
  const s = atCheckoutWait();
  const now = at(15, 9);
  const r = run(def, s, changed(), now, tom);
  assertEqual([r.state.cursor.nodeId, r.state.waiting!.untilAt], ['co_w', CO_TARGET], 'same target');
  assertEqual(r.state.waiting!.token, `co_w@${now}`, 'new token');
  assert(r.state.waiting!.token !== s.waiting!.token, 'the old timer does nothing');
});

test('stay.changed, anchor moved: new target, or `past` — as before', () => {
  const def = journey('stay_guide');
  const s = atCheckoutWait();
  const later = run(def, s, changed(), at(15, 9), { ...tom, checkOutAt: at(18, 10), nights: 6 });
  assertEqual(iso(later.state.waiting!.untilAt!), iso(at(17, 17)), 'moved one day');
  const gone = run(def, s, changed(), at(15, 9), { ...tom, checkOutAt: at(15, 10), nights: 3 });
  assertEqual([gone.state.status, gone.state.exitReason], ['completed', 'exit:x'], 'past → exit');
});

// ── Waits that aren't anchored on the stay ───────────────────────────────────

console.log('\nOther waits ignore the re-link');

test('a wait_until at a time of day (no anchor) ignores stay.relinked, whatever the dates', () => {
  const def = withNode('stay_guide', 'co_w', { type: 'wait_until', config: { at: '17:00' }, edges: { done: 'co', past: 'x' } });
  const s = resumed(atCheckoutWait(def));
  assertEqual([s.waiting!.kind, iso(s.waiting!.untilAt!)], ['timer', iso(at(14, 17))], 'the next 17:00');
  for (const stay of [tom, { ...tom, checkOutAt: at(18, 10), nights: 6 }, { ...tom, checkOutAt: at(15, 10), nights: 3 }]) {
    for (const now of [at(14, 12), at(14, 18)]) {
      const r = run(def, s, relinked(), now, stay);
      assert(r.unchanged && r.effects.length === 0, `unchanged (checkout ${iso(stay.checkOutAt)}, ${iso(now)})`);
      assertEqual(r.state.waiting!.token, s.waiting!.token, 'same token');
    }
  }
  assert(run(def, s, changed(), at(14, 12), { ...tom, checkOutAt: at(18, 10), nights: 6 }).unchanged, 'stay.changed too');
});

test('a delay ignores stay.relinked', () => {
  const def = withNode('stay_guide', 'co_w', { type: 'delay', config: { for: '24h' }, edges: { done: 'co' } });
  const s = resumed(atCheckoutWait(def));
  assertEqual([s.waiting!.kind, iso(s.waiting!.untilAt!)], ['timer', iso(at(15, 11))], '24 h after the mid-stay message');
  for (const stay of [tom, { ...tom, checkOutAt: at(18, 10), nights: 6 }]) {
    const r = run(def, s, relinked(), at(15, 12), stay);
    assert(r.unchanged && r.effects.length === 0, `unchanged (checkout ${iso(stay.checkOutAt)})`);
  }
});

test('an events wait (wait_for) ignores stay.relinked, and still hears its own event', () => {
  const def = journey('stay_review');
  const now = at(17, 15);
  let s = run(def, freshState(def.start, now), { kind: 'start' }, now, tom).state;
  s = resumed(run(def, s, { kind: 'send_result', nodeId: 's1', outcome: 'sent', touch: null }, now, tom).state);
  assertEqual([s.cursor.nodeId, s.waiting!.kind], ['w1', 'events'], 'waiting for a click');
  for (const stay of [tom, { ...tom, checkOutAt: at(18, 10), nights: 6 }]) {
    const r = run(def, s, relinked(), now + HOUR_MS, stay);
    assert(r.unchanged && r.effects.length === 0, `unchanged (checkout ${iso(stay.checkOutAt)})`);
    assertEqual(r.state.waiting!.token, s.waiting!.token, 'same token');
  }
  const click = run(def, s, { kind: 'event', event: event('ev_click', 'message.clicked') }, now + HOUR_MS, tom);
  assertEqual(click.state.status, 'completed', 'a click still ends it');
});

test('a send waiting for its time (send_due) ignores stay.relinked', () => {
  const def = journey('stay_guide');
  const now = at(12, 17);
  const s = run(def, freshState(def.start, now), { kind: 'start' }, now, tom).state;
  assertEqual([s.cursor.nodeId, s.waiting!.kind], ['welcome', 'send_due'], 'the welcome send is due');
  const r = run(def, s, relinked(), now + HOUR_MS, { ...tom, checkOutAt: at(18, 10), nights: 6 });
  assert(r.unchanged && r.effects.length === 0, 'unchanged');
});

test('an instance that is not active (not yet resumed) ignores it: link.ts reactivates first', () => {
  const s = atCheckoutWait();
  const cancelled: InstanceState = { ...s, status: 'cancelled', exitReason: 'stay_unlinked' };
  const r = run(journey('stay_guide'), cancelled, relinked(), at(15, 9), { ...tom, checkOutAt: at(18, 10), nights: 6 });
  assert(r.unchanged && r.effects.length === 0, 'unchanged');
  assertEqual([r.state.status, r.state.waiting!.untilAt], ['cancelled', CO_TARGET], 'still cancelled, wait kept');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
