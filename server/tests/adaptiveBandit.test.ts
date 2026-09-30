/**
 * PR F1 — the bandit: Thompson sampling over wordings and slots, what it learns, and its record.
 *
 * Run: npx tsx tests/adaptiveBandit.test.ts   (from captive-server/server)
 *
 * No Firestore. What these pin:
 *  - The generator repeats for a seed (a fixed vector) and Beta draws have the right mean and
 *    spread; θ stays in (0, 1) for tiny and huge α, β.
 *  - The pick: deterministic per seed, ties by key, the share of picks ≈ the chance of being best;
 *    `requireDiff: variant` forces the other wording (no draws); retired arms are skipped (never
 *    the last; one left goes as `forced:retired` and still trains); one wording → no bandit pick.
 *  - Levels: flat 5 % prior, the pooled prior after 200 finished sends, venue data after 30,
 *    the segment after 100. A new wording starts at the step's mean, so it gets a fair share
 *    against one with numbers (at a flat 5 % it would almost never be tried).
 *  - DF1 rewards, all landing when the send closes (the draw sees finished sends only; events
 *    only count what the admin numbers show): click α+1, rating α+2 once, a return visit α+4
 *    once per journey to its last send, no click β+1, an unsubscribe (once) or an SMS STOP it
 *    caused β+10, a hard bounce nothing; test runs and service sends never train; a slot learns
 *    only from sends that went inside it.
 *  - Drift × 0.95, retire under 1 % chance of being best on two weekly checks in a row after
 *    200 finished sends (never the last; only today's texts compete), pooling sums. A return visit's credit goes to the journey's last live
 *    marketing send, nothing when that one has no draws.
 *  - The record stays under 1 KB in the worst case (past it, with many wordings, the letters go);
 *    Replay finds a changed θ, pick, wording method or slot rule; a v3 record replays the same.
 *  - The switch: turning it on needs "BANDIT ON", off is one click (missing or malformed = off:
 *    tests/emulator/adaptiveBandit.test.ts, since the settings module loads Firebase).
 */

import {
  BANDIT_MAX_BYTES,
  FLAT_PRIOR,
  banditSeed,
  checkBanditBlock,
  effectiveArms,
  fallbackPrior,
  fitBanditBlock,
  stepMean,
  pickFromDraws,
  pickSlot,
  pickWording,
  priorFor,
  probabilityBest,
  readBanditBlock,
  rngFor,
  sampleBeta,
  segmentOf,
  sentInSlot,
  thompsonPick,
  withoutRetired,
  type BanditBlock,
} from '../src/adaptive/core/runtime/bandit';
import { variantArmKey } from '../src/adaptive/core/runtime/banditKeys';
import { applyRetire, deltasForClose, deltasForEvent, deltasForVisit, drifted, groupDeltas, isPenalty, poolFrom, toRetire, type LearnSend } from '../src/adaptive/core/runtime/banditLearn';
import { applyChange, summarizeChange, type LaunchState } from '../src/adaptive/core/runtime/launch';
import { DAY_MS, HOUR_MS, zonedTime } from '../src/adaptive/core/runtime/time';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { SEED } from '../src/adaptive/seed/definitions';
import { smsParts } from '../src/adaptive/core/runtime/smsParts';
import { sampleValues } from '../src/adaptive/core/render';
import { renderMessage } from '../src/adaptive/engine/renderSend';
import { smsFinalText } from '../src/adaptive/send/compose';

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
const SEND = 'js_4f2a9c1d7e6b5a4938271605f4e3d2c1';

console.log('\nThe generator and Beta draws');

test('rngFor: the same seed gives the same sequence (a fixed vector); another seed another', () => {
  const u = rngFor('heidifi');
  const first = [u(), u(), u()].map((x) => Math.round(x * 1e9));
  const again = rngFor('heidifi');
  assertEqual([again(), again(), again()].map((x) => Math.round(x * 1e9)), first, 'repeatable');
  const other = rngFor('heidifi2');
  assert(Math.round(other() * 1e9) !== first[0], 'another seed');
  assert(first.every((x) => x > 0 && x < 1e9), 'in (0, 1)');
});

test('sampleBeta: mean and spread right for Beta(1,1), Beta(2,18), Beta(50,450); θ in (0,1) at the extremes', () => {
  for (const [a, b] of [
    [1, 1],
    [2, 18],
    [50, 450],
  ]) {
    const u = rngFor(`t:${a}:${b}`);
    const n = 20000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i += 1) {
      const t = sampleBeta(a, b, u);
      s += t;
      s2 += t * t;
    }
    const mean = s / n;
    const v = s2 / n - mean * mean;
    const em = a / (a + b);
    const ev = (a * b) / ((a + b) ** 2 * (a + b + 1));
    assert(Math.abs(mean - em) < 4 * Math.sqrt(ev / n) + 1e-4, `Beta(${a},${b}) mean ${mean} vs ${em}`);
    assert(Math.abs(v - ev) / ev < 0.06, `Beta(${a},${b}) variance ${v} vs ${ev}`);
  }
  const u = rngFor('extremes');
  for (const [a, b] of [
    [0.001, 0.001],
    [0.2, 50],
    [1e5, 3],
    [3, 1e5],
  ]) {
    for (let i = 0; i < 200; i += 1) {
      const t = sampleBeta(a, b, u);
      assert(t > 0 && t < 1 && Number.isFinite(t), `Beta(${a},${b}) gave ${t}`);
    }
  }
});

console.log('\nThe pick');

