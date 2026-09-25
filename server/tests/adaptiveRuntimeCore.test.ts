/**
 * Tests for the pure Adaptive engine core (adaptive/core/runtime).
 *
 * Run: npx tsx tests/adaptiveRuntimeCore.test.ts   (from captive-server/server)
 *
 * No Firestore, no clock — every function takes `now`. What these pin:
 *
 *  - **Local time is DST-safe**: 21:00 in Zurich is 19:00 UTC in summer and
 *    20:00 UTC in winter, quiet hours wrap midnight, slots pick the next window.
 *  - **The real seeded A1 / A2 / Wi-Fi journeys walk correctly**: offer → 15 min
 *    → send → wait 48 h → next channel …, the goal (offer redeemed) jumps to the
 *    thank-you, a rating ends A2 mid-wait, a stale timer does nothing.
 *  - **Channel, wording and time pickers** follow the 04 §5 order.
 *  - **Every gate rule** gives the right allow / wait / skip / block with a fact,
 *    and a test run never waits for a pause or credits.
 *  - **The owner sentence** comes from the stored record.
 */

import { SEED } from '../src/adaptive/seed/definitions';
import { journeyDefinitionSchema, type JourneyDefinition, type Offer } from '../src/adaptive/core/schemas';
import {
  atLocalTime,
  isInWindow,
  localDateForRender,
  nextSlotWindow,
  zonedTime,
  HOUR_MS,
  MINUTE_MS,
  DAY_MS,
} from '../src/adaptive/core/runtime/time';
import { evaluateCondition, factsFrom, matchesWhere } from '../src/adaptive/core/runtime/conditions';
import { step, type InterpreterContext } from '../src/adaptive/core/runtime/interpreter';
import { freshState, type InstanceState, type RuntimeInput } from '../src/adaptive/core/runtime/types';
import { checkChannel, pickChannel, pickTime, pickVariant } from '../src/adaptive/core/runtime/pickers';
import { runGate, type GateInput } from '../src/adaptive/core/runtime/gate';
import { buildDecision, explainDecision } from '../src/adaptive/core/runtime/decision';
import { triggerMatches, entryKeyFor } from '../src/adaptive/core/runtime/triggers';
import { phoneCountry } from '../src/adaptive/core/runtime/phoneCountry';

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const TZ = 'Europe/Zurich';
const iso = (ms: number) => new Date(ms).toISOString();

function journey(key: string): JourneyDefinition {
  const seed = SEED.journeys.find((j) => j.header.key === key);
  if (!seed) throw new Error(`no seed journey ${key}`);
  return journeyDefinitionSchema.parse(seed.definition);
}

const DESSERT: Offer = {
  offerKey: 'dessert',
  name: 'Free dessert',
  label: { en: 'a free dessert', de: 'ein Gratis-Dessert' },
  kind: 'free_item',
  value: 0,
  expiryDays: 14,
};

function ctxFor(def: JourneyDefinition, now: number, extra: Partial<InterpreterContext> = {}): InterpreterContext {
  return {
    now,
    definition: def,
    venueTz: TZ,
    slots: { offer: 'dessert', offer_days: 14 },
    offers: [DESSERT],
    facts: factsFrom({}),
    stay: null,
    ...extra,
  };
}

function run(def: JourneyDefinition, state: InstanceState, input: RuntimeInput, now: number, extra: Partial<InterpreterContext> = {}) {
  return step(state, input, ctxFor(def, now, extra));
}

// ── Time ─────────────────────────────────────────────────────────────────────

console.log('\nLocal time');

test('21:00 Zurich is 19:00 UTC in summer and 20:00 UTC in winter (DST-safe)', () => {
  assertEqual(iso(zonedTime(2026, 7, 1, 21, 0, TZ).getTime()), '2026-07-01T19:00:00.000Z', 'summer');
  assertEqual(iso(zonedTime(2026, 12, 1, 21, 0, TZ).getTime()), '2026-12-01T20:00:00.000Z', 'winter');
  // DST ends on 25 Oct 2026: the day before is CEST, the day after CET.
  const sat = Date.parse('2026-10-24T10:00:00Z');
  assertEqual(iso(atLocalTime(new Date(sat), TZ, '21:00', 0).getTime()), '2026-10-24T19:00:00.000Z', 'Sat CEST');
  assertEqual(iso(atLocalTime(new Date(sat), TZ, '21:00', 2).getTime()), '2026-10-26T20:00:00.000Z', 'Mon CET');
});

