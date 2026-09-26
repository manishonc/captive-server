/**
 * Start sending and the admin launch card (PR D, decisions D-D1 and D-D5): the hold rule
 * (a venue turned on before its account went live waits for one click; unknown → held; only
 * events at or after the click start), the per-account "live since" bookkeeping across
 * multi-step launch changes (plus a seeded random check against a reference model), and the
 * typed confirmation (only loosening needs a phrase; the phrase order; how typing is compared).
 *
 * Run: npx tsx tests/adaptiveLaunchHold.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  firstOnMs,
  needsStartSending,
  sendingHeld,
  venueHasSomethingOn,
  venueMode,
  type HoldVenue,
  type LaunchModeValue,
} from '../src/adaptive/core/runtime/hold';
import {
  accountLiveSinceOf,
  applyChange,
  confirmMatches,
  effectiveMode,
  nextLiveSince,
  summarizeChange,
  type LaunchChange,
  type LaunchState,
  type Mode,
  type SafetyLimits,
} from '../src/adaptive/core/runtime/launch';

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

const HOUR = 3_600_000;
/** The account's go-live date (real time): Thu 1 Oct 2026, 08:00 UTC. */
const L = Date.UTC(2026, 9, 1, 8, 0, 0);
/** A guest event at the venue (engine clock), five days later. */
const AT = L + 120 * HOUR;
const MODES: Mode[] = ['off', 'test', 'live'];

// ── The hold: what counts as "on" and "turned on at" ─────────────────────────

test('something is on: a playbook on or paused, or Guest info enabled', () => {
  assertEqual(venueHasSomethingOn({ status: 'on' }), true, 'on');
  assertEqual(venueHasSomethingOn({ status: 'paused' }), true, 'paused');
  assertEqual(venueHasSomethingOn({ status: 'off', utility: { enabled: true } }), true, 'Guest info only');
  assertEqual(venueHasSomethingOn({ status: null, utility: { enabled: true } }), true, 'Guest info, no status');
  for (const status of ['off', 'draft', 'archived', 'ON', '', null, undefined]) {
    assertEqual(venueHasSomethingOn({ status }), false, `status ${JSON.stringify(status)}`);
    assertEqual(venueHasSomethingOn({ status, utility: { enabled: false, enabledAt: L - HOUR } }), false, `status ${JSON.stringify(status)}, Guest info off`);
    assertEqual(venueHasSomethingOn({ status, utility: { enabled: null } }), false, `status ${JSON.stringify(status)}, Guest info null`);
    assertEqual(venueHasSomethingOn({ status, utility: null }), false, `status ${JSON.stringify(status)}, no utility`);
  }
  assertEqual(venueHasSomethingOn({}), false, 'empty doc');
});

test('firstOnAt wins over the older stamps, even when it is later', () => {
  assertEqual(firstOnMs({ firstOnAt: L, activatedAt: L - 5 * HOUR, utility: { enabledAt: L - 9 * HOUR } }), L, 'firstOnAt later than both');
  assertEqual(firstOnMs({ firstOnAt: L, activatedAt: L + HOUR, utility: { enabledAt: L + 2 * HOUR } }), L, 'firstOnAt earlier than both');
  assertEqual(firstOnMs({ firstOnAt: 0, activatedAt: L }), 0, 'epoch 0 is a real firstOnAt');
});

test('without firstOnAt: the earliest of activatedAt and Guest info enabledAt, ignoring nulls', () => {
  assertEqual(firstOnMs({ firstOnAt: null, activatedAt: L + 1, utility: { enabledAt: L } }), L, 'enabledAt earlier by 1 ms');
  assertEqual(firstOnMs({ firstOnAt: null, activatedAt: L, utility: { enabledAt: L + 1 } }), L, 'activatedAt earlier by 1 ms');
  assertEqual(firstOnMs({ activatedAt: L, utility: { enabledAt: L } }), L, 'equal stamps');
  assertEqual(firstOnMs({ activatedAt: L, utility: { enabledAt: null } }), L, 'only activatedAt');
  assertEqual(firstOnMs({ activatedAt: L, utility: null }), L, 'only activatedAt, no utility');
  assertEqual(firstOnMs({ activatedAt: null, utility: { enabledAt: L } }), L, 'only enabledAt');
  assertEqual(firstOnMs({ utility: { enabled: true, enabledAt: L - 1 } }), L - 1, 'only enabledAt, activatedAt missing');
  assertEqual(firstOnMs({ activatedAt: 0, utility: { enabledAt: L } }), 0, 'epoch 0 activatedAt counts');
});

test('no stamp at all: firstOnMs is null, and the venue is held (fail closed)', () => {
  assertEqual(firstOnMs({}), null, 'empty doc');
  assertEqual(firstOnMs({ firstOnAt: null, activatedAt: null, utility: { enabledAt: null } }), null, 'all null');
  assertEqual(firstOnMs({ firstOnAt: undefined, activatedAt: undefined, utility: null }), null, 'all undefined');
  const v: HoldVenue = { status: 'on', firstOnAt: null, activatedAt: null, utility: { enabled: false, enabledAt: null } };
  assertEqual(needsStartSending('live', L, v), true, 'needs Start sending');
  assertEqual(sendingHeld('live', L, v, AT), true, 'held');
  assertEqual(venueMode('live', L, v, AT), 'off', 'acts like off');
});

// ── The hold matrix ──────────────────────────────────────────────────────────

type StatusCase = 'on' | 'paused' | 'off' | 'utility-only';
type FirstOnCase = 'unknown' | 'earlier' | 'equal' | 'later';
type ClickCase = 'none' | 'before' | 'equal' | 'after';

