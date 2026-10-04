/**
 * PR W1 — the pure WhatsApp template core: compile, parse, the checks T01–T22, the status table,
 * the alerts a change brings, the daily summary, the coverage pools. No Firestore, no network.
 *
 * Run: npx tsx tests/adaptiveWhatsAppCore.test.ts   (from captive-server/server)
 */

import {
  buttonUrlFor,
  compileTemplate,
  contentKey,
  langOfMeta,
  parseMetaTemplate,
  parseOurName,
  prefillFromSms,
  sourceFromPositional,
  templateNameFor,
  WA_BUTTON_DEFAULTS,
  type WaSource,
} from '../src/adaptive/core/whatsapp/template';
import { checkImportedTemplate, checkWhatsAppTemplate, promoWordsIn, type CheckContext, type DraftForCheck, type PoolInfo } from '../src/adaptive/core/whatsapp/checks';
import { alertsForChange, categoryFits, digestText, displayStatus, rejectionWords, usable, type AlertView } from '../src/adaptive/core/whatsapp/status';
import { whatsappPools } from '../src/adaptive/core/whatsapp/pools';
import { STOP_LINES } from '../src/adaptive/send/compose';
import type { Lang } from '../src/adaptive/core/constants';

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

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const BASE = 'https://visit.askheidi.app';
const KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

const MARKETING_POOL: PoolInfo = {
  journeyKey: 'welcome_second_visit',
  poolKey: 'welcome_offer',
  purpose: 'marketing',
  whatsappCategory: 'marketing',
  allowedFields: ['venue.name', 'contact.firstName', 'offer.label', 'offer.days', 'offer.expiryDate'],
  linkField: 'link.offer',
};
const UTILITY_POOL: PoolInfo = {
  journeyKey: 'guest_info_wifi',
  poolKey: 'wifi_info',
  purpose: 'service',
  whatsappCategory: 'utility',
  allowedFields: ['venue.name', 'contact.firstName', 'guestinfo.wifiName'],
  linkField: 'link.hub',
};

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    visitorBaseUrl: BASE,
    optOutKeywords: KEYWORDS,
    footers: STOP_LINES,
    pool: MARKETING_POOL,
    siblings: [],
    templateCount: 3,
    templateLimit: 250,
    createsThisHour: 0,
    ...over,
  };
}

const GOOD_MARKETING: WaSource = {
  body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days | default:"14"}} Tagen wieder – dann wartet {{offer.label | default:"eine Überraschung"}} auf dich.',
  footer: 'Antworte STOP zum Abmelden',
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};

const GOOD_UTILITY: WaSource = {
  body: 'Welcome to {{venue.name}}! The Wi-Fi network is {{guestinfo.wifiName | default:"the guest network"}}. Tap below for the house info.',
  footer: null,
  button: { text: 'Open guest info', field: 'link.hub' },
};

