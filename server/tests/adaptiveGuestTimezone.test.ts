/**
 * The guest's time zone from the splash (manager spec §2 `guests.timezone`, §4.2, §14).
 *
 * Run: npx tsx tests/adaptiveGuestTimezone.test.ts   (from captive-server/server)
 *
 * What these pin (decisions D1–D5, 2026-11-04):
 *  - D1 Only a real IANA place is kept: no offsets, no UTC / GMT / Etc/*, nothing unknown; the
 *    name the phone sent is kept (Asia/Kolkata stays Asia/Kolkata), only its letter case fixed.
 *  - D2 Quiet hours hold in the device zone too, on top of the venue and phone-country zones:
 *    a Swiss-number guest whose phone is on London time, 22:00 London → held to 09:00–09:20
 *    London (10:00 Zurich), where before the device zone it went at 09:00 Zurich (08:00 London).
 *    The same device zone as the venue changes nothing; no device zone = exactly as before.
 *  - D3 Send times (slots, fixed times) are picked in the device zone, else the venue's.
 *  - D4 The journey's pinned zone (Contacts.profile.timezone at enrolment) — an invalid one is none.
 *  - D5 The admin "Why?" fact names the device zone; Replay reaches the same decision, and a
 *    record from before reads as "no device zone".
 */