const STATUS_CASES: StatusCase[] = ['on', 'paused', 'off', 'utility-only'];
const FIRST_ON_CASES: FirstOnCase[] = ['unknown', 'earlier', 'equal', 'later'];
const CLICK_CASES: ClickCase[] = ['none', 'before', 'equal', 'after'];

function matrixVenue(status: StatusCase, firstOn: FirstOnCase, click: ClickCase): HoldVenue {
  const firstOnAt = { unknown: null, earlier: L - 1, equal: L, later: L + 1 }[firstOn];
  const sendingConfirmedAt = { none: null, before: AT - 1, equal: AT, after: AT + 1 }[click];
  return {
    status: status === 'utility-only' ? 'off' : status,
    utility: { enabled: status === 'utility-only', enabledAt: null },
    firstOnAt,
    activatedAt: null,
    sendingConfirmedAt,
  };
}

test('hold matrix: mode × venue status × firstOnAt vs liveSince × liveSince known/unknown × click vs event time', () => {
  const wrong: string[] = [];
  let held = 0;
  let combos = 0;
  for (const mode of MODES) {
    for (const status of STATUS_CASES) {
      for (const firstOn of FIRST_ON_CASES) {
        for (const liveSince of [L, null]) {
          for (const click of CLICK_CASES) {
            combos += 1;
            const v = matrixVenue(status, firstOn, click);
            // D-D1 written out from the labels: live, something on, turned on before live (or
            // either date unknown), and no click at or before the event.
            const somethingOn = status !== 'off';
            const turnedOnBeforeLive = liveSince === null || firstOn === 'unknown' || firstOn === 'earlier';
            const needs = mode === 'live' && somethingOn && turnedOnBeforeLive;
            const expectHeld = needs && (click === 'none' || click === 'after');
            const label = `${mode}/${status}/firstOn ${firstOn}/liveSince ${liveSince === null ? 'null' : 'L'}/click ${click}`;
            if (needsStartSending(mode, liveSince, v) !== needs) wrong.push(`${label}: needsStartSending`);
            if (sendingHeld(mode, liveSince, v, AT) !== expectHeld) wrong.push(`${label}: sendingHeld`);
            if (venueMode(mode, liveSince, v, AT) !== (expectHeld ? 'off' : mode)) wrong.push(`${label}: venueMode`);
            if (expectHeld) held += 1;
          }
        }
      }
    }
  }
  assertEqual(combos, 384, 'combinations');
  assert(wrong.length === 0, `${wrong.length} wrong, first: ${wrong.slice(0, 5).join('; ')}`);
  // live only × 3 "on" statuses × 6 firstOn/liveSince pairs that need the click × 2 click cases.
  assertEqual(held, 36, 'held combinations');
});

test('venueMode returns off only while held; otherwise the account mode', () => {
  const held: HoldVenue = { status: 'on', firstOnAt: L - 1 };
  const free: HoldVenue = { status: 'on', firstOnAt: L + 1 };
  assertEqual(venueMode('live', L, held, AT), 'off', 'held live venue');
  assertEqual(venueMode('live', L, free, AT), 'live', 'venue turned on after live');
  assertEqual(venueMode('test', L, held, AT), 'test', 'test account: never held, stays test');
  assertEqual(venueMode('off', L, free, AT), 'off', 'off account stays off');
  assertEqual(venueMode('live', L, { status: 'off', firstOnAt: L - 1 }, AT), 'live', 'nothing on: not held (nothing runs anyway)');
  assert(venueMode('live', L, held, AT) !== 'test', 'a held live venue is off, never a test run');
});

test('a held venue acts like launch off for new guests, Guest info included', () => {
  const guestInfoOnly: HoldVenue = { status: 'off', utility: { enabled: true, enabledAt: L - HOUR }, firstOnAt: L - HOUR };
  assertEqual(needsStartSending('live', L, guestInfoOnly), true, 'Guest info only needs the click');
  assertEqual(venueMode('live', L, guestInfoOnly, AT), 'off', 'Guest info only is off');
  const pausedPlaybook: HoldVenue = { status: 'paused', firstOnAt: L - HOUR };
  assertEqual(venueMode('live', L, pausedPlaybook, AT), 'off', 'a paused playbook counts as on');
});

test('turned on vs went live, at the exact millisecond', () => {
  const at = (firstOnAt: number) => needsStartSending('live', L, { status: 'on', firstOnAt });
  assertEqual(at(L - 1), true, '1 ms before live: waits');
  assertEqual(at(L), false, 'same ms as live: does not wait');
  assertEqual(at(L + 1), false, '1 ms after live: does not wait');
});

test('a venue turned on after its account went live never waits', () => {
  const v: HoldVenue = { status: 'on', firstOnAt: L + HOUR, sendingConfirmedAt: null };
  assertEqual(needsStartSending('live', L, v), false, 'no Start sending');
  for (const atMs of [0, L - HOUR, L, L + HOUR - 1, L + HOUR, AT, AT + 365 * 24 * HOUR]) {
    assertEqual(sendingHeld('live', L, v, atMs), false, `not held at ${atMs}`);
    assertEqual(venueMode('live', L, v, atMs), 'live', `live at ${atMs}`);
  }
});

test('unknown on either side holds (fail closed)', () => {
  assertEqual(sendingHeld('live', null, { status: 'on', firstOnAt: L + HOUR }, AT), true, 'account date unknown, venue on after');
  assertEqual(sendingHeld('live', L, { status: 'on' }, AT), true, 'venue date unknown');
  assertEqual(sendingHeld('live', null, { status: 'on' }, AT), true, 'both unknown');
  assertEqual(sendingHeld('live', null, { status: 'off', utility: { enabled: true } }, AT), true, 'both unknown, Guest info only');
  assertEqual(sendingHeld('live', null, { status: 'off' }, AT), false, 'nothing on: nothing to hold');
});

