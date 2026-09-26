/**
 * The guest's offer and info pages and the owner's Guest info form (PR D, D-D7, §2 and §4):
 * offer status, how long offer and info links open, when the info page shows the Wi-Fi
 * password and door code (edges to the millisecond), per-field language fallback on the page,
 * and the Guest info checks (merge, GI01–GI03 errors, GI04 and GI10–GI13 warnings, the input
 * schema).
 *
 * Run: npx tsx tests/adaptiveOwnerPages.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GUEST_INFO_FIELD_NAMES,
  GUEST_INFO_SECRET_FIELDS,
  GUEST_INFO_TEXT_FIELDS,
  guestInfoInputSchema,
  guestInfoWarnings,
  mergeGuestInfo,
  type GuestInfoIssue,
  type GuestInfoLocale,
} from '../src/adaptive/core/owner/guestInfo';
import {
  NON_STAY_LINK_MS,
  NON_STAY_SECRETS_MS,
  OFFER_LINK_AFTER_EXPIRY_MS,
  SECRETS_AFTER_CHECKOUT_MS,
  SECRETS_BEFORE_CHECKIN_MS,
  STAY_LINK_AFTER_CHECKOUT_MS,
  infoLinkOpen,
  offerLinkOpen,
  offerStatus,
  pageField,
  secretsShown,
  staffNameOf,
  type InfoStay,
} from '../src/adaptive/core/owner/publicPages';

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Sent Mon 5 Oct 2026, 10:00 UTC. */
const SENT = Date.UTC(2026, 9, 5, 10, 0);
/** Check-in Mon 12 Oct 2026 15:00 Zurich (13:00 UTC); checkout Sat 17 Oct 10:00 Zurich (08:00 UTC). */
const CHECK_IN = Date.UTC(2026, 9, 12, 13, 0);
const CHECK_OUT = Date.UTC(2026, 9, 17, 8, 0);
const STAY: InfoStay = { checkInAt: CHECK_IN, checkOutAt: CHECK_OUT, current: true };
const GONE: InfoStay = { ...STAY, current: false };
/** Offer expiry: Mon 19 Oct 2026 21:59:59.999 UTC. */
const EXPIRES = Date.UTC(2026, 9, 19, 21, 59, 59, 999);

/** What the form sends: a field may be null (cleared), a language may be null (deleted). */
type Locales = Record<string, Record<string, string | null | undefined> | null>;
const merge = (existing: Record<string, GuestInfoLocale | undefined> | null | undefined, locales: Locales, baseVersion = 0) =>
  mergeGuestInfo(existing, guestInfoInputSchema.parse({ locales, baseVersion }));
const codes = (issues: GuestInfoIssue[]) => issues.map((i) => i.code);
const errors = (issues: GuestInfoIssue[]) => issues.filter((i) => i.severity === 'error');
const warnings = (issues: GuestInfoIssue[]) => issues.filter((i) => i.severity === 'warning');
/** Content that raises none of the GI10–GI13 warnings. */
const FULL: GuestInfoLocale = {
  wifiName: 'Loft-Guest',
  checkInTime: '15:00',
  checkOutTime: '10:00',
  localTips: 'Try the bakery on the corner',
  directBookingUrl: 'https://loft.example/book',
};

// ── Offer status ─────────────────────────────────────────────────────────────

test('offer status: redeemed within validity → redeemed', () => {
  assertEqual(offerStatus(EXPIRES - DAY, EXPIRES, true), 'redeemed', 'before expiry');
  assertEqual(offerStatus(EXPIRES, EXPIRES, true), 'redeemed', 'now === expiresAt');
  assertEqual(offerStatus(SENT, null, true), 'redeemed', 'no expiry');
  assertEqual(offerStatus(SENT + 400 * DAY, null, true), 'redeemed', 'no expiry, long after the send');
});

test('offer status: redeemed, then past expiry → expired (expiry comes first, PR E follow-up)', () => {
  assertEqual(offerStatus(EXPIRES + 1, EXPIRES, true), 'expired', '1 ms after expiry');
  assertEqual(offerStatus(EXPIRES + DAY, EXPIRES, true), 'expired', 'a day after expiry');
  assertEqual(offerStatus(EXPIRES + 1, EXPIRES, true), offerStatus(EXPIRES + 1, EXPIRES, false), 'the same as an offer never redeemed');
});

