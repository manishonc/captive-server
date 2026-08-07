/**
 * Tests for services/guestLanguage.ts — the single place three different
 * subsystems agree on what a guest's language means.
 *
 * Run: npx tsx tests/guestLanguage.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials. The distinctions asserted here are the ones
 * that change who receives what:
 *   - null (unknown) is NOT the same as 'en' (chose English)
 *   - an absent language filter matches everyone, so adding the field cannot
 *     silently shrink an existing campaign's audience
 *   - a variant overrides only the fields it defines, so a half-authored
 *     translation degrades to the base copy rather than sending blanks
 */

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  UNKNOWN_LANGUAGE,
  languageOrDefault,
  matchesLanguageFilter,
  normalizeLanguage,
  resolveVariant,
} from '../src/services/guestLanguage';

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

console.log('\nnormalizeLanguage');
test('accepts every supported code', () => {
  SUPPORTED_LANGUAGES.forEach((code) => assertEqual(normalizeLanguage(code), code));
});
test('collapses a regional tag to its base (de-CH → de)', () => {
  assertEqual(normalizeLanguage('de-CH'), 'de');
});
test('collapses an underscore locale (en_US → en)', () => {
  assertEqual(normalizeLanguage('en_US'), 'en');
});
test('is case- and whitespace-insensitive', () => {
  assertEqual(normalizeLanguage('  FR  '), 'fr');
});
test('returns null for an unsupported language rather than defaulting', () => {
  assertEqual(normalizeLanguage('es'), null);
});
test('returns null for non-strings', () => {
  assertEqual(normalizeLanguage(undefined), null);
  assertEqual(normalizeLanguage(null), null);
  assertEqual(normalizeLanguage(42), null);
  assertEqual(normalizeLanguage({ language: 'de' }), null);
});
test('languageOrDefault falls back to English', () => {
  assertEqual(languageOrDefault('es'), DEFAULT_LANGUAGE);
  assertEqual(languageOrDefault('it'), 'it');
});

console.log('\nresolveVariant');
const message = {
  id: 'm1',
  channel: 'email' as const,
  delayMinutes: 30,
  subject: 'Welcome',
  body: 'Thanks for visiting',
  translations: {
    de: { subject: 'Willkommen', body: 'Danke für Ihren Besuch' },
    fr: { subject: 'Bienvenue' },
    it: { subject: '   ' },
  },
};

test('overlays the guest language variant', () => {
  const out = resolveVariant(message, 'de');
  assertEqual(out.subject, 'Willkommen');
  assertEqual(out.body, 'Danke für Ihren Besuch');
});
test('a field the variant omits keeps the base (default-language) value', () => {
  const out = resolveVariant(message, 'fr');
  assertEqual(out.subject, 'Bienvenue');
  assertEqual(out.body, 'Thanks for visiting');
});
test('a blank variant field does not blank the message', () => {
  assertEqual(resolveVariant(message, 'it').subject, 'Welcome');
});
test('no variant for this language → base message unchanged', () => {
  assertEqual(resolveVariant(message, 'en'), message);
});
test('unknown guest language → base message unchanged', () => {
  assertEqual(resolveVariant(message, null), message);
  assertEqual(resolveVariant(message, 'es'), message);
});
test('structural fields survive the overlay', () => {
  const out = resolveVariant(message, 'de');
  assertEqual(out.id, 'm1');
  assertEqual(out.channel, 'email');
  assertEqual(out.delayMinutes, 30);
});
test('the base message object is not mutated', () => {
  resolveVariant(message, 'de');
  assertEqual(message.subject, 'Welcome');
});
test('a message with no translations block is returned as-is', () => {
  const plain = { id: 'm2', subject: 'Hi' };
  assertEqual(resolveVariant(plain, 'de'), plain);
});

console.log('\nmatchesLanguageFilter');
test('no filter matches every guest, including unknown', () => {
  assertEqual(matchesLanguageFilter('de', undefined), true);
  assertEqual(matchesLanguageFilter(null, undefined), true);
  assertEqual(matchesLanguageFilter('de', ''), true);
});
test('a language filter matches only that language', () => {
  assertEqual(matchesLanguageFilter('de', 'de'), true);
  assertEqual(matchesLanguageFilter('fr', 'de'), false);
});
test('a language filter matches a regional variant of itself', () => {
  assertEqual(matchesLanguageFilter('de-CH', 'de'), true);
});
test('a language filter excludes guests with no language recorded', () => {
  assertEqual(matchesLanguageFilter(null, 'de'), false);
  assertEqual(matchesLanguageFilter(undefined, 'en'), false);
});
test("'unknown' selects exactly the guests with no language recorded", () => {
  assertEqual(matchesLanguageFilter(undefined, UNKNOWN_LANGUAGE), true);
  assertEqual(matchesLanguageFilter('de', UNKNOWN_LANGUAGE), false);
});
test("a guest whose stored language is no longer supported counts as unknown", () => {
  // The venue removed Spanish, or the code was written by an older build: the
  // guest is still reachable, just not by a language-targeted send.
  assertEqual(matchesLanguageFilter('es', UNKNOWN_LANGUAGE), true);
  assertEqual(matchesLanguageFilter('es', 'en'), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
