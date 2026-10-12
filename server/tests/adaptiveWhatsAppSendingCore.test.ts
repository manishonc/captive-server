/**
 * PR W3 — journeys send WhatsApp: the pure parts.
 *
 * Run: npx tsx tests/adaptiveWhatsAppSendingCore.test.ts   (from captive-server/server)
 *
 * No Firestore, no network. The load-bearing assertions:
 *  - the WhatsApp channel rules (core/runtime/whatsappRules.ts): off, unreachable (131026, 30 days),
 *    marketing to +1 numbers, the marketing limit (131049, 24 h) — and a block: the number's own
 *    WhatsApp STOP, and for marketing an SMS STOP too (W3-D1); a bounce on email changes nothing;
 *  - checkChannel shows `whatsapp_off` while the switch is off (not "no wording");
 *  - Meta's failure codes → what changes for the number;
 *  - renderMessage renders an approved template: the body with the guest's values + footer; every
 *    `{{n}}` needs a value and the link button its link — else they are missing; Meta's values in order;
 *  - the launch switch is a loosening with the phrase WHATSAPP ON; turning it off is a brake;
 *  - a synchronous 131050 from Meta is a STOP (`suppress: 'stop'`);
 *  - Replay's "no channel" words skip the WhatsApp rules like the old `whatsapp_off`.
 * (The stored switch — missing or bad = off — is read in tests/emulator/adaptiveWhatsAppSending.test.ts.)
 */

import { WA_LIMITED_MS, WA_UNREACHABLE_MS, WHATSAPP_CHANNEL_REASONS, whatsappBlocked, whatsappFailureEffect, whatsappRuleFail } from '../src/adaptive/core/runtime/whatsappRules';
import { checkChannel } from '../src/adaptive/core/runtime/pickers';
import { renderMessage, whatsappParams, type WaTemplateContent } from '../src/adaptive/engine/renderSend';
import { compileTemplate } from '../src/adaptive/core/whatsapp/template';
import { applyChange, summarizeChange, type LaunchState } from '../src/adaptive/core/runtime/launch';
import { classifyWhatsAppAnswer } from '../src/adaptive/send/adapters/whatsapp';
import { noChannelFor } from '../src/adaptive/core/runtime/replay';
import { DAY_MS, HOUR_MS } from '../src/adaptive/core/runtime/time';
import { metaSignatureValid } from '../src/services/metaSignature';
import { createHmac } from 'crypto';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const NOW = Date.UTC(2026, 9, 13, 10, 0);
const base = { on: true, purpose: 'marketing' as const, phoneCountry: 'CH', limitedUntil: null, unreachableUntil: null, now: NOW };

