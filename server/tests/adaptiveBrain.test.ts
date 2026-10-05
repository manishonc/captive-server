/**
 * PR F2a — the AI foundation's pure rules.
 *
 * Run: npx tsx tests/adaptiveBrain.test.ts   (from captive-server/server)
 *
 * No Firestore, no model. What these pin:
 *  - Cost: list prices per model, input / output / cache read / cache write, rounded up to the
 *    micro-dollar; unknown models aren't allowed.
 *  - Budget: at or over the month's budget (or a budget of 0) every run is skipped; the agent's
 *    runs per day; the 80 % and 100 % alerts fire once, on the run that crosses them.
 *  - Privacy scan: emails (also "%40", quoted names, non-Latin domains), phone numbers ("+"/"00"
 *    and 8+ digits, or 9+ digits with separators — any Unicode space or dash, fullwidth digits;
 *    not glued to letters; dates, times and two-decimal amounts never count; a whole number of
 *    9–15 digits), the job's secret values (without case, accents, invisible characters or
 *    spacing; digits as whole numbers outside dates, words as whole words; strings and keys,
 *    never numbers) — the finding names the path, never the value: a key that holds data or
 *    isn't a plain field name is `<key #n>`.
 *  - Answers: only a normal end is read (refusal, cut off, other stops, no text, not JSON, wrong
 *    shape are rejected); the schema is checked again (enums and ranges aren't enforced upstream).
 *  - Numbers in the reasoning must be in the input (values and keys), the prompt or the schema
 *    (rounding, % of fractions, "percent", decimal commas, thousands separators); a unit after a
 *    number or a currency before it is still a claim; labels like "GSM-7" and small counts are not.
 *  - The model client: a 200 that isn't a message is a setup error; each HTTP status / SDK error
 *    maps to retryable, setup or bad_request with the upstream words; the SDK's structured-output
 *    helper builds the ping schema.
 *  - The gate: Test connection and the dev route run while the switch is off; a scheduled run
 *    needs the agent on, the AI switch on (the account's override first) and the account live.
 *  - The launch card: turning the AI agents on needs "AI ON" (also an account's explicit "on" while
 *    the default is on), off is one click; a higher budget is "LOOSEN LIMITS", a lower one is one click.
 *  - The ping job: a 4-digit nonce per run id, its valid answer passes every check, a wrong echo fails.
 *  - A claimed task's request: an unreadable trigger reads as `schedule` (the strictest gates).
 */

import { costMicroUsd, isKnownModel, microToUsd, MODELS, MODEL_IDS } from '../src/adaptive/brain/models';
import { budgetBlock, counterValue, crossedLevels, dayKeyOf, monthKeyOf } from '../src/adaptive/brain/budget';
import { looksLikePhone, scanPackage } from '../src/adaptive/brain/privacy';
import { evaluateAnswer, givenNumbers, numbersCheck, quotedNumbers, unexplainedNumbers } from '../src/adaptive/brain/checks';
import { classifyModelError, ModelError, outputFormatFor, relayClient, toReply } from '../src/adaptive/brain/modelClient';
import Anthropic from '@anthropic-ai/sdk';
import { gateFor } from '../src/adaptive/brain/gate';
import { requestOf, testConnectionTask, agentRunTask } from '../src/adaptive/brain/tasks';
import { pingJob, pingNonce, pingOutputSchema } from '../src/adaptive/brain/jobs/ping';
import { AGENT_KEYS, jobFor } from '../src/adaptive/brain/registry';
import { applyChange, summarizeChange, type LaunchState } from '../src/adaptive/core/runtime/launch';
import type { EngineSettings } from '../src/adaptive/store/engineSettings';

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

function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Async tests run one after another, after the sync ones. */
let chain: Promise<void> = Promise.resolve();
function atest(name: string, fn: () => Promise<void>) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
    }
  });
}

const OPUS = MODELS['anthropic/claude-opus-5.5'];
const SONNET = MODELS['anthropic/claude-sonnet-5.5'];

console.log('\nCost');