function draft(source: WaSource, over: Partial<DraftForCheck> = {}, lang: Lang = 'de'): DraftForCheck {
  return {
    id: 'wt_self',
    name: 'hf_welcome_offer_1',
    lang,
    requestedCategory: 'MARKETING',
    use: { kind: 'adaptive', journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' },
    source,
    compiled: compileTemplate(source, { lang, visitorBaseUrl: BASE }),
    atMeta: false,
    nameLocked: false,
    ...over,
  };
}

const codes = (r: { issues: Array<{ code: string; severity: string }> }, sev = 'error') => r.issues.filter((i) => i.severity === sev).map((i) => i.code);

console.log('\nWhatsApp templates — the pure core (PR W1)\n');

// ── Compile ─────────────────────────────────────────────────────────────────

test('compile: fields become {{1}}, {{2}}… in order of first use, with fallbacks, formats and samples', () => {
  const c = compileTemplate(GOOD_MARKETING, { lang: 'de', visitorBaseUrl: BASE });
  assertEqual(c.params.map((p) => [p.n, p.field, p.fallback]), [[1, 'contact.firstName', 'du'], [2, 'venue.name', null], [3, 'offer.days', '14'], [4, 'offer.label', 'eine Überraschung']], 'params');
  assert(c.bodyText.startsWith('Hallo {{1}}, danke für deinen Besuch bei {{2}}!'), c.bodyText);
  assertEqual(c.params.map((p) => p.example), ['Anna', 'Café Bellevue', '14', 'ein Gratis-Dessert'], 'examples (German offer)');
});

test('compile: components are exactly Meta’s shape (nested body example, footer, URL button with the variable part as example)', () => {
  const c = compileTemplate(GOOD_MARKETING, { lang: 'de', visitorBaseUrl: BASE });
  assertEqual(c.components[0], { type: 'BODY', text: c.bodyText, example: { body_text: [['Anna', 'Café Bellevue', '14', 'ein Gratis-Dessert']] } }, 'body');
  assertEqual(c.components[1], { type: 'FOOTER', text: 'Antworte STOP zum Abmelden' }, 'footer');
  assertEqual(c.components[2], { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Angebot ansehen', url: 'https://visit.askheidi.app/{{1}}', example: ['s/gkgq7j5z'] }] }, 'button');
});

test('compile: no fields → no example; no footer/button → none sent; a field used twice keeps one number', () => {
  const c = compileTemplate({ body: 'Thanks for coming to {{venue.name}}, see you at {{venue.name}}.', footer: null, button: null }, { lang: 'en', visitorBaseUrl: BASE });
  assertEqual(c.params.length, 1, 'one param');
  assertEqual(c.bodyText, 'Thanks for coming to {{1}}, see you at {{1}}.', 'reused number');
  assertEqual(c.components.length, 1, 'body only');
  const none = compileTemplate({ body: 'Thank you!', footer: null, button: null }, { lang: 'en', visitorBaseUrl: BASE });
  assert(!('example' in none.components[0]), 'no example without fields');
});

test('compile: dates use their own format in the example', () => {
  const c = compileTemplate({ body: 'Your offer at {{venue.name}} is valid until {{offer.expiryDate | date:"d.M." | default:"soon"}}, enjoy it.', footer: null, button: null }, { lang: 'en', visitorBaseUrl: BASE });
  assertEqual(c.params[1].example, '20.10.', 'date sample');
  assertEqual(c.params[1].date, 'd.M.', 'format kept');
});

test('button URL: the bare host plus one variable, trailing slash removed', () => {
  assertEqual(buttonUrlFor('https://visit.askheidi.app/'), 'https://visit.askheidi.app/{{1}}', 'url');
});

test('names and languages', () => {
  assertEqual(templateNameFor('welcome_offer', 3), 'hf_welcome_offer_3', 'name');
  assertEqual(parseOurName('hf_stay_welcome_12'), { poolKey: 'stay_welcome', n: 12 }, 'parse ours');
  assertEqual(parseOurName('restaurant_feedback_request'), null, 'legacy');
  assertEqual([langOfMeta('en_US'), langOfMeta('de'), langOfMeta('de_CH'), langOfMeta('pt_BR'), langOfMeta(null)], ['en', 'de', 'de', null, null], 'langs');
});

test('sourceFromPositional: Meta’s {{n}} back to named fields (link)', () => {
  const s = sourceFromPositional('Hi {{1}}, thanks for visiting {{2}} today.', [
    { n: 1, field: 'contact.firstName', fallback: 'there' },
    { n: 2, field: 'venue.name' },
  ]);
  assertEqual(s, 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today.', 'source');
  const c = compileTemplate({ body: s, footer: null, button: null }, { lang: 'en', visitorBaseUrl: BASE });
  assertEqual(c.bodyText, 'Hi {{1}}, thanks for visiting {{2}} today.', 'round trip');
});

test('prefill: the SMS without its link, the STOP footer for marketing, the message’s button', () => {
  const s = prefillFromSms('Hallo {{contact.firstName | default:"du"}}, wie war dein Besuch bei {{venue.name}}? Tipp auf einen Stern: {{link.rating}}', {
    lang: 'de',
    category: 'MARKETING',
    linkField: 'link.rating',
    footers: STOP_LINES,
  });
  assert(!s.body.includes('link.'), s.body);
  assert(s.body.endsWith('Tipp auf einen Stern'), s.body);
  assertEqual(s.footer, STOP_LINES.de, 'footer');
  assertEqual(s.button, { text: WA_BUTTON_DEFAULTS['link.rating'].de, field: 'link.rating' }, 'button');
  const u = prefillFromSms('Welcome to {{venue.name}}', { lang: 'en', category: 'UTILITY', linkField: null, footers: STOP_LINES });
  assertEqual([u.footer, u.button], [null, null], 'utility: no footer, no link → no button');
});

test('every default button label fits Meta’s 25 characters', () => {
  for (const [field, langs] of Object.entries(WA_BUTTON_DEFAULTS)) for (const [lang, text] of Object.entries(langs)) assert(text.length <= 25, `${field} ${lang}: ${text}`);
});

test('every STOP line is a valid marketing footer (≤ 60, contains STOP)', () => {
  for (const [lang, line] of Object.entries(STOP_LINES)) {
    assert(line.length <= 60, `${lang} too long`);
    assert(/(^|[^A-Za-z])STOP($|[^A-Za-z])/.test(line), `${lang} has no STOP`);
  }
});

// ── Parse Meta's JSON ───────────────────────────────────────────────────────

const VISIT_FEEDBACK = {
  id: '1234567890',
  name: 'heidifi_visit_feedback',
  language: 'en',
  status: 'APPROVED',
  category: 'UTILITY',
  quality_score: { score: 'GREEN' },
  parameter_format: 'POSITIONAL',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, thanks for visiting {{2}} today. How did we do? Tap below to leave quick feedback.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Rate your visit', url: 'https://visit.askheidi.app/%7B%7B1%7D%7D{{1}}', example: ['s/gkgq7j5z'] }] },
  ],
};
const OTP = {
  id: '111',
  name: 'heidifi_verification_code',
  language: 'en',
  status: 'APPROVED',
  category: 'AUTHENTICATION',
  components: [
    { type: 'BODY', text: '*{{1}}* is your verification code.', add_security_recommendation: true },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
  ],
};

test('parse: the three real templates (status, category, quality, body, buttons; OTP button kept)', () => {
  const v = parseMetaTemplate(VISIT_FEEDBACK)!;
  assertEqual([v.id, v.lang, v.status, v.category, v.quality, v.buttons[0].url], ['1234567890', 'en', 'APPROVED', 'UTILITY', 'GREEN', 'https://visit.askheidi.app/%7B%7B1%7D%7D{{1}}'], 'visit');
  const o = parseMetaTemplate(OTP)!;
  assertEqual([o.category, o.buttons[0].type, o.buttons[0].otpType], ['AUTHENTICATION', 'OTP', 'COPY_CODE'], 'otp');
});

test('parse: lenient — media header and unknown parts kept by name, junk refused', () => {
  const t = parseMetaTemplate({ id: '9', name: 'x', language: 'de', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'CAROUSEL' }, { type: 'BODY', text: 'Hi' }] })!;
  assertEqual(t.otherComponents, ['HEADER:IMAGE', 'CAROUSEL'], 'others');
  assertEqual([parseMetaTemplate(null), parseMetaTemplate({ name: 'x' }), parseMetaTemplate('x')], [null, null, null], 'junk');
});

test('contentKey: whitespace differences are the same content; a different button is not', () => {
  const a = { bodyText: 'Hi  {{1}}\n', footerText: null, buttons: [{ text: 'Go', url: 'u' }] };
  const b = { bodyText: 'Hi {{1}}', footerText: '', buttons: [{ text: 'Go ', url: 'u' }] };
  assertEqual(contentKey(a), contentKey(b), 'same');
  assert(contentKey(a) !== contentKey({ ...b, buttons: [{ text: 'Go', url: 'v' }] }), 'different');
});

// ── The checks ──────────────────────────────────────────────────────────────

test('a good German marketing draft and a good English utility draft pass with no errors or warnings', () => {
  const m = checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx());
  assertEqual([m.ok, m.errors, m.warnings], [true, 0, 0], `marketing: ${JSON.stringify(m.issues)}`);
  const u = checkWhatsAppTemplate(draft(GOOD_UTILITY, { requestedCategory: 'UTILITY', name: 'hf_wifi_info_1', use: { kind: 'adaptive', journeyKey: 'guest_info_wifi', poolKey: 'wifi_info' } }, 'en'), ctx({ pool: UTILITY_POOL }));
  assertEqual([u.ok, u.errors, u.warnings], [true, 0, 0], `utility: ${JSON.stringify(u.issues)}`);
});

