/**
 * Tests for the pure halves of UniFi auto-adoption.
 *
 * Run: npx tsx tests/unifiAdoption.test.ts   (from captive-server/server)
 *
 * Covers `isPendingDevice` and `canonMac` — both live in services/unifi.ts, which
 * touches neither Firestore nor the controller, so this runs with no credentials.
 * (services/unifiAdoption.ts re-exports canonMac but imports ../firebase, whose
 * import-time init needs real credentials — hence the imports below come from
 * services/unifi.) The sweep and the routes need a live controller and are covered
 * by the curl checks in the go-live plan.
 *
 * These two functions matter: isPendingDevice decides which devices the cron is
 * ALLOWED to consider, and canonMac is the join between controller MACs and the
 * registered-AP allowlist — a miss on either side silently disables auto-adoption
 * (or, worse for canonMac, could widen the allowlist).
 */

import { isPendingDevice, canonMac } from '../src/services/unifi';

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

console.log('isPendingDevice');

test('adopted: false is pending regardless of state', () => {
  assertEqual(isPendingDevice({ adopted: false }), true, '{adopted:false}');
  assertEqual(isPendingDevice({ state: 1, adopted: false }), true, '{state:1,adopted:false}');
});

test('state 2 without an adopted flag is pending', () => {
  assertEqual(isPendingDevice({ state: 2 }), true, '{state:2}');
});

test('state 2 but explicitly adopted is NOT pending', () => {
  assertEqual(isPendingDevice({ state: 2, adopted: true }), false, '{state:2,adopted:true}');
});

test('adopted online device is NOT pending', () => {
  assertEqual(isPendingDevice({ state: 1, adopted: true }), false, '{state:1,adopted:true}');
});

test('disconnected device is NOT pending', () => {
  assertEqual(isPendingDevice({ state: 0 }), false, '{state:0}');
});

test('empty row is NOT pending', () => {
  assertEqual(isPendingDevice({}), false, '{}');
});

console.log('\ncanonMac');

test('colon, hyphen, bare and uppercase forms collapse to one key', () => {
  const forms = ['d8:b3:70:12:ab:34', 'D8:B3:70:12:AB:34', 'd8-b3-70-12-ab-34', 'D8B37012AB34', ' d8b37012ab34 '];
  for (const form of forms) {
    assertEqual(canonMac(form), 'd8b37012ab34', form);
  }
});

test('different MACs stay different', () => {
  const a = canonMac('d8:b3:70:12:ab:34');
  const b = canonMac('d8:b3:70:12:ab:35');
  if (a === b) throw new Error(`distinct MACs collided on ${a}`);
});

test('empty input canonicalizes to the empty string', () => {
  assertEqual(canonMac(''), '', 'empty');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