test('epoch 0 is a known time, not "unknown"', () => {
  assertEqual(needsStartSending('live', 0, { status: 'on', firstOnAt: 1 }), false, 'live since epoch 0, turned on at 1 ms');
  assertEqual(needsStartSending('live', 0, { status: 'on', firstOnAt: 0 }), false, 'both epoch 0');
  assertEqual(needsStartSending('live', 1, { status: 'on', firstOnAt: 0 }), true, 'turned on at epoch 0, live at 1 ms');
  assertEqual(sendingHeld('live', L, { status: 'on', firstOnAt: L - 1, sendingConfirmedAt: 0 }, 0), false, 'click at engine epoch 0 lifts an event at 0');
});

test('a routine save does not lift the hold: firstOnAt holds even when the moving stamps are after live', () => {
  const v: HoldVenue = { status: 'on', firstOnAt: L - HOUR, activatedAt: L + HOUR, utility: { enabled: true, enabledAt: L + 2 * HOUR } };
  assertEqual(firstOnMs(v), L - HOUR, 'firstOnAt');
  assertEqual(sendingHeld('live', L, v, AT), true, 'still held');
});

test('an older doc without firstOnAt: the earliest stamp decides', () => {
  const v = (activatedAt: number | null, enabledAt: number | null): HoldVenue => ({ status: 'on', firstOnAt: null, activatedAt, utility: { enabled: true, enabledAt } });
  assertEqual(needsStartSending('live', L, v(L + HOUR, L - 1)), true, 'Guest info on 1 ms before live, playbook after');
  assertEqual(needsStartSending('live', L, v(L - 1, L + HOUR)), true, 'playbook on 1 ms before live, Guest info after');
  assertEqual(needsStartSending('live', L, v(L, L + HOUR)), false, 'earliest stamp is the live ms');
  assertEqual(needsStartSending('live', L, v(null, L + 1)), false, 'only a stamp after live');
  assertEqual(needsStartSending('live', L, v(null, null)), true, 'no stamps');
});

test('the click lifts the hold for events at or after its own millisecond', () => {
  const C = AT;
  const v: HoldVenue = { status: 'on', firstOnAt: L - HOUR, sendingConfirmedAt: C };
  assertEqual(sendingHeld('live', L, v, C - 1), true, '1 ms before the click: held (no backfill)');
  assertEqual(sendingHeld('live', L, v, C), false, 'at the click: starts');
  assertEqual(sendingHeld('live', L, v, C + 1), false, '1 ms after the click: starts');
  assertEqual(venueMode('live', L, v, C - 1), 'off', 'mode before the click');
  assertEqual(venueMode('live', L, v, C), 'live', 'mode at the click');
  assertEqual(needsStartSending('live', L, v), true, 'needsStartSending ignores the click (it says whether the venue needed it)');
});

test('the click only counts while live: test and off accounts ignore it', () => {
  const before: HoldVenue = { status: 'on', firstOnAt: L - HOUR, sendingConfirmedAt: null };
  const clicked: HoldVenue = { ...before, sendingConfirmedAt: AT };
  for (const mode of ['off', 'test'] as LaunchModeValue[]) {
    assertEqual(needsStartSending(mode, L, before), false, `${mode}: no Start sending`);
    for (const v of [before, clicked]) {
      for (const atMs of [AT - 1, AT, AT + 1]) {
        assertEqual(sendingHeld(mode, L, v, atMs), false, `${mode}: never held`);
        assertEqual(venueMode(mode, L, v, atMs), mode, `${mode}: the account mode`);
      }
    }
  }
});

// ── Launch state helpers ─────────────────────────────────────────────────────

const SAFETY: SafetyLimits = { maxSendsPerVenuePerDay: 200, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 };

function state(over: Partial<LaunchState> = {}): LaunchState {
  return {
    default: 'off',
    accounts: {},
    liveSince: { default: null, accounts: {} },
    paused: false,
    safety: { ...SAFETY },
    smsCountries: ['CH', 'DE'],
    alertsEmail: 'ops@heidifi.test',
    ...over,
  };
}

/** One admin save: the new modes, then the new dates at real time `now` (the service's order). */
function step(s: LaunchState, c: LaunchChange, now: number): LaunchState {
  const after = applyChange(s, c);
  return { ...after, liveSince: nextLiveSince(s, after, now) };
}

const since = (s: LaunchState, t: string) => accountLiveSinceOf(s, t);
const T1 = L + HOUR;
const T2 = L + 2 * HOUR;
const T3 = L + 3 * HOUR;
const T4 = L + 4 * HOUR;
const T5 = L + 5 * HOUR;

// ── effectiveMode, accountLiveSinceOf, applyChange ───────────────────────────

test('effectiveMode: an override wins; everyone else follows the default', () => {
  const s = state({ default: 'test', accounts: { u_a: 'live', u_b: 'off' } });
  assertEqual(effectiveMode(s, 'u_a'), 'live', 'override live');
  assertEqual(effectiveMode(s, 'u_b'), 'off', 'override off');
  assertEqual(effectiveMode(s, 'u_new'), 'test', 'no override');
  for (const t of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) assertEqual(effectiveMode(s, t), 'test', `inherited key ${t} follows the default`);
});