test('T01 name / T02 language / T03 category asked', () => {
  const r = checkWhatsAppTemplate(draft(GOOD_MARKETING, { name: 'HF-Welcome', lang: null, requestedCategory: 'AUTHENTICATION' }), ctx());
  for (const c of ['T01', 'T02', 'T03']) assert(codes(r).includes(c), `${c} in ${codes(r)}`);
});

test('T04 the message’s rule: a marketing message filed as Utility, a service message as Marketing, a message with no WhatsApp', () => {
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING, { requestedCategory: 'UTILITY' }), ctx())).includes('T04'), 'marketing as utility');
  const u = draft(GOOD_UTILITY, { requestedCategory: 'MARKETING' }, 'en');
  assert(codes(checkWhatsAppTemplate(u, ctx({ pool: UTILITY_POOL }))).includes('T04'), 'service as marketing');
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ pool: null }))).includes('T04'), 'no pool');
});

test('T05 one category for every language of a name', () => {
  const r = checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ siblings: [{ id: 'wt_en', name: 'hf_welcome_offer_1', language: 'en', category: 'UTILITY', bodyNorm: 'x', dismissed: false }] }));
  assert(codes(r).includes('T05'), codes(r).join());
});

test('T06 body length: over 1024 is an error; a long worst case is a warning', () => {
  const long = { ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} ${'Wir freuen uns. '.repeat(70)}` };
  assert(codes(checkWhatsAppTemplate(draft(long), ctx())).includes('T06'), 'error');
  const near = { ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} ${'Wir freuen uns. '.repeat(52)}` };
  const r = checkWhatsAppTemplate(draft(near), ctx());
  assert(!codes(r).includes('T06') && codes(r, 'warning').includes('T06'), JSON.stringify(r.issues));
});

