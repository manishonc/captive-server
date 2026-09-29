/**
 * PR F0 — SMS as GSM-7, Adaptive's own SMS counter, and the seed upgrade step.
 *
 * Run: npx tsx tests/adaptiveSeedUpgrade.test.ts   (from captive-server/server)
 *
 * No Firestore. What these pin:
 *  - **The counter counts what the carrier bills**: GSM-7 160 / 153, UCS-2 70 / 67 in UTF-16
 *    units (an emoji is 2), extension characters are 2 septets, and nothing is split across
 *    two parts. The shared services/smsBilling.ts counter is unchanged (legacy campaigns).
 *  - **Every seeded SMS is GSM-7**, and every marketing SMS fits 2 parts with a 36-character
 *    venue name, the longest offer, a production-length link and the STOP line.
 *  - **Each upgrade replaces exactly the earlier seed texts**: the hashes in
 *    seed/wordingUpgrades.ts are rebuilt here from the old strings (as they were in PR 1,
 *    PR C and PR E) on top of today's doc.
 *  - **What the upgrade does with a stored doc**: an old seed text → upgrade; today's text →
 *    nothing; anything else (a hand edit, a venue's own wording) → left alone.
 */

import { buildSeedPlan, variantId } from '../src/adaptive/seed/buildSeed';
import { SEED } from '../src/adaptive/seed/definitions';
import { COL } from '../src/adaptive/store/collections';
import { WORDING_UPGRADES, upgradeDecision, upgradeTargets, wordingHash, type WordingUpgrade } from '../src/adaptive/seed/wordingUpgrades';
import { smsCheaperText, smsParts, smsSafeText, smsSegmentCount } from '../src/adaptive/core/runtime/smsParts';
import { renderMessage, smsKeepsExact } from '../src/adaptive/engine/renderSend';
import { smsSegments as legacySmsSegments } from '../src/services/smsBilling';
import { creditsFor, providerCostFor } from '../src/adaptive/send/pricing';
import { renderText, sampleValues } from '../src/adaptive/core/render';
import { smsFinalText } from '../src/adaptive/send/compose';
import type { CreditConfig } from '../src/services/credits';

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const plan = buildSeedPlan(new Date('2026-09-29T10:00:00Z'));
const docs = new Map(plan.units.flatMap((u) => u.docs).filter((d) => d.path[0] === COL.variants).map((d) => [d.path[1], d.data as Record<string, any>]));
const docFor = (pool: string, letter: string) => {
  const d = docs.get(variantId(pool, letter));
  if (!d) throw new Error(`no seed doc ${pool}/${letter}`);
  return JSON.parse(JSON.stringify(d)) as Record<string, any>;
};

// ── The counter ──────────────────────────────────────────────────────────────

console.log('\nSMS parts');

test('GSM-7: 160 in one part, then 153 per part; umlauts, ß and é are GSM-7', () => {
  assertEqual(smsParts('x'.repeat(160)), { encoding: 'gsm7', units: 160, segments: 1, nonGsm: [] }, '160');
  assertEqual(smsSegmentCount('x'.repeat(161)), 2, '161 → 2');
  assertEqual(smsSegmentCount('x'.repeat(306)), 2, '306 → 2');
  assertEqual(smsSegmentCount('x'.repeat(307)), 3, '307 → 3');
  assertEqual(smsParts('Grüezi Müller, schöner Tag – ').encoding, 'ucs2', 'the en dash is not GSM-7');
  assertEqual(smsParts('Grüezi Müller, schöne Grüße, café à côté').encoding, 'ucs2', 'ô is not GSM-7');
  assertEqual(smsParts('Grüezi Müller, schöne Grüße, café à la carte').encoding, 'gsm7', 'ü ö ß é à are');
});