test('Opus 5.5 at list price: 1,000 in + 500 out = $0.014', () => {
  eq(costMicroUsd({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, OPUS), 14_000, 'micro-USD');
  eq(microToUsd(14_000), 0.014, 'dollars, to the micro-dollar');
});

test('cache reads and writes are priced on their own (Sonnet 5.5)', () => {
  // 2,000 cache read × 0.2 + 1,000 cache write × 2.5 + 100 in × 2 + 100 out × 10
  eq(costMicroUsd({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 1000 }, SONNET), 400 + 2500 + 200 + 1000, 'micro-USD');
});

test('a fraction of a micro-dollar is rounded up; bad counts count as 0', () => {
  eq(costMicroUsd({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }, SONNET), 3, '2 + 0.2 → 3');
  eq(costMicroUsd({ inputTokens: -5, outputTokens: NaN as unknown as number, cacheReadTokens: 0, cacheWriteTokens: 0 }, SONNET), 0, 'nothing');
});

test('only the listed gateway models are allowed', () => {
  eq([...MODEL_IDS].sort(), ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5'], 'allow-list');
  assert(!isKnownModel('claude-opus-5-5'), 'the Anthropic id is not a gateway id');
  assert(!isKnownModel('anthropic/claude-fable-5.1'), 'not on the list');
});

console.log('\nBudget');

test('a budget of 0, or a month at or over it, skips every run', () => {
  eq(budgetBlock({ spentMicro: 0, budgetUsd: 0, runsToday: 0, maxRunsPerDay: 10 }), 'budget', 'budget 0');
  eq(budgetBlock({ spentMicro: 100_000_000, budgetUsd: 100, runsToday: 0, maxRunsPerDay: 10 }), 'budget', 'exactly used up');
  eq(budgetBlock({ spentMicro: 99_999_999, budgetUsd: 100, runsToday: 0, maxRunsPerDay: 10 }), null, 'one micro-dollar left');
});

test("the agent's runs per day", () => {
  eq(budgetBlock({ spentMicro: 0, budgetUsd: 100, runsToday: 10, maxRunsPerDay: 10 }), 'daily_limit', 'at the cap');
  eq(budgetBlock({ spentMicro: 0, budgetUsd: 100, runsToday: 0, maxRunsPerDay: 0 }), 'daily_limit', 'cap 0 = none');
});

test('80 % and 100 % fire once, on the run that crosses them', () => {
  eq(crossedLevels(79_000_000, 81_000_000, 100), [80], '80 crossed');
  eq(crossedLevels(79_000_000, 100_000_000, 100), [80, 100], 'both at once');
  eq(crossedLevels(80_000_000, 90_000_000, 100), [], 'already past 80');
  eq(crossedLevels(99_000_000, 120_000_000, 100), [100], '100 crossed');
  eq(crossedLevels(0, 1_000_000, 0), [], 'no budget, no alert levels');
});

test('a spend counter that can’t be read counts as over any budget (fails closed)', () => {
  eq([counterValue(undefined), counterValue(1234)], [0, 1234], 'missing = 0, a number as it is');
  for (const bad of ['12', NaN, -5, {}, Infinity, null]) assert(counterValue(bad) === Number.POSITIVE_INFINITY, `unreadable: ${String(bad)}`);
  eq(budgetBlock({ spentMicro: counterValue('lots'), budgetUsd: 100, runsToday: 0, maxRunsPerDay: 10 }), 'budget', 'blocked');
});

test('months and days are UTC', () => {
  const t = Date.UTC(2026, 8, 30, 23, 30); // 30 Sep 23:30 UTC (1 Oct in Zurich)
  eq(monthKeyOf(t), '202609', 'month');
  eq(dayKeyOf(t), '20260930', 'day');
});

console.log('\nPrivacy scan');

test('an email anywhere in a string is found, with its path and never the value', () => {
  const f = scanPackage({ venue: { note: 'write to anna.muster@example.ch please' } });
  eq(f, [{ kind: 'email', path: 'venue.note' }], 'finding');
  assert(!JSON.stringify(f).includes('anna'), 'no value in the finding');
});

test('phone numbers: in a row, with spaces, or international with separators', () => {
  assert(looksLikePhone('+41 79 123 45 67'), 'international with spaces');
  assert(looksLikePhone('+41-79-123-45-67'), 'international with dashes');
  assert(looksLikePhone('call 079 123 45 67'), 'local with spaces');
  assert(looksLikePhone('0791234567'), 'in a row');
  assert(!looksLikePhone('2026-09-30'), 'a date');
  assert(!looksLikePhone('09:00–17:00'), 'opening hours');
  assert(!looksLikePhone('1234567'), '7 digits');
  assert(!looksLikePhone('CHF 1 234.50'), 'an amount');
  assert(looksLikePhone('079-123-45-67'), 'local with dashes');
  assert(looksLikePhone('(079) 123 45 67'), 'brackets');
  assert(looksLikePhone('0041 79 123 45 67'), '00 prefix');
  assert(looksLikePhone('+41 44 123 45'), 'international, 9 digits');
  assert(looksLikePhone('079.123.45.67'), 'dots');
  assert(!looksLikePhone('ar_1234567890abc'), 'an id (glued to letters)');
  assert(!looksLikePhone('2026-09-30 10:00'), 'a date and time');
  assert(!looksLikePhone('2026-09-30T10:00:00.000Z'), 'an ISO time');
  assert(!looksLikePhone('12 345'), 'a count with a space');
});

test('phone numbers in any Unicode spacing, dashes or digits; split by a tab or a line; next to a date', () => {
  for (const t of [
    '079\u00a0123\u00a045\u00a067',
    '+41\u00a079\u00a0123\u00a045\u00a067',
    '079\u202f123\u202f45\u202f67',
    '079\u2009123\u200945\u200967',
    '079\u2013123\u201345\u201367',
    '079\u2011123\u201145\u201167',
    '079\u2212123\u221245\u221267',
    '\uff10\uff17\uff19 \uff11\uff12\uff13 \uff14\uff15 \uff16\uff17',
    '079\t123 45 67',
    '079 123\n45 67',
    '2026-09-30 079 123 45 67',
    'Preis 12.50, Tel 079 123 45 67',
    '06.12.34.56.78 in France',
  ]) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
});

test('dates, times, date ranges and amounts are not phone numbers', () => {
  for (const t of [
    '30.09.2026 10:00',
    'Samstag, 12.10.2026 18:00 Uhr',
    '01.10.2026 - 31.10.2026',
    '09/30/2026 10:00',
    '2026-09-01/2026-09-30',
    'nonce 4821 2026-09-30',
    '12.50 13.75 14.00 15.25',
    '2026.09.30.1',
    '2026-09-30T18:30:00.000+02:00',
    "CHF 1'234.50 and 2'345.00",
  ]) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
});

test('numbers are never compared with secrets (a count may equal a door code); a phone-long number is a phone', () => {
  eq(scanPackage({ sends: 4821, big: 12_345_678 }, ['4821']), [], 'counts pass');
  eq(scanPackage({ n: 41791234567 }), [{ kind: 'phone', path: 'n' }], 'a phone stored as a number');
  eq(scanPackage({ ms: 1.5e15, fraction: 0.123456789 }), [], 'not a whole number of 9–15 digits');
  eq(scanPackage({ hint: 'door code 4821' }, ['4821']), [{ kind: 'secret', path: 'hint' }], 'the secret in a string');
});

test('a key that holds data, or looks like a name, is named by its position, never written out', () => {
  eq(scanPackage({ AnnaMueller: { e: 'anna@example.ch' } }), [{ kind: 'email', path: '<key #0>.e' }], 'a capitalised key (a name?) is not written out');
  eq(scanPackage({ 'anna@example.ch': 1 }), [{ kind: 'email', path: '<key #0> (key)' }], 'an email key');
  eq(scanPackage({ ok: 1, byGuest: { '+41791234567': 2 } }), [{ kind: 'phone', path: 'byGuest.<key #0> (key)' }], 'a phone key, nested');
  eq(scanPackage({ 'Sunny-Terrace-99': 'x' }, ['sunny-terrace-99']), [{ kind: 'secret', path: '<key #0> (key)' }], 'a secret key');
  eq(scanPackage({ 'my key': { a: 'anna@example.ch' } }), [{ kind: 'email', path: '<key #0>.a' }], 'a key that is no identifier, clean itself');
  const f = scanPackage({ 'anna@example.ch': { note: 'call +41 79 123 45 67' } });
  eq(f, [{ kind: 'email', path: '<key #0> (key)' }, { kind: 'phone', path: '<key #0>.note' }], 'the value under it keeps the redacted path');
  assert(!JSON.stringify(f).includes('anna') && !JSON.stringify(f).includes('79'), 'no value anywhere');
});

test('secrets match without case or extra spaces; under 4 characters they are not checked', () => {
  eq(scanPackage({ a: 'Guest WiFi:  SUNNY-Terrace-99' }, ['sunny-terrace-99']), [{ kind: 'secret', path: 'a' }], 'case and spaces');
  eq(scanPackage({ a: 'code 123' }, ['123']), [], 'too short to scan');
});

test('secrets: accents, invisible characters, fullwidth and spacing do not hide them; whole words and numbers only', () => {
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).length > 0;
  assert(found('Staff: Zoë Müller', 'Zoe Muller') && found('Staff: Zoe Mueller', 'Zoë Müller'), 'accents');
  assert(found('Sun\u200bshine2024', 'Sunshine2024'), 'a zero-width space');
  assert(found('Sun\u00adshine2024', 'Sunshine2024'), 'a soft hyphen');
  assert(found('\uff33\uff55\uff4e\uff53\uff48\uff49\uff4e\uff45\uff12\uff10\uff12\uff14', 'Sunshine2024'), 'fullwidth');
  assert(found('Password: Sunshine 2024', 'Sunshine2024'), 'a space inside (8+ characters)');
  assert(found('door code 4821.', '4821'), 'a door code');
  assert(!found('since 2026-09-30', '2026'), 'a door code is not the year of a date');
  assert(!found('id 148210', '4821'), 'not inside a longer number');
  assert(!found('Cantina Weines', 'Tina'), 'not inside a word');
  assert(found("Tina's shift", 'Tina'), 'a whole word');
});

test('round 3: mixed separators, URL-encoded and "·" phones; short dates, company numbers and "00…" counts are not phones', () => {
  for (const t of [
    'Frag nach 079 123 45.67',
    '079 123.45 67',
    '044 123 45,67',
    'https://wa.me/send?phone=%2B41791234567',
    'tel:%2B41%2079%20123%2045%2067',
    '079·123·45·67',
  ]) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of [
    '01.10.26–31.10.26',
    'Gültig 1.10.26–31.12.26',
    '01.10.–31.10.26',
    '03.10. / 10.10. / 17.10. / 24.10.',
    'Kundennummer 00123456',
    'Nachtruhe 0000-0600',
    '01-10-2026 - 31-10-2026',
    'MWST CHE-123.456.789',
  ]) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
});

test('round 3: emails spelled out or entity-encoded count; profile links and "(at) the bar" do not', () => {
  const kinds = (t: string) => scanPackage({ a: t }).map((f) => f.kind);
  for (const t of ['info(at)restaurant-sonne.ch', 'info [at] restaurant-sonne.ch', 'info (at) sonne (dot) ch', 'anna@example\u3002ch', 'anna&#64;example.ch']) {
    assert(kinds(t).includes('email'), `an email: ${JSON.stringify(t)}`);
  }
  for (const t of ['tiktok.com/@cafe.zurich', 'https://www.youtube.com/@Cafe.Zurich', 'Treffpunkt (at) the bar']) {
    assert(!kinds(t).includes('email'), `not an email: ${JSON.stringify(t)}`);
  }
});

test('an IBAN with a valid check counts, spaced or not; a wrong check digit does not', () => {
  const kinds = (t: string) => scanPackage({ a: t }).map((f) => f.kind);
  assert(kinds('IBAN CH93 0076 2011 6238 5295 7').includes('iban'), 'spaced');
  assert(kinds('CH9300762011623852957').includes('iban'), 'in one piece');
  assert(!kinds('CH9300762011623852958').includes('iban'), 'a wrong check');
});