test('T07 footer length', () => {
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, footer: `STOP ${'x'.repeat(60)}` }), ctx())).includes('T07'), 'footer');
});

test('T08 fields: links in the text, secrets, unknown/multi-line fields, fields this message lacks, a field twice, broken braces', () => {
  const r1 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Hier: {{link.offer}} und mehr Text dazu.` }), ctx());
  assert(r1.issues.some((i) => i.code === 'T08' && /button/.test(i.message)), 'link');
  const r2 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Code {{guestinfo.secret.doorCode | default:"x"}} hier bitte.` }), ctx());
  assert(r2.issues.some((i) => i.code === 'T08' && /Secrets/.test(i.message)), 'secret');
  const r3 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Regeln: {{guestinfo.houseRules | default:"x"}} bitte lesen.` }), ctx());
  assert(r3.issues.some((i) => i.code === 'T08' && /can’t be used/.test(i.message)), 'multi-line');
  const r4 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} WLAN {{guestinfo.wifiName | default:"x"}} gibt es auch.` }), ctx());
  assert(r4.issues.some((i) => i.code === 'T08' && /has no/.test(i.message)), 'not this message');
  const r5 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Bis bald bei {{venue.name}}, wir freuen uns.` }), ctx());
  assert(r5.issues.some((i) => i.code === 'T08' && /2 times/.test(i.message)), 'twice');
  const r6 = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Und {{venue name}} kaputt hier drin.` }), ctx());
  assert(r6.issues.some((i) => i.code === 'T08' && /well formed/.test(i.message)), 'braces');
});

test('T09 placement: not first, not last, not side by side', () => {
  const first = { ...GOOD_MARKETING, body: '{{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}} heute, bis zum nächsten Mal!' };
  assert(codes(checkWhatsAppTemplate(draft(first), ctx())).includes('T09'), 'first');
  const last = { ...GOOD_MARKETING, body: 'Danke für deinen Besuch, wir freuen uns schon auf das nächste Mal bei {{venue.name}}' };
  assert(codes(checkWhatsAppTemplate(draft(last), ctx())).includes('T09'), 'last');
  const side = { ...GOOD_MARKETING, body: 'Hallo {{contact.firstName | default:"du"}}, {{venue.name}} sagt danke für deinen Besuch, bis bald wieder!' };
  assert(codes(checkWhatsAppTemplate(draft(side), ctx())).includes('T09'), 'side by side');
});

test('T10 too few words for its fields: under 2 a field is an error, under 3 a warning', () => {
  const thin = { ...GOOD_MARKETING, body: 'Hi {{contact.firstName | default:"du"}} at {{venue.name}}: {{offer.label | default:"x"}} now!' };
  assert(codes(checkWhatsAppTemplate(draft(thin), ctx())).includes('T10'), 'thin');
  const lean = { ...GOOD_MARKETING, body: 'Hallo {{contact.firstName | default:"du"}}, bei {{venue.name}} wartet noch {{offer.label | default:"x"}} auf dich – aber nur bis {{offer.expiryDate | date:"d.M." | default:"bald"}}. Bis bald!' };
  const r = checkWhatsAppTemplate(draft(lean), ctx());
  assert(!codes(r).includes('T10') && codes(r, 'warning').includes('T10'), JSON.stringify(r.issues));
});