test('GSM-7 extension characters take two septets and are never split across parts', () => {
  assertEqual(smsParts('€'.repeat(80)).units, 160, '80 € = 160 septets');
  assertEqual(smsSegmentCount('€'.repeat(80)), 1, 'one part');
  // 152 plain + € = 154 septets: over 153, so the € starts part 2 (it can't be split).
  assertEqual(smsSegmentCount('x'.repeat(152) + '€' + 'x'.repeat(10)), 2, 'fits 2');
  assertEqual(smsSegmentCount('x'.repeat(152) + '€' + 'x'.repeat(152)), 3, 'the € moved to part 2, so part 2 overflows');
});

test('UCS-2: 70 units in one part, then 67; an emoji is 2 units and never split', () => {
  assertEqual(smsParts('🎁').units, 2, 'emoji = 2 units');
  assertEqual(smsParts('x'.repeat(69) + '🎁').segments, 2, '71 units → 2 parts');
  assertEqual(legacySmsSegments('x'.repeat(69) + '🎁'), 1, 'the shared counter says 1 (unchanged, for legacy campaigns)');
  assertEqual(smsSegmentCount('–'.repeat(70)), 1, '70 → 1');
  assertEqual(smsSegmentCount('–'.repeat(134)), 2, '134 → 2');
  // 66 units + an emoji (2) = 68 > 67: the emoji starts part 2.
  assertEqual(smsSegmentCount('–'.repeat(66) + '🎁' + '–'.repeat(66)), 3, 'emoji not split');
  assertEqual(smsParts('Hi 🎁 – “ok”').nonGsm, ['🎁', '–', '“', '”'], 'each offending character once, in order');
});

test('SMS merge values: typographic punctuation becomes GSM-7, letters stay, email is untouched', () => {
  assertEqual(smsSafeText('Luigi’s “Bar” – Café… « Chez » ‘x’ a\u00A0b\u200Bc'), 'Luigi\'s "Bar" - Café... " Chez " \'x\' a bc', 'punctuation');
  assertEqual(smsParts(smsSafeText('Luigi’s – “Bar”')).encoding, 'gsm7', 'now GSM-7');
  // Swiss single guillemets and the wide Unicode spaces too.
  assertEqual(smsSafeText('Restaurant ‹Löwen›\u2003Bar\u2002\u2005x'), "Restaurant 'Löwen' Bar  x", 'guillemets and spaces');
  const values = { 'contact.firstName': 'Lia', 'venue.name': 'Luigi’s' };
  assertEqual(renderMessage({ text: 'Hi {{contact.firstName}}, see you at {{venue.name}}!' }, 'sms', values).text, "Hi Lia, see you at Luigi's!", 'SMS: apostrophe straightened (now GSM-7)');
  // A name with ë keeps the SMS Unicode either way: then nothing is changed (… → ... would only add units).
  const zoe = { 'contact.firstName': 'Zoë', 'venue.name': 'Luigi’s … Bar' };
  assertEqual(renderMessage({ text: 'Hi {{contact.firstName}}, see you at {{venue.name}}!' }, 'sms', zoe).text, 'Hi Zoë, see you at Luigi’s … Bar!', 'Unicode anyway: as typed');
  const email = renderMessage({ subject: 'At {{venue.name}}', body: 'See you at {{venue.name}}', bodyFormat: 'text' }, 'email', values);
  assertEqual([email.subject, email.text], ['At Luigi’s', 'See you at Luigi’s'], 'email keeps the typography');
});