test('thompsonPick: the same seed → the same pick and draws; the highest θ wins, ties by key', () => {
  const arms = [
    { key: 'v:b', a: 3, b: 30 },
    { key: 'v:a', a: 5, b: 20 },
  ];
  const x = thompsonPick(arms, 'seed1');
  assertEqual(thompsonPick(arms, 'seed1'), x, 'repeatable');
  assertEqual(x.draws.map((d) => d.k), ['v:a', 'v:b'], 'drawn in key order');
  assertEqual(x.picked, pickFromDraws(x.draws), 'the pick is the highest θ');
  assertEqual(pickFromDraws([{ k: 'v:b', a: 1, b: 1, t: 0.5 }, { k: 'v:a', a: 1, b: 1, t: 0.5 }]), 'v:a', 'a tie goes to the smaller key');
  assertEqual(thompsonPick([], 's').picked, null, 'no candidates');
});

test('over many sends the pick share ≈ the chance of being best', () => {
  const arms = [
    { key: 'a', a: 12, b: 88 },
    { key: 'b', a: 8, b: 92 },
  ];
  let wins = 0;
  for (let i = 0; i < 4000; i += 1) if (thompsonPick(arms, `s${i}`).picked === 'a') wins += 1;
  const best = probabilityBest(arms, 4000, 'p');
  assert(Math.abs(wins / 4000 - best.a) < 0.03, `share ${wins / 4000} vs chance ${best.a}`);
  assert(best.a > 0.7, `the better arm is usually best: ${best.a}`);
});

test('no order bias: of two equal arms, the one drawn first wins half the time', () => {
  for (const [a, b] of [
    [1, 19],
    [1, 1],
    [20, 180],
  ]) {
    let first = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) if (thompsonPick([{ key: 'v:aaa', a, b }, { key: 'v:bbb', a, b }], `js_${i}:bandit:var`).picked === 'v:aaa') first += 1;
    assert(Math.abs(first / n - 0.5) < 0.03, `Beta(${a},${b}): the first arm won ${first / n}`);
  }
});

const A = { id: 'var_a', letter: 'A', armKey: 'v:aaaaaaaaaaaa' };
const B = { id: 'var_b', letter: 'B', armKey: 'v:bbbbbbbbbbbb' };
const NO_ARMS = { venue: null, pool: null };

test('pickWording: two wordings → a bandit pick with both draws; requireDiff forces the other (no draws); one → none', () => {
  const p = pickWording({ candidates: [B, A], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: NO_ARMS, seed: banditSeed(SEND, 'var') })!;
  assertEqual([p.method, p.part?.d.length, p.part?.lvl], ['bandit:prior', 2, 'prior'], 'bandit at the flat prior');
  assert(p.vid === p.part!.vid && [A.id, B.id].includes(p.vid), 'vid is the picked wording');
  const forced = pickWording({ candidates: [A, B], lastVariantId: A.id, requireDiffVariant: true, segment: 'new', arms: NO_ARMS, seed: 's' })!;
  assertEqual([forced.vid, forced.method, forced.part], [B.id, 'forced:require_diff', null], 'forced, no draws (never trains)');
  assertEqual(pickWording({ candidates: [A], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: NO_ARMS, seed: 's' }), null, 'one wording: the rotation decides');
  assertEqual(pickWording({ candidates: [A], lastVariantId: A.id, requireDiffVariant: true, segment: 'new', arms: NO_ARMS, seed: 's' }), null, 'nothing left: the rotation decides');
  const same = pickWording({ candidates: [A, { ...B, armKey: A.armKey }], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: NO_ARMS, seed: 's' });
  assertEqual(same, null, 'two wordings with the same text are one arm');
});

test('retired arms are skipped, never the last one; one left goes out and still trains', () => {
  const venue = { all: { variant: { [A.armKey]: { a: 1, b: 300, pulls: 300, closed: 300, retired: true } } } };
  assertEqual(withoutRetired([{ key: A.armKey }, { key: B.armKey }], venue.all.variant).map((c) => c.key), [B.armKey], 'A left out');
  assertEqual(withoutRetired([{ key: A.armKey }], venue.all.variant).map((c) => c.key), [A.armKey], 'never empty');
  // Not the rotation (it would send A, retired, as `rotation:first` every time, and nothing would learn again).
  for (const seed of ['s', 't', 'u', 'v']) {
    const one = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: { venue, pool: null }, seed })!;
    assertEqual([one.vid, one.method, one.part?.pick, one.part?.d.length], [B.id, 'forced:retired', B.armKey, 1], `one active left: B, with one draw (${seed})`);
  }
  const rule = pickWording({ candidates: [A, B], lastVariantId: B.id, requireDiffVariant: true, segment: 'new', arms: { venue, pool: null }, seed: 's' })!;
  assertEqual([rule.vid, rule.method, rule.part], [A.id, 'forced:require_diff', null], 'requireDiff still wins (the rule, not a pick)');
});

test('requireDiff: another text, not only another letter (two letters with the same text are one)', () => {
  const same = { id: 'var_b2', letter: 'B', armKey: A.armKey };
  const C = { id: 'var_c', letter: 'C', armKey: 'v:cccccccccccc' };
  const p = pickWording({ candidates: [A, same, C], lastVariantId: same.id, requireDiffVariant: true, segment: 'new', arms: NO_ARMS, seed: 's' })!;
  assertEqual([p.vid, p.method], [C.id, 'forced:require_diff'], 'not A (the same text as the last B)');
});

test('a new wording starts where the wordings it is compared with are: this venue first, only today\'s texts', () => {
  // The venue does better than the pool (0.64 vs 0.30): the newcomer starts at the venue's mean.
  const venue = { all: { variant: { [A.armKey]: { a: 64, b: 36, pulls: 100, closed: 100 }, 'v:xxxxxxxxxxxx': { a: 1, b: 300, pulls: 300, closed: 300, retired: true } } } };
  const pool = { all: { variant: { [A.armKey]: { a: 60, b: 140, pulls: 200, closed: 200 } } } };
  const eff = effectiveArms({ kind: 'variant', keys: [{ key: A.armKey }, { key: B.armKey }], segment: 'new', venue, pool });
  const b = eff.arms.find((x) => x.key === B.armKey)!;
  assertEqual([eff.level, Math.round(b.a * 1000) / 1000, Math.round(b.b * 1000) / 1000], ['venue', 12.8, 7.2], 'the venue\'s mean (0.64), the retired text left out');
  // On segment data, the segment's mean.
  const seg = { ...venue, returning: { variant: { [A.armKey]: { a: 70, b: 30, pulls: 100, closed: 100 } } } };
  const r = effectiveArms({ kind: 'variant', keys: [{ key: A.armKey }, { key: B.armKey }], segment: 'returning', venue: seg, pool }).arms.find((x) => x.key === B.armKey)!;
  assertEqual([Math.round(r.a * 1000) / 1000, Math.round(r.b * 1000) / 1000], [14, 6], 'the segment\'s mean (0.70)');
});