test('round 3: names and passwords as people write them', () => {
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).length > 0;
  assert(found('Frag nach Tinas Spezial-Cocktail', 'Tina'), 'a genitive');
  assert(found('Annas Brunch', 'Anna'), 'a genitive');
  assert(found('Juerg Mueller empfiehlt', 'Jürg Müller'), '"ue" for "ü"');
  assert(found('Hauptstrasse 5', 'Hauptstraße 5'), '"ss" for "ß"');
  assert(found('Chef D’Angelo', "D'Angelo") && found("Chef D'Angelo", 'D’Angelo'), 'straight and curly apostrophes');
  assert(found('Eva Lena kocht', 'Eva-Lena'), 'a space for a hyphen');
  assert(found('Code: 1234', '*1234#'), 'symbols around a door code');
  assert(found('WLAN: Gast24', 'Gast24!'), 'a symbol after a password');
  assert(found('Passwort Bar12.50', 'Bar12.50'), 'a password that looks like an amount');
  assert(!found('Hanna Bergmann', 'Anna Berg'), 'not inside other words');
  assert(!found('Martina und Annabelle', 'Tina') && !found('Annabelle', 'Anna'), 'not inside other names');
});

test('round 4: long whitespace scans fast; "+41" numbers with mixed separators; year lists and map links are not phones', () => {
  const t0 = Date.now();
  scanPackage({ a: ' '.repeat(239_000), b: '\u00a0'.repeat(60_000), c: `x${' '.repeat(100_000)}(at)` });
  assert(Date.now() - t0 < 2000, `whitespace runs scan fast (${Date.now() - t0} ms)`);
  for (const t of ['+41 79 123 45.67', '+41 79 123 45,67', '+41 44 123 45.67', '0041 79 123 45.67', '+41 79 123.45 67', 'Tel. +41 (0)44 123 45 67', 'tel:%252B41791234567']) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['2024 2025 2026', '2024 / 2025 / 2026', 'Weinkarte: 2015 2016 2018 2019', 'https://www.google.com/maps/@47.3668903,8.5410478,17z', '+12.50 Zuschlag', 'Preis +41.50 CHF']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  const kinds = (t: string) => scanPackage({ a: t }).map((f) => f.kind);
  for (const t of ['info (at) sonne (point) ch', 'anna&#64;example&#46;ch']) assert(kinds(t).includes('email'), `an email: ${JSON.stringify(t)}`);
  for (const t of [
    '/img/logo@2x.png',
    'https://www.google.com/maps/@47.3668903,8.5410478,17z',
    'Mehr Infos @ www.sonne.ch',
    'Buchen @ www.hotel-sonne.ch/brunch',
    'Sommerfest @ Seeufer.Eintritt frei',
    'Live @ Kaufleuten.Tickets ab CHF 25',
  ]) {
    assert(!kinds(t).includes('email'), `not an email: ${JSON.stringify(t)}`);
  }
});

test('round 4: umlauts as "ae/oe/ue" on both sides (names never become words); digit codes in groups', () => {
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).some((f) => f.kind === 'secret');
  assert(found('Frau Mueller', 'Müller') && found('Frau Müller', 'Mueller') && found('Frau Müller', 'Müller'), 'umlaut spellings');
  assert(!found('Komm doch mal vorbei', 'Maël') && !found('Zum ersten Mal', 'Mael'), '"Mael" is not "mal"');
  assert(!found('unsere Bar', 'Baer') && !found('schon ab 11 Uhr', 'Schoen') && !found('Abi-Party', 'Aebi'), 'names are not everyday words');
  assert(found('WLAN-Passwort: 1234 5678', '12345678') && found('Code 1234-5678', '12345678'), 'a code in groups');
  assert(found('Code 482 193', '482193') && found('Türcode 12 34', '1234'), 'a code in groups');
  for (const t of ['CHF 12.34', "1'234 Gäste", 'um 12:34', 'Tel 079 123 45 67']) assert(!found(t, '1234'), `not the code: ${JSON.stringify(t)}`);
  const huge = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
  let threw = false;
  try {
    scanPackage({ a: 'text' }, [huge]);
  } catch {
    threw = true;
  }
  assert(!threw, 'a secret of 400 parts never throws (its text would be in the error)');
});

test('round 5: plain-vowel secrets are found in umlaut text; umlaut secrets never match words; opening hours and prices are not codes; ids in links are not phones', () => {
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).some((f) => f.kind === 'secret');
  assert(found('Frag nach Frau Müller', 'Muller') && found('Frag nach Jürg', 'Jurg') && found('Chef Björn', 'Bjorn'), 'a secret stored without its umlaut');
  for (const [text, secret] of [
    ['Wir haben schon ab 11 Uhr offen', 'Schön'],
    ['Kung Pao Chicken', 'Küng'],
    ['Burger & Fries', 'Bürger'],
    ['Boni für alle', 'Böni'],
  ]) {
    assert(!found(text, secret), `${secret} is not in ${JSON.stringify(text)}`);
  }
  for (const [text, code] of [
    ['Abend 17-22 Uhr', '1722'],
    ['Öffnungszeiten 10-14 Uhr', '1014'],
    ['CHF 1 234', '1234'],
    ['Über 1 200 Gäste', '1200'],
  ]) {
    assert(!found(text, code), `${code} is not in ${JSON.stringify(text)}`);
  }
  for (const t of [
    'https://www.facebook.com/events/1234567890123456/',
    'https://www.eventbrite.ch/e/herbstfest-tickets-812345678901',
    'www.opentable.ch/restref/client?rid=123456789',
    '(2019) 2020 2021',
  ]) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['https://wa.me/41791234567', 'tel:+41791234567', 'https://example.ch/call?phone=0791234567']) assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  let threw = false;
  try {
    scanPackage({ a: 'text' }, ['1'.repeat(800), `geheim${'ä'.repeat(800)}`]);
  } catch {
    threw = true;
  }
  assert(!threw, 'secrets too long for a pattern never throw');
  const long = `${Array.from({ length: 66 }, (_, i) => `w${i}`).join(' ')} Müller`;
  assert(found(`… ${long.replace('Müller', 'Mueller')}`, long), 'a long secret keeps its umlaut');
});

test('round 6: letters with strokes; a phone behind an invisible character or glued to its label; link checks; codes digit by digit', () => {
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).some((f) => f.kind === 'secret');
  assert(found('Barkeeper Lukasz mixt heute', 'Łukasz') && found('Chef Yilmaz empfiehlt', 'Yılmaz') && found('Chef Soren', 'Søren') && found('Chef Søren', 'Soren'), 'strokes');
  for (const t of ['Tel\u200b079 123 45 67', 'Tel\u00ad0791234567', 'Tel079 123 45 67', 'Natel079 123 45 67', 'https://x.ch/?tel=41791234567', 'https://x.ch/41791234567']) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['https://docs.google.com/forms/d/e/x/viewform?entry.1234567890=Sommerfest+2026', 'facebook.com/events/1234567890123456/', '(2019)(2020)(2021)']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  assert(found('Türcode: 4 8 2 1', '4821') && found('Code 4-8-2-1', '4821') && found('Code 48 21', '4821'), 'a door code digit by digit');
  for (const t of ['CHF 4 821', '4 8-2 1']) assert(!found(t, '4821'), `not the code: ${JSON.stringify(t)}`);
  assert(!found('17-22 Uhr', '1722') && !found('Über 1 200 Gäste', '1200'), 'opening hours and counts are not codes');
});

