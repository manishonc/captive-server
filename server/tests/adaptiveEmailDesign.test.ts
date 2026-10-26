/**
 * The email design system (send/design/, Voucher) — pure, no Firestore.
 *
 * Run: npx tsx tests/adaptiveEmailDesign.test.ts   (from captive-server/server)
 * The blocks contract itself is pure core: core/emailBlocks.ts.
 *
 * The load-bearing assertions:
 *  - any brand colour gives readable text (4.5:1 for text, 3:1 for the stars), light and dark;
 *  - every seeded wording, English and German, reads as blocks: its one journey link becomes the
 *    slip or the button (never shown as a raw link), its sign-off is found, no merge field is left;
 *  - the design never adds a link the wording didn't use (only those are minted);
 *  - nothing a guest or an AI writes can add markup; a blocks body that breaks a rule is refused;
 *  - a design failure still sends a plain-text wording in the plain look.
 */

import { composeEmail } from '../src/adaptive/send/compose';
import { contrast, fillPair, tokens } from '../src/adaptive/send/design/colors';
import { designBrandFrom, FALLBACK_COLORS, type DesignBrand } from '../src/adaptive/send/design/brand';
import { structureFromText } from '../src/adaptive/send/design/fromText';
import { blocksBodySchema, parseBlocksBody } from '../src/adaptive/core/emailBlocks';
import { blocksTemplateText, designEmail, labelAfterValue, offerValue, type DesignInput } from '../src/adaptive/send/design';
import { longDate } from '../src/adaptive/send/design/labels';
import { renderMessage } from '../src/adaptive/engine/renderSend';
import { sampleValues, type RenderValues } from '../src/adaptive/core/render';
import { VARIANTS_V1 } from '../src/adaptive/seed/definitions/variants';
import { VARIANTS_SCAN } from '../src/adaptive/seed/definitions/variantsScan';
import { VARIANTS_REFERRAL } from '../src/adaptive/seed/definitions/variantsReferral';
import type { Offer } from '../src/adaptive/core/schemas';
import type { Lang } from '../src/adaptive/core/constants';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const ROSSA: DesignBrand = {
  name: 'Trattoria Rossa',
  primary: '#B3261E',
  secondary: '#FAEEEB',
  accent: '#E8A33D',
  font: 'georgia',
  logoUrl: 'https://cdn.example.ch/rossa.png',
  logoDarkUrl: 'https://cdn.example.ch/rossa-white.png',
  address: 'Langstrasse 120, 8004 Zürich',
  links: [{ label: 'Instagram', url: 'https://instagram.com/rossa' }],
};

const OFFERS: Offer[] = [
  { offerKey: 'pct10', name: '', label: { en: '10% off your next visit', de: '10 % Rabatt auf deinen nächsten Besuch' }, kind: 'percent', value: 10, expiryDays: 14 },
  { offerKey: 'dessert', name: '', label: { en: 'a free dessert', de: 'ein Gratis-Dessert' }, kind: 'free_item', value: 0, expiryDays: 30 },
];

function values(lang: Lang, offer = 'pct10'): RenderValues {
  return sampleValues({
    lang,
    venueName: 'Trattoria Rossa',
    slots: { offer, friend_offer: 'dessert', late_checkout_price: 30 },
    offers: OFFERS,
    now: new Date(Date.UTC(2026, 9, 26, 12)),
  });
}

function input(over: Partial<DesignInput> & Pick<DesignInput, 'content'>): DesignInput {
  return {
    brand: ROSSA,
    lang: 'en',
    values: values('en'),
    facts: { purpose: 'marketing', pool: 'welcome_offer', offer: { kind: 'percent', value: 10 } },
    unsubscribeUrl: 'https://visit.example/u/abc',
    poweredBy: true,
    ...over,
  };
}