test('offer status: valid at the expiry instant, expired 1 ms after', () => {
  assertEqual(offerStatus(EXPIRES - 1, EXPIRES, false), 'valid', '1 ms before');
  assertEqual(offerStatus(EXPIRES, EXPIRES, false), 'valid', 'now === expiresAt');
  assertEqual(offerStatus(EXPIRES + 1, EXPIRES, false), 'expired', '+1 ms');
});

test('offer status: no expiry is always valid', () => {
  assertEqual(offerStatus(SENT, null, false), 'valid', 'at the send');
  assertEqual(offerStatus(SENT + 400 * DAY, null, false), 'valid', 'long after the send');
});

// ── Offer link ───────────────────────────────────────────────────────────────

test('offer link: opens until expiry + 7 days, not 1 ms later', () => {
  assertEqual(OFFER_LINK_AFTER_EXPIRY_MS, 7 * DAY, 'D-D7: 7 days');
  assert(offerLinkOpen(EXPIRES + 1, EXPIRES, SENT), 'just expired: still opens (shows "expired")');
  assert(offerLinkOpen(EXPIRES + 7 * DAY, EXPIRES, SENT), 'expiry + 7 d exactly: opens');
  assert(!offerLinkOpen(EXPIRES + 7 * DAY + 1, EXPIRES, SENT), 'expiry + 7 d + 1 ms: gone');
});

test('offer link: with an expiry the send time does not matter', () => {
  const longOffer = SENT + 90 * DAY;
  assert(offerLinkOpen(SENT + 30 * DAY + 1, longOffer, SENT), 'past send + 30 d but before the expiry: opens');
  assert(offerLinkOpen(longOffer + 7 * DAY, longOffer, SENT), 'expiry + 7 d');
  const shortOffer = SENT + DAY;
  assert(!offerLinkOpen(shortOffer + 7 * DAY + 1, shortOffer, SENT), 'short offer: gone well before send + 30 d');
});

test('offer link without an expiry: opens until the send + 30 days, not 1 ms later', () => {
  assertEqual(NON_STAY_LINK_MS, 30 * DAY, 'D-D7: 30 days');
  assert(offerLinkOpen(SENT, null, SENT), 'at the send');
  assert(offerLinkOpen(SENT + 30 * DAY, null, SENT), 'send + 30 d exactly');
  assert(!offerLinkOpen(SENT + 30 * DAY + 1, null, SENT), 'send + 30 d + 1 ms');
});

// ── Info link ────────────────────────────────────────────────────────────────

test('info link for a stay: opens until checkout + 7 days, not 1 ms later', () => {
  assertEqual(STAY_LINK_AFTER_CHECKOUT_MS, 7 * DAY, 'D-D7: 7 days');
  assert(infoLinkOpen(SENT, SENT, STAY), 'at the send');
  assert(infoLinkOpen(CHECK_OUT + 7 * DAY, SENT, STAY), 'checkout + 7 d exactly');
  assert(!infoLinkOpen(CHECK_OUT + 7 * DAY + 1, SENT, STAY), 'checkout + 7 d + 1 ms');
});

test('info link for a stay follows the stay, not the send + 30 days', () => {
  const early = CHECK_OUT - 60 * DAY; // booked long ahead: the welcome went out two months before
  assert(infoLinkOpen(early + 30 * DAY + 1, early, STAY), 'past send + 30 d, before checkout: opens');
  assert(infoLinkOpen(CHECK_OUT + 7 * DAY, early, STAY), 'checkout + 7 d: opens');
});

test('info link for a stay no longer this guest\'s: closed', () => {
  assert(!infoLinkOpen(SENT, SENT, GONE), 'at the send');
  assert(!infoLinkOpen(CHECK_IN, SENT, GONE), 'during the stay');
  assert(!infoLinkOpen(CHECK_OUT, SENT, GONE), 'at checkout');
});

