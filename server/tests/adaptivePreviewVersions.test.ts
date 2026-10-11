/**
 * PR PV — "See what guests get" per channel: the pure part (core/owner/previewVersions.ts).
 *
 * Run: npx tsx tests/adaptivePreviewVersions.test.ts   (from captive-server/server)
 *
 * Pins: the channel order (the journey's ladder, then email, SMS, WhatsApp — only what the message
 * has); SMS and email rendered with the values given; a WhatsApp template's text, footer and button;
 * the example from the SMS text (D1) — the link moves to the button, the STOP footer only on
 * marketing; and the "nothing to show" version.
 */

import { emailSmsVersion, versionChannels, whatsappExample, whatsappMissing, whatsappVersion } from '../src/adaptive/core/owner/previewVersions';
import type { Channel } from '../src/adaptive/core/constants';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const FOOTERS = { en: 'Reply STOP to unsubscribe', de: 'Antworte STOP zum Abmelden', fr: 'Répondez STOP', it: 'Rispondi STOP' };
const VALUES = {
  'contact.firstName': 'Anna',
  'venue.name': 'Café Bellevue',
  'offer.label': 'a free dessert',
  'offer.days': '14',
  'link.offer': 'hdf.to/x7k2',
  'link.rating': 'hdf.to/r4t8',
};

console.log('\n"See what guests get" per channel (PR PV)\n');

test('channels: the journey’s ladder first, then email, SMS, WhatsApp — only those the message has', () => {
  const has = (set: Channel[]) => (c: Channel) => set.includes(c);
  assertEqual(versionChannels(['sms', 'email', 'whatsapp'], has(['email', 'sms', 'whatsapp'])), ['sms', 'email', 'whatsapp'], 'SMS-first welcome');
  assertEqual(versionChannels(['email', 'whatsapp', 'sms'], has(['email', 'sms', 'whatsapp'])), ['email', 'whatsapp', 'sms'], 'stay guide');
  assertEqual(versionChannels(['email', 'whatsapp'], has(['email', 'whatsapp'])), ['email', 'whatsapp'], 'local tips: no SMS wording');
  assertEqual(versionChannels(['sms', 'email'], has(['email', 'sms'])), ['sms', 'email'], 'stay review: no WhatsApp');
  assertEqual(versionChannels(['email', 'sms'], has(['email', 'sms', 'whatsapp'])), ['email', 'sms', 'whatsapp'], 'a WhatsApp message outside the ladder (Birthday v2) still shows');
  assertEqual(versionChannels(['sms', 'sms', 'email'], has(['email', 'sms'])), ['sms', 'email'], 'no channel twice');
});

test('SMS and email: rendered with the values given, in the wording’s language', () => {
  const sms = emailSmsVersion('sms', { text: 'Hi {{contact.firstName}}, come back to {{venue.name}} for {{offer.label}} {{link.offer}}' }, 'en', 'Friendly & short', VALUES);
  assertEqual(sms, { channel: 'sms', lang: 'en', name: 'Friendly & short', text: 'Hi Anna, come back to Café Bellevue for a free dessert hdf.to/x7k2', unknown: [] }, 'sms');
  const email = emailSmsVersion('email', { subject: 'Thanks from {{venue.name}}', preheader: 'For {{contact.firstName}}', bodyFormat: 'text', body: 'Hallo {{contact.firstName}} {{slot.nope}}' }, 'de', 'B', VALUES);
  assertEqual([email.subject, email.preheader, email.text, email.lang, email.unknown], ['Thanks from Café Bellevue', 'For Anna', 'Hallo Anna {{slot.nope}}', 'de', ['slot.nope']], 'email, an unknown blank shown raw');
});

test('a WhatsApp template: its text with the values, the grey footer and the button label', () => {
  const v = whatsappVersion('approved', 'de', 'hf_welcome_offer_1', { body: 'Hallo {{contact.firstName | default:"du"}}, bei {{venue.name}} wartet {{offer.label}}.', footer: FOOTERS.de, button: { text: 'Angebot ansehen', field: 'link.offer' } }, VALUES);
  assertEqual(v, { channel: 'whatsapp', lang: 'de', status: 'approved', name: 'hf_welcome_offer_1', text: 'Hallo Anna, bei Café Bellevue wartet a free dessert.', footer: FOOTERS.de, button: { text: 'Angebot ansehen' }, unknown: [] }, 'approved');
  assertEqual(whatsappVersion('in_review', 'en', 'hf_x_1', { body: 'Hi', footer: null, button: null }, VALUES).status, 'in_review', 'waiting for Meta');
});

test('D1: the example from the SMS text — the link moves to the button, STOP footer on marketing only', () => {
  const sms = 'Hi {{contact.firstName}}, thanks for visiting {{venue.name}}! Come back for {{offer.label}} 🎁 {{link.offer}}';
  const marketing = whatsappExample(sms, { lang: 'en', category: 'MARKETING', linkField: 'link.offer', footers: FOOTERS, values: VALUES });
  assertEqual(marketing.status, 'example', 'status');
  assertEqual(marketing.name, null, 'no template name');
  assertEqual(marketing.text, 'Hi Anna, thanks for visiting Café Bellevue! Come back for a free dessert 🎁', 'the text without the link');
  assertEqual([marketing.footer, marketing.button], [FOOTERS.en, { text: 'See your offer' }], 'footer + button');
  const utility = whatsappExample('Welcome to {{venue.name}}! Your info: {{link.hub}}', { lang: 'de', category: 'UTILITY', linkField: 'link.hub', footers: FOOTERS, values: VALUES });
  assertEqual([utility.text, utility.footer, utility.button], ['Welcome to Café Bellevue! Your info', null, { text: 'Gästeinfo öffnen' }], 'utility: no footer, the button in the wording’s language');
  const noLink = whatsappExample('Thanks for staying!', { lang: 'en', category: 'MARKETING', linkField: null, footers: FOOTERS, values: VALUES });
  assertEqual(noLink.button, null, 'no link, no button');
});

test('nothing to show: no template and no SMS text', () => {
  assertEqual(whatsappMissing('de'), { channel: 'whatsapp', lang: 'de', status: 'missing', name: null, text: '', footer: null, button: null, unknown: [] }, 'missing');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
