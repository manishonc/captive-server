/**
 * Tests for decision Replay (adaptive/core/runtime/replay.ts, plan §5
 * `POST /admin/decisions/replay`).
 *
 * Run: npx tsx tests/adaptiveReplay.test.ts   (from captive-server/server)
 *
 * Pure: no Firestore. Each case builds a decision the way engine/sendPath.ts does
 * (rule 1 alone, the channel pick, the full gate, a live stop after an allow, the
 * phase-1 re-check), stores it as Firestore would (JSON, shuffled key order), and
 * replays it. What these pin:
 *
 *  - **Same inputs → same decision**: a skip, a quiet-hours deferral (same
 *    `until`: the jitter comes from the send key), an allow, a channel-stage skip,
 *    a rule-1 stop, a stop at dispatch (stage `dispatch`, not a mismatch).
 *  - **One changed input → `same: false`**, with the field that moved.
 *  - **The 140-char fact cut** replays the same.
 *  - **Phase 1**: the snapshot of the re-check replays; the first look's wouldn't.
 *  - **A record without a snapshot** → `replayable: false` + the consistency check.
 *  - **Storable**: no `undefined` anywhere, ≤ 1.5 KB, no address or phone number.
 */

import { runGate, checkSystem, type GateInput } from '../src/adaptive/core/runtime/gate';
import { buildDecision, DECISION_VERSION, type DecisionRecord } from '../src/adaptive/core/runtime/decision';
import { checkChannel, pickChannel, type ChannelFacts, type ChannelRule } from '../src/adaptive/core/runtime/pickers';
import { zonedTime, HOUR_MS, MINUTE_MS } from '../src/adaptive/core/runtime/time';
import { ENGINE_RUNTIME_VERSION } from '../src/adaptive/core/runtime/version';
import type { Channel } from '../src/adaptive/core/constants';
import {
  REPLAY_MAX_BYTES,
  SYSTEM_PRECHECK_CHANNEL,
  buildReplaySnapshot,
  compareDecisions,
  noChannelFor,
  readReplaySnapshot,
  replayAnswer,
  replayDecision,
  systemGate,
  type ReplaySnapshot,
} from '../src/adaptive/core/runtime/replay';

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

const TZ = 'Europe/Zurich';
const SEND_KEY = 'js_4f2a9c1d7e6b5a4938271605f4e3d2c1';
const T0 = zonedTime(2026, 9, 22, 14, 0, TZ).getTime();
const LATE = zonedTime(2026, 9, 22, 21, 40, TZ).getTime();
const VERSIONS = { template: 3, config: 2, playbook: 'restaurant_growth', engine: '1.0.0' };

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
    jitterKey: SEND_KEY,
    system: {
      paused: false,
      lapsed: false,
      tenantActive: true,
      venueOn: true,
      journeyOn: true,
      offSinceAt: null,
      freezeWindowMs: undefined,
      staleAfterMs: 6 * HOUR_MS,
      venueSendsToday: 12,
      venueCeiling: 500,
      platformSendsToday: 340,
      platformCeiling: 10000,
      channelReady: true,
      stayCancelled: false,
      stayUnlinked: false,
    },
    address: { blocked: null, lowRatingAt: null },
    consent: { state: 'granted' },
    channelRules: { audienceOk: true, audienceFact: 'verified number (owner: verified only)', ruleFail: null },
    caps: { touches: 1, maxTouches: 5, clicks: 0, stopAfterClicks: 3 },
    diff: { lastTouch: { channel: 'email', variantId: 'var_9d8c7b6a5f4e3d2c1b0a99887766554a', slot: 'afternoon', sendKey: 'js_0a1b2c3d4e5f60718293a4b5c6d7e8f9', purpose: 'marketing', at: T0 - 2 * 24 * HOUR_MS }, variantId: 'var_1a2b3c4d5e6f708192a3b4c5d6e7f809', slot: 'now' },
    weekly: { count: 1, limit: 3 },
    quiet: { venueTz: TZ, phoneTz: null, window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
    fairUse: { count: 0, limit: 300 },
    credits: { price: 15, spendable: 100, waitStartedAt: null, queueHours: 72 },
  };
  return { ...base, ...over, system: { ...base.system, ...(over.system ?? {}) } };
}