test('round 7 (skeptic-checked): HTML entities, 3-letter names, glued labels, ids with "_", codes as written; no slow input', () => {
  const kinds = (t: string, secrets: string[] = []) => scanPackage({ a: t }, secrets).map((f) => f.kind);
  for (const t of ['Tel. 079&nbsp;123&nbsp;45&nbsp;67', '079&#160;123&#160;45&#160;67', '+41&nbsp;79&nbsp;123&nbsp;45&nbsp;67']) assert(kinds(t).includes('phone'), `a phone: ${t}`);
  assert(kinds('IBAN CH93&nbsp;0076&nbsp;2011&nbsp;6238&nbsp;5295&nbsp;7').includes('iban'), 'an IBAN with entities');
  assert(kinds('Frau M&uuml;ller', ['Müller']).includes('secret') && kinds('Sunshine&nbsp;2024', ['Sunshine2024']).includes('secret'), 'secrets with entities');
  assert(kinds('Frag nach Tim, unserem Barkeeper!', ['Tim']).includes('secret') && kinds('Mia empfiehlt die Pasta', ['Mia']).includes('secret'), '3-letter names');
  assert(!kinds('Timo und Benvenuti', ['Tim', 'Ben']).includes('secret'), 'whole words only');
  assert(!kinds('Frau Wu', ['Wu']).includes('secret'), '2 letters are never checked');
  for (const t of ['Telefon079 123 45 67', 'WhatsApp079 123 45 67', 'Reservation: +49 7531 123456Wir freuen uns', 'Tel +43 664 1234567Mo-Fr', '079 • 123 45 67', '_079 123 45 67_']) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['va_0258177156a9969969739bb1fd01f8fa', 'ar_0791234567', 'Tickets…eventbrite.ch/e/herbstfest-tickets-812345678901', 'Tickets...facebook.com/events/1234567890123456/']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  assert(kinds('WLAN-Passwort: 01.10.2026', ['01.10.2026']).includes('secret') && kinds('Code 12:34', ['12:34']).includes('secret'), 'a code with its own punctuation, as written');
  assert(!kinds('since 2026-09-30', ['2026']).includes('secret'), 'a plain code is still not the year of a date');
  assert(kinds('anna [at] sonne [.] ch').includes('email'), '"[.]" as a dot');
  let t0 = Date.now();
  scanPackage({ a: 'a.'.repeat(119_000) });
  scanPackage({ b: `a${'\u3164'.repeat(79_000)}x` });
  assert(Date.now() - t0 < 1500, `adversarial link and filler runs scan fast (${Date.now() - t0} ms)`);
  t0 = Date.now();
  unexplainedNumbers('999999.5 '.repeat(5_000), givenNumbers(Array.from({ length: 30_000 }, (_, i) => i * 7)));
  assert(Date.now() - t0 < 1500, `repeated numbers are checked once (${Date.now() - t0} ms)`);
});

test('round 7 (skeptic-checked): honest times, dates, percent words and grouped thousands pass; invented numbers still fail', () => {
  eq(unexplainedNumbers('opens at 11:30 and again at 17:30', givenNumbers({ hours: 'Mo–Fr 11.30–14.00 / 17.30–23.00' })), [], 'h.mm given, h:mm quoted');
  eq(unexplainedNumbers('um 11.30 und 17.30 Uhr', givenNumbers({ hours: '11:30–14:00 / 17:30–23:00' })), [], 'h:mm given, h.mm quoted');
  eq(unexplainedNumbers('on 17.10.', givenNumbers({ eventDate: '2026-10-17' })), [], 'an ISO date as dd.mm');
  eq(unexplainedNumbers('42 Prozent und 42 pour cent', givenNumbers({ rate: 0.42 })), [], 'percent words');
  eq(unexplainedNumbers('1 234 sends', givenNumbers({ sends: 1234 })), [], 'space-grouped thousands');
  eq(unexplainedNumbers('12.45 on average', givenNumbers({ sends: 12, clicks: 45 })), ['12.45'], 'an invented decimal from two counts');
  eq(unexplainedNumbers('about 2.05', givenNumbers({ a: 2, b: 5 })), ['2.05'], 'another');
  eq(unexplainedNumbers('12.46 on average', givenNumbers({ avg: 12.46 })), [], 'a real decimal');
});

test('round 8 (skeptic-checked): bullets, UUIDs, codes exactly as written, 3-letter names as whole words with their accents', () => {
  const kinds = (t: string, secrets: string[] = []) => scanPackage({ a: t }, secrets).map((f) => f.kind);
  for (const t of ['2023 • 2024 • 2025', '2023 ∙ 2024 ∙ 2025', '2023 ・ 2024 ・ 2025', '12345678-9012-4abc-8def-0123456789ab', '00123456-7890-4abc-8def-0123456789ab']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['079∙123∙45∙67', 'Telefon079·123·45·67', 'Tel_079 123 45 67', '+4915112345678Wir', '0041·79·123·45·67']) assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  for (const [t, s] of [['Türcode 12-34', '12-34'], ['Türcode 12–34', '12-34'], ['Türcode 1-234', '1-234']]) assert(kinds(t, [s]).includes('secret'), `a code with a dash: ${t}`);
  assert(!kinds('Pizza CHF 12.34', ['12:34']).includes('secret') && !kinds('since 2026-09-30', ['09.30']).includes('secret'), 'as written means its own punctuation');
  for (const [t, s] of [['Venez dans notre bar', 'Dan'], ['Petit mais bon', 'Mai'], ['Curry mit Reis', 'Rei'], ['è già pronto', 'Gia'], ['Öle und Essig', 'Ole'], ['unsere Bar', 'Bar!!!!!']]) {
    assert(!kinds(t, [s]).includes('secret'), `not the secret ${s}: ${t}`);
  }
  for (const [t, s] of [["Tim's Bar", 'Tim'], ['Chef Lea', 'Léa'], ['Chef Zoe', 'Zoë'], ['Wir sind Bar!!!!! Freunde', 'Bar!!!!!']]) assert(kinds(t, [s]).includes('secret'), `the secret ${s}: ${t}`);
  assert(kinds('anna&#37;40example.ch').includes('email') && kinds('anna&#37;2540example.ch').includes('email'), 'a URL escape inside a character reference');
  assert(!kinds('a&constructor;b', ['native code']).includes('secret'), 'only real entity names are read');
});

test('round 8 (skeptic-checked): a date, a time or a price is never a rate; "5 000" is one number; many numbers check fast', () => {
  eq(unexplainedNumbers('About 50 % opened it', givenNumbers({ offer: 'Mittagsmenü CHF 18.50' })), ['50%'], 'the cents of a price');
  eq(unexplainedNumbers('About 30 % opened it', givenNumbers({ hours: 'Mo–Fr 11:30–14:00' })), ['30%'], 'the minutes of a time');
  eq(unexplainedNumbers('10 % more', givenNumbers({ until: '2026-10-17' })), ['10%'], 'the month of a date');
  eq(unexplainedNumbers('31 % more', givenNumbers({ until: 'Gültig bis 31.10.2026' })), ['31%'], 'the day of a date');
  eq(unexplainedNumbers('until 31.10.', givenNumbers({ until: 'Gültig bis 31.10.2026' })), [], 'the date itself, quoted honestly');
  eq(unexplainedNumbers('50 new guests', givenNumbers({ offer: 'CHF 18.50' })), ['50'], 'a price is not a time');
  eq(unexplainedNumbers('5 000 guests visited', givenNumbers({})), ['5 000'], 'never 5 and 0');
  eq(unexplainedNumbers('1 234 sends', givenNumbers({ a: 234 })), ['1 234'], 'never 1 and 234');
  const sevens = givenNumbers(Array.from({ length: 30_000 }, (_, i) => i * 7));
  let t0 = Date.now();
  unexplainedNumbers('1 234 '.repeat(40_000), sevens);
  assert(Date.now() - t0 < 1500, `a repeated grouped number is checked once (${Date.now() - t0} ms)`);
  t0 = Date.now();
  // (A list needs commas: "98 105 112" reads as one space-grouped number.)
  eq(unexplainedNumbers(Array.from({ length: 30_000 }, (_, i) => String(i * 7)).join(', '), sevens), [], 'each explained');
  assert(Date.now() - t0 < 1500, `30,000 different numbers against 30,000 given (${Date.now() - t0} ms)`);
});

