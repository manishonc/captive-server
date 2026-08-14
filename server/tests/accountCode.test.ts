/**
 * Tests for the account code — the credential a venue installer types into the AP Adoption
 * Helper to register an access point without an admin.
 *
 * Run: npx tsx tests/accountCode.test.ts   (from captive-server/server)
 *
 * Covers services/accountCode.ts and services/secretBox.ts. Both are pure (no Firestore, no
 * controller), so this runs with no credentials — services/adoptionCodes.ts holds everything
 * that touches the database and is exercised by the curl checks in the go-live plan.
 *
 * These matter because the code is the ONLY thing authenticating a public, internet-facing
 * endpoint that creates access points and applies WiFi settings. Specifically:
 *   - the alphabet must keep excluding confusable glyphs, or installers mistype constantly;
 *   - normalization must NOT fold lookalikes, or the accepted input space silently widens;
 *   - the doc id must stay peppered, or a leaked database is brute-forceable offline.
 */

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  accountCodeDocId,
  checkAccountCode,
  formatAccountCode,
  generateAccountCode,
  maskAccountCode,
  normalizeAccountCode,
} from '../src/services/accountCode';
import {
  __resetSecretBoxKeyCache,
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  isSealedSecret,
} from '../src/services/secretBox';

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

console.log('\nalphabet — the anti-typo guarantee');

test('excludes every confusable glyph', () => {
  for (const c of 'ILO01') {
    if (CODE_ALPHABET.includes(c)) throw new Error(`${c} must not be in the alphabet`);
  }
  assertEqual(CODE_ALPHABET.length, 31);
});

test('has no duplicate characters', () => {
  assertEqual(new Set(CODE_ALPHABET.split('')).size, CODE_ALPHABET.length);
});

console.log('\ngenerateAccountCode');

test('produces well-formed codes, every time', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateAccountCode();
    assertEqual(code.length, CODE_LENGTH, 'length');
    for (const c of code) {
      if (!CODE_ALPHABET.includes(c)) throw new Error(`generated out-of-alphabet char ${c}`);
    }
    if (!checkAccountCode(code).ok) throw new Error(`generated code failed its own check: ${code}`);
  }
});

test('does not repeat itself over a small sample', () => {
  // Not a randomness test — just a smoke check that the generator isn't returning a constant.
  const seen = new Set(Array.from({ length: 50 }, () => generateAccountCode()));
  if (seen.size < 45) throw new Error(`suspiciously few distinct codes: ${seen.size}/50`);
});

console.log('\nnormalize / format');

test('strips separators and uppercases', () => {
  assertEqual(normalizeAccountCode(' h7k2-m9qx '), 'H7K2M9QX');
  assertEqual(normalizeAccountCode('h7k2 m9qx'), 'H7K2M9QX');
  assertEqual(normalizeAccountCode('H7K2_M9QX'), 'H7K2M9QX');
});

test('formats progressively for as-you-type input', () => {
  assertEqual(formatAccountCode('h7k2m9qx'), 'H7K2-M9QX');
  assertEqual(formatAccountCode('h7k'), 'H7K');
  assertEqual(formatAccountCode('h7k2'), 'H7K2');
  assertEqual(formatAccountCode('h7k2m'), 'H7K2-M');
});

test('normalize/format round-trips', () => {
  const code = generateAccountCode();
  assertEqual(normalizeAccountCode(formatAccountCode(code)), code);
});

test('does NOT fold lookalikes into the alphabet', () => {
  // Folding O->0 would widen the accepted input space for no usability gain, because the
  // alphabet already excludes both sides of the pair. An O must stay an O, and be rejected.
  assertEqual(normalizeAccountCode('H7K2-M9OX'), 'H7K2M9OX');
  assertEqual(checkAccountCode('H7K2-M9OX').ok, false);
});

console.log('\ncheckAccountCode — why, not just no');

test('accepts a well-formed code', () => {
  assertEqual(checkAccountCode('H7K2-M9QX'), { value: 'H7K2M9QX', ok: true });
});

test('reports confusable characters BEFORE length', () => {
  // Someone read O for Q, or 0 for a letter, off a screen. Telling them "too short" here
  // would send them hunting for a missing character that isn't missing.
  assertEqual(checkAccountCode('H7K2-M9O').problem, 'confusable');
  assertEqual(checkAccountCode('H7K2-M9Q0').problem, 'confusable');
  assertEqual(checkAccountCode('1LO').problem, 'confusable');
});

test('distinguishes the remaining failure modes', () => {
  assertEqual(checkAccountCode('').problem, 'empty');
  assertEqual(checkAccountCode('   ').problem, 'empty');
  assertEqual(checkAccountCode(null).problem, 'empty');
  assertEqual(checkAccountCode('H7K').problem, 'too_short');
  assertEqual(checkAccountCode('H7K2-M9QXZ').problem, 'too_long');
  assertEqual(checkAccountCode('H7K2-M9Q!').problem, 'bad_char');
});

console.log('\naccountCodeDocId — peppered, never the raw code');