test('quiet hours 21:00–09:00 wrap midnight', () => {
  const w = { start: '21:00', end: '09:00' };
  assert(!isInWindow(zonedTime(2026, 9, 22, 20, 59, TZ), TZ, w), '20:59 is not quiet');
  assert(isInWindow(zonedTime(2026, 9, 22, 21, 0, TZ), TZ, w), '21:00 is quiet');
  assert(isInWindow(zonedTime(2026, 9, 23, 8, 59, TZ), TZ, w), '08:59 is quiet');
  assert(!isInWindow(zonedTime(2026, 9, 23, 9, 0, TZ), TZ, w), '09:00 is not quiet');
});

test('a slot window is today before it opens, "now" inside it, tomorrow after it', () => {
  const slot: [string, string] = ['14:00', '17:00'];
  const before = nextSlotWindow(zonedTime(2026, 9, 22, 12, 0, TZ), TZ, slot);
  assertEqual(iso(before.from.getTime()), iso(zonedTime(2026, 9, 22, 14, 0, TZ).getTime()), 'before');
  const inside = zonedTime(2026, 9, 22, 15, 30, TZ);
  assertEqual(nextSlotWindow(inside, TZ, slot).from.getTime(), inside.getTime(), 'inside');
  const after = nextSlotWindow(zonedTime(2026, 9, 22, 18, 0, TZ), TZ, slot);
  assertEqual(iso(after.from.getTime()), iso(zonedTime(2026, 9, 23, 14, 0, TZ).getTime()), 'after');
});

test('dates render as the right local day through the UTC date filter', () => {
  // 23:30 Zurich on 5 Oct is 21:30 UTC — still the 5th locally.
  assertEqual(localDateForRender(zonedTime(2026, 10, 5, 23, 30, TZ), TZ), '2026-10-05T12:00:00.000Z', 'late evening');
});

test('phone numbers map to a country, and a zone only for single-zone countries', () => {
  assertEqual(phoneCountry('+41791234567'), { country: 'CH', tz: 'Europe/Zurich' }, 'CH');
  assertEqual(phoneCountry('+4915112345678'), { country: 'DE', tz: 'Europe/Berlin' }, 'DE');
  assertEqual(phoneCountry('+423661234567'), { country: 'LI', tz: 'Europe/Vaduz' }, 'LI before 42x');
  assertEqual(phoneCountry('+12125551234'), { country: 'US' }, 'US has no single zone');
  assertEqual(phoneCountry(null), null, 'none');
});

// ── Conditions ───────────────────────────────────────────────────────────────

console.log('\nConditions');

test('all / any / not and the leaf operators', () => {
  const facts = factsFrom({ stay: { nights: 5 }, contact: { phoneCountry: 'DE', lang: 'de' } });
  assert(evaluateCondition({ fact: 'stay.nights', gte: 4 }, facts), 'gte');
  assert(!evaluateCondition({ fact: 'stay.nights', lt: 4 }, facts), 'lt');
  assert(evaluateCondition({ any: [{ fact: 'contact.phoneCountry', in: ['DE', 'AT'] }, { fact: 'x', eq: 1 }] }, facts), 'any/in');
  assert(evaluateCondition({ all: [{ fact: 'contact.lang', eq: 'de' }, { not: { fact: 'stay.nights', lte: 2 } }] }, facts), 'all/not');
  assert(!evaluateCondition({ fact: 'contact.missing', exists: true }, facts), 'exists');
});

test('event filters: a plain value means equals, an object is operators', () => {
  const ev = { data: { stars: 2, channel: 'sms' } };
  assert(matchesWhere({ 'data.stars': { lte: 2 } }, ev), 'lte');
  assert(matchesWhere({ 'data.channel': 'sms' }, ev), 'eq');
  assert(!matchesWhere({ 'data.channel': 'email' }, ev), 'ne');
});

// ── Triggers ─────────────────────────────────────────────────────────────────

console.log('\nTriggers');

test('A1 starts on a first visit only; the Wi-Fi card on visit 1; A2 on visit end', () => {
  const first = { id: 'e1', type: 'visit.started', occurredAt: 0, data: { isFirstVisit: true, visitNumber: 1, visitId: 'v1' } };
  const second = { id: 'e2', type: 'visit.started', occurredAt: 0, data: { isFirstVisit: false, visitNumber: 2, isRevisit: true, visitId: 'v2' } };
  const ended = { id: 'e3', type: 'visit.ended', occurredAt: 0, data: { endSource: 'timeout', visitId: 'v1' } };
  const a1 = journey('welcome_second_visit').entry.trigger;
  const wifi = journey('wifi_info_card').entry.trigger;
  const a2 = journey('review_ask').entry.trigger;
  assert(triggerMatches(a1, first, 'welcome_second_visit'), 'A1 first');
  assert(!triggerMatches(a1, second, 'welcome_second_visit'), 'A1 not second');
  assert(triggerMatches(wifi, first, 'wifi_info_card') && !triggerMatches(wifi, second, 'wifi_info_card'), 'wifi');
  assert(triggerMatches(a2, ended, 'review_ask'), 'A2 on the timeout fallback (no dwell)');
  assert(!triggerMatches(a2, { ...ended, data: { ...ended.data, dwellMinutes: 10 } }, 'review_ask'), 'A2 skips a 10-min walk-in');
  assertEqual(entryKeyFor('never', first), 'once', 'never → once');
  assertEqual(entryKeyFor('cooldown', ended), 'visit:v1', 'cooldown → the visit');
});