test('round 9 (skeptic-checked): "00" numbers glued to a word, the start of a UUID, degrees up to 180', () => {
  for (const t of ['Tel. 0049-7531-123456Wir freuen uns', '0033.1.23.45.67.89Réservez', '0043-664-1234567Mo-Fr', '004915112345678Wir', '(0049)7531-123456Wir', '0049 7531 123456Wir', 'Tel. 333.1234567']) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['00123456-7890-4abc', '00123456-7890-4abc-8def-0123456789ab', 'GPS 47.3668903, 8.5410478', '179.1234567']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
  const found = (text: string, secret: string) => scanPackage({ a: text }, [secret]).some((f) => f.kind === 'secret');
  assert(!found('Frag nach Tim.', 'Tim.') && found('Frag nach Tim.', 'Tim'), 'a short secret with punctuation is not checked; its letters are');
  assert(!found('Curry mit Reis Nudeln', 'Rei') && !found('Mais Chips', 'Mai'), 'still no genitive for a 3-letter name');
  eq(scanPackage({ test: 'connection', nonce: 4721, date: '2026-09-30' }), [], 'the ping package');
});

test('round 9 (skeptic-checked): grouped thousands as written in the input; readings only as they are; seconds; rate lists', () => {
  const u = (r: string, pkg: unknown) => unexplainedNumbers(r, givenNumbers(pkg));
  eq(u('Platz für 1 200 Gäste', { t: 'Platz für 1 200 Gäste' }), [], 'a space-grouped number quoted as written');
  eq(u('plus de 1 000 bouteilles', { t: 'Une cave de plus de 1 000 bouteilles' }), [], 'a narrow no-break space');
  eq(u('1,200 seats, 1200 in all', { t: 'Platz für 1 200 Gäste' }), [], 'written another way');
  eq(u('over 1,200 guests and 1 200 seats', { t: 'Über 1.200 Gäste' }), [], 'German thousands');
  eq(u('1.200 Gäste', { t: 'Über 1.200 Gäste' }), [], 'as written');
  eq(u('1,300 guests', { t: 'Über 1.200 Gäste' }), ['1300'], 'another number');
  eq(u('5 000 guests visited', { t: 'Platz für 1 200 Gäste' }), ['5 000'], 'still reported as written');
  eq(u('1 201 seats', { t: 'Platz für 1 200 Gäste' }), ['1 201'], 'not the number after it');
  eq(u('18 guests came', { until: '2026-10-17' }), ['18'], 'the day after a date');
  eq(u('19 opens', { hours: '18:30' }), ['19'], 'the hour after a time');
  eq(u('12 visits', { hours: 'Mo–Fr 11:30–14:00' }), ['12'], 'the hour after 11:30');
  eq(u('31 new guests', { test: 'connection', nonce: 4721, date: '2026-09-30' }), ['31'], 'the day after the ping date');
  eq(u('on 17.10. at 18.30, the 17th, 2026', { t: '2026-10-17T18:30:00Z' }), [], 'readings as they are');
  eq(u('on 30.09. and 30.9., nonce 4721', { test: 'connection', nonce: 4721, date: '2026-09-30' }), [], 'the ping, honestly');
  eq(u('created at 18:30:45, 2026-10-17T18:30:45.123Z', { t: '2026-10-17T18:30:45.123Z' }), [], 'seconds and their fraction');
  eq(u('doors at 19:00:30', { t: 'Türöffnung 19:00:30' }), [], 'seconds of a time');
  eq(u('46 guests', { t: '2026-10-17T18:30:45Z' }), ['46'], 'not the second after');
  eq(u('Stufenrabatt bis 20 %', { t: 'Stufenrabatt 5/10/20 %' }), [], 'a list of rates is no date');
  eq(u('bis 15 % Rabatt', { t: 'Rabatt 10-12-15%' }), [], 'with dashes');
  eq(u('bis 20 Prozent', { t: 'Rabatt 5/10/20 Prozent' }), [], 'with a percent word');
  eq(u('valid until 31.12.26', { t: 'Gutschein gültig bis 31.12.26' }), [], 'a real short date');
  eq(u('on 01.10.2026 at 18:00', { t: 'Sa01.10.2026 ab18:00' }), [], 'a date glued to its weekday is still a date');
  eq(u('50 new guests', { t: 'CHF 18.50' }), ['50'], 'a price is still not a time');
  eq(u('About 50 % opened it', { t: 'Fr. 18.50' }), ['50%'], 'nor a rate');
});

test('round 10 (skeptic-checked): "00" phones in 8-4-n groups; a UUID start only by its letters, in one case, its third group ending there', () => {
  for (const t of [
    'Tel. 00491511-2345-678',
    'Tel. 00417912-3456-7',
    'Ref 00123456-7890-1 / 0049 7531 123456',
    'id 00123456-7890-4abc 0049 7531 123456',
    'Tel. 00491511-2345-678Bitte anrufen',
    'Tel. 00491511-2345-67Ab 18 Uhr',
  ]) {
    assert(looksLikePhone(t), `a phone: ${JSON.stringify(t)}`);
  }
  for (const t of ['00123456-7890-4ABC…', '(00123456-7890-4abc)', 'https://app.example.ch/b/00123456-7890-4abc-8def-01234567…']) {
    assert(!looksLikePhone(t), `not a phone: ${JSON.stringify(t)}`);
  }
});

test('round 10 (skeptic-checked): a 4-digit year or a URL escape after a date is no rate list; "v2.100" is a label, "CHF1.200" a price', () => {
  const u = (r: string, pkg: unknown) => unexplainedNumbers(r, givenNumbers(pkg));
  eq(u('17 % more', { link: 'https://tickets.example.ch/?von=17.10.2026%2018:00' }), ['17%'], 'a URL escape after a date');
  eq(u('31 % off', { link: 'https://x.ch/?bis=31.12.26%2018:00' }), ['31%'], 'a URL escape after a short date');
  eq(u('12 % off', { t: 'bis 31.12.2026 %' }), ['12%'], 'a 4-digit year, then "%"');
  eq(u('bis 20 %', { t: 'Rabatt 5/10/20%ab 3 Flaschen' }), [], 'a rate list glued to a word');
  eq(u('bis 20 %', { t: 'Rabatt 5/10/20%25' }), [], '"%25" is a percent sign');
  eq(u('2100 downloads', { t: 'App v2.100' }), ['2100'], 'a version is a label');
  eq(u('CHF 1200 each', { t: 'Bankett CHF1.200, Apéro Fr.1.200.–' }), [], 'a price after its currency');
  eq(u('1200 Gäste', { t: '_1.200 Gäste_ erwarten dich' }), [], 'thousands in _italics_');
});

test('emails: "%40", a quoted name and a non-Latin domain count too', () => {
  for (const t of ['mailto:anna%40example.ch', '"anna"@example.ch', 'anna@beispiel.рф', 'anna@xn--bcher-kva.xn--p1ai']) {
    eq(scanPackage({ a: t }).map((f) => f.kind), ['email'], JSON.stringify(t));
  }
  const long = 'a'.repeat(100_000);
  const t0 = Date.now();
  scanPackage({ a: long, b: `${long}@${long}` });
  assert(Date.now() - t0 < 1000, `a 100k-character token scans fast (${Date.now() - t0} ms)`);
});

test('arrays and nesting keep their paths; a clean package has no finding', () => {
  eq(scanPackage({ wordings: [{ sms: 'ok' }, { sms: 'Ruf an: +41 79 123 45 67' }] }), [{ kind: 'phone', path: 'wordings[1].sms' }], 'path');
  eq(scanPackage({ test: 'connection', nonce: 4721, date: '2026-09-30' }), [], 'the ping package');
});

console.log('\nAnswers');

const S = pingOutputSchema;