test('a new wording gets a fair test: it starts at the step\'s mean, not at a flat 5 %', () => {
  // A with 200 finished sends and the DF1 rewards (20 clicks, 30 visits, 5 ratings, 2 unsubscribes): mean ≈ 41 %.
  const venue = { all: { variant: { [A.armKey]: { a: 150, b: 200, pulls: 200, closed: 200 } } } };
  const mean = stepMean(venue.all.variant, 30)!;
  assert(Math.abs(mean - 150 / 350) < 1e-9, `the step's mean ${mean}`);
  const prior = fallbackPrior(mean);
  assertEqual([prior.from, Math.round(prior.a0 * 1000) / 1000, Math.round((prior.a0 + prior.b0) * 1000) / 1000], ['step', 8.571, 20], '20 pseudo-sends at the mean');
  assertEqual(fallbackPrior(null), { ...FLAT_PRIOR, from: 'flat' }, 'no mean yet: flat 5 %');
  assertEqual(stepMean({ x: { a: 5, b: 5, pulls: 20, closed: 29 } }, 30), null, 'under 30 finished sends: no mean');
  let newWins = 0;
  for (let i = 0; i < 2000; i += 1) {
    const p = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: { venue, pool: null }, seed: `fair:${i}` })!;
    if (p.vid === B.id) newWins += 1;
  }
  assert(newWins > 2000 * 0.3 && newWins < 2000 * 0.7, `B (no data) picked ${newWins} of 2000`);
  // The pool's mean (≥ 200 finished sends there) is the start for an arm the pool doesn't know.
  const pool = { all: { variant: { [A.armKey]: { a: 90, b: 110, pulls: 200, closed: 200 } } } };
  const eff = effectiveArms({ kind: 'variant', keys: [{ key: A.armKey }, { key: B.armKey }], segment: 'new', venue: null, pool });
  const b = eff.arms.find((x) => x.key === B.armKey)!;
  assertEqual([eff.level, Math.round(b.a * 1000) / 1000, Math.round(b.b * 1000) / 1000], ['pool', 9, 11], 'B starts at the pooled step mean (45 %)');
});

test('pickSlot: three slots; requireDiff: slot drops the last one', () => {
  const p = pickSlot({ lastSlot: null, requireDiffSlot: false, segment: 'returning', arms: NO_ARMS, seed: banditSeed(SEND, 'slot') })!;
  assertEqual(p.part.d.map((d) => d.k), ['afternoon', 'evening', 'morning'], 'three slot arms');
  assertEqual(p.slot, p.part.pick, 'the slot is the pick');
  const q = pickSlot({ lastSlot: 'evening', requireDiffSlot: true, segment: 'returning', arms: NO_ARMS, seed: 's' })!;
  assertEqual(q.part.d.map((d) => d.k), ['afternoon', 'morning'], 'not the last slot');
});

test('levels: flat prior → pool prior (≥ 200) → venue data (≥ 30) → segment data (≥ 100)', () => {
  const keys = [{ key: 'x' }, { key: 'y' }];
  assertEqual(priorFor(null), { ...FLAT_PRIOR, from: 'flat' }, 'flat 5 %');
  assertEqual(priorFor({ a: 10, b: 190, closed: 199 }).from, 'flat', 'under 200: flat');
  const pp = priorFor({ a: 30, b: 170, closed: 200 });
  assertEqual([pp.from, Math.round(pp.a0 * 1000) / 1000, Math.round(pp.b0 * 1000) / 1000], ['pool', 3, 17], '20 pseudo-sends at 15 %');
  const pool = { all: { variant: { x: { a: 30, b: 170, pulls: 200, closed: 200 }, y: { a: 20, b: 180, pulls: 200, closed: 200 } } } };
  assertEqual(effectiveArms({ kind: 'variant', keys, segment: 'new', venue: null, pool: null }).level, 'prior', 'nothing yet');
  assertEqual(effectiveArms({ kind: 'variant', keys, segment: 'new', venue: null, pool }).level, 'pool', 'pooled prior');
  const venueAll = { all: { variant: { x: { a: 3, b: 12, pulls: 15, closed: 15 }, y: { a: 2, b: 13, pulls: 15, closed: 15 } } } };
  const v = effectiveArms({ kind: 'variant', keys, segment: 'new', venue: venueAll, pool });
  assertEqual([v.level, v.arms[0].a, v.arms[0].b], ['venue', 3 + 3, 17 + 12], '30 finished sends: venue data + pooled prior');
  const seg = { ...venueAll, new: { variant: { x: { a: 10, b: 40, pulls: 50, closed: 50 }, y: { a: 5, b: 45, pulls: 50, closed: 50 } } } };
  const s = effectiveArms({ kind: 'variant', keys, segment: 'new', venue: seg, pool });
  assertEqual([s.level, s.arms[1].a], ['segment', 2 + 5], '100 in the segment: its own data');
  assertEqual(effectiveArms({ kind: 'variant', keys, segment: 'returning', venue: seg, pool }).level, 'venue', 'another segment: the venue');
});