// ── Interpreter ──────────────────────────────────────────────────────────────

console.log('\nInterpreter (seeded journeys)');

const T0 = zonedTime(2026, 9, 22, 12, 40, TZ).getTime(); // Tuesday 12:40

test('A1: offer → 15 min wait → send', () => {
  const def = journey('welcome_second_visit');
  const r = run(def, freshState(def.start, T0), { kind: 'start' }, T0);
  assertEqual(r.state.cursor.nodeId, 'd1', 'waits at d1');
  assertEqual(r.state.vars.offerKey, 'dessert', 'offer issued');
  assertEqual(r.state.vars.offerExpiresAt, T0 + 14 * DAY_MS, 'offer valid 14 days');
  assert(r.effects.some((e) => e.type === 'timer' && e.at === T0 + 15 * MINUTE_MS), 'timer in 15 min');
  assert(r.effects.some((e) => e.type === 'emit' && e.eventType === 'offer.issued'), 'offer.issued logged');
  assertEqual(r.state.rev, 1, 'rev bumped');

  const woke = run(def, r.state, { kind: 'wake', nodeId: 'd1' }, T0 + 15 * MINUTE_MS);
  assertEqual(woke.state.cursor.nodeId, 's1', 'at s1');
  assert(woke.effects.some((e) => e.type === 'send' && e.nodeId === 's1'), 'asks for a send');
  assertEqual(woke.state.waiting?.kind, 'send_due', 'waiting for the send');
});

test('A1: sent → wait 48 h → no reaction → next channel; a click → last chance after 72 h', () => {
  const def = journey('welcome_second_visit');
  let s = run(def, freshState(def.start, T0), { kind: 'start' }, T0).state;
  s = run(def, s, { kind: 'wake', nodeId: 'd1' }, T0 + 15 * MINUTE_MS).state;
  const touch = { channel: 'sms' as const, variantId: 'var_a', slot: 'now', sendKey: 'js_1', purpose: 'marketing' as const, at: T0 + 15 * MINUTE_MS };
  const sent = run(def, s, { kind: 'send_result', nodeId: 's1', outcome: 'sent', touch }, T0 + 15 * MINUTE_MS);
  assertEqual(sent.state.cursor.nodeId, 'w1', 'waiting for a reaction');
  assertEqual(sent.state.counters.touches, 1, 'touch counted');
  assertEqual(sent.state.lastTouch?.channel, 'sms', 'last touch kept');
  assertEqual(sent.state.waiting?.untilAt, T0 + 15 * MINUTE_MS + 48 * HOUR_MS, '48 h timeout');

  const timeout = run(def, sent.state, { kind: 'wake', nodeId: 'w1' }, T0 + 49 * HOUR_MS);
  assertEqual(timeout.state.cursor.nodeId, 's2_next', 'timeout → next channel step');

  const click = { id: 'ev_click', type: 'message.clicked', occurredAt: T0 + HOUR_MS, instanceId: 'ji_1', data: {} };
  const clicked = run(def, sent.state, { kind: 'event', event: click }, T0 + HOUR_MS);
  assertEqual(clicked.state.cursor.nodeId, 'w_redeem', 'click → wait for the revisit');
  assertEqual(clicked.state.counters.clicks, 1, 'click counted');
  const last = run(def, clicked.state, { kind: 'wake', nodeId: 'w_redeem' }, T0 + 73 * HOUR_MS);
  assertEqual(last.state.cursor.nodeId, 'last', 'last chance after 72 h');
});