test('only a normal end is read', () => {
  const r = (stopReason: string | null, text = '{"reasoning":"x","echo":1}') => evaluateAnswer({ stopReason, text }, S);
  const refusal = r('refusal');
  assert(!refusal.ok && refusal.problem === 'refusal', 'refusal');
  const cut = r('max_tokens', '{"reasoning":"x","echo":1}');
  assert(!cut.ok && cut.problem === 'cut_off', 'a cut-off answer is rejected even when it parses');
  const ctx = r('model_context_window_exceeded');
  assert(!ctx.ok && ctx.problem === 'cut_off', 'context exceeded');
  const tool = r('tool_use');
  assert(!tool.ok && tool.problem === 'unexpected_stop', 'another stop');
  assert(r('end_turn').ok, 'end_turn');
});

test('no text, not JSON, the wrong shape', () => {
  const none = evaluateAnswer({ stopReason: 'end_turn', text: '  ' }, S);
  assert(!none.ok && none.problem === 'no_text', 'no text');
  const prose = evaluateAnswer({ stopReason: 'end_turn', text: 'Sure! Here it is.' }, S);
  assert(!prose.ok && prose.problem === 'bad_json', 'not JSON');
  const shape = evaluateAnswer({ stopReason: 'end_turn', text: '{"reasoning":"x","echo":1.5}' }, S);
  assert(!shape.ok && shape.problem === 'bad_shape' && /echo/.test(shape.detail), 'a non-integer echo');
  const extra = evaluateAnswer({ stopReason: 'end_turn', text: '{"reasoning":"x","echo":1,"more":true}' }, S);
  assert(!extra.ok && extra.problem === 'bad_shape', 'an extra field');
});

console.log('\nNumbers in the reasoning');

test('the numbers a text quotes', () => {
  eq(quotedNumbers('1,234 sends and 12.5 % clicked').map((q) => [q.value, q.percent]), [[1234, false], [12.5, true]], 'thousands and a percent');
  eq(quotedNumbers('GSM-7 SMS at s1 and v2, UCS-2').length, 0, 'labels are not numbers');
  eq(quotedNumbers('3.5b and 12x').map((q) => q.value), [3.5, 12], 'a unit after a number is still a number');
  eq(quotedNumbers('ar_12 and x-12 and a.5').length, 0, 'glued to a letter, "_" or "." before it');
  eq(quotedNumbers('it went at 12.').map((q) => q.value), [12], "a sentence's full stop");
  eq(quotedNumbers("1'250 guests").map((q) => q.value), [1250], 'Swiss thousands');
  eq(quotedNumbers('12,5 % and 3,25').map((q) => [q.value, q.percent]), [[12.5, true], [3.25, false]], 'decimal commas');
  eq(quotedNumbers('12.5 percent, 4 per cent, 3pct').map((q) => [q.value, q.percent]), [[12.5, true], [4, true], [3, true]], 'percent words');
  eq(quotedNumbers('CHF1200 and Fr.30').map((q) => q.value), [1200, 30], 'a currency before a number');
});

test('units and currencies are claims; numbers in keys are given', () => {
  eq(unexplainedNumbers('it took 45min', []), ['45'], 'a unit');
  eq(unexplainedNumbers('about 3.5k guests', []), ['3.5'], 'a unit after a decimal');
  eq(unexplainedNumbers('CHF1200 a month', []), ['1200'], 'a currency');
  eq(unexplainedNumbers('the 2026 plan', givenNumbers({ plan2026: true })), ['2026'], 'glued in the key: a label there, not given');
  eq(unexplainedNumbers('day 20260930 had 250 sends', givenNumbers({ '20260930': { sends: 250 } })), [], 'a key that is a number is given');
  eq(unexplainedNumbers('12,5 % clicked', givenNumbers({ rate: 0.125 })), [], 'a decimal comma percent');
  eq(unexplainedNumbers('best at 18:30', givenNumbers({ slot: '2026-09-30T18:30:00Z' })), [], "an ISO time's hour is given");
  const t0 = Date.now();
  quotedNumbers(`${'1,'.repeat(50_000)}1.1_`);
  assert(Date.now() - t0 < 500, 'a long "1,1,1…" run is read in linear time');
});

test('given numbers explain quoted ones: exact, rounded, a percent of a fraction', () => {
  const given = givenNumbers({ clickRate: 0.375, sends: 1234, avg: 12.46, day: '2026-09-30' });
  eq(unexplainedNumbers('37.5 % of 1,234 sends clicked, about 12.5 on average, since 2026-09-30', given), [], 'all explained');
  eq(unexplainedNumbers('clicks rose by 42 %', given), ['42%'], 'an invented percent');
  eq(unexplainedNumbers('37 % clicked', given), [], '37.5 % cut to 37 (a whole percent)');
  eq(unexplainedNumbers('36 % clicked', given), ['36%'], 'more than one unit off');
  eq(unexplainedNumbers('12.4 on average', given), [], '12.46 cut to one decimal');
  eq(unexplainedNumbers('12.3 on average', given), ['12.3'], 'one decimal, more than 0.1 off');
});

test('small whole counts are not claims; decimals and percents always are', () => {
  eq(unexplainedNumbers('I wrote 3 wordings, a 4-digit number', []), [], 'counts');
  eq(unexplainedNumbers('about 2.5 times better', []), ['2.5'], 'a decimal');
  eq(unexplainedNumbers('5 % more', []), ['5%'], 'a percent');
  eq(unexplainedNumbers('1,500 guests', []), ['1500'], 'a big number');
});

test('the prompt counts as given', () => {
  eq(numbersCheck('As asked, 150 characters at most', {}, ['Keep it under 150 characters']).ok, true, 'from the prompt');
  eq(numbersCheck('As asked, 160 characters', {}, ['Keep it under 150 characters']).ok, false, 'not in the prompt');
});

console.log('\nThe gate');

const engine = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  launch: { default: 'off', accounts: {}, changedBy: null, liveSince: { default: null, accounts: {} } },
  safety: { maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 },
  sms: { allowedCountries: ['CH'] },
  alerts: { email: null },
  paused: true,
  bandit: { mode: 'off', accounts: {}, changedBy: null },
  agents: { mode: 'off', accounts: {}, monthlyBudgetUsd: 100, changedBy: null },
  ...over,
});

test('the Test connection and the dev route run while everything is off', () => {
  eq(gateFor({ scope: 'platform' }, { trigger: 'test', tenantUserId: null }, engine(), { enabled: false }), null, 'test');
  eq(gateFor({ scope: 'venue' }, { trigger: 'dev', tenantUserId: null }, engine(), { enabled: false }), null, 'dev');
});

test('a scheduled platform job needs the agent on and the global switch on', () => {
  eq(gateFor({ scope: 'platform' }, { trigger: 'schedule', tenantUserId: null }, engine(), { enabled: false }), 'agent_off', 'agent off');
  eq(gateFor({ scope: 'platform' }, { trigger: 'schedule', tenantUserId: null }, engine(), { enabled: true }), 'agents_off', 'switch off');
  const on = engine({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd: 100, changedBy: null } });
  eq(gateFor({ scope: 'platform' }, { trigger: 'manual', tenantUserId: null }, on, { enabled: true }), null, 'on');
});

test('PR W2: a person’s run (manual: Suggest with AI) needs the AI switch but not the agent’s scheduled switch', () => {
  const on = engine({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd: 100, changedBy: null } });
  eq(gateFor({ scope: 'platform' }, { trigger: 'manual', tenantUserId: null }, on, { enabled: false }), null, 'scheduled switch off: runs');
  eq(gateFor({ scope: 'platform' }, { trigger: 'manual', tenantUserId: null }, engine(), { enabled: false }), 'agents_off', 'AI switch off: never');
  eq(gateFor({ scope: 'platform' }, { trigger: 'schedule', tenantUserId: null }, on, { enabled: false }), 'agent_off', 'a scheduled run still needs its switch');
});

