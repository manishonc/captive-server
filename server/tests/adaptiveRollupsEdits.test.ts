/**
 * PR B2 — the pure parts of the daily numbers (JourneyStats) and mid-journey edits.
 *
 * Run: npx tsx tests/adaptiveRollupsEdits.test.ts   (from captive-server/server)
 *
 *  - Every event type lands in the right counter; a test-run guest's events only in
 *    `dryRun`, never in `sends` / `credits`; a dotted reason stays one map key.
 *  - The day is the venue's local day (an event at 23:30 UTC in summer is the next day
 *    in Zurich); `_venue` holds the totals, visits only there.
 *  - The config swap: the first step after the freeze window of the save uses the new
 *    version; nothing within the window does, nor a send planned within it; stale
 *    markers are cleared.
 *  - The gate's freeze window comes from the config (0 = no grace).
 */

import { aggregate, countsFor, dayId, statKey, VENUE_KEY, type RollupEvent } from '../src/adaptive/rollups/journeyStats';
import { decideConfigSwap } from '../src/adaptive/core/runtime/configSwap';
import { runGate, type GateInput } from '../src/adaptive/core/runtime/gate';
import { HOUR_MS, MINUTE_MS, zonedTime } from '../src/adaptive/core/runtime/time';
import type { WaitState } from '../src/adaptive/core/runtime/types';

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const TZ = 'Europe/Zurich';
const T0 = zonedTime(2026, 9, 29, 12, 40, TZ).getTime();

function ev(type: string, over: Partial<RollupEvent> = {}): RollupEvent {
  return { id: `e${Math.random()}`, type, journeyKey: 'welcome_second_visit', instanceId: 'ji_1', channel: null, slot: null, variantId: null, occurredAt: T0, mode: 'live', data: {}, ...over };
}

console.log('\nJourneyStats mapping\n');

test('journey events → entered / converted / ended + exited', () => {
  assertEqual(countsFor(ev('journey.entered')).both, { entered: 1 }, 'entered');
  assertEqual(countsFor(ev('journey.converted')).both, { converted: 1 }, 'converted');
  assertEqual(countsFor(ev('journey.exited', { data: { status: 'suppressed', reason: 'switched_off' } })).both, { ended: { suppressed: 1 }, exited: { switched_off: 1 } }, 'exited');
});

test('a live marketing send → sends, slot, variant, credits (not utility)', () => {
  const c = countsFor(ev('message.sent', { channel: 'sms', slot: 'now', variantId: 'var_a', data: { mode: 'live', channel: 'sms', purpose: 'marketing', credits: 30, providerCostMinor: 9 } })).both;
  assertEqual(c, { sends: { sms: { sent: 1 } }, bySlot: { now: { sent: 1 } }, byVariant: { var_a: { sent: 1 } }, credits: { sms: 30 } }, 'marketing send');
});

test('a service send → utility sends + provider cost, no credits', () => {
  const c = countsFor(ev('message.sent', { channel: 'email', slot: 'now', data: { mode: 'live', purpose: 'service', credits: 0, providerCostMinor: 1 } })).both;
  assertEqual(c, { sends: { email: { sent: 1 } }, bySlot: { now: { sent: 1 } }, utility: { sends: 1, providerCostMinor: 1 } }, 'service send');
});

test('delivery / open / click / bounce / failed / unknown → sends.{ch}.*; a click also per slot and variant', () => {
  for (const [type, key] of [['message.delivered', 'delivered'], ['message.opened', 'opened'], ['message.bounced', 'bounced'], ['message.failed', 'failed'], ['message.unknown', 'unknown']]) {
    assertEqual(countsFor(ev(type, { channel: 'email', data: { mode: 'live' } })).both, { sends: { email: { [key]: 1 } } }, type);
  }
  assertEqual(countsFor(ev('message.clicked', { channel: 'sms', slot: 'evening', variantId: 'var_b', data: { mode: 'live' } })).both, { sends: { sms: { clicked: 1 } }, bySlot: { evening: { clicked: 1 } }, byVariant: { var_b: { clicked: 1 } } }, 'click');
});

test('skips and blocks by the decision reason — a dotted reason stays one key', () => {
  assertEqual(countsFor(ev('send.skipped', { data: { decision: { reason: 'quiet_hours_expired' } } })).both, { skipped: { quiet_hours_expired: 1 } }, 'skip');
  const c = countsFor(ev('send.blocked', { data: { decision: { reason: 'missing_value:guestinfo.wifiName' } } })).both as any;
  assertEqual(Object.keys(c.skipped), ['missing_value:guestinfo.wifiName'], 'one key with dots');
  assertEqual(countsFor(ev('send.skipped', { data: { reason: 'contact_gone' } })).both, { skipped: { contact_gone: 1 } }, 'reason without a decision');
});