test('A1: a revisit with a valid offer reaches the goal → thank-you → converted', () => {
  const def = journey('welcome_second_visit');
  let s = run(def, freshState(def.start, T0), { kind: 'start' }, T0).state;
  s = run(def, s, { kind: 'wake', nodeId: 'd1' }, T0 + 15 * MINUTE_MS).state;
  s = run(def, s, { kind: 'send_result', nodeId: 's1', outcome: 'sent', touch: null }, T0 + 15 * MINUTE_MS).state;
  const redeemed = { id: 'ev_red', type: 'offer.redeemed', occurredAt: T0 + 3 * DAY_MS, data: {} };
  const goal = run(def, s, { kind: 'event', event: redeemed }, T0 + 3 * DAY_MS);
  assertEqual(goal.state.cursor.nodeId, 'thanks', 'jumps to the thank-you');
  assert(goal.state.goal?.eventId === 'ev_red', 'goal recorded once');
  assert(goal.effects.some((e) => e.type === 'send' && e.nodeId === 'thanks'), 'sends the thank-you');
  const done = run(def, goal.state, { kind: 'send_result', nodeId: 'thanks', outcome: 'sent', touch: null }, T0 + 3 * DAY_MS);
  assertEqual(done.state.status, 'converted', 'converted');
});

test('a stale timer (wrong node) and an event nobody waits for change nothing', () => {
  const def = journey('welcome_second_visit');
  const s = run(def, freshState(def.start, T0), { kind: 'start' }, T0).state;
  const stale = run(def, s, { kind: 'wake', nodeId: 'w1' }, T0 + HOUR_MS);
  assert(stale.unchanged && stale.state === s, 'stale wake ignored');
  const other = run(def, s, { kind: 'event', event: { id: 'x', type: 'visit.started', occurredAt: T0, data: {} } }, T0);
  assert(other.unchanged, 'unrelated event ignored');
});

test('A2: a rating ends the journey even in the middle of the 72 h wait', () => {
  const def = journey('review_ask');
  let s = run(def, freshState(def.start, T0), { kind: 'start' }, T0).state;
  assertEqual(s.cursor.nodeId, 't', 'waits 3 h first');
  s = run(def, s, { kind: 'wake', nodeId: 't' }, T0 + 3 * HOUR_MS).state;
  s = run(def, s, { kind: 'send_result', nodeId: 's1', outcome: 'sent', touch: null }, T0 + 3 * HOUR_MS).state;
  assertEqual(s.cursor.nodeId, 'w1', 'waiting');
  const rated = run(def, s, { kind: 'event', event: { id: 'r', type: 'rating.submitted', occurredAt: T0, data: { stars: 4 } } }, T0 + 4 * HOUR_MS);
  assertEqual(rated.state.status, 'completed', 'ended');
  assertEqual(rated.state.exitReason, 'exit_on:rating.submitted', 'because of the rating');
});

test('Wi-Fi card: one send, then done — skipped also ends', () => {
  const def = journey('wifi_info_card');
  const s = run(def, freshState(def.start, T0), { kind: 'start' }, T0).state;
  assertEqual(s.cursor.nodeId, 's', 'sends right away');
  const skipped = run(def, s, { kind: 'send_result', nodeId: 's', outcome: 'skipped', touch: null }, T0);
  assertEqual(skipped.state.status, 'completed', 'completed');
});

test('Stay guide: branch on nights, wait_until the stay moments, "past" skips ahead', () => {
  const def = journey('stay_guide');
  const checkIn = zonedTime(2026, 9, 22, 15, 0, TZ).getTime();
  const checkOut = zonedTime(2026, 9, 27, 10, 0, TZ).getTime();
  const stay = { checkInAt: checkIn, checkOutAt: checkOut, nights: 5 };
  const facts = factsFrom({ stay: { nights: 5 } });
  const now = zonedTime(2026, 9, 22, 17, 0, TZ).getTime();
  let r = run(def, freshState(def.start, now), { kind: 'start' }, now, { stay, facts });
  assertEqual(r.state.cursor.nodeId, 'welcome', 'welcome first');
  r = run(def, r.state, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, now, { stay, facts });
  assertEqual(r.state.cursor.nodeId, 'mid_w', '5 nights → mid-stay wait');
  assertEqual(iso(r.state.waiting!.untilAt!), iso(zonedTime(2026, 9, 24, 11, 0, TZ).getTime()), 'day 3, 11:00');
  // A 2-night stay goes straight to the checkout wait.
  const short = run(def, freshState(def.start, now), { kind: 'start' }, now, { stay: { ...stay, nights: 2 }, facts: factsFrom({ stay: { nights: 2 } }) });
  const s2 = run(def, short.state, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, now, { stay: { ...stay, nights: 2 }, facts: factsFrom({ stay: { nights: 2 } }) });
  assertEqual(s2.state.cursor.nodeId, 'co_w', 'short stay → checkout wait');
  assertEqual(iso(s2.state.waiting!.untilAt!), iso(zonedTime(2026, 9, 26, 17, 0, TZ).getTime()), 'day before checkout, 17:00');
});

