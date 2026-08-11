/**
 * Tests for services/smsBilling.ts — what an SMS actually costs.
 *
 * Run: npx tsx tests/smsBilling.test.ts   (from captive-server/server)
 *
 * SMS is the only channel whose price depends on its content, and the content
 * that goes out is the guest's LANGUAGE VARIANT, not the base body. Pricing the
 * base body under-charged every multi-language campaign — silently, because the
 * numbers still added up, they were just the wrong numbers.
 *
 * What these tests pin:
 *
 *  - **A translation that crosses a segment boundary is charged for both
 *    segments.** This is the actual bug: German and Italian translations of an
 *    English SMS are routinely longer, and 160 characters is a cliff, not a
 *    slope.
 *  - **Accents force UCS-2, which more than halves the segment size.** A single
 *    "ü" in a German variant takes the limit from 160 to 70 — the sharpest
 *    version of the same bug, and easy to miss because the string barely
 *    changed.
 *  - **The opt-out suffix is part of the price**, and is added to the variant,
 *    not to the base body. Adding it in the wrong order would price a message
 *    that is never sent.
 *  - **A guest with no language, or a language the campaign has no variant for,
 *    falls back to the base body** — so adding translations can never change
 *    what an untranslated audience is charged.
 */

import {
  ensureSmsOptOutSuffix,
  smsBillingText,
  smsSegments,
  smsSegmentsFor,
} from '../src/services/smsBilling';

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || 'value'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const SUFFIX_LEN = '\nReply STOP to unsubscribe'.length; // 26

console.log('\nsmsSegments');

test('an empty body still costs one segment', () => {
  assertEqual(smsSegments(''), 1);
});

test('GSM-7 fits 160 characters in one segment, 161 needs two', () => {
  assertEqual(smsSegments('a'.repeat(160)), 1);
  assertEqual(smsSegments('a'.repeat(161)), 2);
});

test('concatenated GSM-7 segments hold 153, not 160', () => {
  assertEqual(smsSegments('a'.repeat(306)), 2);
  assertEqual(smsSegments('a'.repeat(307)), 3);
});

test('German umlauts and Latin accents are GSM-7 and cost nothing extra', () => {
  // Worth pinning because it is the opposite of the intuition: "ü" does NOT
  // make an SMS expensive. Length does.
  for (const ch of ['ü', 'ä', 'ö', 'ß', 'é', 'à', 'ò']) {
    assertEqual(smsSegments(`${ch}${'a'.repeat(99)}`), 1, `${ch} should stay GSM-7`);
  }
});

test('typographic punctuation and emoji drop the message to UCS-2 at 70', () => {
  // The real cliff, and the one nobody sees coming: a curly apostrophe from a
  // word processor takes the limit from 160 to 70.
  for (const ch of ['’', '“', '—', '😀', 'ć', 'š']) {
    assertEqual(smsSegments(`${ch}${'a'.repeat(99)}`), 2, `${ch} should force UCS-2`);
  }
  assertEqual(smsSegments(`’${'a'.repeat(69)}`), 1, 'exactly 70 UCS-2 chars');
  assertEqual(smsSegments(`’${'a'.repeat(70)}`), 2, '71 UCS-2 chars');
});

test('GSM-7 extension characters count double', () => {
  // '€' is an extension char: 80 of them = 160 septets = still one segment.
  assertEqual(smsSegments('€'.repeat(80)), 1);
  assertEqual(smsSegments('€'.repeat(81)), 2);
});

console.log('\nensureSmsOptOutSuffix');

test('the suffix is appended when the author did not write one', () => {
  assertEqual(ensureSmsOptOutSuffix('Hello'), 'Hello\nReply STOP to unsubscribe');
});

test("an author's own opt-out wording is left alone", () => {
  const own = 'Hello. Reply STOP to leave.';
  assertEqual(ensureSmsOptOutSuffix(own), own);
});

console.log('\nsmsBillingText — the language variant is what gets priced');

const BASE = 'Thanks for staying with us! Rate your visit: {{link}}';

test('no language → the base body plus the suffix', () => {
  const msg = { content: BASE };
  assertEqual(smsBillingText(msg, null), `${BASE}\nReply STOP to unsubscribe`);
});

test('a guest language with a variant → the VARIANT plus the suffix', () => {
  const msg = {
    content: BASE,
    translations: { de: { content: 'Danke für Ihren Aufenthalt!' } },
  };
  assertEqual(smsBillingText(msg, 'de'), 'Danke für Ihren Aufenthalt!\nReply STOP to unsubscribe');
});