test('a test-run guest: everything under dryRun, nothing in sends or credits', () => {
  assertEqual(countsFor(ev('journey.entered', { mode: 'test' })).both, { dryRun: { entered: 1 } }, 'entered');
  assertEqual(countsFor(ev('send.skipped', { mode: 'test', data: { decision: { reason: 'consent' } } })).both, { dryRun: { skipped: { consent: 1 } } }, 'skipped');
  const dry = countsFor(ev('send.dry_run', { mode: 'test', channel: 'sms', slot: 'now', variantId: 'var_a', data: { decision: { purpose: 'marketing', credits: { price: 45, balance: null }, slot: { picked: 'now' } } } })).both as any;
  assertEqual(dry, { dryRun: { sends: { sms: { sent: 1 } }, bySlot: { now: { sent: 1 } }, byVariant: { var_a: { sent: 1 } }, credits: { sms: 45 } } }, 'dry run');
  // Even without a mode on the event, a dry run is a dry run.
  assert((countsFor(ev('send.dry_run', { mode: null, channel: 'email', data: { decision: { purpose: 'service' } } })).both as any).dryRun.utility.sends === 1, 'dry run without mode');
});

test('visits and captures go to _venue only; unknown events count nothing', () => {
  assertEqual(countsFor(ev('visit.started', { journeyKey: null, data: { isFirstVisit: true, isRevisit: false } })), { both: null, venueOnly: { visits: { total: 1, first: 1 } } }, 'visit');
  assertEqual(countsFor(ev('wifi.connected', { journeyKey: null })), { both: null, venueOnly: { visits: { captures: 1 } } }, 'capture');
  for (const t of ['send.deferred', 'send.retry', 'offer.issued', 'visit.ended', 'consent.revoked', 'journey.config_updated', 'rating.submitted']) {
    assertEqual(countsFor(ev(t)), { both: null, venueOnly: null }, t);
  }
});

test('statKey: never empty, never reserved, bounded', () => {
  assertEqual(statKey(''), 'unknown', 'empty');
  assertEqual(statKey(null), 'unknown', 'null');
  assertEqual(statKey('__name__'), 'x__name__', 'reserved');
  assert(!/^__.*__$/.test(statKey('__x__')), 'never reserved');
  assertEqual(statKey('x'.repeat(300)).length, 120, 'long');
});

test('aggregate: journey doc + _venue totals, the venue-local day, one delta per doc', () => {
  // 23:30 UTC on 29 Sep = 01:30 on 30 Sep in Zurich (summer time).
  const late = Date.UTC(2026, 8, 29, 23, 30);
  assertEqual(dayId(late, TZ), '20260930', 'local day');
  const deltas = aggregate('v1', TZ, [
    ev('journey.entered'),
    ev('journey.entered'),
    ev('message.sent', { channel: 'sms', slot: 'now', data: { purpose: 'marketing', credits: 15 } }),
    ev('visit.started', { journeyKey: null, data: { isFirstVisit: true } }),
    ev('journey.entered', { occurredAt: late }),
  ]);
  const byId = Object.fromEntries(deltas.map((d) => [d.docId, d]));
  assertEqual(Object.keys(byId).sort(), ['v1__venue_20260929', 'v1__venue_20260930', 'v1_welcome_second_visit_20260929', 'v1_welcome_second_visit_20260930'], 'docs');
  assertEqual((byId['v1_welcome_second_visit_20260929'].counts as any).entered, 2, 'journey entered');
  assert(!(byId['v1_welcome_second_visit_20260929'].counts as any).visits, 'no visits on a journey doc');
  assertEqual((byId[`v1_${VENUE_KEY}_20260929`].counts as any).visits, { total: 1, first: 1 }, 'visits on _venue');
  assertEqual((byId[`v1_${VENUE_KEY}_20260929`].counts as any).credits, { sms: 15 }, 'venue credits');
  assertEqual(byId['v1_welcome_second_visit_20260930'].date, '2026-09-30', 'date field');
});

console.log('\nMid-journey edits\n');

const SAVED = T0;
const FREEZE = 60 * MINUTE_MS;
const sendDue = (intendedAt: number): WaitState => ({ kind: 'send_due', nodeId: 's2', token: 't', untilAt: intendedAt, intendedAt });

