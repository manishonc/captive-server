import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  checkAccountCode,
  formatAccountCode,
  maskAccountCode,
  normalizeAccountCode,
} from '../src/main/lib/account-code';

test('normalize strips separators and uppercases', () => {
  assert.equal(normalizeAccountCode(' h7k2-m9qx '), 'H7K2M9QX');
  assert.equal(normalizeAccountCode('h7k2 m9qx'), 'H7K2M9QX');
  assert.equal(normalizeAccountCode('H7K2_M9QX'), 'H7K2M9QX');
});

test('normalize never drops unknown characters', () => {
  // Dropping would shift the rest left and silently turn a typo into a different code.
  assert.equal(normalizeAccountCode('H7K2-M9Q!'), 'H7K2M9Q!');
});

test('format inserts the dash after four characters, progressively', () => {
  assert.equal(formatAccountCode('h7k2m9qx'), 'H7K2-M9QX');
  assert.equal(formatAccountCode('h7k'), 'H7K');
  assert.equal(formatAccountCode('h7k2'), 'H7K2');
  assert.equal(formatAccountCode('h7k2m'), 'H7K2-M');
});

test('format truncates past the code length', () => {
  assert.equal(formatAccountCode('h7k2m9qxZZZ'), 'H7K2-M9QX');
});

test('a well-formed code passes', () => {
  assert.deepEqual(checkAccountCode('H7K2-M9QX'), { value: 'H7K2M9QX', ok: true });
});

test('confusable characters are reported before length', () => {
  // Someone read O for Q off a screen. "Too short" would send them hunting for a
  // character that is not actually missing.
  assert.equal(checkAccountCode('H7K2-M9O').problem, 'confusable');
  assert.equal(checkAccountCode('H7K2-M9Q0').problem, 'confusable');
  assert.equal(checkAccountCode('1').problem, 'confusable');
});

test('the remaining failure modes are distinguishable', () => {
  assert.equal(checkAccountCode('').problem, 'empty');
  assert.equal(checkAccountCode('   ').problem, 'empty');
  assert.equal(checkAccountCode('H7K').problem, 'too_short');
  assert.equal(checkAccountCode('H7K2-M9QXZ').problem, 'too_long');
  assert.equal(checkAccountCode('H7K2-M9Q!').problem, 'bad_char');
});

test('the alphabet excludes every confusable character', () => {
  for (const c of 'ILO01') {
    assert.ok(!CODE_ALPHABET.includes(c), `${c} must not be in the alphabet`);
  }
  assert.equal(CODE_ALPHABET.length, 31);
  assert.equal(CODE_LENGTH, 8);
});

test('mask never reveals the second half', () => {
  // The "Copy log" button emails the whole ring buffer to support.
  assert.equal(maskAccountCode('H7K2-M9QX'), 'H7K2-••••');
  assert.equal(maskAccountCode('H7K'), '••••');
  assert.equal(maskAccountCode(''), '••••');
});

// The renderer cannot import from main — it is a classic script with no module loader — so
// it keeps its own copy of these helpers. Nothing but this test stops the two drifting apart,
// and a drift means the app accepts codes the server rejects (or vice versa).
test('the renderer copy uses the same alphabet and length', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/renderer/account-code.ts'),
    'utf8',
  );
  assert.ok(
    src.includes(`const CODE_ALPHABET = '${CODE_ALPHABET}'`),
    'src/renderer/account-code.ts alphabet has drifted from src/main/lib/account-code.ts',
  );
  assert.ok(
    src.includes(`const CODE_LENGTH = ${CODE_LENGTH}`),
    'src/renderer/account-code.ts length has drifted from src/main/lib/account-code.ts',
  );
});