test('info link without a stay: opens until the send + 30 days, not 1 ms later', () => {
  assert(infoLinkOpen(SENT, SENT, null), 'at the send');
  assert(infoLinkOpen(SENT + 30 * DAY, SENT, null), 'send + 30 d exactly');
  assert(!infoLinkOpen(SENT + 30 * DAY + 1, SENT, null), 'send + 30 d + 1 ms');
});

// ── Secrets (D-D7) ───────────────────────────────────────────────────────────

test('the secret windows are 12 h before check-in, 2 h after checkout, 30 days otherwise', () => {
  assertEqual([SECRETS_BEFORE_CHECKIN_MS, SECRETS_AFTER_CHECKOUT_MS, NON_STAY_SECRETS_MS], [12 * HOUR, 2 * HOUR, 30 * DAY], 'D-D7');
  assertEqual([...GUEST_INFO_SECRET_FIELDS].sort(), ['doorCode', 'keyInstructions', 'wifiPassword'], 'secret fields');
});

test('stay secrets: from check-in − 12 h exactly, not 1 ms earlier', () => {
  const from = CHECK_IN - 12 * HOUR;
  const before = secretsShown(from - 1, SENT, STAY);
  assert(!before.wifiPassword && !before.doorCode, '1 ms before: nothing');
  const at = secretsShown(from, SENT, STAY);
  assert(at.wifiPassword && at.doorCode, 'at check-in − 12 h: both');
  const after = secretsShown(from + 1, SENT, STAY);
  assert(after.wifiPassword && after.doorCode, '1 ms after: both');
  const atSend = secretsShown(SENT, SENT, STAY);
  assert(!atSend.wifiPassword && !atSend.doorCode, 'a week before check-in: nothing');
});

test('stay secrets: until checkout + 2 h exactly, not 1 ms later', () => {
  const until = CHECK_OUT + 2 * HOUR;
  const before = secretsShown(until - 1, SENT, STAY);
  assert(before.wifiPassword && before.doorCode, '1 ms before: both');
  const at = secretsShown(until, SENT, STAY);
  assert(at.wifiPassword && at.doorCode, 'at checkout + 2 h: both');
  const after = secretsShown(until + 1, SENT, STAY);
  assert(!after.wifiPassword && !after.doorCode, '1 ms after: nothing');
  const lastDay = secretsShown(CHECK_OUT + 7 * DAY, SENT, STAY);
  assert(!lastDay.wifiPassword && !lastDay.doorCode, 'link still opens at checkout + 7 d, but no secrets');
});

test('stay secrets: shownFrom / shownUntil are check-in − 12 h and checkout + 2 h', () => {
  const s = secretsShown(CHECK_IN, SENT, STAY);
  assertEqual([s.from, s.until], [CHECK_IN - 12 * HOUR, CHECK_OUT + 2 * HOUR], 'from / until');
  assertEqual([new Date(s.from!).toISOString(), new Date(s.until!).toISOString()], ['2026-10-12T01:00:00.000Z', '2026-10-17T10:00:00.000Z'], 'as the page prints them');
  const outside = secretsShown(SENT, SENT, STAY);
  assertEqual([outside.from, outside.until], [s.from, s.until], 'same window outside it');
});

test('stay no longer this guest\'s: no secrets, even inside the window', () => {
  for (const now of [CHECK_IN - 12 * HOUR, CHECK_IN, CHECK_OUT, CHECK_OUT + 2 * HOUR]) {
    const s = secretsShown(now, SENT, GONE);
    assertEqual([s.wifiPassword, s.doorCode], [false, false], `current:false at ${new Date(now).toISOString()}`);
  }
});