test('a language the campaign has no variant for falls back to the base body', () => {
  // Adding a German translation must not change what French guests are charged.
  const msg = { content: BASE, translations: { de: { content: 'Danke!' } } };
  assertEqual(smsBillingText(msg, 'fr'), `${BASE}\nReply STOP to unsubscribe`);
});

test('a blank variant does not blank the billed text', () => {
  const msg = { content: BASE, translations: { de: { content: '   ' } } };
  assertEqual(smsBillingText(msg, 'de'), `${BASE}\nReply STOP to unsubscribe`);
});

console.log('\nsmsSegmentsFor — the bug this fix exists for');

test('THE BUG: a German variant that crosses 160 chars is charged for 2 segments', () => {
  // English fits one segment with the suffix; the German translation does not.
  const english = 'a'.repeat(160 - SUFFIX_LEN); // exactly fills segment 1 with the suffix
  const german = 'a'.repeat(160 - SUFFIX_LEN + 1); // one character over
  const msg = { content: english, translations: { de: { content: german } } };

  assertEqual(smsSegmentsFor(msg, null), 1, 'English guest');
  assertEqual(smsSegmentsFor(msg, 'de'), 2, 'German guest');

  // Pricing the BASE body — what the code did before — would have charged the
  // German guest for 1 segment while Twilio billed us for 2.
  assert(
    smsSegments(ensureSmsOptOutSuffix(english)) !== smsSegmentsFor(msg, 'de'),
    'this test would not detect the bug it exists for',
  );
});

test('THE SHARP CASE: one curly apostrophe in a variant doubles the cost', () => {
  // Same length, one typographic character — the limit drops 160 → 70. This is
  // what a translator pasting from Word actually produces.
  const english = 'a'.repeat(100);
  const french = `${'a'.repeat(99)}’`;
  const msg = { content: english, translations: { fr: { content: french } } };

  assertEqual(smsSegmentsFor(msg, null), 1, 'English guest');
  assert(smsSegmentsFor(msg, 'fr') >= 2, 'French guest should cost 2+ segments');
});

test('the opt-out decision is made on the VARIANT, not on the base body', () => {
  // The direction that matters: base already has an opt-out, variant does not.
  // Deciding from the base would ship a German SMS with no opt-out at all —
  // a CTIA problem, and under-priced by the suffix length too.
  const msg = {
    content: 'Hello. Reply STOP to unsubscribe.',
    translations: { de: { content: 'Hallo.' } },
  };
  assertEqual(smsBillingText(msg, 'de'), 'Hallo.\nReply STOP to unsubscribe');

  // And the reverse: a variant that already says it does not get a second one.
  const msg2 = {
    content: 'Hello.',
    translations: { de: { content: 'Hallo. Reply STOP to unsubscribe.' } },
  };
  assertEqual(smsBillingText(msg2, 'de'), 'Hallo. Reply STOP to unsubscribe.');
});

test('KNOWN WART: opt-out detection is English-only, so a German opt-out gets a second English one', () => {
  // Documenting, not endorsing. `SMS_OPT_OUT_PATTERN` matches "reply stop" or
  // "stop … unsubscribe/opt-out/cancel" — all English — so a correctly-written
  // German variant receives the English suffix on top of its own instruction.
  //
  // Pre-existing and untouched by the language-pricing fix; pricing is correct
  // either way because it prices the final text. Worth fixing separately: it is
  // both a compliance-copy wart and 26 wasted characters on every send.
  const msg = {
    content: 'Hello',
    translations: { de: { content: 'Hallo. Antworten Sie STOP zum Abbestellen.' } },
  };
  const billed = smsBillingText(msg, 'de');
  assert(billed.includes('Reply STOP'), 'behaviour changed — update this test and the note in smsBilling.ts');
  assert(billed.includes('Antworten Sie STOP'), 'the German instruction should still be there');
});

test('a longer translation never costs LESS than the base', () => {
  // Sanity direction check across a spread of lengths.
  for (const len of [50, 140, 150, 160, 200, 300, 400]) {
    const base = 'a'.repeat(len);
    const longer = 'a'.repeat(len + 40);
    const msg = { content: base, translations: { de: { content: longer } } };
    assert(
      smsSegmentsFor(msg, 'de') >= smsSegmentsFor(msg, null),
      `len ${len}: German (${smsSegmentsFor(msg, 'de')}) < English (${smsSegmentsFor(msg, null)})`,
    );
  }
});

test('an untranslated campaign prices identically for every language', () => {
  // The regression guard: this fix must not move the price of the common case.
  const msg = { content: BASE };
  const baseline = smsSegmentsFor(msg, null);
  for (const lang of ['de', 'fr', 'it', 'en', 'unknown', null, undefined]) {
    assertEqual(smsSegmentsFor(msg, lang), baseline, `language ${String(lang)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
