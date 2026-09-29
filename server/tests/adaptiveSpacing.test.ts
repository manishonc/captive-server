/**
 * PR F0 — the spacing rule: at least N hours (AdaptiveConfig `marketingGapHours`, 4)
 * between two marketing messages to one person, from any venue or owner.
 *
 * Run: npx tsx tests/adaptiveSpacing.test.ts   (from captive-server/server)
 *
 * What these pin:
 *  - The finding from the 29 Sep local run: a welcome held by quiet hours and a review ask
 *    held the same night no longer both go at 09:00–09:20. The second waits 4 h + a spread.
 *  - Info messages are never spaced; a missing input (a record from before the rule) or a
 *    gap of 0 lets the message through.
 *  - A gap that ends in quiet hours moves on to their end; past the step's expiry it's skipped.
 *  - The owner sentence copies the gap from the stored fact; Replay reaches the same decision.
 *  - `newestTouchAt` ignores the send's own touch.
 */

import { runGate, GATE_RULE_ORDER, type GateInput } from '../src/adaptive/core/runtime/gate';
import { buildDecision, explainDecision } from '../src/adaptive/core/runtime/decision';
import { buildReplaySnapshot, replayAnswer } from '../src/adaptive/core/runtime/replay';
import { HOUR_MS, MINUTE_MS, isInWindow, zonedTime } from '../src/adaptive/core/runtime/time';
import { adaptiveConfigSchema } from '../src/adaptive/core/schemas';
import { ADAPTIVE_CONFIG_V1 } from '../src/adaptive/seed/definitions/config';
import { newestTouchAt } from '../src/adaptive/send/touches';

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
const GAP = 4 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (day: number, h: number, m: number) => zonedTime(2026, 9, day, h, m, TZ).getTime();

function gateInput(over: Partial<GateInput> = {}): GateInput {
  const now = over.now ?? at(23, 12, 0);
  const base: GateInput = {
    now,
    mode: 'live',
    purpose: 'marketing',
    channel: 'sms',
    urgent: false,
    enteredAt: now,
    expireAfterMs: null,
    intendedAt: now,
    jitterKey: 'js_review_s1',
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
    spacing: { lastAt: null, minGapMs: GAP },
    fairUse: { count: 0, limit: 300 },
    credits: { price: 15, spendable: 100, waitStartedAt: null, queueHours: 72 },
  };
  return { ...base, ...over, system: { ...base.system, ...(over.system ?? {}) } };
}

const spacingCheck = (i: GateInput) => runGate(i).checks.find((c) => c.rule === 'spacing')!;

console.log('\nSpacing rule');

test('the rule sits right after quiet hours, eleven rules in all', () => {
  assertEqual(GATE_RULE_ORDER.indexOf('spacing'), GATE_RULE_ORDER.indexOf('quiet_hours') + 1, 'after quiet_hours');
  assertEqual(GATE_RULE_ORDER.length, 11, 'eleven rules');
  assertEqual(runGate(gateInput()).checks.map((c) => c.rule), GATE_RULE_ORDER, 'the checklist follows the order');
});

test('no other marketing message → allow, with the gap in the fact', () => {
  const g = runGate(gateInput());
  assertEqual(g.verdict, 'allow', 'allow');
  assertEqual(spacingCheck(gateInput()).fact, 'no other marketing message in the last 4 h', 'fact');
});

test('last one 1 h ago → wait until 4 h after it + 0–20 min', () => {
  const now = at(23, 12, 0);
  const i = gateInput({ now, spacing: { lastAt: now - HOUR_MS, minGapMs: GAP } });
  const g = runGate(i);
  assertEqual([g.verdict, g.rule, g.reason], ['defer', 'spacing', 'spacing'], 'deferred by spacing');
  const ready = now - HOUR_MS + GAP;
  assert(g.until! >= ready && g.until! <= ready + 20 * MINUTE_MS, `until 15:00–15:20, got ${iso(g.until!)}`);
  assert(/^last marketing message 1 h ago, gap 4 h → 15:\d\d$/.test(spacingCheck(i).fact), spacingCheck(i).fact);
  // Repeatable: the same send key gives the same minute.
  assertEqual(runGate(i).until, g.until, 'same until again');
});