test('non-stay link: Wi-Fi password until the send + 30 days, never a door code', () => {
  for (const [now, wifi] of [
    [SENT, true],
    [SENT + 1, true],
    [SENT + 30 * DAY - 1, true],
    [SENT + 30 * DAY, true],
    [SENT + 30 * DAY + 1, false],
    [SENT + 365 * DAY, false],
  ] as Array<[number, boolean]>) {
    const s = secretsShown(now, SENT, null);
    assertEqual(s.wifiPassword, wifi, `Wi-Fi password at send + ${now - SENT} ms`);
    assertEqual(s.doorCode, false, `no door code at send + ${now - SENT} ms`);
  }
  const s = secretsShown(SENT, SENT, null);
  assertEqual([s.from, s.until], [SENT, SENT + 30 * DAY], 'shownFrom = send, shownUntil = send + 30 d');
});

// ── pageField ────────────────────────────────────────────────────────────────

test('page field: the guest\'s language first', () => {
  const gi = { locales: { en: { houseRules: 'No parties' }, de: { houseRules: 'Keine Partys' }, fr: { houseRules: 'Pas de fêtes' } } };
  assertEqual(pageField(gi, 'fr', 'houseRules'), 'Pas de fêtes', 'fr');
  assertEqual(pageField(gi, 'de', 'houseRules'), 'Keine Partys', 'de');
  assertEqual(pageField(gi, 'en', 'houseRules'), 'No parties', 'en');
});

test('page field: then English, then other languages in sorted order', () => {
  const gi = { locales: { it: { parking: 'Garage it' }, de: { parking: 'Garage de' }, en: { parking: 'Garage en' } } };
  assertEqual(pageField(gi, 'fr', 'parking'), 'Garage en', 'English before the others');
  const noEn = { locales: { it: { parking: 'Garage it' }, fr: { parking: '   ' }, de: { parking: 'Garage de' } } };
  assertEqual(pageField(noEn, 'fr', 'parking'), 'Garage de', 'de before it, whatever the key order');
  assertEqual(pageField(noEn, 'en', 'parking'), 'Garage de', 'English guest, no English: de before fr (blank) and it');
  const onlyIt = { locales: { it: { parking: 'Garage it' }, de: { wifiName: 'x' } } };
  assertEqual(pageField(onlyIt, 'fr', 'parking'), 'Garage it', 'the only language with the field');
});

test('page field: German-only Guest info reaches a French guest', () => {
  const gi = { locales: { de: { doorCode: '4711', wifiPassword: 'Sonne2026', houseRules: 'Ruhe ab 22 Uhr' } } };
  assertEqual(pageField(gi, 'fr', 'doorCode'), '4711', 'door code');
  assertEqual(pageField(gi, 'fr', 'wifiPassword'), 'Sonne2026', 'Wi-Fi password');
  assertEqual(pageField(gi, 'fr', 'houseRules'), 'Ruhe ab 22 Uhr', 'house rules');
  assertEqual(pageField(gi, 'fr', 'parking'), null, 'a field no language has');
});

test('page field: trims; whitespace-only and non-strings are skipped', () => {
  const gi = { locales: { fr: { wifiName: ' \n\t ', doorCode: 1234 as unknown as string, localTips: '  Line 1\nLine 2  ' }, en: { wifiName: '  Loft  ', doorCode: ' 99 ' } } };
  assertEqual(pageField(gi, 'fr', 'wifiName'), 'Loft', 'blank French → trimmed English');
  assertEqual(pageField(gi, 'fr', 'doorCode'), '99', 'a number is not a value');
  assertEqual(pageField(gi, 'fr', 'localTips'), 'Line 1\nLine 2', 'inner new line kept');
  assertEqual(pageField({ locales: { en: { wifiName: '   ' } } }, 'en', 'wifiName'), null, 'only blanks → null');
});

test('page field: no Guest info → null', () => {
  assertEqual(pageField(null, 'de', 'wifiPassword'), null, 'null');
  assertEqual(pageField({}, 'de', 'wifiPassword'), null, 'no locales');
  assertEqual(pageField({ locales: {} }, 'de', 'wifiPassword'), null, 'empty locales');
  assertEqual(pageField({ locales: { de: undefined, en: undefined } }, 'de', 'wifiPassword'), null, 'undefined languages');
});

// ── mergeGuestInfo ───────────────────────────────────────────────────────────