test('accountLiveSinceOf: an own entry wins, even null (unreadable = unknown)', () => {
  const s = state({ liveSince: { default: T1, accounts: { u_a: T2, u_b: null } } });
  assertEqual(since(s, 'u_a'), T2, 'own date');
  assertEqual(since(s, 'u_b'), null, 'own null entry is unknown, not the default');
  assertEqual(since(s, 'u_c'), T1, 'no entry: the default date');
  for (const t of ['constructor', 'toString', '__proto__']) assertEqual(since(s, t), T1, `inherited key ${t} uses the default date`);
  assertEqual(since(state(), 'u_a'), null, 'nothing known');
  assertEqual(since(state({ liveSince: { default: 0, accounts: {} } }), 'u_a'), 0, 'epoch 0 default is kept');
});

test('applyChange: null removes an override, a mode sets one, absent fields stay', () => {
  const before = state({ default: 'test', accounts: { u_a: 'live', u_b: 'off' }, paused: true });
  const snapshot = JSON.stringify(before);
  const after = applyChange(before, { accounts: { u_a: null, u_c: 'test', u_zz: null } });
  assertEqual(after.accounts, { u_b: 'off', u_c: 'test' }, 'accounts');
  assertEqual([after.default, after.paused, after.alertsEmail], ['test', true, 'ops@heidifi.test'], 'untouched fields');
  assertEqual(after.smsCountries, ['CH', 'DE'], 'countries');
  assertEqual(after.liveSince, before.liveSince, 'liveSince carried as is (nextLiveSince moves it)');
  assertEqual(JSON.stringify(before), snapshot, 'the before state is not changed');
});

test('applyChange: false, null and [] are values, not "unchanged"; safety merges', () => {
  const before = state({ paused: true, alertsEmail: 'ops@heidifi.test' });
  const after = applyChange(before, { paused: false, alertsEmail: null, smsCountries: [], safety: { staleAfterHours: 12 } });
  assertEqual(after.paused, false, 'paused false');
  assertEqual(after.alertsEmail, null, 'alert email cleared');
  assertEqual(after.smsCountries, [], 'no countries');
  assertEqual(after.safety, { ...SAFETY, staleAfterHours: 12 }, 'one limit changed, the rest kept');
  assertEqual(applyChange(before, { alertsEmail: undefined }).alertsEmail, 'ops@heidifi.test', 'undefined keeps the address');
});

// ── nextLiveSince as multi-step sequences ────────────────────────────────────

test('an account override going live pins its own date', () => {
  const s1 = step(state({ default: 'test' }), { accounts: { u_a: 'live' } }, T1);
  assertEqual(s1.liveSince, { default: null, accounts: { u_a: T1 } }, 'dates after u_a goes live');
  assertEqual(since(s1, 'u_a'), T1, 'u_a live since T1');
  const s2 = step(s1, { default: 'live' }, T2);
  assertEqual([since(s2, 'u_a'), since(s2, 'u_b'), s2.liveSince.default], [T1, T2, T2], 'default live: u_a keeps T1, followers get T2');
  const s3 = step(s2, { default: 'test' }, T3);
  assertEqual(s3.liveSince, s2.liveSince, 'the default leaving live writes nothing');
  const s4 = step(s3, { default: 'live' }, T4);
  assertEqual([since(s4, 'u_a'), since(s4, 'u_b')], [T1, T4], 'default back: u_a still T1, followers T4');
});

test('removing an override while the default is live keeps the date the account has been live since', () => {
  const s1 = step(state({ default: 'test' }), { accounts: { u_a: 'live' } }, T1);
  const s2 = step(s1, { default: 'live' }, T2);
  const s3 = step(s2, { accounts: { u_a: null } }, T3);
  assertEqual(effectiveMode(s3, 'u_a'), 'live', 'still live');
  assertEqual(since(s3, 'u_a'), T1, 'keeps T1 (not the default T2, not now T3)');
});

test('an account live through the default keeps the default date across an override on and off', () => {
  const s1 = step(state(), { default: 'live' }, T1);
  const s2 = step(s1, { accounts: { u_a: 'live' } }, T2);
  assertEqual(s2.liveSince, s1.liveSince, 'override live on a live account writes nothing');
  assertEqual(since(s2, 'u_a'), T1, 'u_a T1');
  const s3 = step(s2, { accounts: { u_a: null } }, T3);
  assertEqual(s3.liveSince, s1.liveSince, 'removing it writes nothing');
  assertEqual(since(s3, 'u_a'), T1, 'u_a still T1');
});

test('removing a test override while the default is live moves the account into live now', () => {
  const s1 = step(state({ accounts: { u_a: 'test' } }), { default: 'live' }, T1);
  assertEqual(effectiveMode(s1, 'u_a'), 'test', 'u_a in a test run');
  const s2 = step(s1, { accounts: { u_a: null } }, T2);
  assertEqual([since(s2, 'u_a'), since(s2, 'u_b')], [T2, T1], 'u_a now T2; followers keep T1');
});

test('live → off → live gets a new date (account and default)', () => {
  const a1 = step(state({ default: 'test' }), { accounts: { u_a: 'live' } }, T1);
  const a2 = step(a1, { accounts: { u_a: 'off' } }, T2);
  assertEqual(a2.liveSince, a1.liveSince, 'going off writes nothing');
  const a3 = step(a2, { accounts: { u_a: 'live' } }, T3);
  assertEqual(since(a3, 'u_a'), T3, 'account back live: T3');

  const d1 = step(state(), { default: 'live' }, T1);
  const d2 = step(d1, { default: 'off' }, T2);
  const d3 = step(d2, { default: 'live' }, T3);
  assertEqual([d3.liveSince.default, since(d3, 'u_b')], [T3, T3], 'default back live: T3');

  // With the hold: a venue turned on during the off gap waits; so does one turned on in the
  // first live period (it never needed the click then); a venue confirmed then stays confirmed.
  const ls = since(d3, 'u_b');
  assertEqual(needsStartSending('live', ls, { status: 'on', firstOnAt: T2 + 1 }), true, 'turned on during the off gap');
  assertEqual(sendingHeld('live', ls, { status: 'on', firstOnAt: T1 + 1 }, T4), true, 'turned on in the first live period, never clicked');
  assertEqual(sendingHeld('live', ls, { status: 'on', firstOnAt: L - HOUR, sendingConfirmedAt: T1 + 2 }, T4), false, 'clicked in the first live period: stays confirmed');
});