test('last one 4 h 10 min ago → allow; 3 h 59 min ago → wait', () => {
  const now = at(23, 14, 0);
  const ok = runGate(gateInput({ now, spacing: { lastAt: now - GAP - 10 * MINUTE_MS, minGapMs: GAP } }));
  assertEqual(ok.verdict, 'allow', 'past the gap');
  assertEqual(ok.checks.find((c) => c.rule === 'spacing')!.fact, 'last marketing message 4 h 10 min ago (gap 4 h)', 'fact');
  const wait = runGate(gateInput({ now, spacing: { lastAt: now - GAP + MINUTE_MS, minGapMs: GAP } }));
  assertEqual(wait.rule, 'spacing', 'one minute short');
});

test('info messages are never spaced (and never counted)', () => {
  const now = at(23, 12, 0);
  const g = runGate(gateInput({ now, purpose: 'service', spacing: { lastAt: now - MINUTE_MS, minGapMs: GAP } }));
  assertEqual(g.verdict, 'allow', 'service goes');
  assertEqual(g.checks.find((c) => c.rule === 'spacing')!.fact, 'info message — not counted', 'fact');
});

test('no input (a record from before the rule) or a gap of 0 → allow', () => {
  const now = at(23, 12, 0);
  const old: Partial<GateInput> = gateInput({ now });
  delete old.spacing;
  assertEqual(runGate(old as GateInput).verdict, 'allow', 'missing input');
  assertEqual(spacingCheck(old as GateInput).fact, 'no gap between messages is set', 'fact');
  assertEqual(runGate(gateInput({ now, spacing: { lastAt: now - MINUTE_MS, minGapMs: 0 } })).verdict, 'allow', 'gap 0 = off');
});

test('a gap that ends in quiet hours moves on to the morning (one hop)', () => {
  const now = at(23, 19, 30);
  const g = runGate(gateInput({ now, spacing: { lastAt: at(23, 18, 0), minGapMs: GAP } })); // ready 22:00 → quiet
  assertEqual(g.rule, 'spacing', 'spacing holds it');
  const nine = at(24, 9, 0);
  assert(g.until! >= nine && g.until! <= nine + 20 * MINUTE_MS, `until 09:00–09:20 next day, got ${iso(g.until!)}`);
  assert(!isInWindow(new Date(g.until!), TZ, { start: '21:00', end: '09:00' }), 'lands outside quiet hours');
});

test('a gap ending mid-minute is rounded up, so a hold never wakes inside quiet hours', () => {
  // 16:53:49 + 4 h = 20:53:49: rounded to 20:54, + 0–20 min; past 21:00 it moves to the morning.
  const lastAt = at(23, 16, 53) + 49_000;
  for (const key of ['js_a', 'js_b', 'js_c', 'js_d', 'js_e', 'js_f', 'js_g', 'js_h']) {
    const g = runGate(gateInput({ now: at(23, 17, 10), jitterKey: key, spacing: { lastAt, minGapMs: GAP } }));
    assert(g.until! % MINUTE_MS === 0, `a whole minute: ${iso(g.until!)}`);
    assert(g.until! >= lastAt + GAP, 'never before the gap ends');
    assert(!isInWindow(new Date(g.until!), TZ, { start: '21:00', end: '09:00' }), `not in quiet hours: ${iso(g.until!)}`);
  }
});

test('past the step expiry → skip as spacing_expired', () => {
  const now = at(23, 12, 0);
  const g = runGate(gateInput({ now, enteredAt: now - 23 * HOUR_MS, expireAfterMs: 24 * HOUR_MS, spacing: { lastAt: now - HOUR_MS, minGapMs: GAP } }));
  assertEqual([g.verdict, g.reason], ['skip', 'spacing_expired'], 'too late');
  assert(g.checks.find((c) => c.rule === 'spacing')!.fact.endsWith(', too late for this step'), 'fact says why');
});