test('merge: a sent language replaces the saved one', () => {
  const saved = { de: { wifiName: 'Alt', doorCode: '1111', houseRules: 'Ruhe' }, en: { wifiName: 'Old' } };
  const { locales, issues } = merge(saved, { de: { wifiName: 'Neu' } });
  assertEqual(locales.de, { wifiName: 'Neu' }, 'de replaced whole (no old door code left)');
  assertEqual(locales.en, { wifiName: 'Old' }, 'en kept');
  assertEqual(errors(issues), [], 'no errors');
});

test('merge: null deletes a language; a language left out is kept', () => {
  const saved = { en: { wifiName: 'Loft' }, de: { wifiName: 'Loft DE' }, it: { wifiName: 'Loft IT' } };
  const { locales } = merge(saved, { de: null, fr: { wifiName: 'Loft FR' } });
  assertEqual(Object.keys(locales).sort(), ['en', 'fr', 'it'], 'languages');
  assert(!('de' in locales), 'de gone');
  assertEqual(locales.it, { wifiName: 'Loft IT' }, 'it untouched');
  assertEqual(merge(null, { en: null }).locales, {}, 'deleting from nothing');
  assertEqual(merge(undefined, {}).locales, {}, 'nothing saved, nothing sent');
});

test('merge: empty and control-character values are dropped', () => {
  const { locales } = merge(null, {
    en: {
      wifiName: '',
      wifiPassword: '   ',
      doorCode: '\u0000\u0007\u001b',
      keyInstructions: ' \u007f ',
      houseRules: 'Quiet\u0000 after\u001f 10',
      localTips: 'Line 1\r\nLine 2\n',
      parking: null,
      extraNotes: '  Welcome  ',
    },
  });
  assertEqual(locales.en, { houseRules: 'Quiet after 10', localTips: 'Line 1\nLine 2', extraNotes: 'Welcome' }, 'cleaned (new lines kept, CR removed)');
});

test('merge: a language whose values all drop is removed, even if it was saved', () => {
  const { locales } = merge({ de: { wifiName: 'Loft DE' }, en: { wifiName: 'Loft' } }, { de: { wifiName: '  ', doorCode: '\u0001' } });
  assertEqual(Object.keys(locales), ['en'], 'de removed');
});

test('merge: an unknown language is refused (GI01) and not stored', () => {
  const { locales, issues } = merge({ en: { wifiName: 'Loft' } }, { es: { wifiName: 'Loft ES' }, EN: { wifiName: 'x' }, xx: null });
  assertEqual(Object.keys(locales), ['en'], 'only en');
  const gi01 = issues.filter((i) => i.code === 'GI01');
  assertEqual(gi01.map((i) => [i.path, i.severity]), [['locales.es', 'error'], ['locales.EN', 'error'], ['locales.xx', 'error']], 'GI01 per language (also for null)');
});

test('merge: saved languages we don\'t support are not carried over', () => {
  const { locales } = merge({ en: { wifiName: 'Loft' }, es: { wifiName: 'Loft ES' }, de: undefined }, {});
  assertEqual(Object.keys(locales), ['en'], 'es and the empty de dropped');
});

test('merge: check-in/out must be HH:MM between 06:00 and 22:00 (GI02)', () => {
  for (const bad of ['10 Uhr', 'ab 15.00 Uhr', '15.00', '6:00', '05:59', '22:01', '23:30', '24:00', '1500', '3pm', '15:60']) {
    const { issues } = merge(null, { de: { checkOutTime: bad } });
    const gi02 = issues.filter((i) => i.code === 'GI02');
    assertEqual(gi02.map((i) => [i.path, i.severity]), [['locales.de.checkOutTime', 'error']], `checkout "${bad}"`);
    const inIssues = merge(null, { fr: { checkInTime: bad } }).issues.filter((i) => i.code === 'GI02');
    assertEqual(inIssues.map((i) => i.path), ['locales.fr.checkInTime'], `check-in "${bad}"`);
    assert(inIssues[0].message.startsWith('Check-in'), 'check-in message');
  }
  for (const good of ['06:00', '22:00', '15:00', '10:00']) {
    assertEqual(codes(merge(null, { en: { checkInTime: good, checkOutTime: good } }).issues).filter((c) => c === 'GI02'), [], `"${good}" is fine`);
  }
  const padded = merge(null, { en: { checkInTime: ' 15:00 ', checkOutTime: '10:00\n' } });
  assertEqual(errors(padded.issues), [], 'surrounding blanks are fine');
  assertEqual([padded.locales.en?.checkInTime, padded.locales.en?.checkOutTime], ['15:00', '10:00'], 'stored trimmed');
});