test('the default going live gives followers the new date and deletes stale dates of accounts that were not live', () => {
  const s1 = step(state({ default: 'test' }), { accounts: { u_a: 'live', u_b: 'live', u_c: 'live' } }, T1);
  const s2 = step(s1, { accounts: { u_a: null, u_b: 'off', u_c: 'test' } }, T2);
  for (const t of ['u_a', 'u_b', 'u_c']) assert(effectiveMode(s2, t) !== 'live', `${t} not live`);
  const s3 = step(s2, { default: 'live' }, T3);
  assertEqual(s3.liveSince.default, T3, 'default date');
  assert(!('u_a' in s3.liveSince.accounts), 'u_a follows the default again: its stale T1 is deleted');
  assertEqual([since(s3, 'u_a'), since(s3, 'u_new')], [T3, T3], 'followers T3');
  assertEqual([effectiveMode(s3, 'u_b'), effectiveMode(s3, 'u_c')], ['off', 'test'], 'overrides unchanged');
  const s4 = step(s3, { accounts: { u_b: null, u_c: 'live' } }, T4);
  assertEqual([since(s4, 'u_b'), since(s4, 'u_c')], [T4, T4], 'later moves into live get their own now, never the stale T1');
  assertEqual(since(s4, 'u_a'), T3, 'u_a unchanged');
});

test('an override removed as the default goes live: the stale date goes too', () => {
  const s0 = state({ default: 'test', accounts: { u_a: 'off' }, liveSince: { default: null, accounts: { u_a: L } } });
  const s1 = step(s0, { default: 'live', accounts: { u_a: null } }, T1);
  assert(!('u_a' in s1.liveSince.accounts), 'stale entry deleted');
  assertEqual(since(s1, 'u_a'), T1, 'u_a T1');
});

test('an account staying live through its override keeps its date when the default goes live', () => {
  const s1 = step(state(), { default: 'live' }, T1);
  const s2 = step(s1, { accounts: { u_a: 'live' } }, T2);
  const s3 = step(s2, { default: 'test' }, T3);
  assertEqual(since(s3, 'u_a'), T1, 'u_a still T1 while the default is out');
  const s4 = step(s3, { default: 'live' }, T4);
  assertEqual(s4.liveSince.accounts.u_a, T1, 'pinned before the default moved');
  assertEqual([since(s4, 'u_a'), since(s4, 'u_b'), s4.liveSince.default], [T1, T4, T4], 'u_a T1, followers T4');
  // Same, but the override is removed in the very change that brings the default back.
  const s4b = step(s3, { default: 'live', accounts: { u_a: null } }, T4);
  assertEqual(effectiveMode(s4b, 'u_a'), 'live', 'u_a stayed live');
  assertEqual(since(s4b, 'u_a'), T1, 'u_a keeps T1 though it follows the default again');
  // And a venue u_a turned on between T1 and T4 is not held again.
  assertEqual(needsStartSending('live', since(s4, 'u_a'), { status: 'on', firstOnAt: T2 }), false, 'no surprise hold');
});

test('an override going live together with the default gets now', () => {
  const s1 = step(state({ default: 'test', accounts: { u_a: 'test' } }), { default: 'live', accounts: { u_a: 'live' } }, T1);
  assertEqual(s1.liveSince, { default: T1, accounts: { u_a: T1 } }, 'both T1');
  const stale = state({ default: 'test', accounts: { u_a: 'off' }, liveSince: { default: L - 9 * HOUR, accounts: { u_a: L - 5 * HOUR } } });
  const s2 = step(stale, { default: 'live', accounts: { u_a: 'live' } }, T2);
  assertEqual([since(s2, 'u_a'), s2.liveSince.default], [T2, T2], 'a stale own date is replaced by now');
});

test('unknown before-date → now, when the account stays live and the default moves', () => {
  // A hand-edited launch doc: u_a live through its override, no dates at all.
  const s0 = state({ default: 'test', accounts: { u_a: 'live' } });
  assertEqual(since(s0, 'u_a'), null, 'unknown');
  const s1 = step(s0, { default: 'live' }, T1);
  assertEqual([s1.liveSince.accounts.u_a, since(s1, 'u_a')], [T1, T1], 'pinned to now');
  // The default was live with no date; it leaves and comes back.
  const d0 = state({ default: 'live', accounts: { u_a: 'live' } });
  const d1 = step(d0, { default: 'test' }, T1);
  assertEqual(since(d1, 'u_a'), null, 'while nothing moves, unknown stays unknown (held, fail closed)');
  const d2 = step(d1, { default: 'live' }, T2);
  assertEqual([since(d2, 'u_a'), since(d2, 'u_b')], [T2, T2], 'default back: both T2');
  // Epoch 0 is a known date, not unknown.
  const z0 = state({ default: 'live', accounts: { u_a: 'live' }, liveSince: { default: 0, accounts: {} } });
  const z2 = step(step(z0, { default: 'test' }, T1), { default: 'live' }, T2);
  assertEqual(since(z2, 'u_a'), 0, 'u_a keeps epoch 0');
});