test('T11 a default for every field but the venue; a format for dates', () => {
  const noDefault = { ...GOOD_MARKETING, body: GOOD_MARKETING.body.replace('{{contact.firstName | default:"du"}}', '{{contact.firstName}}') };
  assert(checkWhatsAppTemplate(draft(noDefault), ctx()).issues.some((i) => i.code === 'T11' && /default/.test(i.message)), 'default');
  const noFormat = { ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Gültig bis {{offer.expiryDate | default:"bald"}} für dich.` };
  assert(checkWhatsAppTemplate(draft(noFormat), ctx()).issues.some((i) => i.code === 'T11' && /date format/.test(i.message)), 'date');
});

test('T12 button: too long (error); another link than the message’s or none (warnings); a non-https base (error)', () => {
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, button: { text: 'x'.repeat(26), field: 'link.offer' } }), ctx())).includes('T12'), 'long');
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, button: { text: 'Bewerten', field: 'link.rating' } }), ctx()), 'warning').includes('T12'), 'other link');
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, button: null }), ctx()), 'warning').includes('T12'), 'no button');
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ visitorBaseUrl: 'http://visit.test' }))).includes('T12'), 'http');
});

test('T12 imported: the mis-registered heidifi_visit_feedback button is an error; the correct legacy one and the OTP template pass', () => {
  const broken = checkImportedTemplate({ name: 'heidifi_visit_feedback', buttons: parseMetaTemplate(VISIT_FEEDBACK)!.buttons, use: { kind: 'legacy' } }, { visitorBaseUrl: BASE });
  assert(codes(broken).includes('T12'), JSON.stringify(broken.issues));
  const good = checkImportedTemplate({ name: 'restaurant_feedback_request', buttons: [{ type: 'URL', text: 'Rate Us', url: 'https://visit.askheidi.app/{{1}}', example: null, otpType: null }], use: { kind: 'legacy' } }, { visitorBaseUrl: BASE });
  assertEqual(good.errors, 0, 'correct legacy');
  assertEqual(checkImportedTemplate({ name: 'heidifi_verification_code', buttons: parseMetaTemplate(OTP)!.buttons, use: { kind: 'otp' } }, { visitorBaseUrl: BASE }).errors, 0, 'otp');
});

test('T13 the venue is named', () => {
  const r = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch! Komm bald wieder, wir freuen uns auf dich.' }), ctx());
  assert(codes(r).includes('T13'), codes(r).join());
});

test('T14 no links, emails or phone numbers in the fixed text', () => {
  for (const extra of ['Mehr auf www.example.ch für dich.', 'Schreib an info@example.ch wenn du magst.', 'Ruf an: +41 44 123 45 67 für Fragen.']) {
    assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} ${extra}` }), ctx())).includes('T14'), extra);
  }
});