test('merge: javascript:, data: and host-less links are refused (GI03)', () => {
  const bad = ['javascript:alert(1)', 'java\tscript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>hi</b>', 'http://', 'http:', 'https://', 'www.example.com', 'ftp://example.com/menu', 'file:///etc/passwd'];
  for (const field of ['directBookingUrl', 'menuUrl', 'hostContactUrl'] as const) {
    for (const v of bad) {
      const { issues } = merge(null, { en: { [field]: v } });
      const gi03 = issues.filter((i) => i.code === 'GI03');
      assertEqual(gi03.map((i) => [i.path, i.severity]), [[`locales.en.${field}`, 'error']], `${field} ${JSON.stringify(v)}`);
    }
  }
});

test('merge: http(s) links with a host are fine on every link field', () => {
  for (const v of ['https://loft.example/book', 'http://loft.example', 'https://loft.example:8443/menu?x=1#top']) {
    const { issues } = merge(null, { de: { directBookingUrl: v, menuUrl: v, hostContactUrl: v } });
    assertEqual(codes(issues).filter((c) => c === 'GI03'), [], v);
  }
});

test('merge: tel: and mailto: only on hostContactUrl', () => {
  for (const v of ['tel:+41791234567', 'TEL:+41791234567', 'mailto:host@loft.example']) {
    assertEqual(codes(merge(null, { en: { hostContactUrl: v } }).issues).filter((c) => c === 'GI03'), [], `hostContactUrl ${v}`);
    for (const field of ['directBookingUrl', 'menuUrl'] as const) {
      const gi03 = merge(null, { en: { [field]: v } }).issues.filter((i) => i.code === 'GI03');
      assertEqual(gi03.map((i) => i.path), [`locales.en.${field}`], `${field} ${v}`);
      assert(!gi03[0].message.includes('tel:'), `${field}: the message doesn't offer tel:`);
    }
  }
  const contact = merge(null, { en: { hostContactUrl: 'javascript:alert(1)' } }).issues.find((i) => i.code === 'GI03')!;
  assert(contact.message.includes('tel:') && contact.message.includes('mailto:'), 'the contact message offers tel: and mailto:');
});

test('merge: errors in one language, per field, all reported', () => {
  const { issues } = merge(null, { de: { checkInTime: '15 Uhr', checkOutTime: '10 Uhr', menuUrl: 'data:x', directBookingUrl: 'javascript:x' }, es: { wifiName: 'x' } });
  assertEqual(errors(issues).map((i) => i.path).sort(), ['locales.de.checkInTime', 'locales.de.checkOutTime', 'locales.de.directBookingUrl', 'locales.de.menuUrl', 'locales.es'], 'every error');
});

// ── The input schema ─────────────────────────────────────────────────────────

test('schema: an unknown field in a language is refused', () => {
  assert(!guestInfoInputSchema.safeParse({ locales: { en: { wifiPasword: 'typo' } }, baseVersion: 0 }).success, 'typo field refused');
  assert(!guestInfoInputSchema.safeParse({ locales: { en: { wifiName: 'Loft', script: '<x>' } }, baseVersion: 0 }).success, 'extra field refused');
  assert(guestInfoInputSchema.safeParse({ locales: { en: { wifiName: 'Loft' } }, baseVersion: 0 }).success, 'known field accepted');
  assertEqual(GUEST_INFO_FIELD_NAMES.length, 16, 'the 16 fields');
});