/** The page with every href removed: what a reader sees as text. */
function visible(html: string): string {
  return html.replace(/href="[^"]*"/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

console.log('\nColours');

test('any brand colour gets readable text on its fill (4.5:1)', () => {
  for (const c of ['#FFFFFF', '#FFE066', '#7FB3C8', '#808080', '#1C2B4A', '#B3261E', '#23262B', '#00FF00', '#FF385C', '#000000']) {
    const p = fillPair(c, '#16181B');
    assert(contrast(p.on, p.fill) >= 4.5, `${c}: ${contrast(p.on, p.fill).toFixed(2)}`);
  }
});

test('links, secondary text and stars stay readable for any brand, light and dark', () => {
  for (const primary of ['#FFE066', '#7FB3C8', '#B3261E', '#1C2B4A', '#FFFFFF', '#000000']) {
    for (const secondary of ['#FAEEEB', '#1C2B4A', '#FFFFFF', '#FFE066']) {
      for (const theme of ['light', 'dark'] as const) {
        const t = tokens({ primary, secondary, accent: '#F5F5F5' }, theme);
        assert(contrast(t.btext, t.paper) >= 4.5, `${primary} ${theme} btext`);
        assert(contrast(t.ink2, t.paper) >= 4.5, `${primary} ${theme} ink2`);
        assert(contrast(t.ink2Ground, t.ground) >= 4.5, `${primary}/${secondary} ${theme} ink2 on the page`);
        assert(contrast(t.ink, t.ground) >= 7, `${primary}/${secondary} ${theme} ink on the page`);
        assert(contrast(t.star, t.paper) >= 3, `${primary} ${theme} stars`);
        assert(contrast(t.on, t.fill) >= 4.5, `${primary} ${theme} button`);
      }
    }
  }
});

test('a very light brand colour still gets a button with a visible shape (light mode)', () => {
  for (const primary of ['#FFFFFF', '#FFFF00', '#00FFFF', '#FAFAFA']) {
    const t = tokens({ primary, secondary: '#FFFFFF', accent: primary }, 'light');
    assert(contrast(t.fill, t.paper) >= 1.8 && contrast(t.fill, t.ground) >= 1.8, `${primary}: ${t.fill}`);
    assert(contrast(t.on, t.fill) >= 4.5, `${primary}: button text`);
  }
});

test('a dark secondary colour is never the page: a light tint of the primary is', () => {
  const t = tokens({ primary: '#B3261E', secondary: '#1C2B4A', accent: '#B3261E' }, 'light');
  assert(t.ground !== '#1C2B4A' && contrast(t.ink, t.ground) >= 10, t.ground);
});

test('a near-black brand gets a button that stands out in dark mode', () => {
  const t = tokens({ ...FALLBACK_COLORS }, 'dark');
  assert(contrast(t.fill, t.ground) >= 2.5, `${t.fill} on ${t.ground}`);
});

console.log('\nBrand');

test('no branding saved: neutral ink, Helvetica, the venue name, no logo', () => {
  const b = designBrandFrom(null, { name: 'Café Linde', address: 'Lindenplatz 3' });
  assertEqual([b.primary, b.font, b.logoUrl, b.name, b.address], [FALLBACK_COLORS.primary, 'helvetica', null, 'Café Linde', 'Lindenplatz 3'], 'fallback');
});

test('saved branding: its colours and font; https only; bad values fall back; venue logo only without an account logo', () => {
  const b = designBrandFrom(
    { primaryColor: '#b3261e', secondaryColor: 'red', accentColor: '#E8A33D', fontFamily: 'georgia', logoUrl: 'http://x.ch/l.png', logoDarkUrl: 'https://cdn.x/d.png', website: 'https://rossa.ch', socials: { instagram: 'https://instagram.com/r', x: 'javascript:alert(1)' } },
    { name: 'Rossa', logoUrl: 'https://cdn.x/venue.png', address: { street: 'not text' } },
  );
  assertEqual([b.primary, b.secondary, b.font, b.logoUrl, b.logoDarkUrl, b.address], ['#B3261E', FALLBACK_COLORS.secondary, 'georgia', 'https://cdn.x/venue.png', 'https://cdn.x/d.png', null], 'brand');
  assertEqual(b.links.map((l) => l.label), ['Instagram', 'Website'], 'links');
  assertEqual(designBrandFrom({ logoUrl: 'https://cdn.x/a.png' }, { name: 'R', logoUrl: 'https://cdn.x/v.png' }).logoUrl, 'https://cdn.x/a.png', 'account logo first');
});

console.log('\nSeeded wordings as blocks');

const EXPECTED_LINK: Record<string, string | null> = {
  welcome_offer: 'offer',
  last_chance: 'offer',
  thank_you: null,
  review_ask: 'rating',
  stay_welcome: 'hub',
  stay_midstay: null,
  stay_checkout: 'hub',
  local_tips: 'hub',
  stay_review: 'rating',
  book_direct: 'booking',
  wifi_info: 'hub',
  checkout_info: 'hub',
  winback: 'offer',
  birthday: 'offer',
  slow_day: 'offer',
  holiday: null, // A has the booking link, B none: checked per wording below
  referral_invite: null,
  friend_reward: 'offer',
  reward_thanks: null,
};

const ALL = [...VARIANTS_V1, ...VARIANTS_SCAN, ...VARIANTS_REFERRAL];
const seededEmails: Array<{ pool: string; letter: string; lang: Lang; purpose: 'marketing' | 'service'; email: { subject: string; preheader?: string; body: string; bodyFormat?: 'text' | 'html' | 'blocks' } }> = [];
for (const v of ALL) {
  const en = (v.channels as { email?: (typeof seededEmails)[number]['email'] }).email;
  if (en) seededEmails.push({ pool: v.poolKey, letter: v.letter, lang: 'en', purpose: v.purpose as 'marketing' | 'service', email: en });
  const de = (v.locales as Record<string, { email?: (typeof seededEmails)[number]['email'] }> | undefined)?.de?.email;
  if (de) seededEmails.push({ pool: v.poolKey, letter: v.letter, lang: 'de', purpose: v.purpose as 'marketing' | 'service', email: de });
}

test('every seeded email wording is covered (English and German)', () => {
  assert(seededEmails.length >= 40, `${seededEmails.length} wordings`);
  for (const pool of Object.keys(EXPECTED_LINK)) assert(seededEmails.some((s) => s.pool === pool), `no wording for ${pool}`);
});

test('each wording: its journey link is found, taken out of the text, and the sign-off is read', () => {
  for (const s of seededEmails) {
    const st = structureFromText(s.email.body);
    const where = `${s.pool} ${s.letter} ${s.lang}`;
    const expected = s.pool === 'holiday' ? (s.email.body.includes('link.booking') ? 'booking' : null) : EXPECTED_LINK[s.pool];
    assertEqual(st.link?.kind ?? null, expected, `${where} link`);
    if (st.link) assert(![...st.before, ...st.after].some((p) => p.includes(`{{link.${st.link!.kind}`) || p.includes(`{{ link.${st.link!.kind}`)), `${where}: the link is still in the text`);
    assert(st.signoff !== null, `${where}: no sign-off`);
    assert([...st.before, ...st.after].every((p) => !/\{\{\s*venue\.name\s*\}\}\s*$/.test(p.split('\n').pop() ?? '') || p.length > 20), `${where}: the venue line stayed in the text`);
    if (s.pool === 'referral_invite') assert(st.code !== null, `${where}: the code line`);
  }
});

test('each wording renders in the design: no merge field left, its link is the button or the stars, never raw text', () => {
  for (const s of seededEmails) {
    const where = `${s.pool} ${s.letter} ${s.lang}`;
    const offerSlot = s.pool === 'birthday' || s.pool === 'friend_reward' ? 'dessert' : 'pct10';
    const v = values(s.lang, offerSlot);
    v['guestinfo.wifiName'] = 'Rossa-Guests';
    const offer = OFFERS.find((o) => o.offerKey === offerSlot)!;
    const r = designEmail(
      input({
        lang: s.lang,
        content: s.email,
        values: v,
        facts: { purpose: s.purpose, pool: s.pool, offer: { kind: offer.kind, value: offer.value } },
        unsubscribeUrl: s.purpose === 'marketing' ? 'https://visit.example/u/abc' : null,
      }),
    );
    assert(!('error' in r), `${where}: ${'error' in r ? r.error : ''}`);
    if ('error' in r) continue;
    assert(!r.html.includes('{{'), `${where}: a merge field is left`);
    assert(!/undefined|\bnull\b/.test(visible(r.html)), `${where}: undefined/null in the text`);
    const st = structureFromText(s.email.body);
    if (st.link) {
      const url = v[`link.${st.link.kind}`]!;
      assert(r.html.includes(`href="${url}"`), `${where}: the ${st.link.kind} link isn't a button or the stars`);
      assert(!visible(r.html).includes(url), `${where}: the ${st.link.kind} link shows as raw text`);
    }
    // Only the links the wording used (the engine mints only those).
    for (const kind of ['offer', 'rating', 'hub', 'booking']) {
      if (!s.email.body.includes(`link.${kind}`)) assert(!r.html.includes(`href="${v[`link.${kind}`]}"`), `${where}: added a ${kind} link`);
    }
    assert((r.html.match(/<!--hf-pb-->/g) ?? []).length === 1, `${where}: Powered by once`);
    assertEqual(r.html.includes('https://visit.example/u/abc'), s.purpose === 'marketing', `${where}: unsubscribe only on marketing`);
    assert(Buffer.byteLength(r.html) < 40_000, `${where}: ${Buffer.byteLength(r.html)} bytes`);
  }
});

test('the slip matches the journey: voucher with value, stars, key card, code', () => {
  const pick = (pool: string, lang: Lang = 'en') => seededEmails.find((s) => s.pool === pool && s.lang === lang)!.email;
  const welcome = designEmail(input({ content: pick('welcome_offer') }));
  assert(!('error' in welcome) && welcome.model.feature?.kind === 'offer', 'welcome: offer slip');
  if (!('error' in welcome) && welcome.model.feature?.kind === 'offer') {
    assertEqual([welcome.model.feature.value, welcome.model.feature.label, welcome.model.feature.action?.label], ['10%', 'off your next visit', 'Show my offer'], 'welcome slip');
    assert(welcome.model.feature.untilDate === 'Monday 9 November', `until ${welcome.model.feature.untilDate}`);
  }
  const review = designEmail(input({ content: pick('review_ask'), facts: { purpose: 'marketing', pool: 'review_ask' } }));
  assert(!('error' in review) && review.model.feature?.kind === 'rating' && (review.html.match(/&#9733;/g) ?? []).length === 5, 'review: five stars');
  const v = values('en');
  v['guestinfo.wifiName'] = 'Rossa-Guests';
  const stay = designEmail(input({ content: pick('stay_welcome'), values: v, facts: { purpose: 'service', pool: 'stay_welcome' }, unsubscribeUrl: null }));
  assert(!('error' in stay) && stay.model.feature?.kind === 'info', 'stay welcome: key card');
  if (!('error' in stay) && stay.model.feature?.kind === 'info') {
    assertEqual([stay.model.feature.lead.label, stay.model.feature.lead.value, stay.model.feature.stub.map((r) => r.value)], ['Check-in from', '15:00', ['Rossa-Guests']], 'key card');
    assert(!stay.html.includes('••'), 'no password or door code the wording did not use');
  }
  const friend = designEmail(input({ content: pick('referral_invite'), facts: { purpose: 'marketing', pool: 'referral_invite' } }));
  assert(!('error' in friend) && friend.model.feature?.kind === 'code' && friend.html.includes('ANNA-7K2Q'), 'referral: code slip');
  const gift = designEmail(input({ content: pick('birthday', 'de'), lang: 'de', values: values('de', 'dessert'), facts: { purpose: 'marketing', pool: 'birthday', offer: { kind: 'free_item', value: 0 } } }));
  assert(!('error' in gift) && gift.model.feature?.kind === 'offer' && gift.model.feature.value === null && gift.model.feature.label === 'Ein Gratis-Dessert' && gift.model.feature.action?.label === 'Geschenk zeigen', 'birthday DE: free item');
});

test('the wording keeps its order: text before the link above the slip, the rest below it', () => {
  const st = structureFromText('Hi {{contact.firstName}},\n\nthanks! It takes one tap: {{link.rating}}\n\nEvery guest can also leave a public review on Google.\n\n{{venue.name}}');
  assertEqual(st.before, ['Hi {{contact.firstName}},', 'thanks! It takes one tap:'], 'before');
  assertEqual(st.after, ['Every guest can also leave a public review on Google.'], 'after');
  assertEqual(st.signoff, '', 'venue name only');
  const label = structureFromText('Hi,\n\ncome back soon.\n\nShow this when you\'re here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}');
  assertEqual([label.before, label.after, label.signoff], [['Hi,', 'come back soon.'], [], 'See you soon,'], 'a label-only paragraph goes with its link');
});

console.log('\nSafety');

test('a guest name or offer label from a form cannot add markup', () => {
  const v = values('en');
  v['contact.firstName'] = '<img src=x onerror=alert(1)>';
  v['offer.label'] = '<b>10%</b> "off"';
  const pick = seededEmails.find((s) => s.pool === 'welcome_offer' && s.lang === 'en')!.email;
  const r = designEmail(input({ content: pick, values: v }));
  assert(!('error' in r), 'renders');
  if (!('error' in r)) {
    assert(!r.html.includes('<img src=x') && !r.html.includes('<b>10%'), 'escaped');
    assert(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'shown as text');
  }
});

test('a very long Wi-Fi name or code wraps instead of widening the email; the stars shrink on small phones', () => {
  const pick = seededEmails.find((s) => s.pool === 'wifi_info' && s.lang === 'en')!.email;
  const v = values('en');
  v['guestinfo.wifiName'] = 'TRATTORIAROSSAGUESTNETWORK5GHZXX';
  const r = designEmail(input({ content: pick, values: v, facts: { purpose: 'service', pool: 'wifi_info' }, unsubscribeUrl: null }));
  assert(!('error' in r), 'renders');
  if (!('error' in r)) {
    // The slip's big text (the wording names the network in the note too).
    const at = r.html.lastIndexOf('TRATTORIAROSSAGUESTNETWORK5GHZXX');
    const lead = r.html.slice(r.html.lastIndexOf('<p', at), at);
    assert(lead.includes('overflow-wrap:anywhere'), 'the big text wraps');
    assert(Number(/font-size:(\d+)px/.exec(lead)![1]) * 32 * 0.6 <= 456 + 1, 'sized to the column');
  }
  const review = designEmail(input({ content: seededEmails.find((s) => s.pool === 'review_ask' && s.lang === 'en')!.email, facts: { purpose: 'marketing', pool: 'review_ask' } }));
  assert(!('error' in review) && review.html.includes('.hf-star{font-size:34px!important'), 'phone stars');
  assert(!('error' in review) && review.html.includes('aria-label="4 of 5 stars, opens the rating page"'), 'the stars say what they do');
});

console.log('\nBlocks (the AI copy writer fills only these)');

const GOOD = {
  v: 1,
  blocks: [
    { t: 'heading', text: 'Thanks for coming by, {{contact.firstName}}' },
    { t: 'text', text: 'Come back within 14 days and your next visit is 10% off. 🎁' },
    { t: 'offer', href: '{{link.offer}}', button: 'Show my offer' },
    { t: 'text', text: 'Show this email when you order.' },
    { t: 'signoff', text: 'See you soon,' },
  ],
};

test('a valid blocks body is accepted and drawn in order', () => {
  const r = designEmail(input({ content: { subject: 'A thank-you', body: JSON.stringify(GOOD), bodyFormat: 'blocks' } }));
  assert(!('error' in r), 'renders');
  if (!('error' in r)) {
    assertEqual([r.model.heading, r.model.before.length, r.model.after, r.model.feature?.kind, r.model.signoff], ['Thanks for coming by, Anna', 1, ['Show this email when you order.'], 'offer', 'See you soon,'], 'model');
    assert(r.html.includes(`href="${values('en')['link.offer']}"`), 'offer button');
  }
});

test('blocks: a button next to the stars is drawn; text after a button stays after it', () => {
  const rating = { v: 1, blocks: [GOOD.blocks[0], { t: 'text', text: 'How was it?' }, { t: 'rating', href: '{{link.rating}}' }, { t: 'button', label: 'Book again', href: '{{link.booking}}' }, GOOD.blocks[4]] };
  const r = designEmail(input({ content: { subject: 'x', body: JSON.stringify(rating), bodyFormat: 'blocks' } }));
  assert(!('error' in r) && r.html.includes(`href="${values('en')['link.booking']}"`) && r.html.includes('Book again'), 'button kept');
  const order = { v: 1, blocks: [GOOD.blocks[0], { t: 'text', text: 'Next time book with us.' }, { t: 'button', label: 'Book now', href: '{{link.booking}}' }, { t: 'text', text: 'Valid for 14 days.' }] };
  const o = designEmail(input({ content: { subject: 'x', body: JSON.stringify(order), bodyFormat: 'blocks' } }));
  assert(!('error' in o), 'renders');
  if (!('error' in o)) {
    assertEqual([o.model.before, o.model.after], [['Next time book with us.'], ['Valid for 14 days.']], 'order');
    assert(o.html.indexOf('Book now') < o.html.indexOf('Valid for 14 days.'), 'the button before the text after it');
  }
});

test('blocks that break a rule are refused', () => {
  const bad: Array<[string, unknown]> = [
    ['two headings', { v: 1, blocks: [GOOD.blocks[0], GOOD.blocks[0], GOOD.blocks[1]] }],
    ['no text', { v: 1, blocks: [GOOD.blocks[0], GOOD.blocks[2]] }],
    ['typed link in the text', { v: 1, blocks: [GOOD.blocks[0], { t: 'text', text: 'See https://evil.example' }] }],
    ['journey link in the text', { v: 1, blocks: [GOOD.blocks[0], { t: 'text', text: 'Here: {{link.offer}}' }] }],
    ['heading too long', { v: 1, blocks: [{ t: 'heading', text: 'x'.repeat(65) }, GOOD.blocks[1]] }],
    ['emoji in the heading', { v: 1, blocks: [{ t: 'heading', text: 'Hello 🎉' }, GOOD.blocks[1]] }],
    ['two emoji', { v: 1, blocks: [GOOD.blocks[0], { t: 'text', text: 'Hi 🎉' }, { t: 'text', text: 'Yes 🎁' }] }],
    ['a button next to the offer', { v: 1, blocks: [...GOOD.blocks, { t: 'button', label: 'Go', href: '{{link.booking}}' }] }],
    ['a link that is not the engine’s', { v: 1, blocks: [GOOD.blocks[0], GOOD.blocks[1], { t: 'button', label: 'Go', href: 'https://evil.example' }] }],
    ['a style', { v: 1, blocks: [{ ...GOOD.blocks[0], color: 'red' }, GOOD.blocks[1]] }],
    ['an image over http', { v: 1, blocks: [GOOD.blocks[0], GOOD.blocks[1], { t: 'image', src: 'http://x.ch/p.jpg', alt: 'Photo' }] }],
  ];
  for (const [name, body] of bad) {
    const parsed = blocksBodySchema.safeParse(body);
    const strict = parsed.success && name === 'a style' ? JSON.stringify(parsed.data).includes('color') : !parsed.success;
    assert(name === 'a style' ? !JSON.stringify(parsed.success ? parsed.data : {}).includes('red') : strict, `accepted: ${name}`);
  }
  assertEqual(parseBlocksBody('not json'), null, 'not JSON');
  const r = designEmail(input({ content: { subject: 'x', body: '{"v":1,"blocks":[]}', bodyFormat: 'blocks' } }));
  assert('error' in r && r.error === 'invalid_blocks', 'invalid blocks are not drawn');
});

test('a blocks wording reads as plain text for the text part and the merge checks', () => {
  const text = blocksTemplateText(JSON.stringify(GOOD))!;
  assert(text.includes('{{link.offer}}') && text.includes('See you soon,\n{{venue.name}}'), text);
  const r = renderMessage({ subject: 'Hi', body: JSON.stringify(GOOD), bodyFormat: 'blocks' }, 'email', values('en'));
  assert(r.missing.length === 0 && r.fieldsUsed.includes('link.offer') && r.text.includes(values('en')['link.offer']!), JSON.stringify(r));
  const bad = renderMessage({ subject: 'Hi', body: '{"v":2}', bodyFormat: 'blocks' }, 'email', values('en'));
  assertEqual(bad.missing, ['email.blocks'], 'invalid blocks are missing content');
});

console.log('\nOffer words and dates');

test('the big value and the label under it', () => {
  assertEqual([offerValue({ kind: 'percent', value: 10 }, 'en'), offerValue({ kind: 'percent', value: 10 }, 'de'), offerValue({ kind: 'amount', value: 500, currency: 'CHF' }, 'en'), offerValue({ kind: 'free_item', value: 0 }, 'en')], ['10%', '10 %', 'CHF 5', null], 'values');
  assertEqual(offerValue({ kind: 'amount', value: 450, currency: 'EUR' }, 'de'), 'EUR\u00a04.50', 'an amount is stored in minor units');
  assertEqual(labelAfterValue('10% off your next visit', '10%'), 'off your next visit', 'en');
  assertEqual(labelAfterValue('10 % Rabatt auf deinen nächsten Besuch', '10 %'), 'Rabatt auf deinen nächsten Besuch', 'de');
  assertEqual(labelAfterValue('a free dessert', null), 'A free dessert', 'free item');
  assertEqual(labelAfterValue('Free coffee', '10%'), 'Free coffee', 'a label without the value stays');
});

test('dates are written out in the wording language', () => {
  const d = '2026-11-09T12:00:00.000Z';
  assertEqual([longDate(d, 'en'), longDate(d, 'de')], ['Monday 9 November', 'Montag, 9. November'], 'dates');
});

console.log('\ncomposeEmail');

test('with the design: the Voucher HTML, the same plain-text part', () => {
  const pick = seededEmails.find((s) => s.pool === 'welcome_offer' && s.lang === 'en')!.email;
  const v = values('en');
  const body = renderMessage(pick, 'email', v).text;
  const withDesign = composeEmail({ body, bodyFormat: 'text', preheader: '', lang: 'en', unsubscribeUrl: 'https://visit.example/u/abc', poweredBy: true, design: { brand: ROSSA, content: pick, values: v, facts: { purpose: 'marketing', pool: 'welcome_offer', offer: { kind: 'percent', value: 10 } } } });
  const plain = composeEmail({ body, bodyFormat: 'text', preheader: '', lang: 'en', unsubscribeUrl: 'https://visit.example/u/abc', poweredBy: true });
  assert(!('error' in withDesign) && !('error' in plain), 'composed');
  if (!('error' in withDesign) && !('error' in plain)) {
    assert(withDesign.html.includes('hf-body') && !plain.html.includes('hf-body'), 'design only when asked');
    assertEqual(withDesign.text, plain.text, 'text part');
  }
});

test('a design failure sends the plain look for text and refuses blocks', () => {
  const broken = new Proxy({}, { get: () => { throw new Error('boom'); } }) as RenderValues;
  const pick = seededEmails.find((s) => s.pool === 'welcome_offer' && s.lang === 'en')!.email;
  const text = composeEmail({ body: 'Hi', bodyFormat: 'text', preheader: '', lang: 'en', unsubscribeUrl: null, poweredBy: true, design: { brand: ROSSA, content: pick, values: broken, facts: { purpose: 'service', pool: 'thank_you' } } });
  assert(!('error' in text) && !text.html.includes('hf-body') && text.html.includes('Hi'), 'plain look');
  const blocks = composeEmail({ body: 'Hi', bodyFormat: 'blocks', preheader: '', lang: 'en', unsubscribeUrl: null, poweredBy: true });
  assert('error' in blocks, 'blocks without the design are refused');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
