/**
 * The last mile of a live message (send/compose.ts) — pure, no Firestore.
 *
 * Run: npx tsx tests/adaptiveCompose.test.ts   (from captive-server/server)
 *
 * The load-bearing assertions:
 *  - the pricing placeholder has exactly the length and character set of a real
 *    short link, so an SMS is charged for the segments it really has;
 *  - every STOP line contains the word STOP (the inbound handler only knows
 *    English keywords) and never switches an SMS into the expensive encoding;
 *  - a guest name from the public form can't inject HTML into an email.
 */

import { composeEmail, maskSecretValues, placeholderLink, shortLinkUrl, smsFinalText, STOP_LINES } from '../src/adaptive/send/compose';
import { smsSegments } from '../src/services/smsBilling';

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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

console.log('\nAdaptive message composition\n');

const BASE = 'https://visit.askheidi.app';

test('the pricing placeholder is exactly as long as a real short link', () => {
  const real = shortLinkUrl(BASE, 'ab3kq9zt');
  assertEqual(placeholderLink(BASE).length, real.length, 'length');
  const text = (link: string) => `Hallo Anna, dein Gratis-Dessert wartet: ${link} – bis Sonntag!`;
  assertEqual(smsSegments(smsFinalText(text(placeholderLink(BASE)), 'de')), smsSegments(smsFinalText(text(real), 'de')), 'same segments');
});

test('every STOP line says STOP and stays in the cheap SMS encoding', () => {
  for (const [lang, line] of Object.entries(STOP_LINES)) {
    assert(/\bSTOP\b/.test(line), `${lang}: contains STOP`);
    const plain = 'Hello Anna, see you soon at the venue. '.repeat(3).trim();
    assertEqual(smsSegments(plain + '\n' + line) <= 2, true, `${lang}: GSM-7 (${smsSegments(plain + '\n' + line)} segments)`);
    assertEqual(smsSegments('x'.repeat(100) + '\n' + line), smsSegments('x'.repeat(100 + 1 + line.length)), `${lang}: counts like plain GSM text`);
  }
});

test('the STOP line is added once, in the guest language', () => {
  assertEqual(smsFinalText('Hi Anna', 'en'), 'Hi Anna\nReply STOP to unsubscribe', 'en');
  assertEqual(smsFinalText('Hallo', 'de'), 'Hallo\nAntworte STOP zum Abmelden', 'de');
  assertEqual(smsFinalText('Hi, reply STOP to opt out', 'en'), 'Hi, reply STOP to opt out', 'already there');
  assertEqual(smsFinalText('Ciao', 'it').endsWith('Rispondi STOP per disiscriverti'), true, 'it');
});

test('a venue or guest name saying STOP does not drop the STOP line (the wording decides)', () => {
  assertEqual(smsFinalText('Hi from STOP & GO bar', 'en', 'Hi from {{venue.name}}'), 'Hi from STOP & GO bar\nReply STOP to unsubscribe', 'line kept');
  assertEqual(smsFinalText('Hi, reply STOP to opt out', 'en', 'Hi, reply STOP to opt out'), 'Hi, reply STOP to opt out', 'wording has its own');
});

test('a link in quotes or angle brackets stays a clean link', () => {
  const r = composeEmail({ body: 'See "https://visit.askheidi.app/s/ab3kq9zt" or <https://x.example/a?b=1&c=2>.', bodyFormat: 'text', preheader: '', lang: 'en', unsubscribeUrl: null, poweredBy: false });
  assert(!('error' in r), 'composed');
  if ('error' in r) return;
  assert(r.html.includes('href="https://visit.askheidi.app/s/ab3kq9zt"'), 'no quote in the href');
  assert(r.html.includes('href="https://x.example/a?b=1&amp;c=2"') && !r.html.includes('&amp;gt'), 'no half entity');
  assert(r.html.includes('&quot;<a') && r.html.includes('</a>&quot;'), 'the quotes stay around it');
});