test('schema: baseVersion must be an integer ≥ 0', () => {
  for (const ok of [0, 1, 42]) assert(guestInfoInputSchema.safeParse({ locales: {}, baseVersion: ok }).success, `${ok} accepted`);
  for (const bad of [-1, 1.5, 0.1, '1', null, NaN, Infinity]) {
    assert(!guestInfoInputSchema.safeParse({ locales: {}, baseVersion: bad }).success, `${String(bad)} refused`);
  }
  assert(!guestInfoInputSchema.safeParse({ locales: {} }).success, 'missing refused');
  assert(!guestInfoInputSchema.safeParse({ baseVersion: 0 }).success, 'locales required');
});

test('schema: null languages and null fields are accepted; lengths are capped', () => {
  assert(guestInfoInputSchema.safeParse({ locales: { de: null, en: { wifiName: null, doorCode: undefined } }, baseVersion: 3 }).success, 'nulls');
  assert(guestInfoInputSchema.safeParse({ locales: { en: { wifiName: 'x'.repeat(GUEST_INFO_TEXT_FIELDS.wifiName) } }, baseVersion: 0 }).success, 'wifiName at the cap');
  assert(!guestInfoInputSchema.safeParse({ locales: { en: { wifiName: 'x'.repeat(GUEST_INFO_TEXT_FIELDS.wifiName + 1) } }, baseVersion: 0 }).success, 'wifiName over the cap');
  assert(guestInfoInputSchema.safeParse({ locales: { de: { checkOutTime: 'ab 15.00 Uhr bitte' } }, baseVersion: 0 }).success, 'a long time text fits, so GI02 can answer');
  assert(!guestInfoInputSchema.safeParse({ locales: { de: { checkOutTime: 'x'.repeat(21) } }, baseVersion: 0 }).success, 'time over 20 chars');
  assert(!guestInfoInputSchema.safeParse({ locales: { en: { wifiName: 1234 } }, baseVersion: 0 }).success, 'a number is not text');
});

// ── Warnings ─────────────────────────────────────────────────────────────────

test('warnings: GI04 when languages give different check-in or check-out times', () => {
  const w = guestInfoWarnings({ en: { ...FULL, checkInTime: '15:00', checkOutTime: '10:00' }, de: { checkInTime: '16:00', checkOutTime: '11:00' } });
  const gi04 = w.filter((i) => i.code === 'GI04');
  assertEqual(gi04.map((i) => [i.path, i.severity]), [['locales.de.checkInTime', 'warning'], ['locales.de.checkOutTime', 'warning']], 'both fields');
  assert(gi04[0].message.includes('15:00') && gi04[1].message.includes('10:00'), 'says the English time every language gets');
  const same = guestInfoWarnings({ en: FULL, de: { checkInTime: ' 15:00 ', checkOutTime: '10:00' } });
  assertEqual(codes(same), [], 'same times: no warning');
});

test('warnings: GI04 takes English first, then the sorted languages', () => {
  const w = guestInfoWarnings({ fr: { checkInTime: '16:00' }, de: { checkInTime: '14:00' } });
  const gi04 = w.filter((i) => i.code === 'GI04');
  assertEqual(gi04.map((i) => i.path), ['locales.fr.checkInTime'], 'de wins over fr, fr differs');
  assert(gi04[0].message.includes('14:00'), 'de time');
  const one = guestInfoWarnings({ en: FULL, de: { wifiName: 'Loft' } });
  assertEqual(one.filter((i) => i.code === 'GI04'), [], 'one language with a time: no GI04');
  const none = guestInfoWarnings({ en: { checkInTime: '10 Uhr' }, de: { checkInTime: '11 Uhr' } });
  assertEqual(none.filter((i) => i.code === 'GI04'), [], 'no valid time at all: no GI04');
});

test('warnings: GI10–GI13 when nothing is there', () => {
  const w = guestInfoWarnings({});
  assertEqual(w.map((i) => [i.code, i.path]), [
    ['GI10', 'locales.en.wifiName'],
    ['GI11', 'locales.en.checkOutTime'],
    ['GI12', 'locales.en.localTips'],
    ['GI13', 'locales.en.directBookingUrl'],
  ], 'all four');
  assert(w.every((i) => i.severity === 'warning'), 'warnings only');
  assertEqual(guestInfoWarnings({ en: FULL }), [], 'full: none');
});