test('at night quiet hours answer first; the spacing check is still recorded', () => {
  const night = at(23, 23, 0);
  const g = runGate(gateInput({ now: night, spacing: { lastAt: night - HOUR_MS, minGapMs: GAP } }));
  assertEqual(g.rule, 'quiet_hours', 'quiet hours win');
  const s = g.checks.find((c) => c.rule === 'spacing')!;
  assert(s.verdict === 'defer' && s.fact.includes('gap 4 h'), JSON.stringify(s));
});

test('the 29 Sep finding: welcome and review ask held overnight no longer go minutes apart', () => {
  // Both messages were held by quiet hours and woke at 09:00–09:20. The welcome goes first
  // (its touch is recorded); the review ask looks a few minutes later.
  const welcomeAt = at(24, 9, 4);
  const reviewEntered = at(24, 2, 55);
  const reviewNow = at(24, 9, 10);
  const g = runGate(gateInput({ now: reviewNow, enteredAt: reviewEntered, expireAfterMs: 18 * HOUR_MS, jitterKey: 'js_review_s1', spacing: { lastAt: welcomeAt, minGapMs: GAP } }));
  assertEqual([g.verdict, g.rule], ['defer', 'spacing'], 'the review ask waits');
  const ready = welcomeAt + GAP;
  assert(g.until! >= ready && g.until! <= ready + 20 * MINUTE_MS, `13:04–13:24, got ${iso(g.until!)}`);
  // Its 18 h limit (20:55) still holds, so it goes that afternoon rather than being dropped.
  assert(g.until! < reviewEntered + 18 * HOUR_MS, 'within its 18 h');
});

test('the owner sentence copies the gap from the fact (EN/DE); the expired case reads plainly', () => {
  const now = at(23, 12, 0);
  const i = gateInput({ now, spacing: { lastAt: now - HOUR_MS, minGapMs: GAP } });
  const decision = decisionFor(i);
  const en = explainDecision(decision, 'en', TZ);
  const de = explainDecision(decision, 'de', TZ);
  assert(en.startsWith('Held back until') && en.includes('in the last 4 hours (including from other places)'), en);
  assert(de.startsWith('Zurückgehalten bis') && de.includes('in den letzten 4 Stunden schon eine Werbenachricht'), de);
  const oneHour = explainDecision(decisionFor(gateInput({ now, spacing: { lastAt: now - 10 * MINUTE_MS, minGapMs: HOUR_MS } })), 'en', TZ);
  assert(oneHour.includes('in the last hour ('), oneHour);
  const expired = explainDecision(decisionFor(gateInput({ now, enteredAt: now - 23 * HOUR_MS, expireAfterMs: 24 * HOUR_MS, spacing: { lastAt: now - HOUR_MS, minGapMs: GAP } })), 'en', TZ);
  assert(expired.startsWith('Not sent because waiting after') && !/_/.test(expired), expired);
});