import { runGate, type GateInput } from '../src/adaptive/core/runtime/gate';
import { buildDecision, type DecisionRecord } from '../src/adaptive/core/runtime/decision';
import { REPLAY_MAX_BYTES, buildReplaySnapshot, readReplaySnapshot, replayDecision } from '../src/adaptive/core/runtime/replay';
import { pickTime } from '../src/adaptive/core/runtime/pickers';
import { HOUR_MS, MINUTE_MS, isInWindow, localParts, zonedTime } from '../src/adaptive/core/runtime/time';
import { ENGINE_RUNTIME_VERSION } from '../src/adaptive/core/runtime/version';
import { contactDeviceTz, parseDeviceTimeZone, sendZone } from '../src/adaptive/core/runtime/deviceTz';
import { ADAPTIVE_CONFIG_V1 } from '../src/adaptive/seed/definitions/config';

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
const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const SEND_KEY = 'js_tz_test';
const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number, tz: string) => {
  const p = localParts(new Date(ms), tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

function gateInput(over: Partial<GateInput> = {}): GateInput {
  const now = over.now ?? zonedTime(2026, 11, 10, 12, 0, TZ).getTime();
  const base: GateInput = {
    now,
    mode: 'live',
    purpose: 'marketing',
    channel: 'sms',
    urgent: false,
    enteredAt: now,
    expireAfterMs: null,
    intendedAt: now,
    jitterKey: SEND_KEY,
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
    quiet: { venueTz: TZ, phoneTz: TZ, window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
    spacing: { lastAt: null, minGapMs: 0 },
    fairUse: { count: 0, limit: 300 },
    credits: { price: 15, spendable: 100, waitStartedAt: null, queueHours: 72 },
  };
  return { ...base, ...over, system: { ...base.system, ...(over.system ?? {}) } };
}

/** The same input with the guest's device zone. */
function withDevice(i: GateInput, deviceTz: string | null | undefined): GateInput {
  return { ...i, quiet: { ...i.quiet, deviceTz } };
}

function decisionOf(i: GateInput): DecisionRecord {
  return buildDecision({
    now: i.now,
    mode: i.mode,
    poolKey: 'welcome_offer',
    purpose: i.purpose,
    gate: runGate(i),
    channelChecks: [{ channel: i.channel, ok: true, reason: null }],
    channel: { picked: i.channel, rule: 'ladder' },
    variant: { picked: i.diff.variantId, method: 'rotation:first' },
    slot: { picked: 'now', rule: 'now', plannedAt: i.intendedAt },
    credits: { price: i.credits.price, balance: i.credits.spendable },
    versions: { runtime: ENGINE_RUNTIME_VERSION, template: 1, config: 1 } as never,
  });
}

/** Through Firestore and back: JSON, then the reader. */
function replayOf(i: GateInput) {
  const decision = decisionOf(i);
  const snap = readReplaySnapshot(JSON.parse(JSON.stringify(buildReplaySnapshot({ stage: 'gate', input: i }))));
  assert(snap, 'the snapshot reads back');
  return { decision, snap, out: replayDecision(JSON.parse(JSON.stringify(decision)), snap, SEND_KEY) };
}

console.log('\nD1 — the device zone from the splash');

test('real IANA places are kept, as the phone sent them', () => {
  for (const tz of ['Europe/London', 'Europe/Zurich', 'Asia/Kolkata', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince', 'Australia/Lord_Howe']) {
    assertEqual(parseDeviceTimeZone(tz), tz, tz);
  }
  assertEqual(parseDeviceTimeZone('  Europe/London \n'), 'Europe/London', 'spaces trimmed');
  assertEqual(parseDeviceTimeZone('europe/zurich'), 'Europe/Zurich', 'letter case fixed');
});

test('no offsets, no UTC / GMT / Etc, nothing unknown or odd', () => {
  const refused = [
    'UTC', 'Etc/UTC', 'etc/utc', 'Etc/GMT+5', 'Etc/GMT-14', 'GMT', 'GMT0', 'UCT', 'Universal', 'Zulu', 'Greenwich',
    '+02:00', '-05:00', '+0530', 'Z',
    'Zurich', 'Europe/Nowhere', 'Mars/Olympus_Mons', 'EST5EDT', 'CET', 'EST',
    'Europe/London; DROP', 'Europe/../London', '/Europe/London', 'Europe/London/', 'Europe//London',
    `Europe/${'x'.repeat(60)}`, '',
  ];
  for (const raw of refused) assertEqual(parseDeviceTimeZone(raw), null, JSON.stringify(raw));
  for (const raw of [null, undefined, 42, true, {}, ['Europe/London']]) assertEqual(parseDeviceTimeZone(raw), null, String(raw));
});

console.log('\nD2 — quiet hours hold in the device zone too');

test('22:00 on a London phone (Swiss number): held to 09:00–09:20 London, not 09:00 Zurich', () => {
  const night = zonedTime(2026, 11, 10, 22, 0, LONDON).getTime(); // 23:00 Zurich
  const nineLondon = zonedTime(2026, 11, 11, 9, 0, LONDON).getTime(); // 10:00 Zurich
  const nineZurich = zonedTime(2026, 11, 11, 9, 0, TZ).getTime(); // 08:00 London
  const base = gateInput({ now: night, enteredAt: night, intendedAt: night });

  const before = runGate(base);
  assertEqual([before.verdict, before.rule], ['defer', 'quiet_hours'], 'quiet at the venue');
  assert(before.until! >= nineZurich && before.until! <= nineZurich + 20 * MINUTE_MS, `no device zone: 09:00 Zurich as before, got ${iso(before.until!)}`);

  const g = runGate(withDevice(base, LONDON));
  assertEqual([g.verdict, g.rule], ['defer', 'quiet_hours'], 'deferred');
  assert(g.until! >= nineLondon && g.until! <= nineLondon + 20 * MINUTE_MS, `device London: 09:00–09:20 London, got ${iso(g.until!)} (${hhmm(g.until!, LONDON)} London)`);
  // The "Why?" fact keeps its old start and adds the phone's own times.
  const fact = g.checks.find((c) => c.rule === 'quiet_hours')!.fact;
  assertEqual(fact, `23:00 Europe/Zurich is inside 21:00–09:00 → ${hhmm(g.until!, TZ)} (guest's phone: 22:00 Europe/London → ${hhmm(g.until!, LONDON)})`, 'hold fact');
  assertEqual(before.checks.find((c) => c.rule === 'quiet_hours')!.fact, `23:00 Europe/Zurich is inside 21:00–09:00 → ${hhmm(before.until!, TZ)}`, 'no device zone: the fact as before');
});

test('daytime at the venue, night on the phone (New York): held to 09:00 New York', () => {
  const noon = zonedTime(2026, 11, 10, 12, 0, TZ).getTime(); // 06:00 New York
  const g = runGate(withDevice(gateInput({ now: noon, enteredAt: noon, intendedAt: noon }), NEW_YORK));
  assertEqual([g.verdict, g.rule], ['defer', 'quiet_hours'], 'night in New York');
  const nineNy = zonedTime(2026, 11, 10, 9, 0, NEW_YORK).getTime(); // 15:00 Zurich
  assert(g.until! >= nineNy && g.until! <= nineNy + 20 * MINUTE_MS, `until 09:00–09:20 New York, got ${iso(g.until!)}`);
  const fact = g.checks.find((c) => c.rule === 'quiet_hours')!.fact;
  assert(fact.includes(NEW_YORK) && fact.startsWith('06:00'), `the fact names the phone's zone: ${fact}`);
  // The same moment, a guest without one: sent (as before).
  assertEqual(runGate(gateInput({ now: noon, enteredAt: noon, intendedAt: noon })).verdict, 'allow', 'no device zone → allow');
});

test('every 10 minutes over a day: the earliest moment venue, phone and device zones are all out of quiet hours', () => {
  const w = { start: '21:00', end: '09:00' };
  for (const [phoneTz, deviceTz] of [[TZ, LONDON], [TZ, NEW_YORK], ['Europe/London', 'Asia/Tokyo'], [null, 'Asia/Kolkata'], ['Europe/Athens', 'America/Los_Angeles']] as Array<[string | null, string]>) {
    for (let t = zonedTime(2026, 11, 10, 0, 0, TZ).getTime(); t < zonedTime(2026, 11, 11, 0, 0, TZ).getTime(); t += 10 * MINUTE_MS) {
      const i = gateInput({ now: t, enteredAt: t, intendedAt: t, quiet: { ...gateInput().quiet, phoneTz, deviceTz } });
      const g = runGate(i);
      const zones = [TZ, phoneTz, deviceTz].filter((z): z is string => Boolean(z));
      let earliest = t;
      while (zones.some((z) => isInWindow(new Date(earliest), z, w))) earliest += MINUTE_MS;
      if (earliest === t) {
        assertEqual(g.verdict, 'allow', `${phoneTz}/${deviceTz} ${iso(t)}: daytime everywhere`);
        continue;
      }
      // A day with no common daytime (e.g. Tokyo + London + Zurich still have 09:00–… overlaps) always ends.
      assertEqual(g.rule, 'quiet_hours', `${phoneTz}/${deviceTz} ${iso(t)}: quiet`);
      assert(g.until! >= earliest && g.until! <= earliest + 20 * MINUTE_MS, `${phoneTz}/${deviceTz} ${iso(t)}: until ${iso(g.until!)}, earliest ${iso(earliest)}`);
    }
  }
});

test('the same zone as the venue, or none: exactly the old checks', () => {
  for (const t of [zonedTime(2026, 11, 10, 22, 0, TZ).getTime(), zonedTime(2026, 11, 10, 12, 0, TZ).getTime(), zonedTime(2026, 11, 11, 8, 50, TZ).getTime()]) {
    const base = gateInput({ now: t, enteredAt: t, intendedAt: t });
    const old = runGate(base);
    for (const d of [TZ, null, undefined]) assertEqual(runGate(withDevice(base, d)), old, `${iso(t)} device ${d}`);
  }
});

test('an allowed send says the phone\'s time in the "Why?" fact', () => {
  const t = zonedTime(2026, 11, 10, 15, 30, TZ).getTime(); // 14:30 London
  const fact = runGate(withDevice(gateInput({ now: t, enteredAt: t, intendedAt: t }), LONDON)).checks.find((c) => c.rule === 'quiet_hours')!.fact;
  assertEqual(fact, "15:30 Europe/Zurich (guest's phone: 14:30 Europe/London) is outside 21:00–09:00", 'fact');
  const same = runGate(withDevice(gateInput({ now: t, enteredAt: t, intendedAt: t }), TZ)).checks.find((c) => c.rule === 'quiet_hours')!.fact;
  assertEqual(same, '15:30 Europe/Zurich is outside 21:00–09:00', 'no note for the venue zone');
});

test('info messages: the utility window holds in the device zone too; urgent ones still go', () => {
  const t = zonedTime(2026, 11, 10, 12, 0, TZ).getTime(); // 06:00 New York, inside 22:00–08:00
  const info = withDevice(gateInput({ now: t, enteredAt: t, intendedAt: t, purpose: 'service' }), NEW_YORK);
  const g = runGate(info);
  assertEqual([g.verdict, g.rule], ['defer', 'quiet_hours'], 'held');
  const eightNy = zonedTime(2026, 11, 10, 8, 0, NEW_YORK).getTime();
  assert(g.until! >= eightNy && g.until! <= eightNy + 20 * MINUTE_MS, `until 08:00–08:20 New York, got ${iso(g.until!)}`);
  assertEqual(runGate({ ...info, urgent: true }).verdict, 'allow', 'urgent info goes');
});

test('spacing: a gap ending in the phone\'s night moves on to its morning', () => {
  // Last marketing message 17:00 London; gap 4 h → 21:00 London (22:00 Zurich: quiet in both) → 09:00 London.
  const t = zonedTime(2026, 11, 10, 19, 0, LONDON).getTime();
  const last = zonedTime(2026, 11, 10, 17, 0, LONDON).getTime();
  const i = withDevice(gateInput({ now: t, enteredAt: t, intendedAt: t, spacing: { lastAt: last, minGapMs: 4 * HOUR_MS } }), LONDON);
  const g = runGate(i);
  assertEqual([g.verdict, g.rule], ['defer', 'spacing'], 'spacing');
  const nineLondon = zonedTime(2026, 11, 11, 9, 0, LONDON).getTime();
  assert(g.until! >= nineLondon && g.until! <= nineLondon + 20 * MINUTE_MS, `until the London morning, got ${iso(g.until!)}`);
});

console.log('\nD3 — send times in the device zone');

test('sendZone: the device zone when it is a real one, else the venue zone', () => {
  assertEqual(sendZone({ venueTz: TZ, deviceTz: LONDON }), LONDON, 'device');
  for (const d of [null, undefined, '', 'Zurich', 'Not/AZone']) assertEqual(sendZone({ venueTz: TZ, deviceTz: d }), TZ, `venue for ${JSON.stringify(d)}`);
});

test('the afternoon slot and a fixed 10:00 land in the phone\'s local time', () => {
  const now = zonedTime(2026, 11, 10, 9, 0, TZ).getTime();
  const slots = ADAPTIVE_CONFIG_V1.slots;
  for (const tz of [LONDON, NEW_YORK, TZ]) {
    const zone = sendZone({ venueTz: TZ, deviceTz: tz });
    for (const key of ['js_a', 'js_b', 'js_c', 'js_d']) {
      const p = pickTime({ mode: 'slot', default: 'afternoon' }, now, zone, slots, key);
      const h = localParts(new Date(p.at), tz).hour;
      assert(h >= 14 && h < 17, `${tz} ${key}: afternoon slot at ${hhmm(p.at, tz)} local`);
    }
    const fixed = pickTime({ mode: 'local_time', at: '10:00' }, now, zone, slots, 'js_a');
    assertEqual(hhmm(fixed.at, tz), '10:00', `${tz}: 10:00 local`);
  }
});

console.log('\nD4 — the zone a journey pins');

test('contactDeviceTz: the saved zone when it is valid, else none', () => {
  assertEqual(contactDeviceTz({ profile: { timezone: LONDON } }), LONDON, 'saved');
  assertEqual(contactDeviceTz({ profile: { timezone: 'Zurich' } }), null, 'invalid');
  assertEqual(contactDeviceTz({ profile: {} }), null, 'none saved');
  assertEqual(contactDeviceTz({}), null, 'no profile');
  assertEqual(contactDeviceTz({ profile: null }), null, 'null profile');
});

console.log('\nD5 — Replay');

test('a hold in the phone\'s zone replays to the same decision', () => {
  const night = zonedTime(2026, 11, 10, 22, 0, LONDON).getTime();
  const { snap, out } = replayOf(withDevice(gateInput({ now: night, enteredAt: night, intendedAt: night }), LONDON));
  assertEqual(snap.gate!.quiet.deviceTz, LONDON, 'stored');
  assert(out.same, `same: ${JSON.stringify(out.differences)}`);
});

test('a record from before the device zone replays the old way', () => {
  const night = zonedTime(2026, 11, 10, 22, 0, LONDON).getTime();
  const i = gateInput({ now: night, enteredAt: night, intendedAt: night });
  const decision = decisionOf(i);
  const raw = JSON.parse(JSON.stringify(buildReplaySnapshot({ stage: 'gate', input: i })));
  delete raw.gate.quiet.deviceTz; // as written before this change
  const snap = readReplaySnapshot(raw);
  assert(snap, 'reads back');
  const out = replayDecision(JSON.parse(JSON.stringify(decision)), snap, SEND_KEY);
  assert(out.same, `same: ${JSON.stringify(out.differences)}`);
  const noDevice = buildReplaySnapshot({ stage: 'gate', input: i });
  assertEqual(noDevice.gate!.quiet.deviceTz, null, 'no device zone is written as null, never undefined');
});

test(`the longest zone names keep the snapshot ≤ ${REPLAY_MAX_BYTES} bytes and the decision < 2 KB`, () => {
  const long = 'America/Argentina/ComodRivadavia';
  const t = zonedTime(2026, 11, 10, 22, 30, long).getTime();
  const i = gateInput({
    now: t,
    enteredAt: t - 3 * HOUR_MS,
    intendedAt: t,
    expireAfterMs: 48 * HOUR_MS,
    system: { ...gateInput().system, offSinceAt: t - 20 * MINUTE_MS, freezeWindowMs: 60 * MINUTE_MS, venueSendsToday: 499, platformSendsToday: 9999 },
    channelRules: { audienceOk: true, audienceFact: 'unverified number (owner: everyone)', ruleFail: 'missing_value:guestinfo.localTips' },
    caps: { touches: 4, maxTouches: 5, clicks: 2, stopAfterClicks: 3 },
    weekly: { count: 2, limit: 3 },
    quiet: { venueTz: long, phoneTz: 'America/Indiana/Petersburg', deviceTz: 'America/Kentucky/Louisville', window: { start: '21:00', end: '09:00' }, utilityWindow: { start: '22:00', end: '08:00' }, jitterMinutes: [0, 20] },
    spacing: { lastAt: t - 2 * HOUR_MS, minGapMs: 48 * HOUR_MS },
    fairUse: { count: 299, limit: 300 },
    credits: { price: 150, spendable: 12345, waitStartedAt: t - 5 * HOUR_MS, queueHours: 72 },
  });
  const bytes = Buffer.byteLength(JSON.stringify(buildReplaySnapshot({ stage: 'gate', input: i })), 'utf8');
  assert(bytes <= REPLAY_MAX_BYTES, `${bytes} bytes`);
  assert(JSON.stringify(decisionOf(i)).length < 2048, 'decision under 2 KB');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
