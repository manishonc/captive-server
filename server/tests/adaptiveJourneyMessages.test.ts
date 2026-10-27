/**
 * Journey channels — the admin journey page's messages (service/journeyMessagesView.ts, pure).
 *
 * Run: npx tsx tests/adaptiveJourneyMessages.test.ts   (from captive-server/server)
 *
 * Pins, on the seeded Welcome → come back v2 and its wording: one entry per message in the journey's
 * order, with the steps that send it; each wording's SMS and email in the asked language (English when
 * there is none), as written and as the example guest gets it; the SMS as sent (the STOP line the engine
 * adds, also on info messages), its parts and credits (info messages free); the email drawn in the
 * Voucher design; WhatsApp: the templates rendered with the same values, and what a guest of the asked
 * language gets (the picked template, else the example from the SMS, else nothing); no WhatsApp part
 * for a message that can't go by it.
 */

import { buildJourneyMessages, type JourneyMessagesInput, type WordingLike } from '../src/adaptive/service/journeyMessagesView';
import { journeyDefinitionSchema, type JourneyDefinition } from '../src/adaptive/core/schemas';
import { smsParts } from '../src/adaptive/core/runtime/smsParts';
import { STOP_LINES } from '../src/adaptive/send/compose';
import { designBrandFrom } from '../src/adaptive/send/design';
import { VARIANTS_V1 } from '../src/adaptive/seed/definitions/variants';
import { welcomeSecondVisitV2 } from '../src/adaptive/seed/definitions/journeysWelcomeV2';
import { PLAYBOOKS_V1 } from '../src/adaptive/seed/definitions/playbooks';

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

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const definition: JourneyDefinition = journeyDefinitionSchema.parse(welcomeSecondVisitV2.definition);
const restaurant = PLAYBOOKS_V1.find((p) => p.key === 'restaurant_growth')!;
const offers = restaurant.content.offerMenuDefaults ?? [];
const variants: WordingLike[] = VARIANTS_V1.filter((v) => v.journeyKey === 'welcome_second_visit').map((v, i) => ({
  ...(v as unknown as WordingLike),
  id: `var_${i}`,
  status: 'active',
  journeyKey: v.journeyKey,
}));
const welcomeEn = { body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}}! {{offer.label | default:"A little surprise"}} waits for you. See you soon!', footer: STOP_LINES.en, button: { text: 'See your offer', field: 'link.offer' as const } };
const thanksDe = { body: 'Danke, dass du wieder bei {{venue.name}} warst, {{contact.firstName | default:"lieber Gast"}}! Bis bald.', footer: null, button: null };

function input(over: Partial<JourneyMessagesInput> = {}): JourneyMessagesInput {
  return {
    definition,
    variants,
    lang: 'de',
    venueName: 'Café Bellevue',
    slots: { offer: 'dessert', offer_days: 14 },
    offers,
    now: new Date('2026-10-26T10:00:00Z'),
    rates: { smsPerPart: 15, email: 1 },
    design: { brand: designBrandFrom(null, { name: 'Café Bellevue' }), poweredBy: true },
    whatsapp: {
      welcome_offer: {
        rule: 'marketing',
        linkField: 'link.offer',
        templates: [{ id: 'wt_1', name: 'hf_welcome_offer_1', lang: 'en', source: welcomeEn }],
        pick: { status: 'approved', lang: 'en', name: 'hf_welcome_offer_1', source: welcomeEn },
      },
      last_chance: { rule: 'marketing', linkField: 'link.offer', templates: [], pick: null },
      thank_you: { rule: 'utility', linkField: null, templates: [{ id: 'wt_2', name: 'hf_thank_you_1', lang: 'de', source: thanksDe }], pick: null },
    },
    stopLines: STOP_LINES,
    ...over,
  };
}

console.log('\nJourney channels: the admin journey page’s messages\n');

const de = buildJourneyMessages(input());

test('one entry per message, in the journey’s order, named in the asked language, with the steps that send it', () => {
  assertEqual(de.map((m) => m.poolKey), ['welcome_offer', 'last_chance', 'thank_you'], 'pools');
  assertEqual(de.map((m) => m.name), ['Willkommensangebot', 'Letzte Chance', 'Dankeschön'], 'names');
  assertEqual(de[0].steps.map((s) => s.number), [3, 5, 6], 'welcome steps');
  assertEqual(de[1].steps.map((s) => s.number), [9], 'last chance step');
  assertEqual(de[2].steps.map((s) => s.number), [11], 'thank-you step');
  assertEqual(de[0].purpose, 'marketing', 'purpose');
  assertEqual(de[2].purpose, 'service', 'thank-you purpose');
});

test('each wording, by letter, with its German SMS as written and as Anna gets it', () => {
  const [a, b] = de[0].wordings;
  assertEqual([a.letter, b.letter], ['A', 'B'], 'letters');
  assert(a.sms, 'wording A has an SMS');
  assertEqual(a.sms.lang, 'de', 'language');
  assertEqual(a.sms.fallback, false, 'no fallback');
  assert(a.sms.template.includes('{{offer.label}}'), 'the template keeps its fields');
  assert(a.sms.text.startsWith('Hallo Anna, danke für deinen Besuch bei Café Bellevue!'), `rendered: ${a.sms.text}`);
  assert(a.sms.text.includes('ein Gratis-Dessert'), 'the offer from the example playbook');
  assert(a.sms.text.includes('hdf.to/x7k2'), 'the example offer link');
});