test('moves out of live, test/off moves, pause, limits and no-ops write no dates', () => {
  const base = step(step(state({ default: 'test' }), { accounts: { u_a: 'live' } }, T1), { default: 'live', accounts: { u_b: 'test' } }, T2);
  const snapshot = JSON.stringify(base);
  const changes: LaunchChange[] = [
    {},
    { default: 'test' },
    { default: 'off' },
    { accounts: { u_a: 'off' } },
    { accounts: { u_a: 'test', u_b: 'off' } },
    { accounts: { u_b: 'off' } },
    { accounts: { u_a: 'live' } },
    { paused: true },
    { safety: { maxSendsPerVenuePerDay: 999 } },
    { smsCountries: ['FR'], alertsEmail: null },
  ];
  for (const c of changes) assertEqual(step(base, c, T5).liveSince, base.liveSince, `no date change for ${JSON.stringify(c)}`);
  const offToTest = step(state(), { default: 'test' }, T1);
  assertEqual(offToTest.liveSince, { default: null, accounts: {} }, 'off → test writes nothing');
  assertEqual(JSON.stringify(base), snapshot, 'the before state is not changed');
});

// ── Seeded random check against a reference model ────────────────────────────

test('seeded random changes: an account is live since its last move into live', () => {
  let seed = 20260925;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  let compared = 0;
  let phrases = 0;
  const wrong: string[] = [];
  for (let run = 0; run < 500 && wrong.length === 0; run += 1) {
    const tenants = rnd() < 0.5 ? ['u_a', 'u_b'] : ['u_a', 'u_b', 'u_c'];
    const everyone = [...tenants, 'u_quiet']; // u_quiet never gets an override
    let s = state({ default: pick<Mode>(['off', 'test']) });
    // The reference model: its own modes, and "the time of the last move into live, while still live".
    let mDefault: Mode = s.default;
    const mOver = new Map<string, Mode>();
    const mSince = new Map<string, number>();
    const modeOf = (t: string): Mode => mOver.get(t) ?? mDefault;
    let now = L;
    const log: string[] = [];
    const steps = 2 + Math.floor(rnd() * 11);
    for (let i = 0; i < steps && wrong.length === 0; i += 1) {
      now += 1 + Math.floor(rnd() * 1000);
      const change: LaunchChange = {};
      if (rnd() < 0.4) change.default = pick(MODES);
      const acc: Record<string, Mode | null> = {};
      for (const t of tenants) if (rnd() < 0.35) acc[t] = pick<Mode | null>([...MODES, null]);
      if (Object.keys(acc).length) change.accounts = acc;
      log.push(`${JSON.stringify(change)}@+${now - L}`);

      const was = new Map(everyone.map((t) => [t, modeOf(t)]));
      const wasOver = JSON.stringify([...mOver.entries()].sort());
      const wasDefault = mDefault;
      if (change.default) mDefault = change.default;
      for (const [t, m] of Object.entries(change.accounts ?? {})) {
        if (m === null) mOver.delete(t);
        else mOver.set(t, m);
      }
      for (const t of everyone) {
        if (modeOf(t) !== 'live') mSince.delete(t);
        else if (was.get(t) !== 'live') mSince.set(t, now);
      }

      const before = s;
      const after = applyChange(before, change);
      s = { ...after, liveSince: nextLiveSince(before, after, now) };
      const where = `run ${run} step ${i} [${log.join(' ')}]`;

      for (const t of everyone) {
        if (effectiveMode(s, t) !== modeOf(t)) wrong.push(`${where} ${t}: mode ${effectiveMode(s, t)} vs model ${modeOf(t)}`);
        if (modeOf(t) !== 'live') continue;
        compared += 1;
        const got = since(s, t);
        if (got !== mSince.get(t)) wrong.push(`${where} ${t}: live since ${got} vs model ${mSince.get(t)}`);
      }

      const summary = summarizeChange(before, after);
      const someoneWentLive = everyone.some((t) => was.get(t) !== 'live' && modeOf(t) === 'live');
      if ((summary.confirmPhrase !== null) !== someoneWentLive) wrong.push(`${where}: phrase ${summary.confirmPhrase} but someone went live = ${someoneWentLive}`);
      if (summary.confirmPhrase !== null) phrases += 1;
      const modesMoved = wasDefault !== mDefault || wasOver !== JSON.stringify([...mOver.entries()].sort());
      if (summary.empty === modesMoved) wrong.push(`${where}: empty ${summary.empty} but modes moved = ${modesMoved}`);
    }
  }
  assert(wrong.length === 0, wrong[0]);
  assert(compared > 1000, `enough live comparisons (${compared})`);
  assert(phrases > 100, `enough go-live changes (${phrases})`);
});

// ── summarizeChange: what needs a typed phrase ───────────────────────────────

const sum = (before: LaunchState, c: LaunchChange) => summarizeChange(before, applyChange(before, c));