test('segmentOf: a stay, a first visit, a return, unknown', () => {
  assertEqual(segmentOf({ stayId: 'st_1', visitNumber: null, isFirstVisit: false }), 'stay', 'stay');
  assertEqual(segmentOf({ stayId: null, visitNumber: 1, isFirstVisit: true }), 'new', 'first visit');
  assertEqual(segmentOf({ stayId: null, visitNumber: 3, isFirstVisit: false }), 'returning', 'return');
  assertEqual(segmentOf({ stayId: null, visitNumber: null, isFirstVisit: false }), 'unknown', 'unknown');
  assertEqual(segmentOf({ stayId: null, isFirstVisit: true }), 'new', 'an older journey without visitNumber');
});

test('variantArmKey: the content decides (an edit is a new arm), not the id', () => {
  const v = { channels: { sms: { text: 'Hi' } }, locales: { de: { sms: { text: 'Hallo' } } } };
  assertEqual(variantArmKey(v), variantArmKey(JSON.parse(JSON.stringify(v))), 'same text, same arm');
  assert(variantArmKey(v) !== variantArmKey({ ...v, channels: { sms: { text: 'Hi!' } } }), 'an edit, another arm');
  assert(/^v:[0-9a-f]{12}$/.test(variantArmKey(v)), variantArmKey(v));
});

test('sentInSlot: inside the evening window yes, a morning send after a hold no', () => {
  const evening = ['18:00', '20:00'] as [string, string];
  assert(sentInSlot(zonedTime(2026, 10, 6, 19, 10, TZ).getTime(), TZ, evening), '19:10');
  assert(!sentInSlot(zonedTime(2026, 10, 7, 9, 5, TZ).getTime(), TZ, evening), '09:05 the next day');
  assert(!sentInSlot(Date.now(), TZ, undefined), 'no window');
});

console.log('\nWhat it learns (DF1)');

const T0 = zonedTime(2026, 10, 6, 12, 0, TZ).getTime();
function send(over: Partial<LearnSend> = {}): LearnSend {
  const block: BanditBlock = { v: 1, seg: 'new', var: { lvl: 'prior', pick: A.armKey, vid: A.id, d: [] }, slot: { lvl: 'prior', pick: 'evening', d: [], in: true } };
  return { sendKey: SEND, mode: 'live', purpose: 'marketing', status: 'sent', channel: 'sms', journeyKey: 'welcome_second_visit', nodeId: 's2_same', instanceId: 'ji_1', sentAt: T0, firstClickAt: null, bandit: block, ...over };
}

test('events: a pull and the counts the admin shows — no α or β before the send closes; the slot too when it went in its slot', () => {
  const s = send();
  assertEqual(deltasForEvent({ type: 'message.sent', occurredAt: T0 }, s).map((d) => [d.kind, d.d]), [['variant', { pulls: 1 }], ['slot', { pulls: 1 }]], 'pull');
  assertEqual(deltasForEvent({ type: 'message.clicked', occurredAt: T0 + HOUR_MS }, s)[0].d, { click: 1 }, 'click: counted, α at close');
  assertEqual(deltasForEvent({ type: 'rating.submitted', occurredAt: T0 + HOUR_MS }, s)[0].d, { rating: 1 }, 'rating, any stars');
  assertEqual(deltasForEvent({ type: 'consent.revoked', occurredAt: T0 + HOUR_MS, data: { source: 'unsubscribe_page' } }, s)[0].d, { unsub: 1 }, 'unsubscribe: counted, β at close');
  assertEqual(deltasForEvent({ type: 'consent.revoked', occurredAt: T0 + HOUR_MS, data: { source: 'sms_keyword' } }, s), [], 'an SMS STOP: at close');
  assertEqual(deltasForEvent({ type: 'message.clicked', occurredAt: T0 + 8 * DAY_MS }, s), [], 'after 7 days: nothing');
  assertEqual(deltasForEvent({ type: 'message.bounced', occurredAt: T0 + HOUR_MS }, s), [], 'a hard bounce: nothing');
  const held = send({ bandit: { ...s.bandit!, slot: { ...s.bandit!.slot!, in: false } } });
  assertEqual(deltasForEvent({ type: 'message.clicked', occurredAt: T0 + HOUR_MS }, held).map((d) => d.kind), ['variant'], 'held past its slot: the slot learns nothing');
});

test('never trains: a test run, an info message, a failed send, a send without a block', () => {
  for (const s of [send({ mode: 'test' }), send({ purpose: 'service' }), send({ status: 'failed' }), send({ bandit: null }), send({ sentAt: null })]) {
    assertEqual(deltasForEvent({ type: 'message.clicked', occurredAt: T0 + HOUR_MS }, s), [], JSON.stringify({ mode: s.mode, purpose: s.purpose, status: s.status }));
    assertEqual(deltasForClose(s, null, { clicked: true, rated: true, visited: true, penalized: false }), [], 'no close either');
  }
});