test('the SMS as sent: the STOP line, its parts and credits; info messages are free but keep the STOP line', () => {
  const sms = de[0].wordings[0].sms!;
  assertEqual(sms.sent, `${sms.text}\n${STOP_LINES.de}`, 'sent');
  const p = smsParts(sms.sent);
  assertEqual([sms.parts, sms.encoding, sms.credits], [p.segments, p.encoding, p.segments * 15], 'parts and credits');
  const thanks = de[2].wordings[0].sms!;
  assertEqual(thanks.credits, 0, 'info message credits');
  assert(thanks.sent.endsWith(STOP_LINES.de), 'the engine adds the STOP line to every SMS');
});

test('the languages each message’s active SMS and email wording has (the coverage strip); drafts don’t count', () => {
  assertEqual(de.map((m) => m.languages), de.map((m) => ({ sms: m.channels.includes('sms') ? ['de', 'en'] : [], email: m.channels.includes('email') ? ['de', 'en'] : [] })), 'EN and DE seeded');
  assertEqual(buildJourneyMessages(input({ lang: 'fr' }))[0].languages, de[0].languages, 'the same in every asked language');
  const drafts = buildJourneyMessages(input({ variants: variants.map((v) => (v.poolKey === 'welcome_offer' ? { ...v, status: 'draft' } : v)) }));
  assertEqual(drafts[0].languages, { sms: [], email: [] }, 'only draft wording');
  assertEqual(drafts[0].wordings.map((w) => w.status), ['draft', 'draft'], 'the drafts still show, with their status');
});

test('a language with no wording shows the English one, marked as the fallback', () => {
  const fr = buildJourneyMessages(input({ lang: 'fr' }));
  const sms = fr[0].wordings[0].sms!;
  assertEqual([sms.lang, sms.fallback], ['en', true], 'French → English');
  assert(sms.text.startsWith('Hi Anna, thanks for visiting Café Bellevue!'), `rendered: ${sms.text}`);
  assertEqual(fr[0].wordings[0].email!.fallback, true, 'email fallback');
});

test('the email: subject, preheader and text as Anna gets them, and the whole email in the Voucher design', () => {
  const email = de[0].wordings[0].email!;
  assertEqual(email.subject, 'Ein kleines Dankeschön von Café Bellevue', 'subject');
  assertEqual(email.subjectTemplate, 'Ein kleines Dankeschön von {{venue.name}}', 'subject as written');
  assert(email.text.startsWith('Hallo Anna,'), 'body');
  assert(email.html && email.html.includes('Café Bellevue') && email.html.includes('<!DOCTYPE html>'), 'designed email');
  assertEqual(email.credits, 1, 'marketing email credits');
  assertEqual(de[2].wordings[0].email!.credits, 0, 'info email credits');
  const plain = buildJourneyMessages(input({ design: null }));
  assertEqual(plain[0].wordings[0].email!.html, null, 'no design → no html');
});

test('WhatsApp: the rule, the templates rendered with the same example values, and what a German guest gets', () => {
  const wa = de[0].whatsapp!;
  assertEqual([wa.rule, wa.linkField], ['marketing', 'link.offer'], 'rule and link');
  assertEqual(wa.templates.map((t) => [t.id, t.name, t.lang]), [['wt_1', 'hf_welcome_offer_1', 'en']], 'templates');
  assertEqual(wa.templates[0].text, 'Hi Anna, thanks for visiting Café Bellevue! a free dessert waits for you. See you soon!', 'rendered with the English values');
  assertEqual(wa.templates[0].button, 'See your offer', 'button');
  assertEqual([wa.guest.status, wa.guest.lang, wa.guest.name], ['approved', 'en', 'hf_welcome_offer_1'], 'a German guest gets the English template');
});

test('WhatsApp with no template: the example from the SMS text, the link in the button, STOP only on marketing', () => {
  const last = de[1].whatsapp!;
  assertEqual(last.guest.status, 'example', 'example');
  assert(!last.guest.text.includes('hdf.to'), 'the link moves to the button');
  assertEqual(last.guest.footer, STOP_LINES.de, 'marketing footer');
  assert(last.guest.button, 'a button for the offer link');
  const thanks = de[2].whatsapp!;
  assertEqual(thanks.guest.status, 'example', 'thank-you example');
  assertEqual(thanks.guest.footer, null, 'no STOP footer on a utility message');
  assertEqual(thanks.templates[0].text, 'Danke, dass du wieder bei Café Bellevue warst, Anna! Bis bald.', 'German template, German values');
});

test('no WhatsApp part for a message without WhatsApp input; nothing to show without SMS wording', () => {
  const none = buildJourneyMessages(input({ whatsapp: {} }));
  assertEqual(none.map((m) => m.whatsapp), [null, null, null], 'no input → no part');
  const empty = buildJourneyMessages(input({ variants: [] }));
  assertEqual(empty[0].wordings, [], 'no wording');
  assertEqual(empty[1].whatsapp!.guest.status, 'missing', 'no template and no SMS → missing');
});

test('a wording the example’s blanks rule out is marked not usable', () => {
  const needsSlot: WordingLike = {
    ...variants[0],
    id: 'var_x',
    letter: 'C',
    name: 'Needs a blank',
    channels: { sms: { text: 'Hi {{contact.firstName | default:"there"}}, ask about {{slot.staff_name}} at {{venue.name}}' } },
    locales: {},
  };
  const out = buildJourneyMessages(input({ variants: [...variants, needsSlot] }));
  const c = out[0].wordings.find((w) => w.letter === 'C')!;
  assertEqual(c.usable, false, 'usable');
  assertEqual(out[0].wordings.find((w) => w.letter === 'A')!.usable, true, 'A usable');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