// ── Pickers ──────────────────────────────────────────────────────────────────

console.log('\nPickers');

const baseState = freshState('s1', T0);

test('channel: ladder first, next rung for next_on_ladder, favourite channel, nothing → null', () => {
  const ladder = ['sms', 'email', 'whatsapp'] as const;
  const p1 = pickChannel({ rule: 'auto', eligible: ['sms', 'email'], ladder: [...ladder], state: baseState, preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: null });
  assertEqual([p1.channel, p1.ladderPos], ['sms', 0], 'first rung');
  const after = { ...baseState, counters: { ...baseState.counters, ladderPos: 0 } };
  const p2 = pickChannel({ rule: 'next_on_ladder', eligible: ['sms', 'email'], ladder: [...ladder], state: after, preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: null });
  assertEqual([p2.channel, p2.ladderPos], ['email', 1], 'next rung');
  const fav = pickChannel({ rule: 'auto', eligible: ['sms', 'email'], ladder: [...ladder], state: baseState, preferredChannel: 'email', consecutiveNoClickOnPreferred: 0, lastClickChannel: null });
  assertEqual(fav.channel, 'email', 'favourite channel wins');
  const tired = pickChannel({ rule: 'auto', eligible: ['sms', 'email'], ladder: [...ladder], state: baseState, preferredChannel: 'email', consecutiveNoClickOnPreferred: 2, lastClickChannel: null });
  assertEqual(tired.channel, 'sms', 'favourite released after 2 no-clicks');
  const none = pickChannel({ rule: 'next_on_ladder', eligible: ['sms'], ladder: [...ladder], state: after, preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: null });
  assertEqual(none.channel, null, 'no rung left');
  const lastClick = pickChannel({ rule: 'same_as_last_click', eligible: ['sms', 'email'], ladder: [...ladder], state: baseState, preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: 'email' });
  assertEqual(lastClick.channel, 'email', 'same as last click');
});

test('a channel needs an address, consent (marketing), no block, the audience and wording', () => {
  const ok = { channel: 'sms' as const, hasAddress: true, consent: 'granted' as const, suppressed: null, audienceOk: true, hasWording: true, ruleFail: null };
  assert(checkChannel('marketing', ok).ok, 'ok');
  assertEqual(checkChannel('marketing', { ...ok, consent: 'none' }).reason, 'no_consent', 'consent');
  assert(checkChannel('service', { ...ok, consent: 'none' }).ok, 'service needs no consent');
  assertEqual(checkChannel('service', { ...ok, suppressed: 'stop' }).reason, 'blocked:stop', 'STOP blocks service too');
  assertEqual(checkChannel('marketing', { ...ok, audienceOk: false }).reason, 'audience', 'verified only');
});

test('wording rotates and never repeats the last one when there is another', () => {
  const opts = [{ id: 'b', letter: 'B' }, { id: 'a', letter: 'A' }];
  assertEqual(pickVariant(opts, null).variantId, 'a', 'first by letter');
  assertEqual(pickVariant(opts, 'a').variantId, 'b', 'next');
  assertEqual(pickVariant(opts, 'b').variantId, 'a', 'wraps');
  assertEqual(pickVariant([{ id: 'a', letter: 'A' }], 'a').method, 'rotation:only_one', 'only one');
});

test('time: now, a slot in the venue zone with repeatable minutes, a fixed time', () => {
  const slots = SEED.config.slots;
  assertEqual(pickTime({ mode: 'now' }, T0, TZ, slots, 'k').at, T0, 'now');
  const a = pickTime({ mode: 'slot', default: 'afternoon' }, T0, TZ, slots, 'k1');
  const b = pickTime({ mode: 'slot', default: 'afternoon' }, T0, TZ, slots, 'k1');
  assertEqual(a.at, b.at, 'repeatable');
  assert(a.at >= zonedTime(2026, 9, 22, 14, 0, TZ).getTime() && a.at < zonedTime(2026, 9, 22, 17, 0, TZ).getTime(), 'inside 14–17 today');
  const fixed = pickTime({ mode: 'local_time', at: '10:00' }, T0, TZ, slots, 'k');
  assertEqual(iso(fixed.at), iso(zonedTime(2026, 9, 23, 10, 0, TZ).getTime()), 'next 10:00');
});

// ── Gate ─────────────────────────────────────────────────────────────────────

console.log('\nSend gate');