test('T15 STOP belongs in the footer; a lowercase “stop by” is fine', () => {
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Antworte STOP zum Abmelden.` }), ctx())).includes('T15'), 'STOP');
  const u = { ...GOOD_UTILITY, body: `${GOOD_UTILITY.body} Stop by the front desk anytime.` };
  assert(!codes(checkWhatsAppTemplate(draft(u, { requestedCategory: 'UTILITY' }, 'en'), ctx({ pool: UTILITY_POOL }))).includes('T15'), 'stop by');
});

test('T16 template limit (error at the limit, warning near it); T22 creates this hour; neither once at Meta', () => {
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ templateCount: 250 }))).includes('T16'), 'full');
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ templateCount: 230 })), 'warning').includes('T16'), 'near');
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ createsThisHour: 100 }))).includes('T22'), 'hour');
  const atMeta = checkWhatsAppTemplate(draft(GOOD_MARKETING, { atMeta: true }), ctx({ templateCount: 250, createsThisHour: 100 }));
  assert(!codes(atMeta).includes('T16') && !codes(atMeta).includes('T22'), 'at Meta');
});

test('T17 name locked; T18 duplicate text in the same language (not another language, not a dismissed one)', () => {
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING, { nameLocked: true }), ctx())).includes('T17'), 'locked');
  const body = compileTemplate(GOOD_MARKETING, { lang: 'de', visitorBaseUrl: BASE }).bodyText;
  const sib = { id: 'wt_other', name: 'hf_welcome_offer_2', language: 'de', category: 'MARKETING', bodyNorm: body.replace(/\s+/g, ' ').trim(), dismissed: false };
  assert(codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ siblings: [sib] }))).includes('T18'), 'dup');
  assert(!codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ siblings: [{ ...sib, language: 'en' }] }))).includes('T18'), 'other language');
  assert(!codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ siblings: [{ ...sib, dismissed: true }] }))).includes('T18'), 'dismissed');
});

test('T19 utility: offer fields are errors; promotional words and emoji are warnings (in all four languages)', () => {
  const offer = { ...GOOD_UTILITY, body: `${GOOD_UTILITY.body} Plus {{offer.label | default:"x"}} for your next stay with us.` };
  assert(codes(checkWhatsAppTemplate(draft(offer, { requestedCategory: 'UTILITY' }, 'en'), ctx({ pool: { ...UTILITY_POOL, allowedFields: [...UTILITY_POOL.allowedFields, 'offer.label'] } }))).includes('T19'), 'offer field');
  for (const word of ['free', 'gratis', 'Rabatt', 'offert', 'sconto']) {
    const r = checkWhatsAppTemplate(draft({ ...GOOD_UTILITY, body: `${GOOD_UTILITY.body} Also ${word} drinks at the bar tonight.` }, { requestedCategory: 'UTILITY' }, 'en'), ctx({ pool: UTILITY_POOL }));
    assert(!codes(r).includes('T19') && codes(r, 'warning').includes('T19'), `${word}: ${JSON.stringify(r.issues)}`);
  }
  const emoji = checkWhatsAppTemplate(draft({ ...GOOD_UTILITY, body: `${GOOD_UTILITY.body} 🎉` }, { requestedCategory: 'UTILITY' }, 'en'), ctx({ pool: UTILITY_POOL }));
  assert(codes(emoji, 'warning').includes('T19'), 'emoji');
  assertEqual(promoWordsIn('feel free to ask'), ['free'], 'whole words only');
  assertEqual(promoWordsIn('freedom and discounts'), [], 'not inside words');
  assert(promoWordsIn('Save 20% today').includes('%'), 'percent');
});

test('T20 marketing needs a STOP footer; a utility footer is a warning', () => {
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, footer: null }), ctx())).includes('T20'), 'missing');
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, footer: 'Antworte STOPP zum Abmelden' }), ctx())).includes('T20'), 'STOPP is not a keyword');
  const u = checkWhatsAppTemplate(draft({ ...GOOD_UTILITY, footer: 'Reply STOP to unsubscribe' }, { requestedCategory: 'UTILITY' }, 'en'), ctx({ pool: UTILITY_POOL }));
  assert(codes(u, 'warning').includes('T20'), 'utility footer');
});

test('T21 formatting: tabs, more than one empty line, runs of spaces', () => {
  for (const bad of ['\tTab', '\n\n\nZu viele Zeilen', 'Viele    Leerzeichen']) {
    assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} ${bad} hier.` }), ctx())).includes('T21'), JSON.stringify(bad));
  }
});