test('SMS merge values: codes, the Wi-Fi name and links go exactly as typed', () => {
  const card = '{{venue.name}}: Wi-Fi {{guestinfo.wifiName}}, password {{guestinfo.secret.wifiPassword}}, door {{guestinfo.secret.doorCode}}. {{link.hub}}';
  const base = { 'guestinfo.wifiName': 'Café–Gast', 'guestinfo.secret.doorCode': '12–34', 'link.hub': 'https://visit.askheidi.app/s/abc' };
  // A password with ´ keeps the SMS Unicode: everything as typed, the venue name too.
  const odd = renderMessage({ text: card }, 'sms', { ...base, 'venue.name': 'Café – Bar', 'guestinfo.secret.wifiPassword': 'Gr`n-2024´x' });
  assertEqual(odd.text, 'Café – Bar: Wi-Fi Café–Gast, password Gr`n-2024´x, door 12–34. https://visit.askheidi.app/s/abc', 'secrets untouched');
  // Only the venue name is cleaned; the Wi-Fi name and door code keep their dash (so this SMS stays Unicode).
  const plain = renderMessage({ text: '{{venue.name}}: code {{guestinfo.secret.doorCode}}' }, 'sms', { ...base, 'venue.name': 'Café – Bar' });
  assertEqual(plain.text, 'Café – Bar: code 12–34', 'a code with a dash keeps it (Unicode, as typed)');
  const clean = renderMessage({ text: '{{venue.name}}: code {{guestinfo.secret.doorCode}}' }, 'sms', { ...base, 'venue.name': 'Café – Bar', 'guestinfo.secret.doorCode': '1234' });
  assertEqual([clean.text, smsParts(clean.text).encoding], ['Café - Bar: code 1234', 'gsm7'], 'the name is cleaned when that makes it GSM-7');
  for (const f of ['guestinfo.secret.wifiPassword', 'guestinfo.wifiPassword', 'guestinfo.doorCode', 'guestinfo.keyInstructions', 'guestinfo.wifiName', 'link.offer', 'guestinfo.menuUrl', 'guestinfo.directBookingUrl']) {
    assert(smsKeepsExact(f), `${f} is kept exactly`);
  }
  for (const f of ['contact.firstName', 'venue.name', 'offer.label', 'guestinfo.houseRules', 'guestinfo.checkOutTime', 'slot.staff_name']) {
    assert(!smsKeepsExact(f), `${f} may be cleaned`);
  }
  // A value that is a web address stays exact whatever its field (a blank of type url).
  assert(smsKeepsExact('slot.review_url', 'https://g.page/luigis–review') && !smsKeepsExact('slot.staff_name', 'Ana – Maria'), 'by value');
  const url = renderMessage({ text: '{{venue.name}}: {{slot.review_url}}' }, 'sms', { 'venue.name': 'Luigi’s', 'slot.review_url': 'https://g.page/luigis–review' });
  assertEqual(url.text, 'Luigi’s: https://g.page/luigis–review', 'the address as typed (so this SMS stays Unicode, as typed)');
});

test('smsCheaperText: the cleaned SMS only when it is GSM-7 and not more parts', () => {
  assertEqual(smsCheaperText('Luigi’s', "Luigi's"), "Luigi's", 'GSM-7, same parts: cleaned');
  assertEqual(smsCheaperText('Zoë’s', "Zoë's"), 'Zoë’s', 'Unicode either way: as typed');
  const dots = '…'.repeat(60);
  assertEqual(smsCheaperText(dots, '...'.repeat(60)), dots, '60 × … is 1 Unicode part; 180 dots would be 2');
});

test('pricing: 15 credits per part for SMS, flat for email; provider cost per part', () => {
  const config = {
    channelRates: { sms: { creditsPerSegment: 15 }, email: { creditsPerMessage: 1 }, whatsapp: { creditsPerMessage: 12 } },
    providerCosts: { sms: { costMinor: 8, perSegment: true }, email: { costMinor: 0 } },
  } as unknown as CreditConfig;
  assertEqual(creditsFor(config, 'sms', 'x'.repeat(69) + '🎁'), 30, 'emoji SMS = 2 parts');
  assertEqual(creditsFor(config, 'email'), 1, 'email');
  assertEqual(providerCostFor(config, 'sms', 'x'.repeat(161)), 16, 'provider cost × parts');
});

// ── The seeded wording ───────────────────────────────────────────────────────

console.log('\nSeeded SMS');

const VENUE = 'Indian Gourmet Restaurant Interlaken';
const LINK = 'https://visit.askheidi.app/s/AbCd1234';
const offers = SEED.playbooks.flatMap((p) => (p.content.offerMenuDefaults ?? []) as any[]);

test('the seed plan has no problems and every upgrade has a target', () => {
  assertEqual(plan.problems, [], 'no seed problems');
  const { targets, problems } = upgradeTargets(plan);
  assertEqual(problems, [], 'no upgrade problems');
  assertEqual(targets.size, new Set(WORDING_UPGRADES.map((u) => `${u.poolKey}/${u.letter}`)).size, 'one target per upgraded wording');
});