test('warnings: any language counts for GI10, GI12 and GI13', () => {
  assertEqual(codes(guestInfoWarnings({ it: { ...FULL } })), [], 'Italian only');
  const split = guestInfoWarnings({ de: { wifiName: 'Loft', checkOutTime: '10:00' }, fr: { localTips: 'Boulangerie', directBookingUrl: 'https://loft.example' } });
  assertEqual(codes(split), [], 'spread over two languages');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, wifiName: undefined } })), ['GI10'], 'only the Wi-Fi name missing');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, localTips: '' } })), ['GI12'], 'only local tips missing');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, directBookingUrl: undefined } })), ['GI13'], 'only the booking link missing');
});

test('warnings: GI11 when no language has a valid check-out time', () => {
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, checkOutTime: undefined } })), ['GI11'], 'none');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, checkOutTime: '10 Uhr' } })), ['GI11'], '"10 Uhr" is no check-out time');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, checkOutTime: '23:00' } })), ['GI11'], 'after 22:00 is no check-out time');
  assertEqual(codes(guestInfoWarnings({ en: { ...FULL, checkOutTime: '10 Uhr' }, de: { checkOutTime: '10:00' } })).filter((c) => c === 'GI11'), [], 'German has a valid one');
});

test('merge returns the warnings for the merged result, never as errors', () => {
  const { issues } = merge({ en: { wifiName: 'Loft', localTips: 'Bakery' } }, { de: { checkOutTime: '10:00', directBookingUrl: 'https://loft.example' } });
  assertEqual(errors(issues), [], 'no errors');
  assertEqual(codes(warnings(issues)), [], 'saved en + sent de cover all four');
  const { issues: empty } = merge({ en: { wifiName: 'Loft' } }, { en: null });
  assertEqual(codes(empty), ['GI10', 'GI11', 'GI12', 'GI13'], 'everything deleted: all four warnings');
  const { issues: mixed } = merge(null, { es: { wifiName: 'x' }, en: { checkOutTime: '10 Uhr' } });
  assertEqual(codes(mixed), ['GI01', 'GI02', 'GI10', 'GI11', 'GI12', 'GI13'], 'errors first, then the warnings');
});

// ── Rating page (PR E follow-up) ─────────────────────────────────────────────

test('staffNameOf: the staff_name blank, trimmed; null when empty or not text; a translated value in the page language, then English', () => {
  assertEqual(staffNameOf('Priya', 'de'), 'Priya', 'plain text, any language');
  assertEqual(staffNameOf('  Priya  ', 'en'), 'Priya', 'trimmed');
  assertEqual(staffNameOf('', 'en'), null, 'empty');
  assertEqual(staffNameOf('   ', 'en'), null, 'blank');
  assertEqual(staffNameOf(undefined, 'en'), null, 'no blank (e.g. the Airbnb review ask has none)');
  assertEqual(staffNameOf(null, 'en'), null, 'null');
  assertEqual(staffNameOf(3, 'en'), null, 'a number');
  assertEqual(staffNameOf(true, 'en'), null, 'a boolean');
  assertEqual(staffNameOf({ en: 'Priya', de: 'Priya (DE)' }, 'de'), 'Priya (DE)', 'translated: the page language');
  assertEqual(staffNameOf({ en: 'Priya', de: ' ' }, 'de'), 'Priya', 'translated: English when the language is blank');
  assertEqual(staffNameOf({ en: 'Priya' }, 'fr'), 'Priya', 'translated: English when the language is missing');
  assertEqual(staffNameOf({ en: '' }, 'en'), null, 'translated but empty');
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the modules are pure: only zod, constants, stay times and time helpers', () => {
  const imports = (file: string) => {
    const src = readFileSync(join(__dirname, '../src/adaptive/core/owner', file), 'utf8');
    return [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort();
  };
  assertEqual(imports('guestInfo.ts'), ['../../stays/times', '../constants', 'zod'], 'guestInfo.ts runtime imports');
  assertEqual(imports('publicPages.ts'), ['../runtime/time'], 'publicPages.ts runtime imports');
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