test('each loosening kind on its own', () => {
  const d = sum(state({ default: 'test' }), { default: 'live' });
  assertEqual([d.lines, d.loosening, d.confirmPhrase, d.empty], [['Default: test run → live'], ['default_live'], 'LIVE FOR EVERYONE', false], 'default live');
  assertEqual(sum(state(), { default: 'live' }).lines, ['Default: off → live'], 'off → live line');
  const a = sum(state({ default: 'test' }), { accounts: { u_a: 'live' } });
  assertEqual([a.lines, a.loosening, a.confirmPhrase], [['u_a: default (test run) → live'], ['account_live'], 'GO LIVE'], 'account live');
  const p = sum(state({ paused: true }), { paused: false });
  assertEqual([p.lines, p.loosening, p.confirmPhrase], [['Release the pause (live accounts send again)'], ['release_pause'], 'RELEASE PAUSE'], 'release pause');
  const l = sum(state(), { safety: { maxSendsPerVenuePerDay: 201 } });
  assertEqual([l.lines, l.loosening, l.confirmPhrase], [['maxSendsPerVenuePerDay: 200 → 201'], ['loosen_limits'], 'LOOSEN LIMITS'], 'a limit raised by 1');
  for (const k of Object.keys(SAFETY) as Array<keyof SafetyLimits>) {
    assertEqual(sum(state(), { safety: { [k]: SAFETY[k] + 1 } }).confirmPhrase, 'LOOSEN LIMITS', `${k} raised`);
  }
  const c = sum(state(), { smsCountries: ['CH', 'DE', 'FR', 'IT'] });
  assertEqual([c.lines, c.loosening, c.confirmPhrase], [['SMS countries added: FR, IT'], ['loosen_limits'], 'LOOSEN LIMITS'], 'countries added');
});

test('each kind is named once, however many changes cause it', () => {
  const s = sum(state({ default: 'test' }), { accounts: { u_a: 'live', u_b: 'live' }, safety: { maxSendsPlatformPerDay: 6000, staleAfterHours: 8 }, smsCountries: ['CH', 'DE', 'FR'] });
  assertEqual(s.loosening, ['account_live', 'loosen_limits'], 'kinds');
  assertEqual(s.confirmPhrase, 'GO LIVE AND LOOSEN LIMITS', 'phrase');
});

test('the joined phrase keeps the fixed order, lines keep theirs', () => {
  const before = state({ default: 'test', accounts: { u_b: 'off' }, paused: true, smsCountries: ['CH'] });
  const s = sum(before, {
    default: 'live',
    accounts: { u_b: 'live', u_a: 'test' },
    paused: false,
    safety: { staleAfterHours: 4, maxSendsPlatformPerDay: 6000 },
    smsCountries: ['CH', 'FR'],
    alertsEmail: null,
  });
  assertEqual(s.loosening, ['default_live', 'account_live', 'release_pause', 'loosen_limits'], 'kinds');
  assertEqual(s.confirmPhrase, 'LIVE FOR EVERYONE AND GO LIVE AND RELEASE PAUSE AND LOOSEN LIMITS', 'phrase');
  assertEqual(
    s.lines,
    [
      'Default: test run → live',
      'u_a: default (test run) → test run',
      'u_b: off → live',
      'Release the pause (live accounts send again)',
      'maxSendsPlatformPerDay: 5000 → 6000',
      'staleAfterHours: 6 → 4',
      'SMS countries added: FR',
      'Alert email: ops@heidifi.test → (none)',
    ],
    'lines',
  );
  assertEqual(sum(state({ paused: true }), { paused: false, safety: { maxNewContactsPerApPerHour: 61 } }).confirmPhrase, 'RELEASE PAUSE AND LOOSEN LIMITS', 'pause + limits');
  assertEqual(sum(state({ default: 'test', paused: true }), { default: 'live', paused: false }).confirmPhrase, 'LIVE FOR EVERYONE AND RELEASE PAUSE', 'default + pause');
});

test('an override removed as the default goes live counts as the default going live', () => {
  const s = sum(state({ default: 'test', accounts: { u_a: 'test' } }), { default: 'live', accounts: { u_a: null } });
  assertEqual(s.lines, ['Default: test run → live', 'u_a: test run → default (live)'], 'lines');
  assertEqual([s.loosening, s.confirmPhrase], [['default_live'], 'LIVE FOR EVERYONE'], 'one phrase, not GO LIVE too');
});

test('an override removed onto an already-live default is an account going live', () => {
  const s = sum(state({ default: 'live', accounts: { u_a: 'test' } }), { accounts: { u_a: null } });
  assertEqual(s.lines, ['u_a: test run → default (live)'], 'line');
  assertEqual([s.loosening, s.confirmPhrase], [['account_live'], 'GO LIVE'], 'GO LIVE');
});

test('pause, off and test runs need no phrase (one click)', () => {
  const live = state({ default: 'live', accounts: { u_a: 'live' } });
  const cases: Array<[LaunchState, LaunchChange, string]> = [
    [live, { paused: true }, 'pause on'],
    [live, { default: 'off' }, 'default live → off'],
    [live, { default: 'test' }, 'default live → test'],
    [live, { accounts: { u_a: 'off' } }, 'account live → off'],
    [live, { accounts: { u_a: 'test' } }, 'account live → test'],
    [state(), { default: 'test' }, 'default off → test'],
    [state(), { accounts: { u_a: 'test' } }, 'account off → test'],
    [state({ default: 'test' }), { default: 'off', accounts: { u_a: 'off' }, paused: true }, 'everything to off and paused'],
    [state({ default: 'live' }), { accounts: { u_a: 'live' } }, 'override live on an account already live'],
    [live, { accounts: { u_a: null } }, 'override live removed onto a live default'],
    [state({ accounts: { u_a: 'live' } }), { accounts: { u_a: null } }, 'override live removed onto an off default'],
  ];
  for (const [before, c, label] of cases) {
    const s = sum(before, c);
    assertEqual([s.loosening, s.confirmPhrase, s.empty], [[], null, false], label);
  }
  assertEqual(sum(live, { paused: true }).lines, ['Pause all sending'], 'pause line');
});