test('every seeded SMS is GSM-7; every marketing SMS fits 2 parts (36-char venue, longest offer, real link, STOP line)', () => {
  const rows: string[] = [];
  for (const v of SEED.variants) {
    for (const lang of ['en', 'de'] as const) {
      const sms = (lang === 'en' ? v.channels.sms : (v.locales as any)?.de?.sms) as { text: string } | undefined;
      if (!sms) continue;
      for (const offer of offers) {
        const values = sampleValues({ lang, venueName: VENUE, slots: { offer: offer.offerKey, late_checkout_price: 30 }, offers: offers as any });
        for (const k of Object.keys(values)) if (k.startsWith('link.') || k === 'guestinfo.hostContactUrl') values[k] = LINK;
        const text = smsFinalText(renderText(sms.text, values).text, lang, sms.text);
        const p = smsParts(text);
        if (p.encoding !== 'gsm7') rows.push(`${v.poolKey}/${v.letter} ${lang}: ${p.nonGsm.join(' ')}`);
        if (v.purpose === 'marketing' && p.segments > 2) rows.push(`${v.poolKey}/${v.letter} ${lang} ${offer.offerKey}: ${p.segments} parts`);
      }
    }
  }
  assertEqual(rows, [], 'all GSM-7 and ≤ 2 parts');
});

test('welcome A keeps its emoji where it costs nothing (the email), so the emoji axis stays true', () => {
  const a = docFor('welcome_offer', 'A');
  assert(a.axes.emoji === true, 'axis');
  assert(a.channels.email.body.includes('🎁') && a.locales.de.email.body.includes('🎁'), 'emoji in the emails');
  assert(!a.channels.sms.text.includes('🎁') && !a.locales.de.sms.text.includes('🎁'), 'not in the SMS');
});

test('welcome B no longer says "next visit" twice with the 10% offer', () => {
  const b = docFor('welcome_offer', 'B');
  for (const [lang, sms, needle] of [['en', b.channels.sms.text, 'next visit'], ['de', b.locales.de.sms.text, 'nächsten Besuch']] as const) {
    const ten = offers.find((o) => o.offerKey === 'ten_pct');
    const values = sampleValues({ lang, venueName: VENUE, slots: { offer: 'ten_pct' }, offers: offers as any });
    const text = renderText(sms, values).text;
    assertEqual(text.split(needle).length - 1, 1, `${lang}: once (${ten ? 'with the 10% label' : ''}) — ${text}`);
  }
});

// ── The upgrades ─────────────────────────────────────────────────────────────

console.log('\nSeed upgrades');

const HI_EN = 'Hi {{contact.firstName | default:"there"}}';
const HI_DE = 'Hallo {{contact.firstName | default:"du"}}';

/** Today's doc with the strings it had in earlier releases put back. */
function older(pool: string, letter: string, put: (d: Record<string, any>) => void): Record<string, any> {
  const d = docFor(pool, letter);
  put(d);
  return d;
}