test('German and French quotes, an ellipsis or a dash after a link stay outside it', () => {
  for (const body of ['Dein Angebot: „https://visit.askheidi.app/s/abcdefgh“', 'Offre : «https://visit.askheidi.app/s/abcdefgh»', 'Hier: https://visit.askheidi.app/s/abcdefgh…', 'Link https://visit.askheidi.app/s/abcdefgh— bis bald']) {
    const r = composeEmail({ body, bodyFormat: 'text', preheader: '', lang: 'de', unsubscribeUrl: null, poweredBy: false });
    assert(!('error' in r) && r.html.includes('href="https://visit.askheidi.app/s/abcdefgh"'), `clean link in: ${body}`);
  }
});

test('plain-text email: escaped, links clickable, trailing punctuation kept outside', () => {
  const r = composeEmail({
    body: 'Hi <script>alert(1)</script>Anna,\n\nYour dessert: https://visit.askheidi.app/s/ab3kq9zt.\nSee you!',
    bodyFormat: 'text',
    preheader: 'A free dessert',
    lang: 'en',
    unsubscribeUrl: 'https://api.example/u/tok.sig',
    poweredBy: true,
  });
  assert(!('error' in r), 'composed');
  if ('error' in r) return;
  assert(!r.html.includes('<script>') && r.html.includes('&lt;script&gt;'), 'guest input escaped');
  assert(r.html.includes('<a href="https://visit.askheidi.app/s/ab3kq9zt"'), 'link without the trailing dot');
  assert(r.html.includes('ab3kq9zt</a>.'), 'the dot stays after the link');
  assert(r.html.includes('<br>') && r.html.includes('</p>\n<p'), 'line breaks and paragraphs kept');
  assert(r.html.includes('display:none') && r.html.includes('A free dessert'), 'hidden preheader');
  assert(r.html.includes('https://api.example/u/tok.sig') && r.html.includes('Unsubscribe'), 'unsubscribe footer');
  assert(/powered by heidifi/i.test(r.html), 'powered by');
  assert(r.text.includes('https://api.example/u/tok.sig') && r.text.includes('Unsubscribe'), 'plain-text part with the link');
});

test('service email: no unsubscribe footer; plan without branding: no "Powered by"', () => {
  const r = composeEmail({ body: 'Wi-Fi: Gourmet Gast', bodyFormat: 'text', preheader: '', lang: 'de', unsubscribeUrl: null, poweredBy: false });
  assert(!('error' in r), 'composed');
  if ('error' in r) return;
  assert(!r.html.includes('Abmelden') && !/powered by heidifi/i.test(r.html), 'neither');
});

test('German footer; block-format wording is refused', () => {
  const r = composeEmail({ body: 'Hallo', bodyFormat: 'text', preheader: '', lang: 'de', unsubscribeUrl: 'https://x/u/t', poweredBy: false });
  assert(!('error' in r) && r.html.includes('Abmelden'), 'Abmelden');
  assertEqual(composeEmail({ body: '[]', bodyFormat: 'blocks', preheader: '', lang: 'en', unsubscribeUrl: null, poweredBy: false }), { error: 'unsupported_format' }, 'blocks');
});

test('stored previews never contain the Wi-Fi password or door code', () => {
  const masked = maskSecretValues({
    'guestinfo.wifiName': 'Gourmet Gast',
    'guestinfo.wifiPassword': 'hunter2',
    'guestinfo.secret.wifiPassword': 'hunter2',
    'guestinfo.doorCode': '4711',
    'contact.firstName': 'Anna',
  });
  assertEqual([masked['guestinfo.wifiName'], masked['guestinfo.wifiPassword'], masked['guestinfo.secret.wifiPassword'], masked['guestinfo.doorCode'], masked['contact.firstName']], ['Gourmet Gast', '••••', '••••', '••••', 'Anna'], 'masked');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