test('Replay reaches the same decision; a record from before PR F0 replays as "the engine changed since"', () => {
  const now = at(23, 12, 0);
  const i = gateInput({ now, spacing: { lastAt: now - HOUR_MS, minGapMs: GAP } });
  const snap = buildReplaySnapshot({ stage: 'gate', input: i });
  assertEqual(snap.gate?.spacing, { lastAt: now - HOUR_MS, minGapMs: GAP }, 'the input is kept');
  assert(JSON.stringify(snap).length < 1536, `snapshot size ${JSON.stringify(snap).length}`);
  const a = replayAnswer({ stored: decisionFor(i), replay: JSON.parse(JSON.stringify(snap)), sendKey: i.jitterKey, lang: 'en', tz: TZ });
  assert(a.replayable && a.same, JSON.stringify(a));
  // A record written before PR F0 (runtime 2026-09-26.a): 10 checks and no spacing input.
  const old: Partial<GateInput> = gateInput({ now });
  delete old.spacing;
  const oldSnap = JSON.parse(JSON.stringify(buildReplaySnapshot({ stage: 'gate', input: old as GateInput })));
  delete oldSnap.gate.spacing;
  const made = decisionFor(old as GateInput);
  const stored = { ...made, checks: made.checks.filter((c) => c.rule !== 'spacing'), versions: { ...made.versions, runtime: '2026-09-26.a' } };
  const b = replayAnswer({ stored, replay: oldSnap, sendKey: i.jitterKey, lang: 'en', tz: TZ });
  assert(b.replayable, 'still replayable');
  // Same outcome; the one difference is the new check ("no gap between messages is set"), and the code changed.
  assertEqual([b.same, b.engine.sameCode], [false, false], 'not the same code, not the same record');
  assertEqual(b.differences.map((d) => d.field), ['checks.spacing'], 'only the spacing check differs');
  assertEqual([b.replayed.result, b.replayed.rule, b.replayed.reason], [b.stored.result, b.stored.rule, b.stored.reason], 'the same outcome');
});

test('newestTouchAt: the newest other touch, never the send itself', () => {
  const t = (ms: number, sendKey: string) => ({ at: new Date(ms), channel: 'sms' as const, tenantUserId: 't', venueId: 'v', sendKey });
  const now = at(23, 12, 0);
  const touches = [t(now - 5 * HOUR_MS, 'js_a'), t(now - HOUR_MS, 'js_b'), t(now - 2 * HOUR_MS, 'js_c')];
  assertEqual(newestTouchAt(touches, 'js_x'), now - HOUR_MS, 'newest');
  assertEqual(newestTouchAt(touches, 'js_b'), now - 2 * HOUR_MS, 'not its own');
  assertEqual(newestTouchAt([], 'js_x'), null, 'none');
  // Firestore gives Timestamps back.
  const ts = { toMillis: () => now - 3 * HOUR_MS } as unknown as Date;
  assertEqual(newestTouchAt([{ ...t(0, 'js_d'), at: ts }], 'js_x'), now - 3 * HOUR_MS, 'a Timestamp');
});

test('the config: seeded 4 h, and an existing doc without the key reads 4 h', () => {
  assertEqual(ADAPTIVE_CONFIG_V1.marketingGapHours, 4, 'seeded');
  const { marketingGapHours: _drop, ...older } = ADAPTIVE_CONFIG_V1;
  const parsed = adaptiveConfigSchema.safeParse(older);
  assert(parsed.success && parsed.data.marketingGapHours === 4, 'default for a doc written before PR F0');
  // A bad hand edit reads 4 and leaves every other rule as it is (not the all-rules v1 fallback).
  for (const bad of [-1, 49, 'four', null]) {
    const r = adaptiveConfigSchema.safeParse({ ...ADAPTIVE_CONFIG_V1, marketingGapHours: bad, caps: { ...ADAPTIVE_CONFIG_V1.caps, globalMarketingPer7Days: 2 } });
    assert(r.success && r.data.marketingGapHours === 4 && r.data.caps.globalMarketingPer7Days === 2, `bad value ${String(bad)} → 4, the doc still reads`);
  }
  const off = adaptiveConfigSchema.safeParse({ ...ADAPTIVE_CONFIG_V1, marketingGapHours: 0 });
  assert(off.success && off.data.marketingGapHours === 0, '0 switches it off');
});

function decisionFor(i: GateInput) {
  return buildDecision({
    now: i.now,
    mode: i.mode,
    poolKey: 'review_ask',
    purpose: i.purpose,
    gate: runGate(i),
    channelChecks: [],
    channel: { picked: i.channel, rule: 'ladder' },
    variant: { picked: 'var_a', method: 'rotation:first' },
    slot: { picked: 'now', rule: 'now', plannedAt: i.intendedAt },
    credits: { price: 15, balance: 100 },
    versions: { template: 1, config: 1, playbook: 'restaurant_growth', engine: '1' },
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
