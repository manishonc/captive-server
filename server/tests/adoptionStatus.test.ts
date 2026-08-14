/**
 * Tests for the adoption phase classifier — what the installer's progress screen shows.
 *
 * Run: npx tsx tests/adoptionStatus.test.ts   (from captive-server/server)
 *
 * Pure module, no credentials needed.
 *
 * Why this is load-bearing: the two obvious existing helpers are both wrong here, and the
 * tests pin down the difference. isPendingDevice() calls anything with adopted===false
 * "pending" regardless of state, which would show no progress for the whole provision AND
 * make the 5-minute cron re-issue `adopt` every pass at a device that is already adopting.
 * mapDeviceState() calls everything except state 1 "offline", which would tell someone their
 * brand-new access point is broken during a normal two-minute provision.
 */

import {
  classifyAdoptionPhase,
  isTerminalPhase,
  retryAfterSeconds,
} from '../src/services/adoptionStatus';

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

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

const T0 = 1_700_000_000_000;

console.log('\nthe device is not on the controller yet');

test('a missing row is "waiting", not an error', () => {
  assertEqual(classifyAdoptionPhase(null), 'waiting_for_device');
  assertEqual(classifyAdoptionPhase(undefined), 'waiting_for_device');
});

console.log('\npending vs adopting — the distinction isPendingDevice cannot make');

test('state 2 with adopted:false is pending', () => {
  assertEqual(classifyAdoptionPhase({ state: 2, adopted: false }), 'pending');
});

test('state 2 with the flag omitted is pending', () => {
  // Some firmware omits `adopted` entirely; state 2 is the fallback signal.
  assertEqual(classifyAdoptionPhase({ state: 2 }), 'pending');
});

test('state 5 with adopted:true is ADOPTING, not pending', () => {
  // The exact case isPendingDevice gets wrong is the inverse of this one; here the flag is
  // already true, so both agree. The next test is the one that matters.
  assertEqual(classifyAdoptionPhase({ state: 5, adopted: true }), 'adopting');
});

test('state 4 (firmware upgrade) is adopting, not offline', () => {
  assertEqual(classifyAdoptionPhase({ state: 4, adopted: true }), 'adopting');
});

test('an unrecognised non-zero state is adopting, not a failure', () => {
  // Better to show continued progress for an unknown transient state than to declare a
  // failure at a device that is mid-provision.
  assertEqual(classifyAdoptionPhase({ state: 11, adopted: true }), 'adopting');
});

console.log('\nconnected');

test('state 1 is connected regardless of the adopted flag', () => {
  assertEqual(classifyAdoptionPhase({ state: 1, adopted: true }), 'connected');
  assertEqual(classifyAdoptionPhase({ state: 1 }), 'connected');
});

test('connected is the only terminal phase', () => {
  assertEqual(isTerminalPhase('connected'), true);
  assertEqual(isTerminalPhase('adopting'), false);
  assertEqual(isTerminalPhase('pending'), false);
  assertEqual(isTerminalPhase('waiting_for_device'), false);
  assertEqual(isTerminalPhase('offline'), false);
});

console.log('\nstate 0 — the reboot-versus-dead distinction');

test('a drop just after our adopt is still adopting', () => {
  // Devices routinely go quiet while rebooting into the controller's config. Calling that
  // "offline" would fail the install at the exact moment it is succeeding.
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 30_000), 'adopting');
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 9 * 60_000), 'adopting');
});

test('a drop long after our adopt is offline', () => {
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 11 * 60_000), 'offline');
});

test('state 0 with no adopt of ours is waiting, not offline', () => {
  // We never asked this device to do anything, so there is nothing to have failed.
  assertEqual(classifyAdoptionPhase({ state: 0 }, null, T0), 'waiting_for_device');
});

test('a missing or junk state is treated as state 0', () => {
  assertEqual(classifyAdoptionPhase({}, null, T0), 'waiting_for_device');
  assertEqual(classifyAdoptionPhase({ state: 'banana' }, T0, T0 + 30_000), 'adopting');
});

console.log('\nretryAfterSeconds — responsive first, then cheap');

test('backs off as the wait lengthens', () => {
  assertEqual(retryAfterSeconds(0), 2);
  assertEqual(retryAfterSeconds(19_000), 2);
  assertEqual(retryAfterSeconds(20_000), 3);
  assertEqual(retryAfterSeconds(59_000), 3);
  assertEqual(retryAfterSeconds(60_000), 10);
  assertEqual(retryAfterSeconds(10 * 60_000), 10);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