test('a return visit: once per journey, to that journey\'s last send in the 7 days before (its α+4 at close)', () => {
  const s1 = send({ sendKey: 'js_1', nodeId: 's1', sentAt: T0 });
  const s2 = send({ sendKey: 'js_2', nodeId: 's2_same', sentAt: T0 + 2 * DAY_MS });
  const other = send({ sendKey: 'js_3', instanceId: 'ji_2', journeyKey: 'review_ask', nodeId: 's1', sentAt: T0 + DAY_MS });
  const credited = new Set<string>();
  const r = deltasForVisit(T0 + 3 * DAY_MS, [s1, s2, other], credited);
  assertEqual(r.deltas.filter((d) => d.kind === 'variant').map((d) => [d.nodeId, d.d]), [['s2_same', { visit: 1 }], ['s1', { visit: 1 }]], 'each journey its last send');
  assertEqual(r.instances.sort(), ['ji_1', 'ji_2'], 'both journeys credited');
  assertEqual(r.sends.sort(), ['js_2', 'js_3'], 'the sends whose close gets α+4');
  assertEqual(deltasForVisit(T0 + 3 * DAY_MS + HOUR_MS, [s1, s2, other], new Set(r.instances)).deltas, [], 'a second visit: nothing more');
  assertEqual(deltasForVisit(T0 + 10 * DAY_MS, [s1, s2], new Set()).deltas, [], 'more than 7 days after: nothing');
  assertEqual(deltasForVisit(T0 - HOUR_MS, [s1], new Set()).deltas, [], 'the visit before the send: nothing');
  // The journey's last message had no draws (sent with the bandit off, forced, a rotation): no credit, and not to s1 either.
  const plain = send({ sendKey: 'js_4', nodeId: 's2_same', sentAt: T0 + 2 * DAY_MS, bandit: null });
  const r2 = deltasForVisit(T0 + 3 * DAY_MS, [s1, plain], new Set());
  assertEqual([r2.deltas, r2.instances, r2.sends], [[], ['ji_1'], []], 'no credit, the journey\'s one credit used');
  // A bounced email never reached the guest: the credit goes to the message before it.
  const bounced = send({ sendKey: 'js_5', nodeId: 's2_same', sentAt: T0 + 2 * DAY_MS, status: 'bounced' });
  assertEqual(deltasForVisit(T0 + 3 * DAY_MS, [s1, bounced], new Set()).deltas.filter((d) => d.kind === 'variant').map((d) => d.nodeId), ['s1'], 'past a bounce');
  const dry = send({ sendKey: 'js_6', nodeId: 's2_same', sentAt: T0 + 2 * DAY_MS, mode: 'test' });
  assertEqual(deltasForVisit(T0 + 3 * DAY_MS, [s1, dry], new Set()).deltas.filter((d) => d.kind === 'variant').map((d) => d.nodeId), ['s1'], 'a test run is no message');
});

test('an unsubscribe or a spam report is a penalty (once per send, by the learner); an SMS STOP is not (closing)', () => {
  assertEqual(
    [{ source: 'unsubscribe_page' }, { source: 'spam' }, { source: 'sms_keyword' }].map((data) => isPenalty({ type: 'consent.revoked', data })),
    [true, true, false],
    'penalties',
  );
  assertEqual(isPenalty({ type: 'message.clicked' }), false, 'a click');
});

test('closing: one more finished send and its whole reward — click α+1, rating α+2, visit α+4; no click β+1, an unsubscribe or its STOP β+10; a bounce nothing', () => {
  const none = { clicked: false, rated: false, visited: false, penalized: false };
  assertEqual(deltasForClose(send(), null, none)[0].d, { closed: 1, b: 1 }, 'no click');
  // The worker applied a click from the last minutes after the 7 days: the fact (the click's own time) counts it.
  assertEqual(deltasForClose(send({ firstClickAt: T0 + 7 * DAY_MS + 60_000 }), null, { ...none, clicked: true })[0].d, { closed: 1, a: 1 }, 'a click applied late');
  assertEqual(deltasForClose(send({ firstClickAt: T0 + HOUR_MS }), null, none)[0].d, { closed: 1, a: 1 }, 'clicked');
  assertEqual(deltasForClose(send({ firstClickAt: T0 + 8 * DAY_MS }), null, none)[0].d, { closed: 1, b: 1 }, 'a click after the 7 days: no click');
  assertEqual(deltasForClose(send({ firstClickAt: T0 + HOUR_MS }), null, { clicked: true, rated: true, visited: true, penalized: false })[0].d, { closed: 1, a: 7 }, 'click, rating, visit');
  assertEqual(deltasForClose(send(), null, { ...none, visited: true })[0].d, { closed: 1, a: 4, b: 1 }, 'came back without a click');
  assertEqual(deltasForClose(send({ channel: 'email' }), null, { ...none, penalized: true })[0].d, { closed: 1, b: 11 }, 'unsubscribed');
  assertEqual(deltasForClose(send(), { stopAt: T0 + DAY_MS, lastLiveSmsKey: SEND }, none)[0].d, { closed: 1, unsub: 1, b: 11 }, 'its STOP');
  assertEqual(deltasForClose(send(), { stopAt: T0 + DAY_MS, lastLiveSmsKey: 'js_other' }, none)[0].d, { closed: 1, b: 1 }, 'a STOP after another SMS: not this one');
  assertEqual(deltasForClose(send({ channel: 'email' }), { stopAt: T0 + DAY_MS, lastLiveSmsKey: SEND }, none)[0].d, { closed: 1, b: 1 }, 'email: no STOP');
  assertEqual(deltasForClose(send({ status: 'bounced' }), null, none), [], 'a hard bounce says nothing');
});

test('groupDeltas: per step, into `all` and the segment', () => {
  const g = groupDeltas([...deltasForEvent({ type: 'message.sent', occurredAt: T0 }, send()), ...deltasForClose(send(), null, { clicked: false, rated: false, visited: false, penalized: false })]);
  const doc = [...g.values()][0];
  assertEqual(Object.keys(doc.blocks).sort(), ['all', 'new'], 'all + segment');
  assertEqual(doc.blocks.all.variant[A.armKey], { pulls: 1, closed: 1, b: 1 }, 'summed');
});