test('lowering limits and removing SMS countries do not loosen; adding a country does', () => {
  const lower = sum(state(), { safety: { maxSendsPerVenuePerDay: 199, staleAfterHours: 1 } });
  assertEqual([lower.lines, lower.confirmPhrase], [['maxSendsPerVenuePerDay: 200 → 199', 'staleAfterHours: 6 → 1'], null], 'lower by 1 and more');
  const same = sum(state(), { safety: { ...SAFETY } });
  assertEqual([same.lines, same.empty], [[], true], 'same limits: no line');
  const mixed = sum(state(), { safety: { maxSendsPerVenuePerDay: 100, maxSendsPlatformPerDay: 5001 } });
  assertEqual(mixed.confirmPhrase, 'LOOSEN LIMITS', 'one lowered, one raised');
  const removed = sum(state(), { smsCountries: ['CH'] });
  assertEqual([removed.lines, removed.confirmPhrase], [['SMS countries removed: DE'], null], 'removed');
  const none = sum(state(), { smsCountries: [] });
  assertEqual([none.lines, none.confirmPhrase], [['SMS countries removed: CH, DE'], null], 'all removed');
  const swapped = sum(state(), { smsCountries: ['CH', 'AT'] });
  assertEqual([swapped.lines, swapped.confirmPhrase], [['SMS countries added: AT', 'SMS countries removed: DE'], 'LOOSEN LIMITS'], 'one swapped for another');
  const reordered = sum(state(), { smsCountries: ['DE', 'CH'] });
  assertEqual([reordered.lines, reordered.empty], [[], true], 'same countries in another order');
  const fromNone = sum(state({ smsCountries: [] }), { smsCountries: ['CH'] });
  assertEqual(fromNone.confirmPhrase, 'LOOSEN LIMITS', 'the first country');
});

test('an alert email change is a line but not loosening', () => {
  const changed = sum(state(), { alertsEmail: 'alerts@heidifi.test' });
  assertEqual([changed.lines, changed.loosening, changed.confirmPhrase, changed.empty], [['Alert email: ops@heidifi.test → alerts@heidifi.test'], [], null, false], 'changed');
  assertEqual(sum(state({ alertsEmail: null }), { alertsEmail: 'ops@heidifi.test' }).lines, ['Alert email: (none) → ops@heidifi.test'], 'set');
  assertEqual(sum(state(), { alertsEmail: null }).lines, ['Alert email: ops@heidifi.test → (none)'], 'cleared');
});

test('a no-op is empty', () => {
  const before = state({ default: 'live', accounts: { u_a: 'test' }, paused: true });
  const cases: LaunchChange[] = [
    {},
    { default: 'live', accounts: { u_a: 'test' }, paused: true, safety: { ...SAFETY }, smsCountries: ['CH', 'DE'], alertsEmail: 'ops@heidifi.test' },
    { accounts: { u_zz: null } },
  ];
  for (const c of cases) assertEqual(sum(before, c), { lines: [], loosening: [], confirmPhrase: null, empty: true }, `no-op ${JSON.stringify(c)}`);
});

// ── confirmMatches ───────────────────────────────────────────────────────────

test('confirmMatches: any case, extra and inner spaces', () => {
  for (const typed of ['GO LIVE', 'go live', 'Go Live', '  go   live  ', 'go\tlive', '\ngo live\n']) assertEqual(confirmMatches(typed, 'GO LIVE'), true, `typed ${JSON.stringify(typed)}`);
  const phrase = 'LIVE FOR EVERYONE AND GO LIVE';
  assertEqual(confirmMatches('live  for everyone\nand go   live', phrase), true, 'joined phrase, any spacing');
  for (const typed of ['GOLIVE', 'GO LIVE!', 'GO', 'GO LIVE GO LIVE', '', '   ', 'G O LIVE']) assertEqual(confirmMatches(typed, 'GO LIVE'), false, `typed ${JSON.stringify(typed)}`);
  assertEqual(confirmMatches('GO LIVE', phrase), false, 'only part of a joined phrase');
  assertEqual(confirmMatches('LIVE FOR EVERYONE', phrase), false, 'only the first part');
});

test('confirmMatches: non-strings are refused; no phrase always passes', () => {
  for (const typed of [undefined, null, 42, true, ['GO LIVE'], { phrase: 'GO LIVE' }]) assertEqual(confirmMatches(typed, 'GO LIVE'), false, `typed ${JSON.stringify(typed)}`);
  for (const typed of [undefined, null, '', 'anything', 42, {}]) assertEqual(confirmMatches(typed, null), true, `no phrase, typed ${JSON.stringify(typed)}`);
});

test('the phrase summarizeChange asks for is the one confirmMatches accepts', () => {
  const s = sum(state({ default: 'test', paused: true }), { accounts: { u_a: 'live' }, paused: false });
  assertEqual(s.confirmPhrase, 'GO LIVE AND RELEASE PAUSE', 'phrase');
  assertEqual(confirmMatches(s.confirmPhrase!.toLowerCase(), s.confirmPhrase), true, 'lowercase');
  assertEqual(confirmMatches('GO LIVE', s.confirmPhrase), false, 'part of it');
  const brake = sum(state({ default: 'live' }), { paused: true });
  assertEqual(confirmMatches(undefined, brake.confirmPhrase), true, 'the brake needs nothing typed');
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('both modules are pure: no runtime imports, firebase.ts not loaded', () => {
  for (const f of ['hold.ts', 'launch.ts']) {
    const src = readFileSync(join(__dirname, '../src/adaptive/core/runtime', f), 'utf8');
    const runtime = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assertEqual(runtime, [], `${f} runtime imports`);
    assert(!/^import\s+'/m.test(src) && !/\brequire\(/.test(src), `${f} has no side-effect import or require`);
  }
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