test('refuses to hash without a pepper', () => {
  const saved = process.env.ADOPTION_CODE_PEPPER;
  delete process.env.ADOPTION_CODE_PEPPER;
  try {
    // An unpeppered SHA-256 of an 8-char code from a published 31-char alphabet is
    // brute-forceable offline in seconds — failing loudly beats degrading silently.
    assertThrows(() => accountCodeDocId('H7K2M9QX'), 'missing pepper');
  } finally {
    if (saved === undefined) delete process.env.ADOPTION_CODE_PEPPER;
    else process.env.ADOPTION_CODE_PEPPER = saved;
  }
});

test('is stable, hex, and never contains the code', () => {
  process.env.ADOPTION_CODE_PEPPER = 'test-pepper';
  const id = accountCodeDocId('H7K2M9QX');
  assertEqual(id, accountCodeDocId('H7K2M9QX'), 'stability');
  assertEqual(/^[0-9a-f]{64}$/.test(id), true, 'hex sha256');
  assertEqual(id.includes('H7K2M9QX'), false, 'must not embed the code');
});

test('canonicalizes before hashing, so display form and wire form agree', () => {
  process.env.ADOPTION_CODE_PEPPER = 'test-pepper';
  assertEqual(accountCodeDocId('h7k2-m9qx'), accountCodeDocId('H7K2M9QX'));
});

test('changing the pepper changes the id', () => {
  process.env.ADOPTION_CODE_PEPPER = 'pepper-a';
  const a = accountCodeDocId('H7K2M9QX');
  process.env.ADOPTION_CODE_PEPPER = 'pepper-b';
  const b = accountCodeDocId('H7K2M9QX');
  if (a === b) throw new Error('pepper had no effect on the hash');
});

console.log('\nmaskAccountCode — logs must never carry a live code');

test('hides the second half', () => {
  assertEqual(maskAccountCode('H7K2-M9QX'), 'H7K2-••••');
  assertEqual(maskAccountCode('H7K'), '••••');
  assertEqual(maskAccountCode(''), '••••');
});

console.log('\nsecretBox — the displayable copy');

const TEST_KEY_ENV = 'ADOPTION_CODE_ENCRYPTION_KEY';

test('reports an unconfigured key', () => {
  const saved = process.env[TEST_KEY_ENV];
  delete process.env[TEST_KEY_ENV];
  __resetSecretBoxKeyCache();
  try {
    assertEqual(isEncryptionConfigured(TEST_KEY_ENV), false);
    assertThrows(() => encryptSecret('x', TEST_KEY_ENV), 'missing key');
  } finally {
    if (saved === undefined) delete process.env[TEST_KEY_ENV];
    else process.env[TEST_KEY_ENV] = saved;
    __resetSecretBoxKeyCache();
  }
});

test('rejects a key of the wrong length', () => {
  process.env[TEST_KEY_ENV] = Buffer.alloc(16).toString('base64');
  __resetSecretBoxKeyCache();
  assertThrows(() => encryptSecret('x', TEST_KEY_ENV), '16-byte key');
});

test('round-trips a code', () => {
  process.env[TEST_KEY_ENV] = Buffer.alloc(32, 7).toString('base64');
  __resetSecretBoxKeyCache();
  const code = generateAccountCode();
  const sealed = encryptSecret(code, TEST_KEY_ENV);
  assertEqual(isSealedSecret(sealed), true, 'shape');
  assertEqual(sealed.ciphertext.includes(code), false, 'ciphertext must not contain plaintext');
  assertEqual(decryptSecret(sealed, TEST_KEY_ENV), code);
});

test('uses a fresh nonce per seal', () => {
  process.env[TEST_KEY_ENV] = Buffer.alloc(32, 7).toString('base64');
  __resetSecretBoxKeyCache();
  const a = encryptSecret('H7K2M9QX', TEST_KEY_ENV);
  const b = encryptSecret('H7K2M9QX', TEST_KEY_ENV);
  if (a.iv === b.iv) throw new Error('IV reuse — catastrophic for GCM');
  if (a.ciphertext === b.ciphertext) throw new Error('deterministic ciphertext');
});

test('detects tampering', () => {
  process.env[TEST_KEY_ENV] = Buffer.alloc(32, 7).toString('base64');
  __resetSecretBoxKeyCache();
  const sealed = encryptSecret('H7K2M9QX', TEST_KEY_ENV);
  const flipped = Buffer.from(sealed.ciphertext, 'base64');
  flipped[0] ^= 0xff;
  assertThrows(
    () => decryptSecret({ ...sealed, ciphertext: flipped.toString('base64') }, TEST_KEY_ENV),
    'tampered ciphertext',
  );
});

test('a wrong key fails closed rather than returning garbage', () => {
  process.env[TEST_KEY_ENV] = Buffer.alloc(32, 7).toString('base64');
  __resetSecretBoxKeyCache();
  const sealed = encryptSecret('H7K2M9QX', TEST_KEY_ENV);
  process.env[TEST_KEY_ENV] = Buffer.alloc(32, 9).toString('base64');
  __resetSecretBoxKeyCache();
  assertThrows(() => decryptSecret(sealed, TEST_KEY_ENV), 'wrong key');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
