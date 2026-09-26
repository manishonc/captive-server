/**
 * The smaller PR D review fixes: which dead signal tasks lost everything (and which are urgent),
 * the "marketing was stopped" skip sentence and the fact that feeds it, and the link rules shared
 * by the engine and the owner's test send (booking link per field, info page, Local tips, offer)
 * with the reason a missing value gives.
 *
 * Run: npx tsx tests/adaptiveOwnerRules.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { detailLessSignal, isUrgent, refusalText, urgentNote, type DetailLessSignal, type SignalEventFacts } from '../src/adaptive/core/owner/deadTasks';
import { buildDecision, explainDecision, type DecisionRecord } from '../src/adaptive/core/runtime/decision';
import { noChannelFor } from '../src/adaptive/core/runtime/replay';
import { checkChannel, type ChannelCheck, type ChannelFacts } from '../src/adaptive/core/runtime/pickers';
import { linkGates, missingReason } from '../src/adaptive/engine/renderSend';
import type { Channel, Lang } from '../src/adaptive/core/constants';

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

const ZRH = 'Europe/Zurich';
const T = Date.UTC(2026, 9, 2, 10, 0, 0);
const ALL_KINDS: DetailLessSignal[] = ['sms_stop', 'sms_start', 'sms_reply', 'legacy_unsubscribe', 'consent_without_guest'];

// ── Dead signal tasks (core/owner/deadTasks.ts) ──────────────────────────────

test('dead signals: STOP, START, reply, old unsubscribe and consent without a guest', () => {
  const rows: Array<[SignalEventFacts, DetailLessSignal | null, string]> = [
    [{ type: 'consent.revoked', source: 'sms_keyword', contactId: 'u_1_c1' }, 'sms_stop', 'STOP with a guest'],
    [{ type: 'consent.revoked', source: 'sms_keyword' }, 'sms_stop', 'STOP without a guest (the keyword wins)'],
    [{ type: 'consent.granted', source: 'sms_keyword', contactId: 'u_1_c1' }, 'sms_start', 'START with a guest'],
    [{ type: 'consent.granted', source: 'sms_keyword' }, 'sms_start', 'START without a guest'],
    [{ type: 'consent.revoked', source: 'unsubscribe_page' }, 'legacy_unsubscribe', 'unsubscribe without a guest'],
    [{ type: 'consent.revoked' }, 'legacy_unsubscribe', 'revoke with no source and no guest'],
    [{ type: 'consent.granted', source: 'splash' }, 'consent_without_guest', 'grant without a guest'],
    [{ type: 'consent.granted' }, 'consent_without_guest', 'grant with no source and no guest'],
    [{ type: 'message.replied', source: 'sms_keyword', contactId: 'u_1_c1' }, 'sms_reply', 'reply with a guest'],
    [{ type: 'message.replied' }, 'sms_reply', 'reply with nothing'],
  ];
  for (const [e, want, name] of rows) assertEqual(detailLessSignal(e), want, name);
});

test('dead signals: a revoke or grant that names its guest can be retried', () => {
  for (const source of ['owner', 'unsubscribe_page', 'brevo_spam', 'brevo_unsubscribed', 'provider_stop', 'splash']) {
    assertEqual(detailLessSignal({ type: 'consent.revoked', source, contactId: 'u_1_c1' }), null, `revoke ${source}`);
    assertEqual(detailLessSignal({ type: 'consent.granted', source, contactId: 'u_1_c1' }), null, `grant ${source}`);
  }
  for (const type of ['rating.submitted', 'wifi.connected', 'visit.started', 'message.clicked']) {
    assertEqual(detailLessSignal({ type, contactId: 'u_1_c1' }), null, `${type} with a guest`);
    assertEqual(detailLessSignal({ type }), null, `${type} without a guest`);
    assertEqual(detailLessSignal({ type, source: 'sms_keyword' }), null, `${type} with the keyword source`);
  }
});

test('dead signals: an empty or non-text guest id counts as no guest', () => {
  for (const contactId of ['', null, undefined, 42, { id: 'u_1_c1' }]) {
    assertEqual(detailLessSignal({ type: 'consent.revoked', source: 'owner', contactId }), 'legacy_unsubscribe', `revoke, contactId ${JSON.stringify(contactId)}`);
    assertEqual(detailLessSignal({ type: 'consent.granted', source: 'owner', contactId }), 'consent_without_guest', `grant, contactId ${JSON.stringify(contactId)}`);
  }
  assertEqual(detailLessSignal({ type: 'consent.revoked', source: 'owner', contactId: ' ' }), null, 'a one-space id is still an id');
});

test('dead signals: the source must be exactly sms_keyword, and the type exact', () => {
  assertEqual(detailLessSignal({ type: 'consent.revoked', source: 'SMS_KEYWORD', contactId: 'u_1_c1' }), null, 'upper case source');
  assertEqual(detailLessSignal({ type: 'consent.revoked', source: { v: 'sms_keyword' }, contactId: 'u_1_c1' }), null, 'non-text source with a guest');
  assertEqual(detailLessSignal({ type: 'consent.revoked', source: 123 }), 'legacy_unsubscribe', 'non-text source, no guest');
  assertEqual(detailLessSignal({ type: 'Consent.revoked', source: 'sms_keyword' }), null, 'type is case sensitive');
  assertEqual(detailLessSignal({ type: 'consent.revoked ', source: 'sms_keyword' }), null, 'no trimming of the type');
  assertEqual(detailLessSignal({ type: '', source: 'sms_keyword' }), null, 'empty type');
});

test('urgent only for a STOP and an old unsubscribe', () => {
  assertEqual(ALL_KINDS.filter(isUrgent), ['sms_stop', 'legacy_unsubscribe'], 'urgent kinds');
  assertEqual(isUrgent(null), false, 'null');
  assertEqual(isUrgent(detailLessSignal({ type: 'consent.revoked', source: 'sms_keyword' })), true, 'a dead STOP is urgent');
  assertEqual(isUrgent(detailLessSignal({ type: 'consent.revoked', source: 'owner', contactId: 'u_1_c1' })), false, 'a retryable revoke is not');
});

test('urgent note: only urgent rows have one', () => {
  for (const k of ALL_KINDS) assertEqual(urgentNote(k) !== null, isUrgent(k), `${k}: note iff urgent`);
  assertEqual(urgentNote(null), null, 'null');
  assert(/STOP/.test(urgentNote('sms_stop')!) && /number/.test(urgentNote('sms_stop')!), `STOP note: ${urgentNote('sms_stop')}`);
  assert(/unsubscribe/.test(urgentNote('legacy_unsubscribe')!) && /address/.test(urgentNote('legacy_unsubscribe')!), `unsubscribe note: ${urgentNote('legacy_unsubscribe')}`);
});

const PHONE = /\+?\d[\d\s().-]{5,}\d/;
const EMAIL = /[^\s@]+@[^\s@]+/;
const CODE = /\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z]+\b|[{}<>]|\n/;

test('urgent notes and refusal texts are plain sentences with no number, address or code', () => {
  const texts: Array<[string, string]> = [
    ...ALL_KINDS.map((k) => [`refusal ${k}`, refusalText(k)] as [string, string]),
    ...ALL_KINDS.flatMap((k) => (urgentNote(k) ? [[`note ${k}`, urgentNote(k)!] as [string, string]] : [])),
  ];
  assertEqual(texts.length, 7, 'five refusals and two notes');
  for (const [name, t] of texts) {
    assert(t.trim().length > 20, `${name} is a sentence: ${t}`);
    assert(t.endsWith('.'), `${name} ends with a full stop: ${t}`);
    assert(!PHONE.test(t), `${name} has no phone number: ${t}`);
    assert(!EMAIL.test(t), `${name} has no email address: ${t}`);
    assert(!CODE.test(t), `${name} has no code, markup or line break: ${t}`);
  }
  assertEqual(new Set(ALL_KINDS.map(refusalText)).size, ALL_KINDS.length, 'one refusal per kind');
});

test('refusal texts say what was lost and why a retry is refused', () => {
  assert(/STOP/.test(refusalText('sms_stop')) && /number/.test(refusalText('sms_stop')), 'STOP: number');
  assert(/START/.test(refusalText('sms_start')) && /START again/.test(refusalText('sms_start')), 'START: text START again');
  assert(/reply/.test(refusalText('sms_reply')), 'reply');
  assert(/unsubscribe/.test(refusalText('legacy_unsubscribe')) && /address/.test(refusalText('legacy_unsubscribe')), 'unsubscribe: address');
  assert(/consent/.test(refusalText('consent_without_guest')), 'consent change');
  for (const k of ALL_KINDS) assert(/lost the guest's/.test(refusalText(k)), `${k} says the guest's details were lost`);
});

// ── "Marketing was stopped" (core/runtime/decision.ts, core/runtime/replay.ts) ─

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 2,
    at: T,
    mode: 'live',
    result: 'skip',
    rule: 'consent',
    reason: 'no_consent',
    until: null,
    poolKey: 'welcome',
    purpose: 'marketing',
    checks: [
      { rule: 'system', ok: true, fact: 'sending on' },
      { rule: 'consent', ok: false, fact: 'no yes for sms from this venue' },
    ],
    channel: { picked: 'sms', rule: 'auto', rejected: [] },
    variant: { picked: 'a', method: 'fixed' },
    slot: { picked: 'lunch', rule: 'slot', plannedAt: T },
    credits: { price: 15, balance: 400 },
    versions: { template: 1, config: 1, playbook: 'restaurant', engine: '1.0.0' },
    ...over,
  };
}

function withFact(fact: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return decision({ checks: [{ rule: 'system', ok: true, fact: 'sending on' }, { rule: 'consent', ok: false, fact }], ...over });
}

const STOPPED_EN = 'Not sent because marketing to this guest was stopped (by you, or the guest unsubscribed or replied STOP).';
const STOPPED_DE = 'Nicht gesendet, weil Werbung an diesen Gast gestoppt wurde (von dir, oder der Gast hat sich abgemeldet oder STOP geantwortet).';
const NO_YES_EN = 'Not sent because the guest has not said yes to this channel.';
const NO_YES_DE = 'Nicht gesendet, weil der Gast diesem Kanal nicht zugestimmt hat.';

test('no_consent after a stop says marketing was stopped, EN and DE', () => {
  const d = withFact('marketing to this guest was stopped');
  assertEqual(explainDecision(d, 'en', ZRH), STOPPED_EN, 'en');
  assertEqual(explainDecision(d, 'de', ZRH), STOPPED_DE, 'de');
  assert(explainDecision(d, 'en', ZRH).includes('marketing to this guest was stopped (by you, or the guest unsubscribed or replied STOP)'), 'en phrase');
  assert(explainDecision(d, 'de', ZRH).includes('Werbung an diesen Gast gestoppt wurde'), 'de phrase');
  assertEqual(explainDecision(d, 'fr', ZRH), STOPPED_EN, 'any other language gets English');
  assertEqual(explainDecision({ ...d, mode: 'test' }, 'en', ZRH), STOPPED_EN, 'same words in a test run');
});

test("the gate's own revoke fact (said no to …) gets the same stopped wording", () => {
  for (const ch of ['sms', 'email', 'whatsapp']) {
    const d = withFact(`said no to ${ch} (unsubscribed)`);
    assertEqual(explainDecision(d, 'en', ZRH), STOPPED_EN, `${ch} en`);
    assertEqual(explainDecision(d, 'de', ZRH), STOPPED_DE, `${ch} de`);
  }
});

test('a guest who never said yes keeps the old wording', () => {
  for (const fact of ['no yes for email from this venue', 'no yes for sms from this venue', '', 'marketing to this guest was stopped by the owner', 'Said no to sms (unsubscribed)']) {
    const d = withFact(fact);
    assertEqual(explainDecision(d, 'en', ZRH), NO_YES_EN, `en, fact "${fact}"`);
    assertEqual(explainDecision(d, 'de', ZRH), NO_YES_DE, `de, fact "${fact}"`);
  }
  assertEqual(explainDecision(decision({ checks: [] }), 'en', ZRH), NO_YES_EN, 'no checks at all');
});

test("the stopped wording reads the stopping rule's own fact, and only for no_consent", () => {
  const elsewhere = decision({ checks: [{ rule: 'channel_rules', ok: false, fact: 'marketing to this guest was stopped' }, { rule: 'consent', ok: false, fact: 'no yes for sms from this venue' }] });
  assertEqual(explainDecision(elsewhere, 'en', ZRH), NO_YES_EN, 'the fact under another rule is not read');
  const blocked = withFact('marketing to this guest was stopped', { rule: 'consent', reason: 'blocked' });
  assertEqual(explainDecision(blocked, 'en', ZRH), 'Not sent because this address is blocked (bounced or unsubscribed from all messages).', 'another reason keeps its words');
});

const rev = (channel: Channel): ChannelCheck => ({ channel, ok: false, reason: 'consent_revoked' });
const no = (channel: Channel, reason: string): ChannelCheck => ({ channel, ok: false, reason });
const STOPPED_FACT = { rule: 'consent', reason: 'no_consent', fact: 'marketing to this guest was stopped' };

test('noChannelFor: every reachable channel revoked → consent, "marketing to this guest was stopped"', () => {
  assertEqual(noChannelFor([rev('sms'), rev('email')], ['sms', 'email']), STOPPED_FACT, 'both revoked');
  assertEqual(noChannelFor([rev('sms')], ['sms']), STOPPED_FACT, 'the only channel revoked');
  assertEqual(noChannelFor([rev('sms'), no('email', 'no_address')], ['sms', 'email']), STOPPED_FACT, 'no address does not count');
  assertEqual(noChannelFor([rev('sms'), no('whatsapp', 'whatsapp_off')], ['sms', 'whatsapp']), STOPPED_FACT, 'WhatsApp off does not count');
  assertEqual(noChannelFor([rev('sms'), no('email', 'no_consent')], ['sms']), STOPPED_FACT, 'a channel off the ladder does not count');
});

test('noChannelFor: anything else is not called a stop', () => {
  // One taken back and one never given: consent, but not "stopped" (the owner's lift reads the same, PR D).
  assertEqual(
    noChannelFor([rev('sms'), no('email', 'no_consent')], ['sms', 'email']),
    { rule: 'consent', reason: 'no_consent', fact: 'no yes for sms, email from this venue' },
    'one revoked, one never said yes',
  );
  assertEqual(noChannelFor([no('email', 'no_consent')], ['sms', 'email'])?.fact, 'no yes for email from this venue', 'never said yes');
  assertEqual(noChannelFor([rev('sms'), no('email', 'blocked:hard_bounce')], ['sms', 'email']), undefined, 'one revoked, one blocked');
  assertEqual(noChannelFor([rev('sms'), no('email', 'audience')], ['sms', 'email']), undefined, 'one revoked, one audience');
  assertEqual(noChannelFor([rev('sms')], ['email']), undefined, 'revoked only off the ladder');
  assertEqual(noChannelFor([no('sms', 'no_address'), no('email', 'no_address')], ['sms', 'email']), undefined, 'no address anywhere');
  assertEqual(noChannelFor([], ['sms', 'email']), undefined, 'no checks');
  assertEqual(noChannelFor([no('sms', 'audience'), no('email', 'no_address')], ['sms', 'email'])?.reason, 'audience', 'audience still wins alone');
});

test('a skip built from all-revoked channels explains as stopped (sendPath shape)', () => {
  const facts: ChannelFacts[] = [
    { channel: 'sms', hasAddress: true, consent: 'revoked', suppressed: null, audienceOk: true, hasWording: true, ruleFail: null },
    { channel: 'email', hasAddress: true, consent: 'revoked', suppressed: null, audienceOk: true, hasWording: true, ruleFail: null },
    { channel: 'whatsapp', hasAddress: false, consent: 'none', suppressed: null, audienceOk: true, hasWording: false, ruleFail: 'whatsapp_off' },
  ];
  const ladder: Channel[] = ['sms', 'email', 'whatsapp'];
  const checks = facts.map((f) => checkChannel('marketing', f));
  assertEqual(checks.map((c) => c.reason), ['consent_revoked', 'consent_revoked', 'no_address'], 'checks');
  const noChannel = noChannelFor(checks, ladder);
  const d = buildDecision({
    now: T,
    mode: 'live',
    poolKey: 'welcome',
    purpose: 'marketing',
    gate: null,
    channelChecks: checks,
    channel: { picked: null, rule: 'auto' },
    variant: { picked: null, method: 'none' },
    slot: { picked: 'lunch', rule: 'slot', plannedAt: T },
    credits: null,
    versions: { template: 1, config: 1, playbook: 'restaurant', engine: '1.0.0' },
    ...(noChannel ? { noChannel } : {}),
  });
  assertEqual([d.result, d.rule, d.reason], ['skip', 'consent', 'no_consent'], 'verdict');
  assertEqual(d.checks, [{ rule: 'consent', ok: false, fact: 'marketing to this guest was stopped' }], 'the stored fact');
  assertEqual(explainDecision(d, 'en', ZRH), STOPPED_EN, 'en');
  assertEqual(explainDecision(d, 'de', ZRH), STOPPED_DE, 'de');

  const mixed = facts.map((f) => (f.channel === 'email' ? checkChannel('marketing', { ...f, consent: 'none' }) : checkChannel('marketing', f)));
  const nc = noChannelFor(mixed, ladder);
  assertEqual(nc, { rule: 'consent', reason: 'no_consent', fact: 'no yes for sms, email from this venue' }, 'one channel never said yes: consent, not a stop');
  const d2 = buildDecision({
    now: T,
    mode: 'live',
    poolKey: 'welcome',
    purpose: 'marketing',
    gate: null,
    channelChecks: mixed,
    channel: { picked: null, rule: 'auto' },
    noChannel: nc,
    variant: { picked: null, method: 'none' },
    slot: { picked: 'lunch', rule: 'slot', plannedAt: T },
    credits: null,
    versions: { template: 1, config: 1, playbook: 'restaurant', engine: '1.0.0' },
  });
  assertEqual(explainDecision(d2, 'en', ZRH), 'Not sent because the guest has not said yes to this channel.', 'mixed: no yes, not "stopped"');
});

// ── Link gates (engine/renderSend.ts) ────────────────────────────────────────

const gi = (locales: Record<string, Record<string, unknown>>) => ({ locales });
const BOOK_EN = 'https://example.org/book';
const BOOK_DE = 'https://example.org/de/buchen';

test('booking link: the guest language, else English, field by field', () => {
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN } }), 'de', 'book_direct', false).bookingRaw, BOOK_EN, 'de guest, only English set');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { wifiName: 'Cafe' } }), 'de', 'book_direct', false).bookingRaw, BOOK_EN, 'de block without the field');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { directBookingUrl: '   ' } }), 'de', 'book_direct', false).bookingRaw, BOOK_EN, 'de whitespace only');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { directBookingUrl: '' } }), 'de', 'book_direct', false).bookingRaw, BOOK_EN, 'de empty');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { directBookingUrl: 42 } }), 'de', 'book_direct', false).bookingRaw, BOOK_EN, 'de not text');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { directBookingUrl: BOOK_DE } }), 'de', 'book_direct', false).bookingRaw, BOOK_DE, 'de own link');
  assertEqual(linkGates(gi({ en: { directBookingUrl: BOOK_EN }, de: { directBookingUrl: BOOK_DE } }), 'en', 'book_direct', false).bookingRaw, BOOK_EN, 'en guest');
  assertEqual(linkGates(gi({ en: { directBookingUrl: `  ${BOOK_EN}\n` } }), 'fr', 'book_direct', false).bookingRaw, BOOK_EN, 'trimmed');
});

test('booking link: none when neither the guest language nor English has one', () => {
  assertEqual(linkGates(gi({ de: { directBookingUrl: BOOK_DE } }), 'en', 'book_direct', false).bookingRaw, null, 'no English → an en guest gets none');
  assertEqual(linkGates(gi({ de: { directBookingUrl: BOOK_DE } }), 'fr', 'book_direct', false).bookingRaw, null, 'another language is never borrowed');
  assertEqual(linkGates(gi({ en: { directBookingUrl: ' ' } }), 'en', 'book_direct', false).bookingRaw, null, 'whitespace only in English');
  assertEqual(linkGates(null, 'de', 'book_direct', false).bookingRaw, null, 'no Guest info');
  assertEqual(linkGates({}, 'de', 'book_direct', false).bookingRaw, null, 'no locales');
});

test('info page: off when Guest info is empty', () => {
  assertEqual(linkGates(null, 'en', 'wifi_info', false).hub, false, 'null');
  assertEqual(linkGates({}, 'en', 'wifi_info', false).hub, false, 'no locales');
  assertEqual(linkGates(gi({}), 'en', 'wifi_info', false).hub, false, 'empty locales');
  assertEqual(linkGates(gi({ en: {}, de: {} }), 'en', 'wifi_info', false).hub, false, 'empty blocks');
  assertEqual(linkGates(gi({ en: { wifiName: '  ', houseRules: '\n' } }), 'en', 'wifi_info', false).hub, false, 'whitespace only');
  assertEqual(linkGates(gi({ en: { wifiName: 42, doorCode: true } }), 'en', 'wifi_info', false).hub, false, 'not text');
  assertEqual(linkGates(gi({ en: { notAGuestInfoField: 'x' } }), 'en', 'wifi_info', false).hub, false, 'only an unknown field');
});

test('info page: on with content in any language', () => {
  assertEqual(linkGates(gi({ en: { wifiName: 'Cafe Rose' } }), 'en', 'wifi_info', false).hub, true, 'English');
  assertEqual(linkGates(gi({ it: { houseRules: 'Niente fumo' } }), 'de', 'wifi_info', false).hub, true, 'Italian only, for a German guest');
  assertEqual(linkGates(gi({ de: { directBookingUrl: BOOK_DE } }), 'en', 'stay_welcome', false).hub, true, 'a booking link counts');
  for (const f of ['trashRules', 'parking', 'emergencyNumbers', 'extraNotes']) {
    assertEqual(linkGates(gi({ fr: { [f]: 'x' } }), 'en', 'stay_checkout', false).hub, true, `PR D field ${f}`);
  }
});

test('Local tips: the info page only when there are tips in the guest language or English', () => {
  const content = { wifiName: 'Cafe Rose' };
  assertEqual(linkGates(gi({ en: content }), 'en', 'local_tips', false).hub, false, 'content, no tips');
  assertEqual(linkGates(gi({ en: content }), 'en', 'wifi_info', false).hub, true, 'another pool does not need tips');
  assertEqual(linkGates(gi({ de: { localTips: 'Der Bäcker' } }), 'de', 'local_tips', false).hub, true, 'tips in the guest language');
  assertEqual(linkGates(gi({ en: { localTips: 'The bakery' } }), 'de', 'local_tips', false).hub, true, 'English tips for a German guest');
  assertEqual(linkGates(gi({ en: { localTips: 'The bakery' }, de: { localTips: '  ' } }), 'de', 'local_tips', false).hub, true, 'German whitespace → English tips');
  assertEqual(linkGates(gi({ de: { localTips: 'Der Bäcker' } }), 'en', 'local_tips', false).hub, false, 'German tips only, English guest');
  assertEqual(linkGates(gi({ it: { localTips: 'Il forno' }, en: content }), 'de', 'local_tips', false).hub, false, 'Italian tips only, German guest');
  assertEqual(linkGates(gi({ en: { localTips: ' ' } }), 'en', 'local_tips', false).hub, false, 'whitespace tips');
  assertEqual(linkGates(null, 'en', 'local_tips', false).hub, false, 'no Guest info');
});

test('offer link mirrors whether the journey holds an offer', () => {
  const full = gi({ en: { wifiName: 'x', directBookingUrl: BOOK_EN, localTips: 'y' } });
  assertEqual(linkGates(full, 'en', 'welcome', true).offer, true, 'offer');
  assertEqual(linkGates(full, 'en', 'welcome', false).offer, false, 'no offer');
  assertEqual(linkGates(null, 'en', 'welcome', true), { bookingRaw: null, hub: false, offer: true }, 'offer does not depend on Guest info');
  assertEqual(linkGates(full, 'en', 'local_tips', false), { bookingRaw: BOOK_EN, hub: true, offer: false }, 'the whole answer');
});

test('missing value reason: info page, booking link, else the first field', () => {
  const rows: Array<[string[], string]> = [
    [['link.hub'], 'guest_info_missing'],
    [['guestinfo.wifiName'], 'guest_info_missing'],
    [['guestinfo.secret.doorCode'], 'guest_info_missing'],
    [['guestinfo.checkOutTime', 'contact.firstName'], 'guest_info_missing'],
    [['contact.firstName', 'link.hub'], 'guest_info_missing'],
    [['link.booking'], 'booking_link_missing'],
    [['slot.price', 'link.booking'], 'booking_link_missing'],
    [['link.booking', 'guestinfo.localTips'], 'guest_info_missing'],
    [['link.booking', 'link.hub'], 'guest_info_missing'],
    [['contact.firstName'], 'missing_value:contact.firstName'],
    [['slot.price', 'contact.firstName'], 'missing_value:slot.price'],
    [['link.offer'], 'missing_value:link.offer'],
    [['link.hubs'], 'missing_value:link.hubs'],
    [['guestinfo'], 'missing_value:guestinfo'],
    [['link.booking.x'], 'missing_value:link.booking.x'],
  ];
  for (const [missing, want] of rows) assertEqual(missingReason(missing), want, JSON.stringify(missing));
});

test('each missing value reason has its own owner sentence', () => {
  const rows: Array<[string[], string, string]> = [
    [['link.hub'], 'Not sent because the Guest info page is not filled in yet.', 'Nicht gesendet, weil die Gästeinfos noch nicht ausgefüllt sind.'],
    [['link.booking'], 'Not sent because no direct-booking link is set in Guest info.', 'Nicht gesendet, weil in den Gästeinfos kein Link für Direktbuchungen hinterlegt ist.'],
    [['slot.price'], 'Not sent because a value this message needs is missing.', 'Nicht gesendet, weil ein Wert fehlt, den diese Nachricht braucht.'],
  ];
  for (const [missing, en, de] of rows) {
    const reason = missingReason(missing);
    const d = decision({ result: 'block', rule: 'channel_rules', reason, checks: [{ rule: 'channel_rules', ok: false, fact: reason }] });
    assertEqual(explainDecision(d, 'en', ZRH), en, `${reason} (en)`);
    assertEqual(explainDecision(d, 'de', ZRH), de, `${reason} (de)`);
  }
});

// ── Purity ───────────────────────────────────────────────────────────────────

const SRC = join(__dirname, '../src');

function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const imports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const reexports = [...src.matchAll(/^export\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  return [...imports, ...reexports];
}

function resolveTs(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const p of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(p)) return p;
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

/** Every file a module loads at run time, and the packages it pulls in. */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of runtimeImports(f)) {
      if (spec.startsWith('.')) todo.push(resolveTs(f, spec));
      else packages.add(spec);
    }
  }
  return { files, packages };
}