test('PR W2: only a job that asks waits on the sending pause (scheduled runs only)', () => {
  const on = engine({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd: 100, changedBy: null }, paused: true });
  eq(gateFor({ scope: 'platform', waitsOnSendingPause: true }, { trigger: 'schedule', tenantUserId: null }, on, { enabled: true }), 'sending_paused', 'waits');
  eq(gateFor({ scope: 'platform', waitsOnSendingPause: true }, { trigger: 'manual', tenantUserId: null }, on, { enabled: true }), null, 'a person’s run doesn’t');
  eq(gateFor({ scope: 'platform', waitsOnSendingPause: false }, { trigger: 'schedule', tenantUserId: null }, on, { enabled: true }), null, 'the writer: never (Manish, 2026-10-05)');
  eq(gateFor({ scope: 'platform', waitsOnSendingPause: true }, { trigger: 'schedule', tenantUserId: null }, { ...on, paused: false }, { enabled: true }), null, 'not paused');
});

test("an account's job: the account's AI override first, and the account live", () => {
  const e = engine({
    launch: { default: 'off', accounts: { t_live: 'live', t_test: 'test' }, changedBy: null, liveSince: { default: null, accounts: {} } },
    agents: { mode: 'on', accounts: { t_off: 'off' }, monthlyBudgetUsd: 100, changedBy: null },
  });
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: null }, e, { enabled: true }), 'no_account', 'no account');
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: 't_off' }, e, { enabled: true }), 'agents_off', 'override off');
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: 't_test' }, e, { enabled: true }), 'not_live', 'a test run');
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: 't_other' }, e, { enabled: true }), 'not_live', 'follows the default (off)');
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: 't_live' }, e, { enabled: true }), null, 'live, AI on');
  const offGlobal = engine({ ...e, agents: { mode: 'off', accounts: { t_live: 'on' }, monthlyBudgetUsd: 100, changedBy: null } });
  eq(gateFor({ scope: 'venue' }, { trigger: 'schedule', tenantUserId: 't_live' }, offGlobal, { enabled: true }), null, 'an account override on');
});

console.log('\nThe launch card');

const state = (over: Partial<LaunchState> = {}): LaunchState => ({
  default: 'off',
  accounts: {},
  liveSince: { default: null, accounts: {} },
  paused: true,
  safety: { maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 },
  smsCountries: ['CH'],
  alertsEmail: null,
  bandit: { mode: 'off', accounts: {} },
  agents: { mode: 'off', accounts: {}, monthlyBudgetUsd: 100 },
  ...over,
});

test('turning the AI agents on needs "AI ON"; off is one click', () => {
  const before = state();
  const on = summarizeChange(before, applyChange(before, { agents: { mode: 'on' } }));
  eq(on.confirmPhrase, 'AI ON', 'phrase');
  eq(on.lines, ['AI agents (default): off → on'], 'line');
  const onState = applyChange(before, { agents: { mode: 'on' } });
  const off = summarizeChange(onState, applyChange(onState, { agents: { mode: 'off' } }));
  eq(off.confirmPhrase, null, 'off: one click');
});

test('per account, with the account in the line', () => {
  const before = state();
  const s = summarizeChange(before, applyChange(before, { agents: { accounts: { t1: 'on' } } }));
  eq(s.confirmPhrase, 'AI ON', 'phrase');
  eq(s.lines, ['t1: AI agents default (off) → on'], 'line');
  const after = applyChange(before, { agents: { accounts: { t1: 'on' } } });
  const back = summarizeChange(after, applyChange(after, { agents: { accounts: { t1: null } } }));
  eq(back.confirmPhrase, null, 'back to the default (off): one click');
});

test("an account's explicit \"on\" while the default is on still needs \"AI ON\" (it outlives the default)", () => {
  const before = state({ agents: { mode: 'on', accounts: {}, monthlyBudgetUsd: 100 } });
  const s = summarizeChange(before, applyChange(before, { agents: { accounts: { t1: 'on' } } }));
  eq(s.confirmPhrase, 'AI ON', 'phrase');
  const off = summarizeChange(before, applyChange(before, { agents: { accounts: { t1: 'off' } } }));
  eq(off.confirmPhrase, null, 'an explicit off: one click');
});

test('a higher budget is LOOSEN LIMITS; a lower one is one click', () => {
  const before = state();
  const up = summarizeChange(before, applyChange(before, { agents: { monthlyBudgetUsd: 150 } }));
  eq(up.confirmPhrase, 'LOOSEN LIMITS', 'up');
  eq(up.lines, ['AI budget: $100 → $150 a month'], 'line');
  const down = summarizeChange(before, applyChange(before, { agents: { monthlyBudgetUsd: 50 } }));
  eq(down.confirmPhrase, null, 'down');
});

test('with Learning in the same change, both phrases', () => {
  const before = state();
  const s = summarizeChange(before, applyChange(before, { bandit: { mode: 'on' }, agents: { mode: 'on' } }));
  eq(s.confirmPhrase, 'BANDIT ON AND AI ON', 'both');
});

test('a state without `agents` (older callers) gets none added', () => {
  const { agents: _a, ...rest } = state();
  const after = applyChange(rest as LaunchState, { paused: false });
  assert(!('agents' in after), 'no agents key');
});

console.log('\nThe ping job and the tasks');

test('a 4-digit nonce per run id, the same for a retried run', () => {
  const a = pingNonce('ar_1');
  assert(a >= 1000 && a <= 9999, '4 digits');
  eq(pingNonce('ar_1'), a, 'deterministic');
});

test('its valid answer passes every check; a wrong echo fails', () => {
  const built = pingJob.buildInput({ runId: 'ar_x', realNow: Date.UTC(2026, 8, 30), tenantUserId: null, venueId: null, params: {} }) as { pkg: { nonce: number } };
  eq(scanPackage(built.pkg), [], 'nothing personal');
  const answer = pingJob.sandboxAnswer(built.pkg as never);
  const ev = evaluateAnswer({ stopReason: 'end_turn', text: JSON.stringify(answer) }, pingJob.outputSchema);
  assert(ev.ok, 'parses');
  const prompt = pingJob.prompts['ping-v1'];
  assert(numbersCheck(pingJob.reasoningOf(answer), built.pkg, [prompt.system, prompt.instructions]).ok, 'numbers ok');
  assert(pingJob.check(answer, built.pkg as never).every((c) => c.ok), 'echo ok');
  assert(!pingJob.check({ reasoning: 'x', echo: 1 }, built.pkg as never)[0].ok, 'a wrong echo');
});

test('the registry knows the ping job and (PR W2) the WhatsApp writer; defaults are allowed models, off', () => {
  eq([...AGENT_KEYS], ['ping', 'wa_template_writer'], 'agents');
  for (const key of AGENT_KEYS) {
    const job = jobFor(key)!;
    assert(isKnownModel(job.defaults.model) && isKnownModel(job.defaults.fallbackModel), `${key}: allowed models`);
    eq(job.defaults.enabled, false, `${key}: off`);
    assert(Object.prototype.hasOwnProperty.call(job.prompts, job.defaults.promptVersion), `${key}: its default prompt exists`);
  }
  const w = jobFor('wa_template_writer')!;
  eq([w.defaults.model, w.defaults.fallbackModel, w.defaults.effort, w.defaults.maxRunsPerDay, w.defaults.maxOutputTokens, w.scope, w.waitsOnSendingPause], ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'medium', 10, 4000, 'platform', false], 'writer defaults (Manish, 2026-10-05)');
  assert(typeof w.apply === 'function' && typeof w.precheck === 'function' && typeof w.report === 'function', 'the writer applies, prechecks and reports');
  assert(jobFor('nope') === null && jobFor(undefined) === null, 'unknown');
});

test('Test connection: one task a minute, due now on the engine clock, three attempts at most', () => {
  const a = testConnectionTask(Date.UTC(2026, 8, 30, 10, 0, 5), 123);
  const b = testConnectionTask(Date.UTC(2026, 8, 30, 10, 0, 55), 456);
  eq(a.dedupeKey, b.dedupeKey, 'same minute, same task');
  eq(a.dueAt, 123, 'engine clock');
  eq(a.maxAttempts, 3, 'attempts (a later one closes a dead run; it never calls the model again)');
  eq(a.kind, 'agent_run', 'kind');
  eq(a.payload, { agentKey: 'ping', trigger: 'test', params: {} }, 'payload');
});