test('drift × 0.95 (counts stay); retire under 1 % on two weekly checks in a row after 200 finished sends, never the last', () => {
  const block = { variant: { x: { a: 100, b: 900, pulls: 1000, closed: 1000 } }, slot: { evening: { a: 10, b: 90, pulls: 100, closed: 100 } } };
  const d = drifted(block);
  assertEqual([d.variant!.x.a, d.variant!.x.b, d.variant!.x.closed, d.slot!.evening.a], [95, 855, 1000, 9.5], 'drifted');
  const good = { a: 60, b: 240, pulls: 300, closed: 300 };
  const bad = { a: 15, b: 285, pulls: 300, closed: 300 };
  const today = ['good', 'bad', 'worse'];
  const none = { retire: [], low: [] };
  assertEqual(toRetire({ good, bad }, undefined, 'r1', today), { retire: [], low: ['bad'] }, 'the hopeless one: low at the first check');
  assertEqual(toRetire({ good, bad: { ...bad, low: true } }, undefined, 'r1', today), { retire: ['bad'], low: [] }, 'low at two checks in a row: retired');
  assertEqual(toRetire({ good, bad: { ...bad, closed: 150, low: true } }, undefined, 'r1', today), none, 'under 200: not yet');
  assertEqual(toRetire({ bad: { ...bad, low: true } }, undefined, 'r1', today), none, 'never the last one');
  const worse = { a: 5, b: 295, pulls: 300, closed: 300, low: true };
  assertEqual(toRetire({ good, bad: { ...bad, low: true }, worse }, undefined, 'r1', today).retire.sort(), ['bad', 'worse'], 'two of three');
  assertEqual(toRetire({ good: { ...good, low: true }, bad }, undefined, 'r1', today), { retire: [], low: ['bad'] }, 'a recovered one is no longer low');
  // An arm whose text was edited away is never sent again: it doesn't compete (else "never the last" could leave none of today's texts).
  const old = { a: 200, b: 100, pulls: 300, closed: 300 };
  assertEqual(toRetire({ good, bad: { ...bad, low: true }, old }, undefined, 'r1', ['good', 'bad']).retire, ['bad'], 'only today\'s texts compete');
  assertEqual(toRetire({ good, old }, undefined, 'r1', ['good']), none, 'the last of today\'s texts stays');
  // The weekly write: retired marked, this week's low flagged, the others' flag cleared.
  const applied = applyRetire({ good: { ...good, low: true }, bad: { ...bad, low: true }, worse }, { retire: ['bad'], low: ['worse'] });
  assertEqual([applied.good.low, applied.bad.retired, applied.bad.low, applied.worse.low], [undefined, true, undefined, true], 'flags');
});

/**
 * A fresh step with wordings A and B over 13 weeks, 20 sends a day, per seeded venue — the real
 * learner functions end to end (sends pull at once, their whole reward lands at close; weekly
 * drift and the retire check). Returns how often each ended retired and B led the last 4 weeks.
 */
function simulateStep(quality: Record<string, { click: number; visit: number; rating: number }>, venues: number, seedPrefix: string) {
  let aRetired = 0;
  let bRetired = 0;
  let bLeads = 0;
  for (let run = 0; run < venues; run += 1) {
    const u = rngFor(`${seedPrefix}:${run}`);
    const data: Record<string, any> = {};
    const apply = (deltas: ReturnType<typeof deltasForEvent>) => {
      for (const x of deltas) {
        if (x.kind !== 'variant') continue;
        const arm = (data[x.arm] ??= { a: 0, b: 0, pulls: 0, closed: 0 });
        for (const k of ['a', 'b', 'pulls', 'closed'] as const) arm[k] += x.d[k] ?? 0;
      }
    };
    const closing: Array<Array<() => void>> = Array.from({ length: 110 }, () => []);
    const weekShare: number[] = [];
    let aSends = 0;
    for (let day = 0; day < 91; day += 1) {
      for (const close of closing[day]) close();
      if (day > 0 && day % 7 === 0) {
        weekShare.push(aSends / 140);
        aSends = 0;
        Object.assign(data, drifted({ variant: data }).variant);
        Object.assign(data, applyRetire(data, toRetire(data, undefined, `r:${run}:${day}`, [A.armKey, B.armKey])));
      }
      for (let i = 0; i < 20; i += 1) {
        const sentAt = T0 + day * DAY_MS + i * 60_000;
        const p = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: { venue: { all: { variant: data } }, pool: null }, seed: `js_${seedPrefix}_${run}_${day}_${i}:bandit:var` })!;
        if (p.vid === A.id) aSends += 1;
        const q = quality[p.part!.pick!];
        const clicked = u() < q.click;
        const facts = { clicked, visited: u() < q.visit, rated: u() < q.rating, penalized: false };
        const s = send({ sendKey: `js_${run}_${day}_${i}`, nodeId: 's1', sentAt, firstClickAt: clicked ? sentAt + HOUR_MS : null, bandit: { v: 1, seg: 'new', var: p.part, slot: null } });
        apply(deltasForEvent({ type: 'message.sent', occurredAt: sentAt }, s));
        if (clicked) apply(deltasForEvent({ type: 'message.clicked', occurredAt: sentAt + HOUR_MS }, s));
        closing[day + 8].push(() => apply(deltasForClose(s, null, facts)));
      }
    }
    if (data[A.armKey]?.retired) aRetired += 1;
    if (data[B.armKey]?.retired) bRetired += 1;
    if (weekShare.slice(-4).reduce((x, y) => x + y, 0) / 4 < 0.5) bLeads += 1;
  }
  return { aRetired, bRetired, bLeads };
}

test('a fresh step, 13 weeks, 40 seeded venues: the better wording ends up with the traffic and is never retired', () => {
  // Counted when they happen, rewards made young sends look good: the better wording was retired in 4–8 of 40.
  const r = simulateStep({ [A.armKey]: { click: 0.1, visit: 0.15, rating: 0.025 }, [B.armKey]: { click: 0.08, visit: 0.1, rating: 0.02 } }, 40, 'venue');
  assertEqual(r.aRetired, 0, 'the better wording retired');
  assert(r.bLeads <= 2, `the worse wording leads weeks 10–13 in ${r.bLeads} of 40`);
});