const EARLIER: Array<{ pool: string; letter: string; label: string; doc: Record<string, any> }> = [
  {
    pool: 'welcome_offer',
    letter: 'A',
    label: 'PR 1 – PR E',
    doc: older('welcome_offer', 'A', (d) => {
      d.channels.sms.text = `${HI_EN}, thanks for visiting {{venue.name}}! Come back within {{offer.days}} days for {{offer.label}} 🎁 {{link.offer}}`;
      d.channels.email.body = `${HI_EN},\n\nthanks for stopping by {{venue.name}}! Come back within {{offer.days}} days and enjoy {{offer.label}} on us.\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`;
      d.locales.de.sms.text = `${HI_DE}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich 🎁 {{link.offer}}`;
      d.locales.de.email.body = `${HI_DE},\n\ndanke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich, aufs Haus.\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`;
    }),
  },
  {
    pool: 'welcome_offer',
    letter: 'B',
    label: 'PR 1 – PR E',
    doc: older('welcome_offer', 'B', (d) => {
      d.channels.sms.text = `{{venue.name}}: there's {{offer.label}} waiting for you on your next visit – valid until {{offer.expiryDate | date:"d.M."}} {{link.offer}}`;
      d.locales.de.sms.text = `{{venue.name}}: Bei deinem nächsten Besuch wartet {{offer.label}} auf dich – gültig bis {{offer.expiryDate | date:"d.M."}} {{link.offer}}`;
    }),
  },
  {
    pool: 'book_direct',
    letter: 'A',
    label: 'PR C – PR E',
    doc: older('book_direct', 'A', (d) => {
      d.locales.de.sms.text = 'Hat dir {{venue.name}} gefallen? Buch nächstes Mal direkt bei uns – dann gibt es {{offer.label}}: {{link.booking}}';
    }),
  },
  {
    pool: 'stay_checkout',
    letter: 'A',
    label: 'PR C – PR E',
    doc: older('stay_checkout', 'A', (d) => {
      d.channels.sms.text = `${HI_EN}, check-out tomorrow is at {{guestinfo.checkOutTime}}. Want to stay longer? Late check-out until 14:00 is CHF {{slot.late_checkout_price}} – ask your host: {{guestinfo.hostContactUrl}}`;
      d.locales.de.sms.text = `${HI_DE}, morgen ist Check-out um {{guestinfo.checkOutTime}}. Länger bleiben? Später Check-out bis 14:00 kostet CHF {{slot.late_checkout_price}} – frag deinen Gastgeber: {{guestinfo.hostContactUrl}}`;
    }),
  },
  {
    pool: 'wifi_info',
    letter: 'A',
    label: 'PR E (neutral wording, old preheader)',
    doc: older('wifi_info', 'A', (d) => {
      d.channels.email.preheader = 'Wi-Fi details and house info';
      d.locales.de.email.preheader = 'WLAN-Details und Hausinfos';
    }),
  },
  {
    pool: 'wifi_info',
    letter: 'A',
    label: 'PR 1 – PR C (menu and opening hours)',
    doc: older('wifi_info', 'A', (d) => {
      d.channels.sms.text = "Welcome to {{venue.name}}! You're online on {{guestinfo.wifiName}}. Menu, opening hours and more: {{link.hub}}";
      d.channels.email.preheader = 'Wi-Fi details and house info';
      d.channels.email.body = `${HI_EN},\n\nyou're online at {{venue.name}} on the {{guestinfo.wifiName}} network. Menu, opening hours and everything else: {{link.hub}}\n\nEnjoy your visit,\n{{venue.name}}`;
      d.locales.de.sms.text = 'Willkommen bei {{venue.name}}! Du bist im WLAN {{guestinfo.wifiName}} online. Menü, Öffnungszeiten und mehr: {{link.hub}}';
      d.locales.de.email.preheader = 'WLAN-Details und Hausinfos';
      d.locales.de.email.body = `${HI_DE},\n\ndu bist bei {{venue.name}} im WLAN {{guestinfo.wifiName}} online. Menü, Öffnungszeiten und alles Weitere: {{link.hub}}\n\nViel Spass bei deinem Besuch,\n{{venue.name}}`;
    }),
  },
];

test('the upgrades of each wording list exactly its earlier seed texts (rebuilt from the old strings)', () => {
  for (const key of new Set(WORDING_UPGRADES.map((u) => `${u.poolKey}/${u.letter}`))) {
    const [pool, letter] = key.split('/');
    const listed = WORDING_UPGRADES.filter((u) => u.poolKey === pool && u.letter === letter).flatMap((u) => u.replaces);
    const earlier = EARLIER.filter((e) => e.pool === pool && e.letter === letter).map((e) => wordingHash(e.doc));
    assertEqual([...earlier].sort(), [...listed].sort(), `${key}: the earlier texts`);
  }
});

const targetOf = (u: WordingUpgrade) => ({ poolKey: u.poolKey, letter: u.letter, upgrades: [u] });