async function main() {
  console.log('\nWhatsApp sending — pure parts (PR W3)\n');

  await test('the channel rules: off, unreachable, +1 marketing, the marketing limit — in that order; info messages skip the marketing ones', () => {
    assertEqual(whatsappRuleFail({ ...base, on: false }), 'whatsapp_off', 'off');
    assertEqual(whatsappRuleFail(base), null, 'on, a Swiss number');
    assertEqual(whatsappRuleFail({ ...base, unreachableUntil: NOW + DAY_MS }), 'whatsapp_unreachable', '131026 still running');
    assertEqual(whatsappRuleFail({ ...base, unreachableUntil: NOW - 1 }), null, '131026 over');
    assertEqual(whatsappRuleFail({ ...base, phoneCountry: 'US' }), 'whatsapp_us_marketing', '+1 marketing');
    assertEqual(whatsappRuleFail({ ...base, phoneCountry: 'US', purpose: 'service' }), null, '+1 info message');
    assertEqual(whatsappRuleFail({ ...base, limitedUntil: NOW + HOUR_MS }), 'whatsapp_limited', '131049 still running');
    assertEqual(whatsappRuleFail({ ...base, limitedUntil: NOW + HOUR_MS, purpose: 'service' }), null, 'the marketing limit holds no info message');
    assertEqual(whatsappRuleFail({ ...base, on: false, unreachableUntil: NOW + DAY_MS }), 'whatsapp_off', 'off wins');
    assertEqual([WA_LIMITED_MS, WA_UNREACHABLE_MS], [24 * HOUR_MS, 30 * DAY_MS], 'the holds');
    // Verification round: WhatsApp's own rules, not the owner's audience choice.
    assertEqual(whatsappRuleFail({ ...base, verified: false }), 'whatsapp_unverified', 'an unproved number');
    assertEqual(whatsappRuleFail({ ...base, on: false, verified: false }), 'whatsapp_off', 'off still wins');
    assertEqual(whatsappRuleFail({ ...base, purpose: 'service', optedIn: false }), 'whatsapp_no_optin', 'an info message needs a WhatsApp yes');
    assertEqual(whatsappRuleFail({ ...base, purpose: 'marketing', optedIn: false }), null, 'marketing: consent is checked before (no_consent)');
  });

  await test('the block: its own WhatsApp STOP; an SMS STOP for marketing only (W3-D1); an email bounce changes nothing', () => {
    assertEqual(whatsappBlocked(null, 'marketing'), null, 'no point');
    assertEqual(whatsappBlocked({ suppression: { whatsapp: { reason: 'stop' } } }, 'service'), 'stop', 'WhatsApp STOP blocks info messages too');
    assertEqual(whatsappBlocked({ suppression: { sms: { reason: 'stop' } } }, 'marketing'), 'sms_stop', 'SMS STOP → no WhatsApp marketing');
    assertEqual(whatsappBlocked({ suppression: { sms: { reason: 'stop' } } }, 'service'), null, 'SMS STOP → WhatsApp info messages still go');
    assertEqual(whatsappBlocked({ suppression: { sms: { reason: 'erasure' } } }, 'marketing'), null, 'only a STOP');
    assertEqual(whatsappBlocked({ suppression: { email: { reason: 'hard_bounce' } } }, 'marketing'), null, 'email bounce');
  });

  await test('checkChannel: `whatsapp_off` while off (the switch is the reason, not "no wording"); no_wording once on without a template', () => {
    const facts = { channel: 'whatsapp' as const, hasAddress: true, consent: 'granted' as const, suppressed: null, audienceOk: true };
    assertEqual(checkChannel('marketing', { ...facts, hasWording: true, ruleFail: 'whatsapp_off' }).reason, 'whatsapp_off', 'off');
    assertEqual(checkChannel('marketing', { ...facts, hasWording: false, ruleFail: null }).reason, 'no_wording', 'on, no template');
    assertEqual(checkChannel('marketing', { ...facts, hasWording: true, ruleFail: null }).ok, true, 'on, a template');
    assertEqual(checkChannel('marketing', { ...facts, suppressed: 'sms_stop', hasWording: true, ruleFail: null }).reason, 'blocked:sms_stop', 'SMS STOP');
    assertEqual(checkChannel('marketing', { ...facts, audienceOk: false, hasWording: true, ruleFail: null }).reason, 'audience', 'unverified number');
  });

  await test("Meta's failure codes → the number: 131049 limited, 131026 unreachable, 131050 STOP, others nothing", () => {
    assertEqual(['131049', '131026', '131050', '132001', null].map(whatsappFailureEffect), ['limited', 'unreachable', 'stop', null, null], 'effects');
  });

  const source = {
    body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}}! Come back within {{offer.days | default:"14"}} days for {{offer.label | default:"a surprise"}}.',
    footer: 'Reply STOP to unsubscribe',
    button: { text: 'See your offer', field: 'link.offer' as const },
  };
  const compiled = compileTemplate(source, { lang: 'en', visitorBaseUrl: 'https://visit.example' });
  const content: WaTemplateContent = { kind: 'wa_template', templateId: 'wt_1', name: 'hf_welcome_offer_1', language: 'en', source, compiled, buttonIndex: 0 };

  await test('renderMessage: the template with the guest’s values and its footer; Meta’s values in {{n}} order; the button’s link is used', () => {
    const values = { 'contact.firstName': 'Anna', 'venue.name': 'Madras Jungle', 'offer.days': '14', 'offer.label': 'a free dessert', 'link.offer': 'https://visit.example/s/abcdefgh' };
    const r = renderMessage(content, 'whatsapp', values);
    assertEqual(r.missing, [], 'nothing missing');
    assertEqual(r.text, 'Hi Anna, thanks for visiting Madras Jungle! Come back within 14 days for a free dessert.\nReply STOP to unsubscribe', 'the text');
    assertEqual(r.fieldsUsed.sort(), ['contact.firstName', 'link.offer', 'offer.days', 'offer.label', 'venue.name'], 'fields incl. the button link');
    assertEqual(whatsappParams(content, values), ['Anna', 'Madras Jungle', '14', 'a free dessert'], 'Meta values in order');
  });

  await test('renderMessage: a guest without a first name gets the default; no venue name or no offer link → missing (the send is blocked)', () => {
    const values = { 'venue.name': 'Madras Jungle', 'offer.days': '14', 'offer.label': 'a free dessert', 'link.offer': 'https://visit.example/s/abcdefgh' };
    assertEqual(whatsappParams(content, values)[0], 'there', 'the default');
    assertEqual(renderMessage(content, 'whatsapp', { ...values, 'venue.name': undefined }).missing, ['venue.name'], 'no venue name');
    assertEqual(renderMessage(content, 'whatsapp', { ...values, 'link.offer': undefined }).missing, ['link.offer'], 'no offer link (no offer on the journey)');
    assertEqual(renderMessage({ notATemplate: true }, 'whatsapp', values).missing, ['whatsapp'], 'not a template → never sent');
  });

  const state = (mode?: 'off' | 'on'): LaunchState => ({
    default: 'off',
    accounts: {},
    liveSince: { default: null, accounts: {} },
    paused: false,
    safety: { maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 },
    smsCountries: ['CH'],
    alertsEmail: null,
    ...(mode ? { whatsappSending: { mode } } : {}),
  });

  await test('the launch switch: on is a loosening (WHATSAPP ON), off is a brake (no phrase); missing = off', () => {
    const on = summarizeChange(state(), applyChange(state(), { whatsappSending: { mode: 'on' } }));
    assertEqual([on.loosening, on.confirmPhrase], [['wa_send_on'], 'WHATSAPP ON'], 'on');
    assert(on.lines.some((l) => l.startsWith('WhatsApp sending')), `a line: ${on.lines.join(' | ')}`);
    const off = summarizeChange(state('on'), applyChange(state('on'), { whatsappSending: { mode: 'off' } }));
    assertEqual([off.loosening, off.confirmPhrase, off.empty], [[], null, false], 'off');
    assertEqual(summarizeChange(state('on'), applyChange(state('on'), { whatsappSending: { mode: 'on' } })).empty, true, 'on again: nothing changes');
    const both = summarizeChange(state(), applyChange(state(), { paused: true, whatsappSending: { mode: 'on' } }));
    assertEqual(both.confirmPhrase, 'WHATSAPP ON', 'with a brake');
  });

  await test('Meta at send time: 131050 is a STOP; 131026 / 131049 plain refusals (the webhook holds the number)', () => {
    const r = classifyWhatsAppAnswer(400, { error: { code: 131050, message: 'User stopped marketing messages' } }, null);
    assert(r.kind === 'rejected' && r.suppress === 'stop' && !r.config, `131050: ${JSON.stringify(r)}`);
    const u = classifyWhatsAppAnswer(400, { error: { code: 131026, message: 'Message undeliverable' } }, null);
    assert(u.kind === 'rejected' && !u.suppress && u.code === '131026', `131026: ${JSON.stringify(u)}`);
  });

  await test('Replay’s "no channel" words: the WhatsApp rules are not the guest’s reachability (like the old whatsapp_off)', () => {
    assertEqual([...WHATSAPP_CHANNEL_REASONS], ['whatsapp_off', 'whatsapp_unverified', 'whatsapp_no_optin', 'whatsapp_unreachable', 'whatsapp_us_marketing', 'whatsapp_limited'], 'the reasons');
    for (const reason of WHATSAPP_CHANNEL_REASONS) {
      const r = noChannelFor(
        [
          { channel: 'sms', ok: false, reason: 'audience' },
          { channel: 'email', ok: false, reason: 'no_address' },
          { channel: 'whatsapp', ok: false, reason },
        ],
        ['sms', 'email', 'whatsapp'],
      );
      assertEqual(r?.reason, 'audience', `only the owner's audience choice stopped it (${reason})`);
    }
  });

  await test('Replay’s words: WhatsApp blocked by the guest’s SMS STOP is the guest’s stop — "marketing to this guest was stopped"', () => {
    const r = noChannelFor(
      [
        { channel: 'sms', ok: false, reason: 'consent_revoked' },
        { channel: 'email', ok: false, reason: 'no_address' },
        { channel: 'whatsapp', ok: false, reason: 'blocked:sms_stop' },
      ],
      ['sms', 'email', 'whatsapp'],
    );
    assertEqual(r?.fact, 'marketing to this guest was stopped', 'stopped');
  });

  await test('Meta’s signature: only sha256=<HMAC of the raw body with the app secret>; nothing without the secret or the body', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    assertEqual(metaSignatureValid(body, sig, 'app-secret'), true, 'signed');
    assertEqual(metaSignatureValid(body, sig.toUpperCase().replace('SHA256=', 'sha256='), 'app-secret'), true, 'hex case');
    assertEqual(metaSignatureValid(Buffer.from('{"object":"x"}'), sig, 'app-secret'), false, 'another body');
    assertEqual(metaSignatureValid(body, sig, 'other-secret'), false, 'another secret');
    assertEqual(metaSignatureValid(body, sig, undefined), false, 'no secret');
    assertEqual(metaSignatureValid(undefined, sig, 'app-secret'), false, 'no raw body');
    assertEqual(metaSignatureValid(body, 'sha1=abc', 'app-secret'), false, 'not sha256');
    assertEqual(metaSignatureValid(body, undefined, 'app-secret'), false, 'no header');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