test('near-equal wordings: one 10 % better is never retired; of two equal ones, one retires at few venues', () => {
  // One check at 5 % retired the better (or an equal) wording at up to 4 venues in 10 within a quarter.
  const same = { click: 0.1, visit: 0.04, rating: 0.02 };
  const edge = simulateStep({ [A.armKey]: { click: 0.11, visit: 0.044, rating: 0.022 }, [B.armKey]: same }, 100, 'edge');
  assertEqual(edge.aRetired, 0, 'the 10 % better wording retired');
  const equal = simulateStep({ [A.armKey]: same, [B.armKey]: same }, 100, 'equal');
  assert(equal.aRetired + equal.bRetired <= 10, `one of two equal wordings retired at ${equal.aRetired + equal.bRetired} of 100 venues`);
});

test('poolFrom: every venue summed per step and segment', () => {
  const docs = [
    { journeyKey: 'j', nodeId: 's1', segments: { all: { variant: { x: { a: 1, b: 9, pulls: 10, closed: 10, rewards: { click: 1 } } } } } },
    { journeyKey: 'j', nodeId: 's1', segments: { all: { variant: { x: { a: 2, b: 8, pulls: 10, closed: 10, rewards: { click: 2 } } } } } },
  ];
  const p = [...poolFrom(docs).values()][0];
  assertEqual([p.venues, p.segments.all!.variant!.x.a, p.segments.all!.variant!.x.closed, p.segments.all!.variant!.x.rewards!.click], [2, 3, 20, 3], 'summed');
});

console.log('\nThe record and Replay');

test('the worst-case block (8 wordings + 3 slots, α / β in the thousands) stays under 1 KB', () => {
  const draws = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ k: `${prefix}${String(i).padStart(11, '0')}`, l: String.fromCharCode(65 + i), a: 1234.567, b: 98765.432, t: 0.123456 }));
  const block: BanditBlock = { v: 1, seg: 'returning', var: { lvl: 'segment', pick: 'v:00000000000', vid: 'var_' + 'a'.repeat(32), d: draws(8, 'v:') }, slot: { lvl: 'segment', pick: 'afternoon', d: ['afternoon', 'evening', 'morning'].map((k) => ({ k, a: 1234.567, b: 98765.432, t: 0.123456 })), in: true } };
  const size = JSON.stringify(block).length;
  assert(size <= BANDIT_MAX_BYTES, `${size} B`);
});

test('Replay: a real pick checks out; a changed θ, a changed pick or another wording id shows', () => {
  const p = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: NO_ARMS, seed: banditSeed(SEND, 'var') })!;
  const sp = pickSlot({ lastSlot: null, requireDiffSlot: false, segment: 'new', arms: NO_ARMS, seed: banditSeed(SEND, 'slot') })!;
  const block: BanditBlock = JSON.parse(JSON.stringify({ v: 1, seg: 'new', var: p.part, slot: sp.part }));
  const decision = { variant: { picked: p.vid }, slot: { picked: sp.slot } };
  assertEqual(checkBanditBlock(block, SEND, decision), [], 'the same');
  assert(readBanditBlock(block) !== null, 'readable');
  const t = JSON.parse(JSON.stringify(block));
  t.var.d[0].t = 0.999999;
  const diffs = checkBanditBlock(t, SEND, decision).map((d) => d.field);
  assert(diffs.some((f) => f.startsWith('bandit.var.draw.')), `a changed θ: ${diffs}`);
  assertEqual(checkBanditBlock(block, 'js_other', decision).length > 0, true, 'another send key draws differently');
  assertEqual(checkBanditBlock(block, SEND, { ...decision, variant: { picked: 'var_other' } }).map((d) => d.field), ['bandit.var.vid'], 'another wording id');
  assertEqual(readBanditBlock({ v: 2 }), null, 'not a block');
  // The decision's method and slot rule must be what the block says.
  const full = { variant: { picked: p.vid, method: p.method }, slot: { picked: sp.slot, rule: `bandit:${sp.part.lvl}` } };
  assertEqual(checkBanditBlock(block, SEND, full), [], 'method and rule check out');
  assertEqual(checkBanditBlock(block, SEND, { ...full, variant: { picked: p.vid, method: 'bandit:venue' } }).map((d) => d.field), ['variant.method'], 'another method');
  assertEqual(checkBanditBlock(block, SEND, { ...full, slot: { picked: sp.slot, rule: `slot:${sp.slot}` } }).map((d) => d.field), ['slot.rule'], 'another slot rule');
  const venue = { all: { variant: { [A.armKey]: { a: 1, b: 300, pulls: 300, closed: 300, retired: true } } } };
  const one = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: { venue, pool: null }, seed: banditSeed(SEND, 'var') })!;
  assertEqual(checkBanditBlock({ v: 1, seg: 'new', var: one.part, slot: null }, SEND, { variant: { picked: one.vid, method: one.method }, slot: { picked: 'now' } }), [], 'forced:retired checks out');
});

test('Replay: a wording sent in English for another language (`:en_fallback`) checks out', () => {
  const p = pickWording({ candidates: [A, B], lastVariantId: null, requireDiffVariant: false, segment: 'new', arms: NO_ARMS, seed: banditSeed(SEND, 'var') })!;
  const block: BanditBlock = { v: 1, seg: 'new', var: p.part, slot: null };
  assertEqual(checkBanditBlock(block, SEND, { variant: { picked: p.vid, method: `${p.method}:en_fallback` }, slot: { picked: 'now' } }), [], 'a French guest');
});