const SLOT = (at: number) => ({ picked: 'now', rule: 'now', plannedAt: at });

/** The full gate, as sendPath builds the record (channel checks + pick + variant + credits). */
function gateDecision(i: GateInput): DecisionRecord {
  return buildDecision({
    now: i.now,
    mode: i.mode,
    poolKey: 'welcome_offer',
    purpose: i.purpose,
    gate: runGate(i),
    channelChecks: [{ channel: i.channel, ok: true, reason: null }, { channel: 'email', ok: false, reason: 'no_address' }, { channel: 'whatsapp', ok: false, reason: 'whatsapp_off' }],
    channel: { picked: i.channel, rule: 'ladder' },
    variant: { picked: i.diff.variantId, method: 'rotation:next' },
    slot: SLOT(i.intendedAt),
    credits: i.purpose === 'marketing' ? { price: i.credits.price, balance: i.credits.spendable } : null,
    versions: VERSIONS,
  });
}

/** Rule 1 alone, as sendPath's pre-check. */
function systemDecision(i: GateInput): DecisionRecord {
  const pre = checkSystem({ now: i.now, mode: i.mode, purpose: i.purpose, channel: SYSTEM_PRECHECK_CHANNEL, intendedAt: i.intendedAt, system: i.system } as GateInput);
  return buildDecision({ now: i.now, mode: i.mode, poolKey: 'welcome_offer', purpose: i.purpose, gate: systemGate(pre), channelChecks: [], channel: { picked: null, rule: 'not reached' }, variant: { picked: null, method: 'none' }, slot: SLOT(i.intendedAt), credits: null, versions: VERSIONS });
}

const FACTS: ChannelFacts[] = [
  { channel: 'sms', hasAddress: true, consent: 'none', suppressed: null, audienceOk: true, hasWording: true, ruleFail: null },
  { channel: 'email', hasAddress: false, consent: 'granted', suppressed: null, audienceOk: true, hasWording: true, ruleFail: null },
  { channel: 'whatsapp', hasAddress: true, consent: 'none', suppressed: null, audienceOk: true, hasWording: false, ruleFail: 'whatsapp_off' },
];

/** The channel stage, as sendPath builds it when nothing is usable. */
function channelStage(facts: ChannelFacts[], ladder: Channel[] = ['sms', 'email'], rule: ChannelRule = 'auto') {
  const i = gateInput();
  const checks = facts.map((f) => checkChannel(i.purpose, f));
  const pick = pickChannel({ rule, eligible: checks.filter((c) => c.ok).map((c) => c.channel), ladder, state: { counters: { touches: 1, clicks: 0, opens: 0, ladderPos: 0, consecutiveNoClick: 0 }, lastTouch: i.diff.lastTouch }, preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: null });
  assert(!pick.channel, 'fixture: no channel');
  const noChannel = noChannelFor(checks, ladder);
  const decision = buildDecision({ now: i.now, mode: i.mode, poolKey: 'welcome_offer', purpose: i.purpose, gate: null, channelChecks: checks, channel: { picked: null, rule: pick.rule }, variant: { picked: null, method: 'none' }, slot: SLOT(i.intendedAt), credits: null, versions: VERSIONS, ...(noChannel ? { noChannel } : {}) });
  const snapshot = buildReplaySnapshot({ stage: 'channel', system: i.system, channel: { facts, rule, ladder, ladderPos: 0, lastTouchChannel: 'email', preferredChannel: null, consecutiveNoClickOnPreferred: 0, lastClickChannel: null } });
  return { decision, snapshot };
}

/** What Firestore gives back: JSON values, map keys in any order. */
function shuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(shuffleKeys) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v)])) as T;
  }
  return value;
}
const stored = <T>(v: T): T => shuffleKeys(JSON.parse(JSON.stringify(v)) as T);