test('the modules are pure: their runtime imports load no firebase', () => {
  assertEqual(runtimeImports(join(SRC, 'adaptive/core/owner/deadTasks.ts')), [], 'deadTasks imports nothing');
  assertEqual(
    runtimeImports(join(SRC, 'adaptive/engine/renderSend.ts')).sort(),
    ['../core/registry', '../core/render', '../core/runtime/conditions', '../core/runtime/time', '../core/schemas'],
    'renderSend runtime imports',
  );
  for (const rel of ['adaptive/core/owner/deadTasks.ts', 'adaptive/core/runtime/decision.ts', 'adaptive/core/runtime/replay.ts', 'adaptive/engine/renderSend.ts']) {
    const { files, packages } = closure(join(SRC, rel));
    const bad = [...files].filter((f) => /[\\/](firebase|store|service|send)[\\/.]/.test(f.slice(SRC.length)));
    assertEqual(bad, [], `${rel} loads no firebase, store, service or send module`);
    assertEqual([...packages].filter((p) => p !== 'zod'), [], `${rel} packages besides zod`);
  }
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(cache.length > 0, 'require.cache is readable');
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
  assert(!cache.some((k) => /[\\/]node_modules[\\/](firebase-admin|@google-cloud)[\\/]/.test(k)), 'no Firebase or Google Cloud package was loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
