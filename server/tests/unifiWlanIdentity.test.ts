/**
 * Tests for the two identity rules that replaced global SSID uniqueness.
 *
 * Run: npx tsx tests/unifiWlanIdentity.test.ts   (from captive-server/server)
 *
 * Covers `venueApGroupName` and `validateSsid`. Both are pure; neither touches Firestore
 * nor the controller, so this runs with no credentials. `validateSsid` was moved out of
 * services/unifiWlan.ts (which imports ../firebase, whose import-time init needs real
 * credentials) into services/unifi.ts for exactly that reason; unifiWlan re-exports it.
 *
 * Why these matter: SSIDs are deliberately no longer unique across the shared controller,
 * so the only things keeping two tenants' networks apart are (a) the AP group name being
 * derived from the venue id rather than the venue's display name, and (b) WLAN lookup
 * keying on that group. A regression in either silently hands one tenant's access points
 * to another tenant's WLAN.
 */

import { venueApGroupName, validateSsid } from '../src/services/unifi';

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

function assertThrows(fn: () => unknown, label: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected a throw, got none`);
}

console.log('\nvenueApGroupName — the cross-tenant separator');

test('derives from the venue id, not the display name', () => {
  assertEqual(venueApGroupName('abc123'), 'venue-abc123');
});

test('two venues sharing a display name still get distinct groups', () => {
  // The exact bug this replaced: both venues were called "The Coffee House", so the
  // second one adopted the first one's group and overwrote its device_macs.
  const a = venueApGroupName('venueAAA');
  const b = venueApGroupName('venueBBB');
  if (a === b) throw new Error(`distinct venues collided on ${a}`);
});

test('is stable across venue renames', () => {
  assertEqual(venueApGroupName('v1'), venueApGroupName('v1'));
});

console.log('\nvalidateSsid — byte-limited, control-char free, duplicates allowed');

test('accepts an ordinary name', () => {
  assertEqual(validateSsid('Cafe Rosa Guest'), 'Cafe Rosa Guest');
});

test('trims surrounding whitespace', () => {
  assertEqual(validateSsid('  Guest WiFi  '), 'Guest WiFi');
});

test('rejects empty and whitespace-only', () => {
  assertThrows(() => validateSsid(''), 'empty');
  assertThrows(() => validateSsid('   '), 'whitespace-only');
  assertThrows(() => validateSsid(null), 'null');
});

test('counts BYTES, not characters, at the 32 limit', () => {
  // 32 ASCII characters: fine.
  assertEqual(validateSsid('a'.repeat(32)).length, 32);
  // 32 characters but 64 bytes — the controller would have rejected this only AFTER
  // we had already created the AP group.
  assertThrows(() => validateSsid('é'.repeat(32)), '32 two-byte chars');
  // 30 two-byte characters = 60 bytes, also over.
  assertThrows(() => validateSsid('é'.repeat(30)), '30 two-byte chars');
  // 16 two-byte characters = 32 bytes exactly: allowed.
  assertEqual(validateSsid('é'.repeat(16)), 'é'.repeat(16));
});

test('rejects control characters', () => {
  // Built from char codes rather than written literally: a raw control character in
  // source is invisible in every diff and editor, and gets silently eaten by tooling.
  const withCode = (code: number) => `Guest${String.fromCharCode(code)}WiFi`;
  assertThrows(() => validateSsid(withCode(0x00)), 'NUL');
  assertThrows(() => validateSsid(withCode(0x1b)), 'ESC');
  assertThrows(() => validateSsid(withCode(0x7f)), 'DEL');
  assertThrows(() => validateSsid(withCode(0x0a)), 'LF');
});

test('does NOT reject a duplicate-looking name', () => {
  // Uniqueness is not this function's job, and is not enforced anywhere — two
  // tenants may both run "Free WiFi".
  assertEqual(validateSsid('Free WiFi'), 'Free WiFi');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