test('an earlier seed text → upgrade; the doc id and scope stay the same', () => {
  for (const e of EARLIER) {
    const target = docFor(e.pool, e.letter);
    const u = WORDING_UPGRADES.find((x) => x.poolKey === e.pool && x.letter === e.letter)!;
    const d = upgradeDecision(e.doc, targetOf(u), target.contentHash);
    assertEqual([d.decision, d.upgradeId], ['upgrade', u.id], `${e.pool}/${e.letter} from ${e.label}`);
  }
});

test('two entries for one wording: each replaces its own earlier texts (a later reword keeps the first working)', () => {
  const f0 = WORDING_UPGRADES.find((x) => x.id === 'f0-gsm7-welcome-a')!;
  const todayHash = docFor('welcome_offer', 'A').contentHash;
  const later: WordingUpgrade = { id: 'later-reword', poolKey: 'welcome_offer', letter: 'A', replaces: [todayHash], why: 'a later reword' };
  const target = { poolKey: 'welcome_offer', letter: 'A', upgrades: [f0, later] };
  const nextHash = 'f'.repeat(64);
  assertEqual(upgradeDecision(EARLIER[0].doc, target, nextHash).upgradeId, 'f0-gsm7-welcome-a', 'the PR 1 text: the first entry');
  const onF0 = { ...docFor('welcome_offer', 'A'), seedUpgrades: ['f0-gsm7-welcome-a'] };
  assertEqual([upgradeDecision(onF0, target, nextHash).decision, upgradeDecision(onF0, target, nextHash).upgradeId], ['upgrade', 'later-reword'], "today's text: the later entry, although f0 ran");
  // (An old text put back on purpose is kept by the apply step, from the doc's history/: emulator test.)
});

test('the upgrade list is sound: no id twice, no text claimed by two entries', () => {
  const { problems } = upgradeTargets(plan);
  assertEqual(problems, [], 'no problems');
  assertEqual(new Set(WORDING_UPGRADES.map((u) => u.id)).size, WORDING_UPGRADES.length, 'unique ids');
});

test("the stored contentHash isn't trusted: a stale field with an old text still upgrades, a stale field with today's text is current", () => {
  const u = WORDING_UPGRADES.find((x) => x.id === 'f0-gsm7-welcome-a')!;
  const target = docFor('welcome_offer', 'A');
  const old = { ...EARLIER[0].doc, contentHash: target.contentHash };
  assertEqual(upgradeDecision(old, targetOf(u), target.contentHash).decision, 'upgrade', 'old text, new-looking hash field');
  assertEqual(upgradeDecision({ ...target, contentHash: 'stale' }, targetOf(u), target.contentHash).decision, 'current', "today's text, stale hash field");
});

test('a hand-edited doc, a venue wording or a missing doc is never rewritten', () => {
  const u = WORDING_UPGRADES.find((x) => x.id === 'f0-gsm7-welcome-a')!;
  const target = docFor('welcome_offer', 'A');
  const edited = older('welcome_offer', 'A', (d) => {
    d.channels.sms.text = 'Our own words for {{venue.name}}: {{link.offer}}';
  });
  assertEqual(upgradeDecision(edited, targetOf(u), target.contentHash).decision, 'edited', 'hand edit');
  assertEqual(upgradeDecision({ ...EARLIER[0].doc, scope: 'venue' }, targetOf(u), target.contentHash).decision, 'edited', 'a venue wording');
  assertEqual(upgradeDecision({ ...EARLIER[0].doc, letter: 'B' }, targetOf(u), target.contentHash).decision, 'edited', 'another letter');
  assertEqual(upgradeDecision(null, targetOf(u), target.contentHash).decision, 'missing', 'missing');
});

test('ids of the upgraded wordings never change (running journeys keep pointing at them)', () => {
  assertEqual(variantId('welcome_offer', 'A').slice(0, 12), 'var_b48eedfd', 'welcome A id as in production');
  for (const u of WORDING_UPGRADES) assert(docs.has(variantId(u.poolKey, u.letter)), `${u.id} target id`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