function replay(decision: DecisionRecord, snapshot: ReplaySnapshot | null, sendKey = SEND_KEY) {
  const snap = readReplaySnapshot(stored(snapshot));
  assert(snap, 'snapshot reads back');
  return replayDecision(stored(decision), snap, sendKey);
}

function assertSame(out: ReturnType<typeof replay>, stage: string) {
  assert(out.same, `same, got differences ${JSON.stringify(out.differences)}`);
  assert(out.differences.length === 0, 'no differences');
  assert(out.stage === stage, `stage ${stage}, got ${out.stage}`);
}

function findUndefined(value: unknown, path = '$'): string | null {
  if (value === undefined) return path;
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k += 1) {
      const hit = findUndefined(value[k], `${path}[${k}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findUndefined(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Same inputs → same decision ──────────────────────────────────────────────

console.log('\nReplay reaches the same decision');

test('a weekly-limit skip replays the same', () => {
  const i = gateInput({ weekly: { count: 3, limit: 3 } });
  const d = gateDecision(i);
  assert(d.result === 'skip' && d.rule === 'weekly_limit', `fixture: ${d.result}/${d.rule}`);
  assertSame(replay(d, buildReplaySnapshot({ stage: 'gate', input: i })), 'gate');
});

test('a quiet-hours deferral replays the same, with the same `until` (jitter from the send key)', () => {
  const i = gateInput({ now: LATE, enteredAt: LATE, intendedAt: LATE, quiet: { ...gateInput().quiet, phoneTz: 'America/New_York' } });
  const d = gateDecision(i);
  assert(d.result === 'defer' && d.rule === 'quiet_hours' && d.until !== null, `fixture: ${d.result}/${d.rule}`);
  const out = replay(d, buildReplaySnapshot({ stage: 'gate', input: i }));
  assertSame(out, 'gate');
  assert(out.replayed.until === d.until, `until ${out.replayed.until} vs ${d.until}`);
  // Another send key moves the jitter: the replay needs the real one.
  const other = replay(d, buildReplaySnapshot({ stage: 'gate', input: i }), 'js_another_send_key_000000000000000');
  assert(!other.same && other.differences.some((x) => x.field === 'until'), 'another key → another until');
});

test('an allow (live, and a test run) replays the same', () => {
  const i = gateInput();
  const d = gateDecision(i);
  assert(d.result === 'allow', `fixture: ${d.result}`);
  assertSame(replay(d, buildReplaySnapshot({ stage: 'gate', input: i })), 'gate');
  const t = gateInput({ mode: 'test', credits: { price: 15, spendable: null, waitStartedAt: null, queueHours: 72 } });
  assertSame(replay(gateDecision(t), buildReplaySnapshot({ stage: 'gate', input: t })), 'gate');
});

test('a channel-stage skip replays the same (no channel; and the owner-audience wording)', () => {
  // A blocked number and no email: no channel, not a consent reason.
  const plain = channelStage([{ ...FACTS[0], consent: 'granted', suppressed: 'hard_bounce' }, FACTS[1], FACTS[2]]);
  assert(plain.decision.reason === 'no_eligible_channel', `fixture: ${plain.decision.reason}`);
  assertSame(replay(plain.decision, plain.snapshot), 'channel');
  // The only reachable channel has no yes: consent (PR D).
  const noYes = channelStage(FACTS);
  assert(noYes.decision.reason === 'no_consent' && noYes.decision.rule === 'consent', `fixture: ${noYes.decision.reason}`);
  assertSame(replay(noYes.decision, noYes.snapshot), 'channel');
  const audience = channelStage([{ ...FACTS[0], consent: 'granted', audienceOk: false }, FACTS[1], FACTS[2]]);
  assert(audience.decision.reason === 'audience', `fixture: ${audience.decision.reason}`);
  assertSame(replay(audience.decision, audience.snapshot), 'channel');
});

test('a rule-1 stop before the channel pick (stale, paused) replays the same', () => {
  const stale = gateInput({ now: T0 + 8 * HOUR_MS });
  const d = systemDecision(stale);
  assert(d.result === 'skip' && d.reason === 'stale', `fixture: ${d.reason}`);
  assertSame(replay(d, buildReplaySnapshot({ stage: 'system', system: stale.system })), 'system');
  const paused = gateInput({ system: { ...gateInput().system, paused: true } });
  const p = systemDecision(paused);
  assert(p.result === 'defer' && p.until === T0 + 15 * MINUTE_MS, 'fixture: paused');
  assertSame(replay(p, buildReplaySnapshot({ stage: 'system', system: paused.system })), 'system');
});

test('a live stop after the gate allowed it → stage `dispatch`, not a mismatch', () => {
  const i = gateInput();
  const allow = gateDecision(i);
  const snap = buildReplaySnapshot({ stage: 'gate', input: i });
  const blocked = replay({ ...allow, result: 'block', rule: 'system', reason: 'channel_not_ready' }, snap);
  assertSame(blocked, 'dispatch');
  assert(blocked.replayed.result === 'block' && /gate allowed it/.test(blocked.note ?? ''), `note: ${blocked.note}`);
  assertSame(replay({ ...allow, result: 'skip', reason: 'no_address' }, snap), 'dispatch');
  // …but if the gate no longer allows it, that shows.
  const changed = readReplaySnapshot(stored(snap))!;
  changed.gate!.consent.state = 'revoked';
  const out = replayDecision(stored({ ...allow, result: 'block', rule: 'system', reason: 'channel_not_ready' }), changed, SEND_KEY);
  assert(out.stage === 'dispatch' && !out.same && out.differences.some((x) => x.field === 'checks.consent.ok'), JSON.stringify(out.differences));
});

// ── Differences ──────────────────────────────────────────────────────────────

console.log('\nDifferences');

test('one changed input (the weekly count) → same: false, with the fields that moved', () => {
  const i = gateInput();
  const d = gateDecision(i);
  const snap = readReplaySnapshot(stored(buildReplaySnapshot({ stage: 'gate', input: i })))!;
  snap.gate!.weekly.count = 3;
  const out = replayDecision(stored(d), snap, SEND_KEY);
  assert(!out.same, 'not the same');
  const fields = out.differences.map((x) => x.field);
  for (const f of ['result', 'rule', 'reason', 'checks.weekly_limit.ok', 'checks.weekly_limit.fact']) assert(fields.includes(f), `${f} in ${fields.join(', ')}`);
  const fact = out.differences.find((x) => x.field === 'checks.weekly_limit.fact')!;
  assert(fact.stored === '1 of 3 in the last 7 days' && fact.replayed === '3 of 3 marketing messages in the last 7 days', JSON.stringify(fact));
  assert(!fields.some((f) => f.startsWith('checks.quiet_hours')), 'untouched rules stay out');
});

test('the compare is field by field: key order and a missing check both count right', () => {
  const d = gateDecision(gateInput());
  assert(compareDecisions(d, shuffleKeys(d)).same, 'key order ignored');
  const fewer = { ...d, checks: d.checks.filter((c) => c.rule !== 'credits') };
  const out = compareDecisions(fewer, d);
  assert(!out.same && out.differences.length === 1 && out.differences[0].field === 'checks.credits' && out.differences[0].stored === null, JSON.stringify(out.differences));
});

test('a fact longer than 140 characters is cut the same way on replay', () => {
  const long = `missing_value:${'guestinfo.localTips.'.repeat(12)}`;
  const i = gateInput({ channelRules: { audienceOk: true, audienceFact: 'verified number (owner: verified only)', ruleFail: long } });
  const d = gateDecision(i);
  const fact = d.checks.find((c) => c.rule === 'channel_rules')!.fact;
  assert(long.length > 140 && fact.length === 140, `cut to 140, got ${fact.length}`);
  assertSame(replay(d, buildReplaySnapshot({ stage: 'gate', input: i })), 'gate');
});

test('phase 1: the re-check snapshot replays; the first look would falsely answer "allow"', () => {
  const first = gateInput();
  const regate: GateInput = { ...first, consent: { state: 'revoked' } }; // a STOP between the look and the claim
  const d = gateDecision(regate);
  assert(d.result === 'skip' && d.rule === 'consent', `fixture: ${d.rule}`);
  assertSame(replay(d, buildReplaySnapshot({ stage: 'gate', input: regate })), 'gate');
  const wrong = replay(d, buildReplaySnapshot({ stage: 'gate', input: first }));
  assert(!wrong.same && wrong.replayed.result === 'allow', 'the first look replays as allow');
});

// ── The admin answer ─────────────────────────────────────────────────────────

console.log('\nThe answer');

test('a record without a snapshot → replayable: false, with the consistency check', () => {
  const d = gateDecision(gateInput({ weekly: { count: 3, limit: 3 } }));
  const v1 = { ...d, v: 1, versions: VERSIONS };
  for (const raw of [undefined, null, {}, { v: 99, stage: 'gate' }]) {
    const a = replayAnswer({ stored: stored(v1), replay: raw, sendKey: SEND_KEY, lang: 'en', tz: TZ });
    assert(a.replayable === false && a.reason === 'recorded before replay inputs were kept', JSON.stringify(a));
    if (a.replayable === false) assert(a.consistency.firstFailingCheckIsRule, 'consistent record');
  }
  const off = replayAnswer({ stored: { ...v1, rule: 'credits' }, replay: null, sendKey: SEND_KEY, lang: 'en', tz: TZ });
  assert(off.replayable === false && !off.consistency.firstFailingCheckIsRule, 'rule ≠ first failing check');
});

test('a replayable answer: same, stage, engine versions, sentences in EN/DE', () => {
  const i = gateInput({ now: LATE, enteredAt: LATE, intendedAt: LATE });
  const d = gateDecision(i);
  assert(d.v === DECISION_VERSION && DECISION_VERSION === 2 && d.versions.runtime === ENGINE_RUNTIME_VERSION, 'v2 + versions.runtime');
  const a = replayAnswer({ stored: stored(d), replay: stored(buildReplaySnapshot({ stage: 'gate', input: i })), sendKey: SEND_KEY, lang: 'de', tz: TZ });
  assert(a.replayable === true && a.same && a.stage === 'gate' && a.engine.sameCode && a.engine.recorded === ENGINE_RUNTIME_VERSION, JSON.stringify(a));
  if (a.replayable) {
    assert(a.sentence.stored === a.sentence.replayed && a.sentence.stored.startsWith('Zurückgehalten bis'), a.sentence.stored);
    assert(a.stored.until === a.replayed.until && a.replayed.checks.length === 10, 'summary');
  }
  const older = replayAnswer({ stored: stored({ ...d, versions: { ...d.versions, runtime: '2026-01-01.a' } }), replay: buildReplaySnapshot({ stage: 'gate', input: i }), sendKey: SEND_KEY, lang: 'en', tz: TZ });
  assert(older.replayable && !older.engine.sameCode && older.engine.recorded === '2026-01-01.a', 'another code version');
});

// ── Storable ─────────────────────────────────────────────────────────────────

console.log('\nStorable snapshots');

// 22:30 in the venue's (long-named) zone: quiet hours there.
const LATE_AR = zonedTime(2026, 9, 22, 22, 30, 'America/Argentina/ComodRivadavia').getTime();
const WORST = gateInput({
  now: LATE_AR,
  enteredAt: LATE_AR - 3 * HOUR_MS,
  intendedAt: LATE_AR,
  expireAfterMs: 48 * HOUR_MS,
  system: { ...gateInput().system, offSinceAt: LATE_AR - 20 * MINUTE_MS, freezeWindowMs: 60 * MINUTE_MS, venueSendsToday: 499, platformSendsToday: 9999 },
  address: { blocked: null, lowRatingAt: null },
  channelRules: { audienceOk: true, audienceFact: 'unverified number (owner: everyone)', ruleFail: null },
  caps: { touches: 4, maxTouches: 5, clicks: 2, stopAfterClicks: 3 },
  weekly: { count: 2, limit: 3 },
  quiet: { venueTz: 'America/Argentina/ComodRivadavia', phoneTz: 'America/Indiana/Petersburg', window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
  fairUse: { count: 299, limit: 300 },
  credits: { price: 150, spendable: 12345, waitStartedAt: LATE_AR - 5 * HOUR_MS, queueHours: 72 },
});

test('never undefined (deep), even when an input is missing at run time', () => {
  const holes = gateInput({ quiet: { ...gateInput().quiet, phoneTz: undefined as unknown as null } });
  delete (holes.system as Partial<GateInput['system']>).stayCancelled;
  delete (holes.system as Partial<GateInput['system']>).stayUnlinked;
  const snaps = [
    buildReplaySnapshot({ stage: 'gate', input: holes }),
    buildReplaySnapshot({ stage: 'gate', input: WORST }),
    buildReplaySnapshot({ stage: 'system', system: holes.system }),
    channelStage(FACTS).snapshot,
  ];
  for (const s of snaps) {
    const hit = findUndefined(s);
    assert(hit === null, `undefined at ${hit}`);
  }
  assert(snaps[0].system.freezeWindowMs === null && snaps[0].system.stayCancelled === null && snaps[0].gate!.quiet.phoneTz === null, 'written as null');
  // …and a null reads back as "not given" (the 60-minute freeze default still applies).
  assertSame(replay(gateDecision(holes), snaps[0]), 'gate');
});

test(`≤ ${REPLAY_MAX_BYTES} bytes, and no address, name or phone number in it`, () => {
  const d = gateDecision(WORST);
  assert(d.result === 'defer' && d.rule === 'quiet_hours', `fixture: ${d.result}/${d.rule}`);
  const busy = { ...WORST, address: { blocked: 'hard_bounce', lowRatingAt: LATE_AR - HOUR_MS }, channelRules: { ...WORST.channelRules, ruleFail: 'missing_value:guestinfo.localTips' } };
  const channelFull = channelStage(FACTS.map((f) => ({ ...f, suppressed: 'spam_complaint', ruleFail: 'email_unsubscribe_not_configured' })), ['sms', 'email', 'whatsapp'], 'next_on_ladder');
  const sizes: number[] = [];
  for (const s of [buildReplaySnapshot({ stage: 'gate', input: WORST }), buildReplaySnapshot({ stage: 'gate', input: busy }), channelFull.snapshot]) {
    const json = JSON.stringify(s);
    const bytes = Buffer.byteLength(json, 'utf8');
    sizes.push(bytes);
    assert(bytes <= REPLAY_MAX_BYTES, `${bytes} bytes > ${REPLAY_MAX_BYTES}: ${json}`);
    assert(!json.includes('@'), 'no email address');
    assert(!/\+\d/.test(json), 'no phone number');
  }
  assert(JSON.stringify(d).length < 2048, 'the decision itself stays under 2 KB');
  assertSame(replay(d, buildReplaySnapshot({ stage: 'gate', input: WORST })), 'gate');
  console.log(`    (sizes: gate ${sizes[0]} B, gate with every field set ${sizes[1]} B, channel ${sizes[2]} B; decision ${JSON.stringify(d).length} B)`);
});

test('numbers stay numbers: a Timestamp or Date read back becomes ms', () => {
  const snap = JSON.parse(JSON.stringify(buildReplaySnapshot({ stage: 'gate', input: WORST })));
  snap.gate.credits.waitStartedAt = { toMillis: () => LATE_AR - 5 * HOUR_MS };
  snap.system.offSinceAt = new Date(LATE_AR - 20 * MINUTE_MS);
  const read = readReplaySnapshot(snap)!;
  assert(read.gate!.credits.waitStartedAt === LATE_AR - 5 * HOUR_MS && read.system.offSinceAt === LATE_AR - 20 * MINUTE_MS, 'converted to ms');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
