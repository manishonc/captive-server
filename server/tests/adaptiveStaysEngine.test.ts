/**
 * Airbnb stays in the engine, the pure parts (PR C): the interpreter moving anchored waits
 * on new dates and ending on a cancellation, gate rule 1 ("the stay isn't cancelled"),
 * the stay numbers, the checkout wording without late checkout, printed check-in/out
 * times, and the link window on a turnover day.
 *
 * Run: npx tsx tests/adaptiveStaysEngine.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { SEED } from '../src/adaptive/seed/definitions';
import { journeyDefinitionSchema, type JourneyDefinition } from '../src/adaptive/core/schemas';
import { factsFrom } from '../src/adaptive/core/runtime/conditions';
import { step, type InterpreterContext } from '../src/adaptive/core/runtime/interpreter';
import { freshState, type InstanceState, type RuntimeInput } from '../src/adaptive/core/runtime/types';
import { runGate, type GateInput } from '../src/adaptive/core/runtime/gate';
import { buildDecision, explainDecision } from '../src/adaptive/core/runtime/decision';
import { triggerMatches, entryKeyFor } from '../src/adaptive/core/runtime/triggers';
import { HOUR_MS, zonedTime } from '../src/adaptive/core/runtime/time';
import { aggregate, countsFor, type RollupEvent } from '../src/adaptive/rollups/journeyStats';
import { missingReason, renderMessage, renderValues, variantContent, variantEligible, guestInfoHasContent } from '../src/adaptive/engine/renderSend';
import { buildSeedPlan } from '../src/adaptive/seed/buildSeed';
import { resolveStayTimes, stayInstants } from '../src/adaptive/stays/times';
import { COVER_MARGIN_MS, guideStillSends, seenDuring, seenDuringAny, windowCandidates, type StaySnap } from '../src/adaptive/stays/plan';

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

function journey(key: string): JourneyDefinition {
  const seed = SEED.journeys.find((j) => j.header.key === key);
  if (!seed) throw new Error(`no seed journey ${key}`);
  return journeyDefinitionSchema.parse(seed.definition);
}

function run(def: JourneyDefinition, state: InstanceState, input: RuntimeInput, now: number, stay: InterpreterContext['stay']) {
  return step(state, input, { now, definition: def, venueTz: TZ, slots: {}, offers: [], facts: factsFrom({ stay: stay ? { nights: stay.nights } : {} }), stay });
}

const event = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, occurredAt: 0, data });

// ── The interpreter ──────────────────────────────────────────────────────────

console.log('\nInterpreter');

// Tom: 5 nights, 12 → 17 Oct 2026.
const tomIn = zonedTime(2026, 10, 12, 15, 0, TZ).getTime();
const tomOut = zonedTime(2026, 10, 17, 10, 0, TZ).getTime();
const tom = { checkInAt: tomIn, checkOutAt: tomOut, nights: 5 };

function guideAtCheckoutWait(now: number): InstanceState {
  const def = journey('stay_guide');
  let s = run(def, freshState(def.start, now), { kind: 'start' }, now, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, now, tom).state;
  assertEqual(s.cursor.nodeId, 'mid_w', '5 nights → mid-stay wait');
  const mid = zonedTime(2026, 10, 14, 11, 0, TZ).getTime();
  s = run(def, s, { kind: 'wake', nodeId: 'mid_w' }, mid, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'mid', outcome: 'sent', touch: null }, mid, tom).state;
  assertEqual(s.cursor.nodeId, 'co_w', 'waiting for the checkout message');
  return s;
}

test('stay.changed re-enters an anchored wait: a new target and token; the old timer is stale', () => {
  const def = journey('stay_guide');
  const s = guideAtCheckoutWait(zonedTime(2026, 10, 12, 17, 0, TZ).getTime());
  assertEqual(iso(s.waiting!.untilAt!), iso(zonedTime(2026, 10, 16, 17, 0, TZ).getTime()), 'checkout −1 day 17:00');
  const later = { ...tom, checkOutAt: zonedTime(2026, 10, 18, 10, 0, TZ).getTime(), nights: 6 };
  const now = zonedTime(2026, 10, 15, 9, 0, TZ).getTime();
  const r = run(def, s, { kind: 'event', event: event('ev_changed_2', 'stay.changed') }, now, later);
  assertEqual(r.state.cursor.nodeId, 'co_w', 'still the checkout wait');
  assertEqual(iso(r.state.waiting!.untilAt!), iso(zonedTime(2026, 10, 17, 17, 0, TZ).getTime()), 'moved one day');
  assert(r.state.waiting!.token !== s.waiting!.token, 'a new token: the old timer does nothing');
  assert(r.effects.some((e) => e.type === 'timer'), 'a new timer');
});

test('stay.changed to a date already past takes `past` (known limit: no checkout message)', () => {
  const def = journey('stay_guide');
  const s = guideAtCheckoutWait(zonedTime(2026, 10, 12, 17, 0, TZ).getTime());
  const earlier = { ...tom, checkOutAt: zonedTime(2026, 10, 15, 10, 0, TZ).getTime(), nights: 3 };
  const r = run(def, s, { kind: 'event', event: event('ev_c', 'stay.changed') }, zonedTime(2026, 10, 14, 18, 0, TZ).getTime(), earlier);
  assertEqual([r.state.status, r.state.exitReason], ['completed', 'exit:x'], 'past → exit');
});

test('a shortened stay: a wait counted from arrival that now ends after checkout is past (no mid-stay message after the guest left)', () => {
  const def = journey('stay_guide');
  const now = zonedTime(2026, 10, 12, 17, 0, TZ).getTime();
  let s = run(def, freshState(def.start, now), { kind: 'start' }, now, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 'welcome', outcome: 'sent', touch: null }, now, tom).state;
  assertEqual(s.cursor.nodeId, 'mid_w', 'waiting for the mid-stay message (14 Oct 11:00)');
  // Checkout moves from 17 to 14 Oct 10:00: the mid-stay moment (14 Oct 11:00) is after it.
  const short = { ...tom, checkOutAt: zonedTime(2026, 10, 14, 10, 0, TZ).getTime(), nights: 2 };
  const r = run(def, s, { kind: 'event', event: event('ev_short', 'stay.changed') }, zonedTime(2026, 10, 12, 20, 0, TZ).getTime(), short);
  assertEqual(r.state.cursor.nodeId, 'co_w', 'straight on to the checkout wait');
  assertEqual(iso(r.state.waiting!.untilAt!), iso(zonedTime(2026, 10, 13, 17, 0, TZ).getTime()), 'the new checkout −1 day 17:00');
  assert(!r.effects.some((e) => e.type === 'send'), 'no mid-stay send');
});

test('stay.changed on a due wait whose anchor did not move: it fires (not skipped as `past`)', () => {
  const def = journey('stay_guide');
  const s = guideAtCheckoutWait(zonedTime(2026, 10, 12, 17, 0, TZ).getTime());
  const due = zonedTime(2026, 10, 16, 17, 2, TZ).getTime(); // the timer's task hasn't run yet
  const arrivalMoved = { ...tom, checkInAt: zonedTime(2026, 10, 12, 16, 0, TZ).getTime() };
  const r = run(def, s, { kind: 'event', event: event('ev_in', 'stay.changed') }, due, arrivalMoved);
  assertEqual([r.state.status, r.state.cursor.nodeId], ['active', 'co'], 'on to the checkout message');
  assert(r.state.trail.some((t) => t.nodeId === 'co_w' && t.outcome === 'done'), 'co_w left by `done`');
  const moved = { ...tom, checkOutAt: zonedTime(2026, 10, 18, 10, 0, TZ).getTime(), nights: 6 };
  const r2 = run(def, s, { kind: 'event', event: event('ev_out', 'stay.changed') }, due, moved);
  assertEqual([r2.state.cursor.nodeId, iso(r2.state.waiting!.untilAt!)], ['co_w', iso(zonedTime(2026, 10, 17, 17, 0, TZ).getTime())], 'the checkout moved: waits for the new one');
});

test('stay.changed while not waiting on an anchor changes nothing', () => {
  const def = journey('stay_review');
  const now = zonedTime(2026, 10, 17, 15, 0, TZ).getTime();
  let s = run(def, freshState(def.start, now), { kind: 'start' }, now, tom).state;
  s = run(def, s, { kind: 'send_result', nodeId: 's1', outcome: 'sent', touch: null }, now, tom).state;
  const r = run(def, s, { kind: 'event', event: event('ev_c', 'stay.changed') }, now + HOUR_MS, tom);
  assert(r.unchanged, 'a wait_for click ignores it');
});

test('stay.cancelled ends a stay journey as cancelled / stay_cancelled (D-C19), mid-wait', () => {
  const def = journey('stay_guide');
  const s = guideAtCheckoutWait(zonedTime(2026, 10, 12, 17, 0, TZ).getTime());
  const r = run(def, s, { kind: 'event', event: event('ev_x', 'stay.cancelled') }, zonedTime(2026, 10, 15, 9, 0, TZ).getTime(), tom);
  assertEqual([r.state.status, r.state.exitReason], ['cancelled', 'stay_cancelled'], 'cancelled');
  assert(r.effects.some((e) => e.type === 'emit' && e.eventType === 'journey.exited' && e.data.status === 'cancelled'), 'journey.exited says cancelled');
  const other = run(journey('stay_review'), freshState('s1', 0), { kind: 'event', event: event('r', 'rating.submitted') }, 0, tom);
  assertEqual(other.state.exitReason, 'exit_on:rating.submitted', 'other exit events keep their reason');
});

test('the trigger matches only stay.moment for its own journey; a skipped moment never enrols', () => {
  const trig = journey('stay_guide').entry.trigger;
  assert(triggerMatches(trig, event('m', 'stay.moment', { journeyKey: 'stay_guide', stayId: 'st_1' }), 'stay_guide'), 'its moment');
  assert(!triggerMatches(trig, event('m', 'stay.moment', { journeyKey: 'stay_review', stayId: 'st_1' }), 'stay_guide'), 'another journey');
  assert(!triggerMatches(trig, event('m', 'stay.moment_skipped', { journeyKey: 'stay_guide', stayId: 'st_1' }), 'stay_guide'), 'moment_skipped');
  assertEqual(entryKeyFor('after_exit', event('m', 'stay.moment', { stayId: 'st_1' })), 'stay:st_1', 'one instance per stay');
});

// ── Gate rule 1 ──────────────────────────────────────────────────────────────

console.log('\nGate rule 1: the stay isn\'t cancelled');

function gateInput(over: Partial<GateInput['system']> = {}, mode: 'test' | 'live' = 'live', purpose: 'marketing' | 'service' = 'service'): GateInput {
  const now = zonedTime(2026, 10, 16, 17, 0, TZ).getTime();
  return {
    now,
    mode,
    purpose,
    channel: 'email',
    urgent: false,
    enteredAt: now,
    expireAfterMs: null,
    intendedAt: now,
    jitterKey: 'k',
    system: { paused: false, lapsed: false, tenantActive: true, venueOn: true, journeyOn: true, offSinceAt: null, staleAfterMs: 6 * HOUR_MS, venueSendsToday: 0, venueCeiling: 500, platformSendsToday: 0, platformCeiling: 5000, channelReady: true, ...over },
    address: { blocked: null, lowRatingAt: null },
    consent: { state: 'granted' },
    channelRules: { audienceOk: true, audienceFact: 'email', ruleFail: null },
    caps: { touches: 0, maxTouches: 5, clicks: 0, stopAfterClicks: 3 },
    diff: { lastTouch: null, variantId: 'v', slot: 'now' },
    weekly: { count: 0, limit: 3 },
    quiet: { venueTz: TZ, phoneTz: null, window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
    fairUse: { count: 0, limit: 300 },
    credits: { price: 0, spendable: 100, waitStartedAt: null, queueHours: 72 },
  };
}

test('a cancelled stay skips service and marketing sends, in test runs too, with no freeze grace', () => {
  for (const [mode, purpose] of [['live', 'service'], ['live', 'marketing'], ['test', 'service'], ['test', 'marketing']] as const) {
    const g = runGate(gateInput({ stayCancelled: true, venueOn: false, offSinceAt: Date.now() }, mode, purpose));
    assertEqual([g.verdict, g.reason], ['skip', 'stay_cancelled'], `${mode} ${purpose}`);
  }
  assertEqual(runGate(gateInput({ stayCancelled: false })).verdict, 'allow', 'not cancelled: allowed');
  assertEqual(runGate(gateInput()).verdict, 'allow', 'not a stay journey: allowed');
});

test('the checkout overlap rule near the freeze edge leans towards sending (both messages rather than neither)', () => {
  const moment = zonedTime(2026, 10, 16, 17, 0, TZ).getTime();
  const freeze = 60 * 60_000;
  assert(guideStillSends(moment, moment - 30 * 60_000, freeze), 'paused 30 min before: Stay guide still sends (the reminder stays quiet)');
  assert(!guideStillSends(moment, moment - 59 * 60_000, freeze), 'paused 59 min before: its send may land after the freeze → the reminder goes');
  assert(guideStillSends(moment, moment - freeze + COVER_MARGIN_MS, freeze) && !guideStillSends(moment, moment - freeze + COVER_MARGIN_MS - 1, freeze), 'the edge is freeze − 15 min');
  assert(!guideStillSends(moment, null, freeze), 'never switched off: not this rule');
});

test('the owner\'s sentence, EN and DE', () => {
  const g = runGate(gateInput({ stayCancelled: true }));
  const d = buildDecision({ now: 0, mode: 'live', poolKey: 'stay_checkout', purpose: 'service', gate: g, channelChecks: [], channel: { picked: null, rule: 'not reached' }, variant: { picked: null, method: 'none' }, slot: { picked: 'now', rule: 'now', plannedAt: 0 }, credits: null, versions: { template: 1, config: 1, playbook: 'str_stay', engine: 'x' } });
  assertEqual(explainDecision(d, 'en', TZ), 'Not sent because the booking was cancelled.', 'EN');
  assertEqual(explainDecision(d, 'de', TZ), 'Nicht gesendet, weil die Buchung storniert wurde.', 'DE');
});

// ── The numbers ──────────────────────────────────────────────────────────────

console.log('\nNumbers');

test('stay events count on `_venue` only, whatever the mode (never under dryRun)', () => {
  const at = zonedTime(2026, 10, 12, 16, 0, TZ).getTime();
  const ev = (type: string, mode: 'test' | 'live' | null = null): RollupEvent => ({ id: type, type, journeyKey: null, instanceId: null, channel: null, slot: null, variantId: null, occurredAt: at, mode, data: {} });
  assertEqual(countsFor(ev('stay.created')), { both: null, venueOnly: { stays: { created: 1 } } }, 'created');
  assertEqual(countsFor(ev('stay.linked', 'test')), { both: null, venueOnly: { stays: { linked: 1 } } }, 'a test-run link is still counted there');
  const deltas = aggregate('venue_r', TZ, ['stay.created', 'stay.changed', 'stay.cancelled', 'stay.linked', 'stay.overlap_flagged', 'stay.moment_skipped', 'stay.moment'].map((t) => ev(t)));
  assertEqual(deltas.map((d) => [d.docId, d.counts]), [['venue_r__venue_20261012', { stays: { created: 1, changed: 1, cancelled: 1, linked: 1, overlapFlagged: 1, momentsSkipped: 1 } }]], 'one _venue doc (stay.moment itself is not counted)');
});

// ── Wording fix #1 ───────────────────────────────────────────────────────────

console.log('\nThe checkout wording without late checkout (D-C22)');

const plan = buildSeedPlan(new Date('2026-09-25T00:00:00Z'));
const checkoutVariants = plan.units.filter((u) => u.label.startsWith('Wording stay_checkout/')).map((u) => u.docs[0].data as any);

test('the seed writes B with its `when`; A has none', () => {
  assertEqual(plan.problems, [], 'the seed has no problems');
  const a = checkoutVariants.find((v) => v.letter === 'A');
  const b = checkoutVariants.find((v) => v.letter === 'B');
  assert(a && b, 'A and B');
  assertEqual(a.when, undefined, 'A: no when (as in production)');
  assertEqual(b.when, { not: { fact: 'slot.late_checkout_price', gt: 0 } }, 'B: when the price is not above 0');
  assert(!JSON.stringify([b.channels, b.locales]).includes('late_checkout'), 'B never mentions the price');
});

test('price 30 → A ("CHF 30"); 0, cleared (null) and missing → B (never "CHF 0" / "CHF ")', () => {
  const pick = (slots: Record<string, any>) => checkoutVariants.filter((v) => variantEligible(v, slots)).map((v) => v.letter);
  assertEqual(pick({ late_checkout_price: 30 }), ['A'], '30');
  assertEqual(pick({ late_checkout_price: 0 }), ['B'], '0');
  assertEqual(pick({ late_checkout_price: null }), ['B'], 'cleared');
  assertEqual(pick({}), ['B'], 'missing');
  const a = checkoutVariants.find((v) => v.letter === 'A');
  const values = renderValues({ lang: 'en', tz: TZ, contact: { firstName: 'Tom', lastName: '' }, venueName: 'Retreat', vars: {}, slots: { late_checkout_price: 30 }, offers: [], guestInfo: { locales: { en: { checkOutTime: '10:00', hostContactUrl: 'https://host.example' } } }, links: { hub: '[info]' } });
  assert(renderMessage(variantContent(a, 'sms', 'en')!.content, 'sms', values).text.includes('CHF 30'), 'A prints the price');
  const b = checkoutVariants.find((v) => v.letter === 'B');
  const de = renderMessage(variantContent(b, 'email', 'de')!.content, 'email', { ...values, 'guestinfo.checkOutTime': '10:00' });
  assert(!de.missing.length && de.text.includes('Check-out um 10:00') && !de.text.includes('CHF'), `B in German: ${de.text}`);
});

// ── Printed times and the info page ──────────────────────────────────────────

console.log('\nPrinted times (D-C20) and the info page (D-C21)');

test('a stay prints the venue-level times in every language; with none valid, the keys are gone (fail closed)', () => {
  const guestInfo = { locales: { en: { checkOutTime: '11:00', hostContactUrl: 'https://h' }, de: { checkOutTime: '10 Uhr', hostContactUrl: 'https://h' } } };
  const inst = stayInstants('2026-10-12', '2026-10-17', TZ, resolveStayTimes(guestInfo));
  const base = { tz: TZ, contact: { firstName: 'Tom', lastName: '' }, venueName: 'Retreat', vars: {}, slots: {}, offers: [], links: {} };
  const de = renderValues({ ...base, lang: 'de', guestInfo, stay: { ...inst, times: resolveStayTimes(guestInfo) } });
  assertEqual([de['guestinfo.checkOutTime'], de['guestinfo.secret.checkOutTime']], ['11:00', '11:00'], 'German guest: the resolved 11:00, not "10 Uhr"');
  assertEqual([de['stay.nights'], String(de['stay.checkOutDate']).slice(0, 10)], ['5', '2026-10-17'], 'stay values');
  const none = { locales: { de: { checkOutTime: '10 Uhr' } } };
  const v = renderValues({ ...base, lang: 'de', guestInfo: none, stay: { ...stayInstants('2026-10-12', '2026-10-17', TZ, resolveStayTimes(none)), times: resolveStayTimes(none) } });
  assert(!('guestinfo.checkOutTime' in v) && !('guestinfo.secret.checkOutTime' in v), 'no valid time anywhere: deleted, never 10:00');
  const checkout = SEED.variants.find((x) => x.poolKey === 'checkout_info')!;
  const r = renderMessage((checkout.locales as any).de.sms, 'sms', v);
  assertEqual(missingReason(r.missing), 'guest_info_missing', 'so the checkout reminder is skipped');
  const plain = renderValues({ ...base, lang: 'de', guestInfo, stay: null });
  assertEqual(plain['guestinfo.checkOutTime'], '10 Uhr', 'not a stay journey: unchanged behaviour');
});

test('no Guest info content → no info page link (guest_info_missing)', () => {
  assert(!guestInfoHasContent(null) && !guestInfoHasContent({ locales: { en: { wifiName: '  ' } } }), 'empty');
  assert(guestInfoHasContent({ locales: { de: { houseRules: 'No parties' } } }), 'any field in any language');
  assertEqual(missingReason(['link.hub']), 'guest_info_missing', 'the reason');
});

// ── Linking ──────────────────────────────────────────────────────────────────

console.log('\nThe link window (D-C11)');

function snap(id: string, checkIn: string, checkOut: string, over: Partial<StaySnap> = {}): StaySnap {
  const i = stayInstants(checkIn, checkOut, TZ, { checkIn: null, checkOut: null });
  return { id, status: 'confirmed', checkIn, checkOut, checkInAt: i.checkInAt, checkOutAt: i.checkOutAt, nights: i.nights, datesVersion: 1, missingCount: 0, lastMissAt: null, contactId: null, linkedAt: null, linkMode: null, overlapWith: [], lastSeenInFeedAt: null, ...over };
}

test('12 h before check-in until checkout; not before, not after', () => {
  const s = snap('b', '2026-10-12', '2026-10-17');
  const at = (d: number, h: number, m = 0) => zonedTime(2026, 10, d, h, m, TZ).getTime();
  assertEqual(windowCandidates([s], at(12, 3, 0)).length, 1, 'check-in 15:00 − 12 h = 03:00');
  assertEqual(windowCandidates([s], at(12, 2, 59)).length, 0, 'before');
  assertEqual(windowCandidates([s], at(17, 9, 59)).length, 1, 'until checkout 10:00');
  assertEqual(windowCandidates([s], at(17, 10, 0)).length, 0, 'at checkout: over');
  assertEqual(windowCandidates([snap('c', '2026-10-12', '2026-10-17', { status: 'overlap_flagged' })], at(12, 16)).length, 0, 'overlapping stays link nobody');
  assertEqual(windowCandidates([snap('d', '2026-10-12', '2026-10-17', { contactId: 'someone' })], at(12, 16)).length, 0, 'linked to someone else');
});

test('turnover day: the window opens at the previous checkout; the previous party is never linked', () => {
  const prev = snap('a', '2026-10-07', '2026-10-12', { contactId: 'guest_a' });
  const next = snap('b', '2026-10-12', '2026-10-17');
  const at = (h: number, m = 0) => zonedTime(2026, 10, 12, h, m, TZ).getTime();
  assertEqual(windowCandidates([prev, next], at(8)).length, 0, '08:00: the previous guests are still in');
  const c = windowCandidates([prev, next], at(11));
  assertEqual([c.length, c[0]?.previous.map((p) => p.id)], [1, ['a']], '11:00: open, with the previous stay in hand');
  const companion = { firstVisitAt: new Date(zonedTime(2026, 10, 8, 19, 0, TZ).getTime()), lastVisitAt: new Date(at(8)), lastVisitEndedAt: null };
  assert(seenDuring(companion, prev), 'a companion seen during the previous stay');
  const tomCv = { firstVisitAt: new Date(at(15, 10)), lastVisitAt: new Date(at(15, 10)), lastVisitEndedAt: null };
  assert(!seenDuring(tomCv, prev), 'the new guest at 15:10 is not');
  assert(!seenDuring(null, prev), 'no record');
});

test('turnover day after an overlap-flagged stay: still protected (the previous party is found, not linked)', () => {
  const prev = snap('a', '2026-10-07', '2026-10-12', { status: 'overlap_flagged' });
  const next = snap('b', '2026-10-12', '2026-10-17');
  const at = (h: number) => zonedTime(2026, 10, 12, h, 0, TZ).getTime();
  assertEqual(windowCandidates([prev, next], at(8)).length, 0, '08:00: not open yet');
  const c = windowCandidates([prev, next], at(11));
  assertEqual([c.map((x) => x.stay.id), c[0]?.previous.map((p) => p.id)], [['b'], ['a']], '11:00: the flagged stay is the previous one');
  const cancelled = snap('a', '2026-10-07', '2026-10-12', { status: 'cancelled' });
  assertEqual(windowCandidates([cancelled, next], at(8)).map((x) => x.opensAt), [next.checkInAt - 12 * HOUR_MS], 'a cancelled one is no previous stay');
});

test('turnover day after a double booking: both previous stays count, in any order; the window opens at the later checkout', () => {
  // A (7 → 12 Oct, Ann's party) and B (10 → 12 Oct) overlap and both check out on the 12th; s checks in then.
  const A = snap('A', '2026-10-07', '2026-10-12', { status: 'overlap_flagged', contactId: 'ann' });
  const B = snap('B', '2026-10-10', '2026-10-12', { status: 'overlap_flagged', checkOutAt: zonedTime(2026, 10, 12, 11, 0, TZ).getTime() });
  const s = snap('s', '2026-10-12', '2026-10-17');
  const at = (h: number) => zonedTime(2026, 10, 12, h, 0, TZ).getTime();
  // Ben, Ann's companion: first seen on the 7th, one long visit since (never ended).
  const ben = { firstVisitAt: new Date(zonedTime(2026, 10, 7, 16, 0, TZ).getTime()), lastVisitAt: new Date(zonedTime(2026, 10, 7, 16, 0, TZ).getTime()), lastVisitEndedAt: null };
  for (const order of [[B, A, s], [A, B, s], [s, B, A]]) {
    assertEqual(windowCandidates(order, at(10)).length, 0, `10:00, before B's later checkout: not open (${order.map((x) => x.id)})`);
    const c = windowCandidates(order, at(12));
    assertEqual([c.map((x) => x.stay.id), c[0]?.previous.map((p) => p.id).sort(), c[0]?.opensAt], [['s'], ['A', 'B'], at(11)], `both previous stays (${order.map((x) => x.id)})`);
    assert(seenDuringAny(ben, c[0].previous), 'the companion is seen during one of them → not linked');
  }
  assert(!seenDuring(ben, B) && seenDuring(ben, A), 'only A covers him: checking B alone would link him');
});

test('a booking missing from the calendar (the old half of a cancel-and-rebook) is never linked, but still protects the turnover day', () => {
  const old = snap('old', '2026-10-11', '2026-10-15');
  const rebooked = snap('new', '2026-10-12', '2026-10-15');
  const at = zonedTime(2026, 10, 12, 16, 0, TZ).getTime();
  assertEqual(windowCandidates([old, rebooked], at).map((c) => c.stay.id), ['old', 'new'], 'without the missing list the ghost comes first (in progress)');
  assertEqual(windowCandidates([old, rebooked], at, new Set(['old'])).map((c) => c.stay.id), ['new'], 'with it, only the real booking');
  const prev = snap('prev', '2026-10-07', '2026-10-12');
  const next = snap('next', '2026-10-12', '2026-10-15');
  const c = windowCandidates([prev, next], zonedTime(2026, 10, 12, 11, 0, TZ).getTime(), new Set(['prev']));
  assertEqual([c.map((x) => x.stay.id), c[0]?.previous.map((p) => p.id)], [['next'], ['prev']], 'a missing previous stay still guards the turnover day');
});

test('an in-progress stay is preferred when two windows are open', () => {
  const now = zonedTime(2026, 10, 12, 16, 0, TZ).getTime();
  const current = snap('now', '2026-10-10', '2026-10-13');
  // (Only odd times make two windows open at once; a back-to-back stay's window waits for the previous checkout.)
  const soon = snap('soon', '2026-10-14', '2026-10-16', { checkInAt: now + 2 * HOUR_MS });
  assertEqual(windowCandidates([soon, current], now).map((c) => c.stay.id), ['now', 'soon'], 'in progress first');
  assertEqual(windowCandidates([current, snap('next', '2026-10-13', '2026-10-15')], now).map((c) => c.stay.id), ['now'], 'back to back: the next one waits');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
