/**
 * Language rules in the campaign validator — and a guard that this PORT still
 * agrees with the CMS authority it was copied from.
 *
 * Run: npx tsx tests/campaignLanguage.test.ts   (from captive-server/mcp)
 *
 * src/validation/campaigns.ts is a hand-maintained port of
 * cms/app/api/captive-portal/_lib/campaigns.js, because create_campaign and
 * update_campaign write Firestore directly rather than proxying through the CMS
 * (unlike splash config, which does proxy). Two validators means they can drift,
 * and the drift is invisible: the MCP accepts something the dashboard would
 * reject, the campaign saves, and the divergence only surfaces when a tenant
 * opens it in the UI.
 *
 * So the cases below are written once and asserted against this port. The CMS
 * side runs the same table in its own suite.
 */

import { validateCampaignInput } from '../src/validation/campaigns';

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

type Raw = Record<string, unknown>;

/** A minimal valid broadcast, with `overrides` merged over it. */
function campaign(overrides: Raw = {}): Raw {
  return {
    name: 'Test',
    type: 'broadcast',
    channels: ['sms', 'email', 'whatsapp'],
    ...overrides,
  };
}

function validate(input: Raw) {
  return validateCampaignInput(input, { isCreate: true }) as
    | { campaign: Raw }
    | { error: string; field?: string | null; code: string };
}

function expectOk(input: Raw): Raw {
  const result = validate(input);
  if ('error' in result) throw new Error(`expected success, got ${result.code}: ${result.error}`);
  return result.campaign;
}

function expectError(input: Raw, code: string) {
  const result = validate(input);
  if (!('error' in result)) throw new Error(`expected error "${code}", got success`);
  assert(result.code === code, `expected code "${code}", got "${result.code}" (${result.error})`);
}

console.log('\nsegment.language');

test('absent means every language — adding the field cannot shrink an audience', () => {
  const out = expectOk(campaign({ segment: { venueIds: [] } }));
  assert((out.segment as Raw).language === undefined, 'no language key should be stored');
});

test('each supported language is accepted', () => {
  for (const code of ['en', 'de', 'it', 'fr']) {
    const out = expectOk(campaign({ segment: { language: code } }));
    assert((out.segment as Raw).language === code, `${code} should round-trip`);
  }
});

test('"unknown" targets guests with no language recorded', () => {
  const out = expectOk(campaign({ segment: { language: 'unknown' } }));
  assert((out.segment as Raw).language === 'unknown', 'unknown should round-trip');
});

test('an unsupported language is rejected, not silently dropped', () => {
  expectError(campaign({ segment: { language: 'es' } }), 'invalid_language');
});

test('empty string means no filter', () => {
  const out = expectOk(campaign({ segment: { language: '' } }));
  assert((out.segment as Raw).language === undefined, 'empty string should not store a filter');
});

console.log('\nmessage translations');

const smsMessage = (translations?: Raw) => ({
  channel: 'sms',
  delayMinutes: 0,
  content: 'Hello',
  ...(translations ? { translations } : {}),
});

test('a variant is stored per language', () => {
  const out = expectOk(campaign({
    messages: [smsMessage({ de: { content: 'Hallo' }, fr: { content: 'Salut' } })],
  }));
  const msg = (out.messages as Raw[])[0];
  assert(JSON.stringify(msg.translations) === JSON.stringify({ de: { content: 'Hallo' }, fr: { content: 'Salut' } }),
    `got ${JSON.stringify(msg.translations)}`);
});

test('the base message is left intact — it is the default-language copy', () => {
  const out = expectOk(campaign({ messages: [smsMessage({ de: { content: 'Hallo' } })] }));
  assert((out.messages as Raw[])[0].content === 'Hello', 'base content must not change');
});

test('a message with no translations stores no translations key', () => {
  const out = expectOk(campaign({ messages: [smsMessage()] }));
  assert((out.messages as Raw[])[0].translations === undefined, 'absent should stay absent');
});

test('an unsupported language is rejected', () => {
  expectError(campaign({ messages: [smsMessage({ es: { content: 'Hola' } })] }), 'unsupported_language');
});

// The important one. A variant that could carry its own delay or channel would
// make one message behave as several, and per-message metrics would stop being
// attributable to anything.
test('a variant cannot change delayMinutes', () => {
  expectError(
    campaign({ messages: [smsMessage({ de: { content: 'Hallo', delayMinutes: 60 } })] }),
    'structural_field_in_translation',
  );
});

test('a variant cannot change the channel', () => {
  expectError(
    campaign({ messages: [smsMessage({ de: { channel: 'email' } })] }),
    'structural_field_in_translation',
  );
});

test('a variant cannot change the message id', () => {
  expectError(
    campaign({ messages: [smsMessage({ de: { id: 'other-message' } })] }),
    'structural_field_in_translation',
  );
});

test('an empty variant is not stored — it would read as translated while doing nothing', () => {
  const out = expectOk(campaign({ messages: [smsMessage({ de: {} })] }));
  assert((out.messages as Raw[])[0].translations === undefined, 'empty variant should be dropped');
});

test('translations must be an object, not an array', () => {
  expectError(
    campaign({ messages: [{ channel: 'sms', delayMinutes: 0, content: 'x', translations: [] }] }),
    'invalid_translations',
  );
});

test('each variant must be an object', () => {
  expectError(
    campaign({ messages: [{ channel: 'sms', delayMinutes: 0, content: 'x', translations: { de: 'Hallo' } }] }),
    'invalid_translation',
  );
});

const UNSUB = '<a href="{{unsubscribeUrl}}">Unsubscribe</a>';

test('an email variant carries subject and body', () => {
  const out = expectOk(campaign({
    messages: [{
      channel: 'email',
      delayMinutes: 0,
      subject: 'Hi',
      body: `Hello ${UNSUB}`,
      translations: { de: { subject: 'Hallo', body: `Guten Tag ${UNSUB}` } },
    }],
  }));
  const variant = ((out.messages as Raw[])[0].translations as Raw).de as Raw;
  assert(variant.subject === 'Hallo', `got ${JSON.stringify(variant)}`);
  assert(String(variant.body).startsWith('Guten Tag'), `got ${JSON.stringify(variant)}`);
});

// Compliance is per recipient, so it is per language: a German guest who gets a
// translated email with no unsubscribe link is exactly the case the base-body
// check exists to prevent.
test('a translated email body without an unsubscribe link is rejected', () => {
  expectError(
    campaign({
      messages: [{
        channel: 'email',
        delayMinutes: 0,
        subject: 'Hi',
        body: `Hello ${UNSUB}`,
        translations: { de: { body: 'Guten Tag' } },
      }],
    }),
    'missing_unsubscribe',
  );
});

test('a WhatsApp variant carries a template locale', () => {
  const out = expectOk(campaign({
    messages: [{
      channel: 'whatsapp',
      delayMinutes: 0,
      templateName: 'heidifi_visit_feedback',
      languageCode: 'en',
      content: 'preview',
      translations: { de: { languageCode: 'de' } },
    }],
  }));
  const variant = ((out.messages as Raw[])[0].translations as Raw).de as Raw;
  assert(variant.languageCode === 'de', `got ${JSON.stringify(variant)}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