test("a claimed task's request; an unreadable trigger is `schedule`", () => {
  const spec = agentRunTask({ agentKey: 'ping', trigger: 'dev', dedupeKey: 'x', dueAt: 0 });
  const claimed = { id: 'jt_1', kind: 'agent_run', dueAt: 0, attempts: 2, maxAttempts: 3, payload: spec.payload, tenantUserId: null, venueId: null };
  eq(requestOf(claimed), { agentKey: 'ping', trigger: 'dev', taskId: 'jt_1', attempt: 2, tenantUserId: null, venueId: null, params: {} }, 'request');
  eq(requestOf({ ...claimed, payload: { agentKey: 'ping', trigger: 'whatever', params: [] } }).trigger, 'schedule', 'strictest');
  eq(requestOf({ ...claimed, payload: { agentKey: 'ping', trigger: 'test', params: [1] } }).params, {}, 'params must be an object');
});

console.log('\nThe model client (no call)');

test('a reply is read defensively; a 200 that is no message is a setup error', () => {
  const r = toReply({
    content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }],
    stop_reason: 'end_turn',
    model: 'claude-opus-5-5',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: -1 },
  });
  eq([r.text, r.stopReason, r.model, r.refusalCategory], ['{"a":1}', 'end_turn', 'claude-opus-5-5', null], 'text blocks joined');
  eq(r.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'bad counts are 0');
  const refusal = toReply({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } });
  eq(refusal.refusalCategory, 'cyber', 'refusal category');
  for (const bad of ['<html>login</html>', null, { content: 'x' }, {}]) {
    let err: unknown;
    try {
      toReply(bad);
    } catch (e) {
      err = e;
    }
    assert(err instanceof ModelError && err.kind === 'setup' && err.code === 'bad_response' && err.reachedRelay, `bad reply ${JSON.stringify(bad)}`);
  }
});

test('errors: SDK classes and statuses map to retryable / setup / bad_request with the upstream words', () => {
  const sdk = { default: Anthropic } as unknown as typeof import('@anthropic-ai/sdk');
  const gen = (status: number, body: unknown) => Anthropic.APIError.generate(status, body as object, undefined, new Headers());
  const c = (e: unknown) => {
    const m = classifyModelError(e, sdk);
    return [m.kind, m.code, m.status, m.reachedRelay];
  };
  eq(c(gen(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })), ['retryable', 'rate_limited', 429, true], '429');
  eq(c(gen(408, {})), ['retryable', 'timeout', 408, true], '408');
  eq(c(gen(503, {})), ['retryable', 'server_error', 503, true], '5xx');
  eq(c(gen(504, { type: 'error', error: { type: 'api_error', message: 'The AI Gateway took too long' } })), ['retryable', 'timeout', 504, true], "the relay's give-up is a timeout (it may have been billed)");
  eq(c(gen(401, {})), ['setup', 'unauthorized', 401, true], '401');
  eq(c(gen(403, {})), ['setup', 'forbidden', 403, true], '403');
  eq(c(gen(404, {})), ['setup', 'not_found', 404, true], '404');
  eq(c(gen(413, {})), ['bad_request', 'bad_request', 413, true], '413');
  eq(c(gen(409, {})), ['setup', 'api_error', 409, true], 'another status');
  eq(c(gen(429, { type: 'error', error: { type: 'relay_daily_limit', message: 'The relay made 300 calls today' } })), ['setup', 'relay_daily_limit', 429, true], "the relay's own cap is not a rate limit");
  eq(c(gen(401, { type: 'error', error: { type: 'relay_unauthorized', message: 'x' } })), ['setup', 'relay_unauthorized', 401, true], 'relay secret refused');
  eq(c(new Anthropic.APIConnectionTimeoutError()), ['retryable', 'timeout', null, true], 'our timeout (the relay may have called the model)');
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
  eq(c(new Anthropic.APIConnectionError({ cause: refused })), ['retryable', 'connection', null, false], 'never sent (refused)');
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  eq(c(new Anthropic.APIConnectionError({ cause: reset })), ['retryable', 'connection', null, true], 'broke off after sending: maybe billed');
  // Round 8: what fetch throws for a redirect under `redirect: 'error'` (no code): a setup error, not counted.
  const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  eq(c(new Anthropic.APIConnectionError({ cause: redirect })), ['setup', 'relay_not_configured', null, false], 'a redirect (apex → www): fix CMS_INTERNAL_URL');
  eq(c(gen(502, { type: 'error', error: { type: 'relay_answer_lost', message: 'broke off' } })), ['setup', 'answer_lost', 502, true], 'an answer lost on the way back: no second call');
  eq(c(new Anthropic.APIUserAbortError()), ['retryable', 'aborted', null, true], 'aborted mid-call (it may have reached the model)');
  eq(c(new TypeError('x is not a function')), ['setup', 'unknown', null, false], 'a bug is not retried');
  const words = classifyModelError(gen(400, { type: 'error', error: { type: 'invalid_request_error', message: 'y'.repeat(500) } }), sdk);
  assert(words.message.includes('invalid_request_error') && words.message.length < 400, 'upstream words kept, capped');
  // A secret quoted near the cut is removed BEFORE the cut (a half secret can't be found after).
  const secret = 's3cr3t-'.repeat(9);
  const quoted = classifyModelError(gen(401, { type: 'error', error: { type: 'x', message: `${'x'.repeat(250)} secret=${secret}` } }), sdk, (t) => t.split(secret).join('[secret]'));
  assert(!quoted.message.includes('s3cr3t-s3cr3t'), `no piece of the secret: ${quoted.message.slice(-80)}`);
});

atest('a relay URL that is no web address is refused before anything is sent or counted', async () => {
  const saved = { url: process.env.CMS_INTERNAL_URL, secret: process.env.INTERNAL_API_SECRET, emu: process.env.FIRESTORE_EMULATOR_HOST };
  delete process.env.FIRESTORE_EMULATOR_HOST;
  process.env.INTERNAL_API_SECRET = 'a-test-secret';
  try {
    for (const url of ['portal.heidifi.invalid', 'ftp://relay.invalid']) {
      process.env.CMS_INTERNAL_URL = url;
      let err: unknown;
      try {
        await relayClient().call({ agentKey: 'ping', runId: 'ar_x', model: 'anthropic/claude-opus-5.5', system: 's', cacheSystem: false, user: 'u', format: { type: 'json_schema', schema: {} }, effort: 'low', maxOutputTokens: 256, timeoutMs: 1000, pkg: {} });
      } catch (e) {
        err = e;
      }
      assert(err instanceof ModelError && err.code === 'relay_not_configured' && !err.reachedRelay, `refused: ${url}`);
    }
    process.env.CMS_INTERNAL_URL = 'https://portal.heidifi.invalid';
    process.env.INTERNAL_API_SECRET = 'has a space';
    let err: unknown;
    try {
      await relayClient().call({ agentKey: 'ping', runId: 'ar_x', model: 'anthropic/claude-opus-5.5', system: 's', cacheSystem: false, user: 'u', format: { type: 'json_schema', schema: {} }, effort: 'low', maxOutputTokens: 256, timeoutMs: 1000, pkg: {} });
    } catch (e) {
      err = e;
    }
    assert(err instanceof ModelError && err.code === 'relay_not_configured' && !err.message.includes('has a space'), 'a secret a header cannot carry: refused, never quoted');
  } finally {
    for (const [k, v] of [['CMS_INTERNAL_URL', saved.url], ['INTERNAL_API_SECRET', saved.secret], ['FIRESTORE_EMULATOR_HOST', saved.emu]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

atest("the SDK's structured-output helper builds the ping schema (strict object, no extra keys)", async () => {
  const f = await outputFormatFor(pingOutputSchema);
  eq(f.type, 'json_schema', 'type');
  const schema = f.schema as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
  eq(schema.type, 'object', 'object');
  eq(Object.keys(schema.properties ?? {}).sort(), ['echo', 'reasoning'], 'fields');
  eq(schema.additionalProperties, false, 'no extra keys');
  eq([...(schema.required ?? [])].sort(), ['echo', 'reasoning'], 'required');
});

void chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
});