test('no pending version → keep; an older or equal one → stale (cleared)', () => {
  const later = SAVED + 2 * HOUR_MS;
  assertEqual(decideConfigSwap({ configVersion: 2, pendingConfigVersion: null, pendingConfigAt: null }, null, FREEZE, later), { kind: 'keep', use: 2 }, 'keep');
  assertEqual(decideConfigSwap({ configVersion: 3, pendingConfigVersion: 2, pendingConfigAt: SAVED }, null, FREEZE, later), { kind: 'stale', use: 3 }, 'older');
  assertEqual(decideConfigSwap({ configVersion: 3, pendingConfigVersion: 3, pendingConfigAt: SAVED }, null, FREEZE, SAVED).kind, 'stale', 'equal, even within the window');
});

test('the first step after the window uses the new version (a timer, a wait for a click)', () => {
  const pin = { configVersion: 1, pendingConfigVersion: 2, pendingConfigAt: SAVED };
  const wait: WaitState = { kind: 'events', nodeId: 'w1', token: 't', untilAt: SAVED + 48 * HOUR_MS };
  assertEqual(decideConfigSwap(pin, wait, FREEZE, SAVED + 61 * MINUTE_MS), { kind: 'swap', use: 2, from: 1 }, 'swap');
  assertEqual(decideConfigSwap(pin, null, FREEZE, SAVED + 2 * HOUR_MS).kind, 'swap', 'no wait');
});

test('within 60 min of the save nothing moves: a delay ending, an open or a click, a planned send', () => {
  const pin = { configVersion: 1, pendingConfigVersion: 2, pendingConfigAt: SAVED };
  const timer: WaitState = { kind: 'timer', nodeId: 'd1', token: 't', untilAt: SAVED + 10 * MINUTE_MS };
  assertEqual(decideConfigSwap(pin, timer, FREEZE, SAVED + 10 * MINUTE_MS), { kind: 'hold', use: 1, pending: 2 }, 'a delay ending 10 min after the save (its send goes now)');
  assertEqual(decideConfigSwap(pin, { kind: 'events', nodeId: 'w1', token: 't', untilAt: null }, FREEZE, SAVED + 60 * MINUTE_MS).kind, 'hold', 'a click at exactly 60 min');
  assertEqual(decideConfigSwap(pin, timer, 0, SAVED + 1).kind, 'swap', 'freeze window 0');
});

test('a send planned within 60 min of the save keeps the old values, also when held past the window; later ones get the new', () => {
  const pin = { configVersion: 1, pendingConfigVersion: 2, pendingConfigAt: SAVED };
  const after = SAVED + 3 * HOUR_MS; // the send runs later (quiet hours, a pause, a retry)
  assertEqual(decideConfigSwap(pin, sendDue(SAVED + 59 * MINUTE_MS), FREEZE, after), { kind: 'hold', use: 1, pending: 2 }, 'planned within');
  assertEqual(decideConfigSwap(pin, sendDue(SAVED + 60 * MINUTE_MS), FREEZE, after).kind, 'hold', 'planned at exactly 60 min');
  assertEqual(decideConfigSwap(pin, sendDue(SAVED - 3 * HOUR_MS), FREEZE, after).kind, 'hold', 'overdue (paused) send planned before the save');
  assertEqual(decideConfigSwap(pin, sendDue(SAVED + 61 * MINUTE_MS), FREEZE, SAVED + 61 * MINUTE_MS).kind, 'swap', 'planned after the window');
  assertEqual(decideConfigSwap(pin, sendDue(SAVED + 30 * MINUTE_MS), 0, after).kind, 'swap', 'freeze window 0');
});

test('the gate: a switched-off journey still sends within the configured freeze window only', () => {
  const base = gateInput();
  const off = (freeze: number | undefined, since: number) => runGate({ ...base, system: { ...base.system, journeyOn: false, offSinceAt: since, freezeWindowMs: freeze } });
  assertEqual(off(undefined, T0 - 30 * MINUTE_MS).verdict, 'allow', 'default 60 min');
  assertEqual(off(0, T0 - 30 * MINUTE_MS).reason, 'switched_off', 'freeze 0');
  assertEqual(off(90 * MINUTE_MS, T0 - 80 * MINUTE_MS).verdict, 'allow', 'freeze 90');
  assertEqual(off(undefined, T0 - 61 * MINUTE_MS).reason, 'switched_off', 'past 60');
  const venueOff = runGate({ ...base, system: { ...base.system, venueOn: false, offSinceAt: null } });
  assertEqual(venueOff.reason, 'switched_off', 'unknown off-time → no grace');
});

function gateInput(): GateInput {
  return {
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
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