function gateInput(over: Partial<GateInput> = {}): GateInput {
  const base: GateInput = {
    now: T0,
    mode: 'live',
    purpose: 'marketing',
    channel: 'sms',
    urgent: false,
    enteredAt: T0,
    expireAfterMs: null,
    intendedAt: T0,
    jitterKey: 'ji_1:s1',
    system: {
      paused: false,
      lapsed: false,
      tenantActive: true,
      venueOn: true,
      journeyOn: true,
      offSinceAt: null,
      staleAfterMs: 6 * HOUR_MS,
      venueSendsToday: 0,
      venueCeiling: 500,
      platformSendsToday: 0,
      platformCeiling: 10000,
      channelReady: true,
    },
    address: { blocked: null, lowRatingAt: null },
    consent: { state: 'granted' },
    channelRules: { audienceOk: true, audienceFact: 'verified number', ruleFail: null },
    caps: { touches: 0, maxTouches: 5, clicks: 0, stopAfterClicks: 3 },
    diff: { lastTouch: null, variantId: 'var_a', slot: 'now' },
    weekly: { count: 0, limit: 3 },
    quiet: { venueTz: TZ, phoneTz: null, window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
    fairUse: { count: 0, limit: 300 },
    credits: { price: 15, spendable: 100, waitStartedAt: null, queueHours: 72 },
  };
  return { ...base, ...over, system: { ...base.system, ...(over.system ?? {}) } };
}

test('everything fine → allow, with one fact per rule', () => {
  const g = runGate(gateInput());
  assertEqual(g.verdict, 'allow', 'allow');
  assertEqual(g.checks.length, 10, 'ten rules');
  assert(g.checks.find((c) => c.rule === 'journey_caps')?.fact === 'touches 0/5', 'touches fact');
});

test('quiet hours: 21:40 → wait until 09:00–09:20 next day; past expireAfter → skip', () => {
  const late = zonedTime(2026, 9, 22, 21, 40, TZ).getTime();
  const g = runGate(gateInput({ now: late, enteredAt: late, intendedAt: late }));
  assertEqual([g.verdict, g.rule], ['defer', 'quiet_hours'], 'deferred');
  const nine = zonedTime(2026, 9, 23, 9, 0, TZ).getTime();
  assert(g.until! >= nine && g.until! <= nine + 20 * MINUTE_MS, `until 09:00–09:20, got ${iso(g.until!)}`);
  const expired = runGate(gateInput({ now: late, enteredAt: late, intendedAt: late, expireAfterMs: 2 * HOUR_MS }));
  assertEqual([expired.verdict, expired.reason], ['skip', 'quiet_hours_expired'], 'too late');
  const urgentInfo = runGate(gateInput({ now: late, enteredAt: late, intendedAt: late, purpose: 'service', urgent: true }));
  assertEqual(urgentInfo.verdict, 'allow', 'urgent info goes at night');
});

test('a tourist phone zone only makes quiet hours stricter', () => {
  const london = { ...gateInput().quiet, phoneTz: 'Europe/London' };
  // 09:20 in Zurich is 08:20 in London (a single-zone country): still quiet there,
  // so wait until 09:00 London (= 10:00 Zurich) plus the morning jitter.
  const early = zonedTime(2026, 9, 23, 9, 20, TZ).getTime();
  const g = runGate(gateInput({ now: early, enteredAt: early, intendedAt: early, quiet: london }));
  assertEqual([g.verdict, g.rule], ['defer', 'quiet_hours'], 'still quiet in London');
  const tenZurich = zonedTime(2026, 9, 23, 10, 0, TZ).getTime();
  assert(g.until! >= tenZurich && g.until! <= tenZurich + 20 * MINUTE_MS, `until 09:00–09:20 London, got ${iso(g.until!)}`);
  // 10:30 Zurich = 09:30 London: daytime in both.
  const later = zonedTime(2026, 9, 23, 10, 30, TZ).getTime();
  assertEqual(runGate(gateInput({ now: later, enteredAt: later, intendedAt: later, quiet: london })).verdict, 'allow', 'daytime in both');
  // The venue zone alone never gets looser: 21:30 Zurich is quiet even if the phone zone says 20:30.
  const night = zonedTime(2026, 9, 22, 21, 30, TZ).getTime();
  assertEqual(runGate(gateInput({ now: night, enteredAt: night, intendedAt: night, quiet: london })).rule, 'quiet_hours', 'venue night');
});

test('a phone zone east of the venue: the next morning, not a day later', () => {
  // Thu 22:00 Zurich = Thu 23:00 Athens / Fri 05:00 Tokyo → Fri 09:00–09:20 Zurich suits both.
  const night = zonedTime(2026, 9, 24, 22, 0, TZ).getTime();
  const nine = zonedTime(2026, 9, 25, 9, 0, TZ).getTime();
  for (const phoneTz of ['Europe/Athens', 'Asia/Tokyo']) {
    const g = runGate(gateInput({ now: night, enteredAt: night, intendedAt: night, quiet: { ...gateInput().quiet, phoneTz } }));
    assert(g.until! >= nine && g.until! <= nine + 20 * MINUTE_MS, `${phoneTz}: until Fri 09:00–09:20 Zurich, got ${iso(g.until!)}`);
  }
  // Every 10 minutes over a day, for zones west and east: the earliest moment both are out of quiet hours (+ jitter).
  const w = { start: '21:00', end: '09:00' };
  for (const phoneTz of ['Europe/London', 'Europe/Athens', 'Asia/Kolkata', 'Asia/Tokyo', 'America/New_York']) {
    for (let t = zonedTime(2026, 9, 24, 0, 0, TZ).getTime(); t < zonedTime(2026, 9, 25, 0, 0, TZ).getTime(); t += 10 * MINUTE_MS) {
      const g = runGate(gateInput({ now: t, enteredAt: t, intendedAt: t, quiet: { ...gateInput().quiet, phoneTz } }));
      let earliest = t;
      while (isInWindow(new Date(earliest), TZ, w) || isInWindow(new Date(earliest), phoneTz, w)) earliest += MINUTE_MS;
      if (earliest === t) {
        assertEqual(g.verdict, 'allow', `${phoneTz} ${iso(t)}: daytime in both`);
        continue;
      }
      assert(g.until! >= earliest && g.until! <= earliest + 20 * MINUTE_MS, `${phoneTz} ${iso(t)}: until ${iso(g.until!)}, earliest ${iso(earliest)}`);
    }
  }
});

test('a branch sees what earlier steps of the same run set (instance.* facts)', () => {
  const base = journey('welcome_second_visit');
  const def = {
    ...base,
    nodes: {
      ...base.nodes,
      offer: { ...base.nodes.offer, edges: { done: 'b', none: 'x_done' } },
      b: { type: 'branch', config: { cases: [{ when: { fact: 'instance.vars.offerKey', eq: 'dessert' }, edge: 'has' }] }, edges: { has: 'd1', default: 'x_done' } },
    },
  } as unknown as JourneyDefinition;
  const t0 = zonedTime(2026, 9, 22, 12, 40, TZ).getTime();
  const r = run(def, freshState(def.start, t0), { kind: 'start' }, t0);
  assertEqual(r.state.cursor.nodeId, 'd1', 'the branch saw the offer issued one step earlier');
});

test('consent, blocked address, caps, weekly limit, must-differ each skip with a reason', () => {
  assertEqual(runGate(gateInput({ consent: { state: 'none' } })).reason, 'no_consent', 'consent');
  assertEqual(runGate(gateInput({ address: { blocked: 'stop', lowRatingAt: null } })).reason, 'blocked', 'blocked');
  assertEqual(runGate(gateInput({ address: { blocked: null, lowRatingAt: T0 } })).reason, 'low_rating', 'low rating');
  assertEqual(runGate(gateInput({ caps: { touches: 5, maxTouches: 5, clicks: 0, stopAfterClicks: 3 } })).reason, 'max_touches', 'touches');
  assertEqual(runGate(gateInput({ weekly: { count: 3, limit: 3 } })).reason, 'weekly_limit', 'weekly');
  const last = { channel: 'sms' as const, variantId: 'var_a', slot: 'now', sendKey: 'x', purpose: 'marketing' as const, at: T0 - HOUR_MS };
  assertEqual(runGate(gateInput({ diff: { lastTouch: last, variantId: 'var_a', slot: 'now' } })).reason, 'same_as_last', 'differ');
  assertEqual(runGate(gateInput({ diff: { lastTouch: last, variantId: 'var_b', slot: 'now' } })).verdict, 'allow', 'new wording is enough');
});

test('credits: enough → allow; short → wait 1 h; after 72 h → skip; a test run never waits', () => {
  assertEqual(runGate(gateInput({ credits: { price: 15, spendable: 10, waitStartedAt: null, queueHours: 72 } })).verdict, 'defer', 'short');
  const expired = runGate(gateInput({ credits: { price: 15, spendable: 10, waitStartedAt: T0 - 73 * HOUR_MS, queueHours: 72 } }));
  assertEqual(expired.reason, 'credits_expired', 'expired');
  assertEqual(runGate(gateInput({ mode: 'test', credits: { price: 15, spendable: 0, waitStartedAt: null, queueHours: 72 } })).verdict, 'allow', 'test run');
});

test('system: pause holds (live) but not a test run; stale skips; switched off skips unless due within 60 min', () => {
  const paused = runGate(gateInput({ system: { ...gateInput().system, paused: true } }));
  assertEqual([paused.verdict, paused.reason], ['defer', 'paused'], 'pause holds');
  assertEqual(runGate(gateInput({ mode: 'test', system: { ...gateInput().system, paused: true } })).verdict, 'allow', 'test ignores pause');
  assertEqual(runGate(gateInput({ intendedAt: T0 - 7 * HOUR_MS })).reason, 'stale', 'stale');
  assertEqual(runGate(gateInput({ system: { ...gateInput().system, journeyOn: false, offSinceAt: T0 - 2 * HOUR_MS } })).reason, 'switched_off', 'off');
  assertEqual(runGate(gateInput({ system: { ...gateInput().system, journeyOn: false, offSinceAt: T0 - 30 * MINUTE_MS } })).verdict, 'allow', 'due within 60 min still goes');
  assertEqual(runGate(gateInput({ system: { ...gateInput().system, lapsed: 'unknown' } })).verdict, 'defer', 'lapse lookup failed → wait');
  assertEqual(runGate(gateInput({ system: { ...gateInput().system, channelReady: false } })).verdict, 'block', 'no adapter → block');
});

test('info messages: no consent needed, not counted, capped by fair use', () => {
  const g = runGate(gateInput({ purpose: 'service', consent: { state: 'none' }, weekly: { count: 9, limit: 3 }, caps: { touches: 9, maxTouches: 5, clicks: 9, stopAfterClicks: 3 } }));
  assertEqual(g.verdict, 'allow', 'allowed');
  assertEqual(runGate(gateInput({ purpose: 'service', fairUse: { count: 300, limit: 300 } })).reason, 'fair_use', 'fair use');
});

// ── Decision record + owner sentence ─────────────────────────────────────────

console.log('\nWhy records');

test('the owner sentence comes from the stored record (EN + DE)', () => {
  const late = zonedTime(2026, 9, 22, 21, 40, TZ).getTime();
  const gate = runGate(gateInput({ now: late, enteredAt: late, intendedAt: late }));
  const rec = buildDecision({
    now: late,
    mode: 'live',
    poolKey: 'welcome_offer',
    purpose: 'marketing',
    gate,
    channelChecks: [{ channel: 'sms', ok: true, reason: null }, { channel: 'email', ok: false, reason: 'no_address' }],
    channel: { picked: 'sms', rule: 'ladder' },
    variant: { picked: 'var_a', method: 'rotation:first' },
    slot: { picked: 'now', rule: 'now', plannedAt: late },
    credits: { price: 15, balance: 100 },
    versions: { template: 1, config: 1, playbook: 'restaurant_growth', engine: '1.0.0' },
  });
  assert(JSON.stringify(rec).length < 2048, 'under 2 KB');
  const en = explainDecision(rec, 'en', TZ);
  assert(en.startsWith('Held back until') && en.includes('quiet hours'), en);
  const de = explainDecision(rec, 'de', TZ);
  assert(/^Zurückgehalten bis [A-Z][a-z]+\., \d{1,2}\. [A-Z][a-z]+\.?, \d{2}:\d{2}, weil Ruhezeit war\.$/.test(de), `German date + verb at the end: ${de}`);
  // Limits come from the stored fact; unknown or suffixed codes never leak into the sentence.
  const weekly = { ...rec, result: 'skip' as const, until: null, rule: 'weekly_limit' as const, reason: 'weekly_limit', checks: [{ rule: 'weekly_limit' as const, ok: false, fact: '2 of 2 marketing messages in the last 7 days' }] };
  assert(explainDecision(weekly, 'en', TZ).includes('already got 2 marketing messages') && explainDecision(weekly, 'de', TZ).includes('schon 2 Werbenachrichten erhalten hat'), explainDecision(weekly, 'de', TZ));
  for (const reason of ['booking_link_missing', 'missing_value:venue.name', 'something_new']) {
    const s = explainDecision({ ...rec, result: 'skip', until: null, reason }, 'en', TZ) + explainDecision({ ...rec, result: 'skip', until: null, reason }, 'de', TZ);
    assert(!/_/.test(s), `no machine code in: ${s}`);
  }
  const sent = explainDecision({ ...rec, result: 'allow', until: null, reason: null }, 'en', TZ);
  assertEqual(sent, 'Sent by SMS (15 credits).', 'sent');
  const dry = explainDecision({ ...rec, result: 'allow', until: null, reason: null, mode: 'test' }, 'en', TZ);
  assert(dry.startsWith('Test run: would have sent by SMS'), dry);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