test('review fixes: dates, times and opening hours are not phone numbers; a real number still is', () => {
  for (const extra of ['Gültig bis 31.12.2026 für dich.', 'Frühstück 7.00 - 10.30 im Café.', 'Check-in 15:00 – 22:00 bitte.']) {
    const r = checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} ${extra}` }), ctx());
    assert(!codes(r).includes('T14'), `${extra}: ${JSON.stringify(r.issues)}`);
  }
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, body: `${GOOD_MARKETING.body} Ruf an: 044 123 45 67 für Fragen.` }), ctx())).includes('T14'), 'phone');
});

test('review fixes: a field or line break in the footer (T07) or the button text (T12) is an error', () => {
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, footer: 'STOP to {{venue.name}}' }), ctx())).includes('T07'), 'footer field');
  assert(codes(checkWhatsAppTemplate(draft({ ...GOOD_MARKETING, button: { text: 'Hi {{venue.name}}', field: 'link.offer' } }), ctx())).includes('T12'), 'button field');
});

test('review fixes: T05/T18 judge drafts only, and ignore deleted / name-locked siblings', () => {
  const body = compileTemplate(GOOD_MARKETING, { lang: 'de', visitorBaseUrl: BASE }).bodyText.replace(/\s+/g, ' ').trim();
  const sib = { id: 'wt_other', name: 'hf_welcome_offer_2', language: 'de', category: 'MARKETING', bodyNorm: body, dismissed: false };
  assert(!codes(checkWhatsAppTemplate(draft(GOOD_MARKETING), ctx({ siblings: [{ ...sib, active: false }] }))).includes('T18'), 'inactive sibling');
  assert(!codes(checkWhatsAppTemplate(draft(GOOD_MARKETING, { atMeta: true }), ctx({ siblings: [sib] }))).includes('T18'), 'at Meta: no T18');
  const otherLang = { id: 'wt_en', name: 'hf_welcome_offer_1', language: 'en', category: 'UTILITY', bodyNorm: 'x', dismissed: false };
  assert(!codes(checkWhatsAppTemplate(draft(GOOD_MARKETING, { atMeta: true }), ctx({ siblings: [otherLang] }))).includes('T05'), 'at Meta: no T05');
});

// ── Status ──────────────────────────────────────────────────────────────────

test('display status: our stage first, then Meta’s status; unknown values need attention', () => {
  const base = { stage: 'submitted' as const, metaCategory: 'MARKETING', dismissed: false, checksOk: true, poolCategory: 'marketing' as const, adaptive: true };
  const cases: Array<[string | null, string]> = [
    ['APPROVED', 'approved'],
    ['PENDING', 'in_review'],
    ['IN_APPEAL', 'in_review'],
    ['REJECTED', 'rejected'],
    ['PAUSED', 'paused'],
    ['DISABLED', 'disabled'],
    ['PENDING_DELETION', 'deleted'],
    ['LIMIT_EXCEEDED', 'attention'],
    ['SOMETHING_NEW', 'attention'],
  ];
  for (const [s, want] of cases) assertEqual(displayStatus({ ...base, metaStatus: s }), want, String(s));
  assertEqual(displayStatus({ ...base, stage: 'draft', metaStatus: null, checksOk: false }), 'needs_fix', 'draft with errors');
  assertEqual(displayStatus({ ...base, stage: 'draft', metaStatus: null }), 'ready', 'draft');
  assertEqual(displayStatus({ ...base, stage: 'submitting', metaStatus: null }), 'submitting', 'submitting');
  assertEqual(displayStatus({ ...base, metaStatus: 'APPROVED', dismissed: true }), 'dismissed', 'dismissed');
});

test('blocked: a service message approved as MARKETING; a marketing message takes either category', () => {
  assertEqual(categoryFits('MARKETING', 'utility'), false, 'utility needs UTILITY');
  assertEqual([categoryFits('UTILITY', 'marketing'), categoryFits('MARKETING', 'marketing')], [true, true], 'marketing');
  const s = displayStatus({ stage: 'submitted', metaStatus: 'APPROVED', metaCategory: 'MARKETING', dismissed: false, checksOk: true, poolCategory: 'utility', adaptive: true });
  assertEqual(s, 'blocked', 'blocked');
  assertEqual([usable('approved', true, true), usable('approved', false, true), usable('blocked', true, true), usable('approved', true, false)], [true, false, false, false], 'usable');
});

test('rejection reasons in words', () => {
  assert(/category/.test(rejectionWords('INCORRECT_CATEGORY')), 'category');
  assert(/no reason/.test(rejectionWords('NONE')), 'none');
  assert(/WEIRD/.test(rejectionWords('WEIRD')), 'unknown kept');
});

// ── Alerts ──────────────────────────────────────────────────────────────────

const view = (display: AlertView['display'], over: Partial<AlertView> = {}): AlertView => ({ display, name: 'hf_x_1', language: 'de', otp: false, metaCategory: 'MARKETING', quality: 'GREEN', rejectedReason: null, ...over });

test('alerts: entering rejected / paused / blocked / attention / RED quality / deleted-while-approved alerts once; approval does not', () => {
  assertEqual(alertsForChange(view('in_review'), view('approved'), 'k').length, 0, 'approval goes to the summary');
  assertEqual(alertsForChange(view('in_review'), view('rejected', { rejectedReason: 'INVALID_FORMAT' }), 'k').length, 1, 'rejected');
  assertEqual(alertsForChange(view('rejected'), view('rejected'), 'k').length, 0, 'still rejected: no repeat');
  assertEqual(alertsForChange(view('approved'), view('paused'), 'k').length, 1, 'paused');
  assertEqual(alertsForChange(view('approved'), view('blocked', { metaCategory: 'MARKETING' }), 'k').length, 1, 'blocked');
  assertEqual(alertsForChange(view('approved'), view('attention'), 'k').length, 1, 'attention');
  assertEqual(alertsForChange(view('approved'), view('approved', { quality: 'RED' }), 'k').length, 1, 'red');
  assertEqual(alertsForChange(view('approved'), view('deleted'), 'k').length, 1, 'deleted while approved');
  assertEqual(alertsForChange(view('rejected'), view('deleted'), 'k').length, 0, 'deleted after rejected');
});

test('alerts: keys are per change; the OTP template is urgent, also on first import when not approved', () => {
  const two = alertsForChange(view('approved'), view('paused', { quality: 'RED' }), 'wa:doc:7');
  assertEqual(two.map((a) => a.key), ['wa:doc:7:0', 'wa:doc:7:1'], 'keys');
  const otp = alertsForChange(view('approved', { otp: true }), view('paused', { otp: true }), 'k');
  assert(otp[0].urgent && /URGENT/.test(otp[0].subject), 'urgent');
  assertEqual(alertsForChange(null, view('rejected'), 'k').length, 0, 'an import does not alert');
  assertEqual(alertsForChange(null, view('paused', { otp: true }), 'k').length, 1, 'OTP import alerts');
});

test('the daily summary: nothing to tell → null; otherwise sections and a subject', () => {
  assertEqual(digestText({ approved: [], waiting: [], inReview: [], problems: [] }), null, 'empty');
  const d = digestText({ approved: [{ label: 'hf_a_1 (en)', note: 'UTILITY' }], waiting: [{ label: 'hf_b_1 (de)' }], inReview: [], problems: [{ label: 'hf_c_1 (fr)', note: 'rejected' }] })!;
  assertEqual(d.subject, 'WhatsApp templates: 1 approved, 1 waiting for you, 1 problem', 'subject');
  assert(d.text.includes('Approved by Meta since the last summary (1):') && d.text.includes('- hf_c_1 (fr) — rejected'), d.text);
});

// ── Coverage pools ──────────────────────────────────────────────────────────

test('pools: only WhatsApp-capable pools, their rule, allowed fields from their wording, their link', () => {
  const def = {
    pools: {
      welcome_offer: { purpose: 'marketing', channels: ['sms', 'email', 'whatsapp'], requiredLocales: ['en'], whatsappCategory: 'marketing' },
      sms_only: { purpose: 'marketing', channels: ['sms'], requiredLocales: ['en'] },
      wifi_info: { purpose: 'service', channels: ['email', 'whatsapp'], requiredLocales: ['en'], whatsappCategory: 'utility' },
      stay_midstay: { purpose: 'service', channels: ['whatsapp'], requiredLocales: ['en'] },
    },
  } as never;
  const rows = whatsappPools(
    [{ key: 'j', name: { en: 'Journey' }, availability: 'available', definition: def }],
    [
      { poolKey: 'welcome_offer', journeyKey: 'j', status: 'active', channels: { sms: { text: 'Hi {{contact.firstName}}, {{offer.label}} at {{venue.name}} {{link.offer}}' } } },
      { poolKey: 'wifi_info', journeyKey: 'j', status: 'active', channels: { sms: { text: 'Wi-Fi {{guestinfo.wifiName}} {{offer.label}} {{link.hub}}' } } },
      { poolKey: 'stay_midstay', journeyKey: 'j', status: 'active', channels: { sms: { text: 'Need anything? {{guestinfo.hostContactUrl}}' } } },
    ],
  );
  assertEqual(rows.map((r) => [r.poolKey, r.whatsappCategory, r.linkField]), [['welcome_offer', 'marketing', 'link.offer'], ['wifi_info', 'utility', 'link.hub'], ['stay_midstay', 'utility', 'link.hub']], 'rows');
  assert(rows[0].allowedFields.includes('offer.label'), 'offer allowed in marketing');
  assert(!rows[1].allowedFields.includes('offer.label') && rows[1].allowedFields.includes('guestinfo.wifiName'), 'utility drops offer fields');
  assert(!rows[2].allowedFields.includes('guestinfo.hostContactUrl'), 'never a URL field');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