test('many wordings: past 1 KB the letters go, every draw stays', () => {
  const draws = (n: number) => Array.from({ length: n }, (_, i) => ({ k: `v:${String(i).padStart(12, '0')}`, l: String.fromCharCode(65 + i), a: 1234.567, b: 9876.543, t: 0.123456 }));
  const big: BanditBlock = { v: 1, seg: 'returning', var: { lvl: 'segment', pick: 'v:000000000000', vid: 'var_' + 'a'.repeat(32), d: draws(10) }, slot: { lvl: 'segment', pick: 'afternoon', d: ['afternoon', 'evening', 'morning'].map((k) => ({ k, a: 1234.567, b: 9876.543, t: 0.123456 })), in: true } };
  assert(JSON.stringify(big).length > BANDIT_MAX_BYTES, `the test block is over: ${JSON.stringify(big).length}`);
  const fit = fitBanditBlock(big);
  assert(JSON.stringify(fit).length <= BANDIT_MAX_BYTES, `fitted: ${JSON.stringify(fit).length} B`);
  assertEqual([fit.var!.d.length, fit.var!.d.every((d) => d.l === undefined), fit.var!.pick, fit.slot!.d.length], [10, true, 'v:000000000000', 3], 'every draw kept, letters gone');
  assertEqual(checkBanditBlock(fit, SEND, { variant: { picked: big.var!.vid }, slot: { picked: 'afternoon' } }).filter((d) => d.field.endsWith('.pick')), [], 'the picks still check out');
  const small: BanditBlock = { v: 1, seg: 'new', var: { lvl: 'prior', pick: 'v:1', vid: 'x', d: draws(2) }, slot: null };
  assertEqual(fitBanditBlock(small), small, 'a small block as it is');
});

console.log('\nThe B wordings (F-D11)');

test('each B SMS costs no more parts than its A — every venue name 3–45 characters, first name, offer, en + de', () => {
  const offers = SEED.playbooks.flatMap((p: any) => (p.content.offerMenuDefaults ?? []) as any[]);
  const offerKeys = [...new Set(offers.map((o: any) => String(o.offerKey)))];
  const text = (pool: string, letter: string, lang: 'en' | 'de') => {
    const v = (SEED.variants as any[]).find((x) => x.poolKey === pool && x.letter === letter)!;
    return String((lang === 'en' ? v.channels.sms : v.locales.de.sms).text);
  };
  const partsOf = (tpl: string, lang: 'en' | 'de', venueLen: number, first: string | null, offer: string) => {
    const values: Record<string, unknown> = sampleValues({ lang, venueName: 'Luna Bar & Grill Interlaken Zentrum Nord'.padEnd(60, 'x').slice(0, venueLen), slots: { offer }, offers: offers as any });
    if (first === null) delete values['contact.firstName'];
    else values['contact.firstName'] = first;
    for (const k of Object.keys(values)) if (k.startsWith('link.')) values[k] = 'https://visit.askheidi.app/s/AbCd1234';
    // The engine's own SMS path: the render (with its GSM-7 clean-ups), then the STOP line.
    return smsParts(smsFinalText(renderMessage({ text: tpl }, 'sms', values as any).text, lang, tpl)).segments;
  };
  const worse: string[] = [];
  for (const pool of ['review_ask', 'last_chance', 'stay_review']) {
    for (const lang of ['en', 'de'] as const) {
      const a = text(pool, 'A', lang);
      const b = text(pool, 'B', lang);
      for (let len = 3; len <= 45; len += 1) {
        for (const first of [null, '', 'Anna', 'Zoë', 'Alexandrea', 'Maximiliane-Josefine']) {
          for (const offer of offerKeys) {
            const pa = partsOf(a, lang, len, first, offer);
            const pb = partsOf(b, lang, len, first, offer);
            if (pb > pa) worse.push(`${pool} ${lang} venue ${len} name ${first?.length ?? 0} ${offer}: A ${pa}, B ${pb}`);
          }
        }
      }
    }
  }
  assertEqual(worse.slice(0, 5), [], `B needs more parts (${worse.length} cases)`);
});

console.log('\nThe learner stays off the send path');

/** Every file a module loads at run time (relative imports, `import()` too; `import type` left out). */
function runtimeImports(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const stack: Array<[string, string | null]> = [[entry, null]];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (stack.length) {
    const [file, parent] = stack.pop()!;
    if (seen.has(file)) continue;
    seen.set(file, parent);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[3] ?? m[4];
      if (m[2] || !spec?.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
      if (found) stack.push([found, file]);
    }
  }
  return seen;
}

test('the learner, its tasks and the admin numbers import nothing from send/ (04-engine-runtime §9.2)', () => {
  const src = join(__dirname, '../src');
  for (const entry of ['adaptive/bandit/learn.ts', 'adaptive/bandit/tasks.ts', 'adaptive/core/runtime/banditLearn.ts', 'adaptive/service/banditAdmin.ts']) {
    const graph = runtimeImports(join(src, entry));
    const bad = [...graph.keys()].filter((f) => f.includes(`${join('adaptive', 'send')}/`));
    const chain = (f: string) => {
      const out: string[] = [];
      for (let x: string | null | undefined = f; x; x = graph.get(x)) out.unshift(relative(src, x));
      return out.join(' → ');
    };
    assert(graph.size > 1, `${entry}: the scan found its imports`);
    assertEqual(bad.map(chain), [], `${entry} reaches send/`);
  }
});

console.log('\nThe switch');

test('the launch card: turning it on needs "BANDIT ON"; turning it off is one click', () => {
  const before: LaunchState = { default: 'live', accounts: {}, liveSince: { default: 1, accounts: {} }, paused: false, safety: { maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 }, smsCountries: ['CH'], alertsEmail: null, bandit: { mode: 'off', accounts: {} } };
  const on = summarizeChange(before, applyChange(before, { bandit: { accounts: { t1: 'on' } } }));
  assertEqual([on.lines, on.loosening, on.confirmPhrase], [['t1: learning default (off) → on'], ['bandit_on'], 'BANDIT ON'], 'on for one account');
  const after = applyChange(before, { bandit: { mode: 'on' } });
  const off = summarizeChange(after, applyChange(after, { bandit: { mode: 'off' } }));
  assertEqual([off.lines, off.loosening, off.confirmPhrase], [['Learning (default): on → off'], [], null], 'off: the brake');
  const drop = summarizeChange(after, applyChange(after, { bandit: { accounts: { t1: 'off' } } }));
  assertEqual(drop.loosening, [], 'an account off: no phrase');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
