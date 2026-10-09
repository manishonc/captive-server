/**
 * Tests for services/birthdayMonth.ts — what the splash's Birthday month field accepts.
 *
 * Run: npx tsx tests/birthdayMonth.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials. A skipped or junk answer must be null, because null is
 * what keeps an earlier answer on the guest and the profile.
 */

import { parseBirthdayMonth } from '../src/services/birthdayMonth';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\nbirthdayMonth');

test('a month number 1–12 is kept', () => {
  eq(parseBirthdayMonth(1), 1, 'January');
  eq(parseBirthdayMonth(12), 12, 'December');
});

test('its digits as a string are kept (a form post)', () => {
  eq(parseBirthdayMonth('3'), 3, '"3"');
  eq(parseBirthdayMonth(' 07 '), 7, '" 07 "');
});

test('skipped, out of range or junk is null', () => {
  for (const raw of [undefined, null, '', ' ', 0, 13, -1, 2.5, '13', '0', 'March', '2026-03', '3.0', NaN, true, {}, []]) {
    eq(parseBirthdayMonth(raw), null, JSON.stringify(raw) ?? String(raw));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
