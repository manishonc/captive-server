/**
 * The guest timeline in plain sentences (PR D, spec R71): one sentence per event type in
 * English and German, decision sentences straight from `explainDecision`, a send's status
 * before "sent", test runs, "other places" with no foreign ids, no feedback / bodies /
 * addresses, newest first, `detail` for admins only.
 *
 * Run: npx tsx tests/adaptiveOwnerTimeline.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TIMELINE_EVENT_TYPES,
  buildTimeline,
  offerLabelText,
  offerLabelsFrom,
  type BuildTimelineArgs,
  type OfferMenuSetup,
  type TimelineConsentInput,
  type TimelineEventInput,
  type TimelineItem,
  type TimelineLang,
  type TimelineSendInput,
} from '../src/adaptive/core/owner/timeline';
import { explainDecision, type DecisionRecord } from '../src/adaptive/core/runtime/decision';
import { HOUR_MS, zonedTime } from '../src/adaptive/core/runtime/time';

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

const TENANT = 'u_owner';
const OTHER_TENANT = 'u_rival';
const ZRH = 'Europe/Zurich';
const NYC = 'America/New_York';
/** Fri 2 Oct 2026, 12:00 in Zurich. */
const T = zonedTime(2026, 10, 2, 12, 0, ZRH).getTime();

const VENUES = { v_cafe: { name: 'Café Rose', tz: ZRH }, v_ny: { name: 'NY Loft', tz: NYC } };
const NAMES: Record<TimelineLang, Record<string, string>> = {
  en: { welcome: 'Welcome', stay_guide: 'Stay guide', checkout_reminder: 'Checkout reminder' },
  de: { welcome: 'Willkommen', stay_guide: 'Aufenthaltsguide', checkout_reminder: 'Check-out-Erinnerung' },
};

let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}, over: Partial<TimelineEventInput> = {}): TimelineEventInput {
  seq += 1;
  return { id: `ev_${seq}`, type, occurredAt: T, venueId: 'v_cafe', tenantUserId: TENANT, contactId: `${TENANT}_c1`, data, ...over };
}

function build(over: Partial<BuildTimelineArgs> & { lang?: TimelineLang }): TimelineItem[] {
  const lang = over.lang ?? 'en';
  return buildTimeline({ tenantUserId: TENANT, events: [], sends: {}, consents: [], venues: VENUES, journeyNames: NAMES[lang] ?? NAMES.en, lang, audience: 'owner', ...over });
}

function one(e: TimelineEventInput, lang: TimelineLang, sends: Record<string, TimelineSendInput> = {}): TimelineItem {
  const items = build({ events: [e], sends, lang });
  assertEqual(items.length, 1, `one item for ${e.type}`);
  return items[0];
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 1,
    at: T,
    mode: 'live',
    result: 'allow',
    rule: null,
    reason: null,
    until: null,
    poolKey: 'welcome',
    purpose: 'marketing',
    checks: [
      { rule: 'system', ok: true, fact: 'sending on' },
      { rule: 'consent', ok: true, fact: 'sms yes at venue' },
    ],
    channel: { picked: 'sms', rule: 'auto', rejected: [] },
    variant: { picked: 'a', method: 'fixed' },
    slot: { picked: 'lunch', rule: 'slot', plannedAt: T },
    credits: { price: 15, balance: 400 },
    versions: { template: 1, config: 1, playbook: 'restaurant', engine: '1.0.0' },
    ...over,
  };
}

function send(sendKey: string, over: Partial<TimelineSendInput> = {}): TimelineSendInput {
  return { sendKey, status: 'delivered', channel: 'sms', purpose: 'marketing', mode: 'live', credits: 15, toMasked: '+41 ••• ••• 567', tenantUserId: TENANT, venueId: 'v_cafe', ...over };
}

// ── One sentence per event type, EN and DE ───────────────────────────────────

const J = { journeyKey: 'welcome', instanceId: 'inst_1', mode: 'live' as const };
const MOMENT = zonedTime(2026, 10, 2, 15, 0, ZRH).getTime();

const CASES: Array<{ e: TimelineEventInput; sends?: Record<string, TimelineSendInput>; en: string; de: string }> = [
  { e: ev('wifi.connected', { apId: 'ap1' }, { contactId: null }), en: 'Connected to the Wi-Fi.', de: 'Mit dem WLAN verbunden.' },
  { e: ev('visit.started', { visitNumber: 1, isFirstVisit: true }), en: 'First visit: connected to the Wi-Fi.', de: 'Erster Besuch: mit dem WLAN verbunden.' },
  { e: ev('visit.started', { visitNumber: 3, isFirstVisit: false, isRevisit: true }), en: 'Came back (visit 3).', de: 'Wieder da (Besuch 3).' },
  { e: ev('visit.ended', { endSource: 'timeout' }), en: 'The visit ended.', de: 'Der Besuch ist zu Ende.' },
  { e: ev('journey.entered', { mode: 'live' }, J), en: 'Journey “Welcome” started.', de: 'Journey „Willkommen“ gestartet.' },
  { e: ev('journey.exited', { status: 'cancelled', reason: 'stay_cancelled' }, J), en: 'Journey “Welcome” ended: the booking was cancelled.', de: 'Journey „Willkommen“ beendet: die Buchung wurde storniert.' },
  { e: ev('journey.exited', { status: 'cancelled', reason: 'stay_unlinked' }, J), en: 'Journey “Welcome” ended: the booking was unlinked from this guest.', de: 'Journey „Willkommen“ beendet: die Buchung wurde von diesem Gast getrennt.' },
  { e: ev('journey.resumed', { stayId: 'st_1', linkSeq: 3 }, J), en: 'Journey “Welcome” runs on: you linked this guest to the booking again.', de: 'Journey „Willkommen“ läuft weiter: du hast diesen Gast wieder mit der Buchung verbunden.' },
  { e: ev('journey.exited', { status: 'suppressed', reason: 'switched_off' }, J), en: 'Journey “Welcome” ended: it or the venue was switched off.', de: 'Journey „Willkommen“ beendet: sie oder der Standort wurde ausgeschaltet.' },
  { e: ev('journey.exited', { status: 'converted', reason: 'goal' }, J), en: 'Journey “Welcome” finished: goal reached.', de: 'Journey „Willkommen“ abgeschlossen: Ziel erreicht.' },
  { e: ev('journey.exited', { status: 'completed', reason: 'exit_on:rating.submitted' }, J), en: 'Journey “Welcome” ended early: the guest gave a rating.', de: 'Journey „Willkommen“ vorzeitig beendet: der Gast hat bewertet.' },
  { e: ev('journey.exited', { status: 'completed', reason: 'exit:done' }, J), en: 'Journey “Welcome” finished.', de: 'Journey „Willkommen“ abgeschlossen.' },
  { e: ev('journey.exited', { status: 'exhausted', reason: 'exit:end' }, J), en: 'Journey “Welcome” finished: nothing more to send.', de: 'Journey „Willkommen“ abgeschlossen: nichts mehr zu senden.' },
  { e: ev('journey.exited', { status: 'failed', reason: 'template_version_missing' }, J), en: 'Journey “Welcome” stopped because of a problem in its setup.', de: 'Journey „Willkommen“ wegen eines Problems in der Einrichtung gestoppt.' },
  { e: ev('journey.converted', { goalEvent: 'visit.started', eventId: 'ev_x' }, J), en: 'Journey “Welcome” reached its goal (the guest came back).', de: 'Journey „Willkommen“ hat ihr Ziel erreicht (der Gast kam wieder).' },
  { e: ev('journey.config_updated', { from: 1, to: 2 }, J), en: 'Journey “Welcome” now uses your latest changes.', de: 'Journey „Willkommen“ nutzt jetzt deine neuesten Änderungen.' },
  {
    e: ev('journey.not_started', { reason: 'signup_breaker', apId: 'ap1' }),
    en: 'No journey started: unusually many new guests signed up at this access point within the hour.',
    de: 'Keine Journey gestartet: an diesem Access Point haben sich in dieser Stunde ungewöhnlich viele neue Gäste angemeldet.',
  },
  {
    e: ev('journey.not_started', { reason: 'late_connect' }),
    en: 'No journey started: this visit was processed too late to still send anything.',
    de: 'Keine Journey gestartet: dieser Besuch wurde zu spät verarbeitet, um noch etwas zu senden.',
  },
  { e: ev('offer.issued', { offerKey: 'coffee', days: 14, label: 'Free coffee' }, J), en: 'Got an offer: “Free coffee”, valid for 14 days.', de: 'Angebot erhalten: „Free coffee“, 14 Tage gültig.' },
  { e: ev('offer.redeemed', { redeemedVia: 'revisit_auto', visitId: 'vis_1' }, J), en: 'Came back while the offer was valid: counted as used.', de: 'Kam wieder, solange das Angebot galt: zählt als eingelöst.' },
  {
    e: ev('send.dry_run', {}, { ...J, mode: 'test', sendKey: 'js_dry' }),
    en: 'Test run: a message would have been sent — nothing was sent.',
    de: 'Testlauf: eine Nachricht wäre gesendet worden — nichts wurde gesendet.',
  },
  { e: ev('send.skipped', { reason: 'contact_gone' }, J), en: "Not sent because the guest's details were removed.", de: 'Nicht gesendet, weil die Daten des Gastes entfernt wurden.' },
  { e: ev('send.blocked', {}, J), en: 'Not sent because a sending rule stopped it.', de: 'Nicht gesendet, weil eine Versandregel es verhindert hat.' },
  { e: ev('send.deferred', { until: MOMENT }, J), en: 'Held back until Fri 2 Oct, 15:00.', de: 'Zurückgehalten bis Fr., 2. Okt., 15:00.' },
  {
    e: ev('message.sent', { mode: 'live', channel: 'sms', purpose: 'service', credits: 0 }, { ...J, sendKey: 'js_svc', channel: 'sms' }),
    en: 'Sent by SMS (free).',
    de: 'Per SMS gesendet (gratis).',
  },
  {
    e: ev('message.sent', { mode: 'live', channel: 'email', purpose: 'marketing', credits: 3 }, { ...J, sendKey: 'js_nodoc', channel: 'email' }),
    en: 'Sent by email (3 credits).',
    de: 'Per E-Mail gesendet (3 Credits).',
  },
  {
    e: ev('message.sent', { mode: 'live', kind: 'reply_notice', channel: 'sms', purpose: 'service', credits: 0 }, { sendKey: 'js_reply', channel: 'sms', mode: 'live' }),
    en: "Automatic answer to the guest's text: Sent by SMS (free).",
    de: 'Automatische Antwort auf eine SMS des Gastes: Per SMS gesendet (gratis).',
  },
  { e: ev('send.retry', { mode: 'live', channel: 'sms', reason: 'rate_limited', attempt: 2 }, { ...J, channel: 'sms' }), en: 'Sending by SMS will be tried again later (attempt 2).', de: 'Versand per SMS wird später nochmals versucht (Versuch 2).' },
  { e: ev('message.delivered', { mode: 'live', status: 'delivered' }, { ...J, channel: 'sms' }), en: 'The SMS was delivered.', de: 'Die SMS wurde zugestellt.' },
  { e: ev('message.opened', { mode: 'live', event: 'opened' }, { ...J, channel: 'email' }), en: 'Opened the email.', de: 'Hat die E-Mail geöffnet.' },
  { e: ev('message.read', {}, { ...J, channel: 'whatsapp' }), en: 'Read the WhatsApp message.', de: 'Hat die WhatsApp-Nachricht gelesen.' },
  { e: ev('message.clicked', { shortCode: 'abc123', link: 'offer' }, { ...J, channel: 'sms' }), en: 'Clicked the link in the SMS.', de: 'Hat auf den Link in der SMS geklickt.' },
  { e: ev('message.bounced', { invalid: true, reason: 'bad [address]' }, { ...J, channel: 'email' }), en: 'The email bounced: the address is invalid.', de: 'Die E-Mail kam zurück: die Adresse ist ungültig.' },
  { e: ev('message.bounced', { hard: true }, { ...J, channel: 'email' }), en: "The email bounced: the address can't receive it.", de: 'Die E-Mail kam zurück: die Adresse kann sie nicht empfangen.' },
  { e: ev('message.failed', { status: 'undelivered', errorCode: '30003' }, { ...J, channel: 'sms' }), en: 'The SMS did not arrive.', de: 'Die SMS kam nicht an.' },
  { e: ev('message.failed', { errorCode: '21610' }, { ...J, channel: 'sms' }), en: 'The SMS did not arrive: this number has said STOP to texts.', de: 'Die SMS kam nicht an: diese Nummer hat SMS mit STOP abbestellt.' },
  { e: ev('message.failed', { blocked: true }, { ...J, channel: 'email' }), en: 'The email did not arrive: the email service blocked it.', de: 'Die E-Mail kam nicht an: der E-Mail-Dienst hat sie blockiert.' },
  { e: ev('message.unknown', { reason: 'adapter_threw:timeout' }, { ...J, channel: 'email' }), en: 'Not confirmed yet whether the email went out.', de: 'Noch nicht bestätigt, ob die E-Mail rausging.' },
  { e: ev('message.replied', { source: 'sms_keyword', kind: 'reply' }, { ...J, channel: 'sms' }), en: 'Replied to the SMS.', de: 'Hat auf die SMS geantwortet.' },
  { e: ev('rating.submitted', { stars: 4, hasFeedback: false }, J), en: 'Rated 4 of 5 stars.', de: 'Mit 4 von 5 Sternen bewertet.' },
  { e: ev('rating.submitted', { stars: 2, hasFeedback: true }, J), en: 'Rated 2 of 5 stars. No more marketing messages from here.', de: 'Mit 2 von 5 Sternen bewertet. Keine Werbenachrichten mehr von hier.' },
  { e: ev('consent.revoked', { source: 'brevo_spam', channel: 'email' }, { channel: 'email' }), en: 'Marked an email as spam: no more emails.', de: 'Hat eine E-Mail als Spam markiert: keine E-Mails mehr.' },
  { e: ev('consent.revoked', { source: 'unsubscribe_page', channel: 'email' }, { channel: 'email' }), en: 'Unsubscribed from emails.', de: 'Hat sich von E-Mails abgemeldet.' },
  { e: ev('consent.granted', { source: 'sms_keyword', kind: 'start' }, { channel: 'sms', venueId: null, tenantUserId: null }), en: 'Texted START: SMS are allowed again.', de: 'Hat START geschickt: SMS sind wieder erlaubt.' },
  { e: ev('stay.created', { stayId: 'st_1', checkIn: '2026-10-02', checkOut: '2026-10-05', nights: 3 }), en: 'New booking: Fri 2 Oct to Mon 5 Oct (3 nights).', de: 'Neue Buchung: Fr., 2. Okt. bis Mo., 5. Okt. (3 Nächte).' },
  {
    e: ev('stay.changed', { stayId: 'st_1', datesVersion: 2, from: { checkIn: '2026-10-02', checkOut: '2026-10-05' }, to: { checkIn: '2026-10-03', checkOut: '2026-10-06' } }),
    en: 'Booking moved to Sat 3 Oct to Tue 6 Oct (was Fri 2 Oct to Mon 5 Oct).',
    de: 'Buchung verschoben auf Sa., 3. Okt. bis Di., 6. Okt. (vorher Fr., 2. Okt. bis Mo., 5. Okt.).',
  },
  {
    e: ev('stay.changed', { stayId: 'st_1', reinstated: true, from: { checkIn: '2026-10-02', checkOut: '2026-10-05' }, to: { checkIn: '2026-10-02', checkOut: '2026-10-05' } }),
    en: 'Booking back in the calendar: Fri 2 Oct to Mon 5 Oct.',
    de: 'Buchung wieder im Kalender: Fr., 2. Okt. bis Mo., 5. Okt.',
  },
  {
    e: ev('stay.cancelled', { stayId: 'st_1', reason: 'missing', checkIn: '2026-10-02', checkOut: '2026-10-05' }),
    en: 'Booking Fri 2 Oct to Mon 5 Oct cancelled: it is no longer in the calendar.',
    de: 'Buchung Fr., 2. Okt. bis Mo., 5. Okt. storniert: sie ist nicht mehr im Kalender.',
  },
  {
    e: ev('stay.cancelled', { stayId: 'st_1', reason: 'feed_deleted', checkIn: '2026-10-02', checkOut: '2026-10-05', by: 'uid_actor' }),
    en: 'Booking Fri 2 Oct to Mon 5 Oct cancelled: the calendar link was removed.',
    de: 'Buchung Fr., 2. Okt. bis Mo., 5. Okt. storniert: der Kalender-Link wurde entfernt.',
  },
  { e: ev('stay.linked', { stayId: 'st_1', linkMode: 'live', checkIn: '2026-10-02', checkOut: '2026-10-05' }), en: 'Linked to the booking Fri 2 Oct to Mon 5 Oct.', de: 'Mit der Buchung Fr., 2. Okt. bis Mo., 5. Okt. verknüpft.' },
  {
    e: ev('stay.linked', { stayId: 'st_1', linkMode: 'live', linkedBy: 'owner', checkIn: '2026-10-02', checkOut: '2026-10-05' }),
    en: 'Linked by you to the booking Fri 2 Oct to Mon 5 Oct.',
    de: 'Von dir mit der Buchung Fr., 2. Okt. bis Mo., 5. Okt. verknüpft.',
  },
  {
    e: ev('stay.linked', { stayId: 'st_1', linkMode: 'test', checkIn: '2026-10-02', checkOut: '2026-10-05' }),
    en: 'Test run: linked to the booking Fri 2 Oct to Mon 5 Oct.',
    de: 'Testlauf: Mit der Buchung Fr., 2. Okt. bis Mo., 5. Okt. verknüpft.',
  },
  { e: ev('stay.unlinked', { stayId: 'st_1', linkSeq: 2, by: 'uid_actor' }, { source: 'cms' }), en: 'You unlinked this guest from the booking.', de: 'Du hast diesen Gast von der Buchung getrennt.' },
  {
    e: ev('stay.relinked', { stayId: 'st_1', linkSeq: 3, by: 'uid_actor' }, { source: 'cms' }),
    en: 'You linked this guest back to the booking: their stay messages run on from where they stopped.',
    de: 'Du hast diesen Gast wieder mit der Buchung verbunden: seine Aufenthalts-Nachrichten laufen dort weiter, wo sie aufgehört haben.',
  },
  {
    e: ev('stay.overlap_flagged', { stayId: 'st_1', overlapWith: ['st_2'], checkIn: '2026-10-02', checkOut: '2026-10-05' }),
    en: "Booking Fri 2 Oct to Mon 5 Oct overlaps another booking: guests aren't linked to it automatically.",
    de: 'Buchung Fr., 2. Okt. bis Mo., 5. Okt. überschneidet sich mit einer anderen: Gäste werden nicht automatisch verknüpft.',
  },
  { e: ev('stay.moment', { stayId: 'st_1', journeyKey: 'stay_guide', momentAt: MOMENT }), en: 'Time for journey “Stay guide” (Fri 2 Oct, 15:00).', de: 'Zeit für Journey „Aufenthaltsguide“ (Fr., 2. Okt., 15:00).' },
  {
    e: ev('stay.moment_skipped', { stayId: 'st_1', journeyKey: 'checkout_reminder', momentAt: MOMENT, reason: 'too_late' }),
    en: 'Journey “Checkout reminder” skipped for this booking: it was too late.',
    de: 'Journey „Check-out-Erinnerung“ für diese Buchung übersprungen: es war zu spät.',
  },
  {
    e: ev('stay.moment_skipped', { stayId: 'st_1', journeyKey: 'stay_guide', momentAt: MOMENT, reason: 'switched_off' }),
    en: 'Journey “Stay guide” skipped for this booking: it was switched off.',
    de: 'Journey „Aufenthaltsguide“ für diese Buchung übersprungen: sie war ausgeschaltet.',
  },
  {
    e: ev('moment.passed', { stayId: 'st_1', journeyKey: 'stay_guide', reason: 'checked_out_before_live' }),
    en: 'Journey “Stay guide” didn\'t run: the guest had checked out before it was turned on.',
    de: 'Journey „Aufenthaltsguide“ lief nicht: der Gast war ausgecheckt, bevor sie eingeschaltet wurde.',
  },
  {
    e: ev('moment.passed', { stayId: 'st_1', journeyKey: 'stay_guide', reason: 'checked_out_before_start_sending' }),
    en: 'Journey “Stay guide” didn\'t run: the guest had checked out before you started sending.',
    de: 'Journey „Aufenthaltsguide“ lief nicht: der Gast war ausgecheckt, bevor du den Versand gestartet hast.',
  },
];

test('every event type the engine writes has its own sentence, in English and German', () => {
  assertEqual(one(ev('stay.cancelled', { checkIn: '2026-10-02', checkOut: '2026-10-05' }), 'de').sentence, 'Buchung Fr., 2. Okt. bis Mo., 5. Okt. storniert.', 'one full stop after a German date');
  assertEqual(one(ev('stay.created', { checkIn: '2026-10-02', checkOut: '2026-10-05' }), 'de').sentence, 'Neue Buchung: Fr., 2. Okt. bis Mo., 5. Okt.', 'no double full stop');
  const covered = new Set(CASES.map((c) => c.e.type));
  const missing = TIMELINE_EVENT_TYPES.filter((type) => !covered.has(type));
  assertEqual(missing, [], 'types without a case');
  for (const c of CASES) {
    assertEqual(one(c.e, 'en', c.sends).sentence, c.en, `${c.e.type} (en)`);
    assertEqual(one(c.e, 'de', c.sends).sentence, c.de, `${c.e.type} (de)`);
  }
});

test('a type the builder does not know: neutral for owners, the raw type for admins', () => {
  const e = ev('computed.slow_daypart', { secret: 'x' });
  assertEqual(one(e, 'en').sentence, 'Something else happened.', 'owner en');
  assertEqual(one(e, 'de').sentence, 'Etwas anderes ist passiert.', 'owner de');
  assertEqual(build({ events: [e], audience: 'admin' })[0].sentence, 'computed.slow_daypart', 'admin');
  for (const c of CASES) assert(one(c.e, 'en').sentence !== 'Something else happened.', `${c.e.type} is known`);
});

test('any other language falls back to English; an unknown journey shows its key', () => {
  const e = ev('journey.entered', {}, { journeyKey: 'mystery', mode: 'live' });
  assertEqual(build({ events: [e], lang: 'fr' as TimelineLang })[0].sentence, 'Journey “mystery” started.', 'fr → en, key as name');
});

// ── Decision sentences come from the stored record ──────────────────────────

test('skipped, blocked, held back and dry-run sentences equal explainDecision(stored record) in the venue zone', () => {
  const quiet = decision({ result: 'defer', rule: 'quiet_hours', reason: 'quiet_hours', until: T + 20 * HOUR_MS, checks: [{ rule: 'quiet_hours', ok: false, fact: 'quiet 22:00–08:00' }] });
  const weekly = decision({ result: 'skip', rule: 'weekly_limit', reason: 'weekly_limit', checks: [{ rule: 'weekly_limit', ok: false, fact: '3 of 3 in the last 7 days' }] });
  const blocked = decision({ result: 'block', rule: 'blocked_address', reason: 'blocked', channel: { picked: 'email', rule: 'auto', rejected: [] } });
  const dry = decision({ mode: 'test' });
  const rows: Array<[string, DecisionRecord, string]> = [
    ['send.deferred', quiet, 'v_ny'],
    ['send.deferred', quiet, 'v_cafe'],
    ['send.skipped', weekly, 'v_cafe'],
    ['send.blocked', blocked, 'v_cafe'],
    ['send.dry_run', dry, 'v_cafe'],
  ];
  for (const lang of ['en', 'de'] as const) {
    for (const [type, d, venueId] of rows) {
      const e = ev(type, { decision: d }, { ...J, mode: d.mode, venueId, sendKey: `js_${type}` });
      const got = one(e, lang).sentence;
      assertEqual(got, explainDecision(d, lang, VENUES[venueId as keyof typeof VENUES].tz), `${type} at ${venueId} (${lang})`);
    }
  }
  const ny = one(ev('send.deferred', { decision: quiet }, { ...J, venueId: 'v_ny' }), 'en').sentence;
  const zh = one(ev('send.deferred', { decision: quiet }, { ...J, venueId: 'v_cafe' }), 'en').sentence;
  assert(ny !== zh, `times are in the venue's zone (${ny} / ${zh})`);
});

test("a live message.sent is worded from the send's record when it went out", () => {
  const d = decision();
  const s = { js_live: send('js_live', { decision: d, status: 'delivered' }) };
  const e = ev('message.sent', { mode: 'live', channel: 'sms', purpose: 'marketing', credits: 15 }, { ...J, sendKey: 'js_live', channel: 'sms' });
  for (const lang of ['en', 'de'] as const) assertEqual(one(e, lang, s).sentence, explainDecision(d, lang, ZRH), `sent (${lang})`);
  assertEqual(one(e, 'en', s).sentence, 'Sent by SMS (15 credits).', 'with the credits');
  assertEqual(one(e, 'en', s).credits, 15, 'credits on the item');
});

test('a failed, bounced, cancelled or unconfirmed send never says "sent"', () => {
  for (const status of ['failed', 'bounced', 'cancelled', 'unknown', 'dispatching']) {
    const s = { js_bad: send('js_bad', { decision: decision(), status }) };
    const e = ev('message.sent', { mode: 'live', channel: 'sms', purpose: 'marketing', credits: 15 }, { ...J, sendKey: 'js_bad', channel: 'sms' });
    const en = one(e, 'en', s);
    const de = one(e, 'de', s);
    assert(!/sent/i.test(en.sentence), `${status} (en): ${en.sentence}`);
    assert(!/gesendet/i.test(de.sentence), `${status} (de): ${de.sentence}`);
    assertEqual(en.credits, null, `${status}: no credits shown`);
  }
  const failed = { js_bad: send('js_bad', { status: 'failed' }) };
  const e = ev('message.sent', { mode: 'live', channel: 'sms' }, { ...J, sendKey: 'js_bad', channel: 'sms' });
  assertEqual(one(e, 'en', failed).sentence, 'The SMS did not arrive.', 'failed (en)');
  assertEqual(one(e, 'de', failed).sentence, 'Die SMS kam nicht an.', 'failed (de)');
});

test('test runs say so, also for a skip whose sentence does not', () => {
  const d = decision({ mode: 'test', result: 'skip', rule: 'consent', reason: 'no_consent', checks: [{ rule: 'consent', ok: false, fact: 'no sms yes' }] });
  const e = ev('send.skipped', { decision: d }, { ...J, mode: 'test' });
  for (const lang of ['en', 'de'] as const) {
    const item = one(e, lang);
    const s = explainDecision(d, lang, ZRH);
    // English goes on in lower case after the colon.
    assertEqual(item.sentence, lang === 'de' ? `Testlauf: ${s}` : `Test run: ${s[0].toLowerCase()}${s.slice(1)}`, `test skip (${lang})`);
    assertEqual(item.mode, 'test', 'mode on the item');
  }
  const dry = one(ev('send.dry_run', { decision: decision({ mode: 'test' }) }, { ...J, mode: 'test' }), 'en');
  assert(dry.sentence.startsWith('Test run: would have sent by SMS (15 credits)'), `dry run said once: ${dry.sentence}`);
  assertEqual(dry.credits, null, 'a dry run spends nothing');
  assertEqual(one(ev('journey.exited', { status: 'completed', reason: 'exit:x' }, { ...J, mode: 'test' }), 'de').sentence, 'Testlauf: Journey „Willkommen“ abgeschlossen.', 'test exit (de)');
});

// ── Consent ledger ───────────────────────────────────────────────────────────

test('consent ledger sentences by source, and a consent event the ledger already has is not repeated', () => {
  const c = (over: Partial<TimelineConsentInput>): TimelineConsentInput => ({ id: `cs_${(seq += 1)}`, occurredAt: T, venueId: 'v_cafe', channel: 'sms', action: 'revoke', source: 'owner', tenantUserId: TENANT, ...over });
  const rows: Array<[TimelineConsentInput, string, string]> = [
    [c({ action: 'grant', source: 'splash', channel: 'email' }), 'Said yes to messages by email on the Wi-Fi page.', 'Hat auf der WLAN-Seite Nachrichten per E-Mail zugestimmt.'],
    [c({ source: 'owner' }), 'You stopped marketing by SMS for this guest.', 'Du hast Werbung per SMS für diesen Gast gestoppt.'],
    [c({ action: 'grant', source: 'owner', channel: 'whatsapp' }), 'You turned marketing by WhatsApp back on for this guest.', 'Du hast Werbung per WhatsApp für diesen Gast wieder eingeschaltet.'],
    [c({ source: 'sms_keyword', sourceRef: { eventId: 'ev_stop', sendKey: null } }), 'Replied STOP: no more SMS.', 'Hat mit STOP geantwortet: keine SMS mehr.'],
    [c({ action: 'grant', source: 'sms_keyword' }), 'Texted START: SMS are allowed again.', 'Hat START geschickt: SMS sind wieder erlaubt.'],
    [c({ source: 'provider_stop', sourceRef: { sendKey: 'js_own', errorCode: '21610' } }), 'The phone network reports that this number said STOP: no more SMS.', 'Das Mobilfunknetz meldet ein STOP für diese Nummer: keine SMS mehr.'],
    [c({ source: 'unsubscribe_page', channel: 'email' }), 'Unsubscribed from emails.', 'Hat sich von E-Mails abgemeldet.'],
    [c({ source: 'brevo_unsubscribed', channel: 'email' }), 'Unsubscribed from emails.', 'Hat sich von E-Mails abgemeldet.'],
    [c({ source: 'brevo_spam', channel: 'email' }), 'Marked an email as spam: no more emails.', 'Hat eine E-Mail als Spam markiert: keine E-Mails mehr.'],
    [c({ source: 'import_legacy' }), 'Had already said no to messages by SMS before (carried over).', 'Hatte Nachrichten per SMS schon früher abgelehnt (übernommen).'],
  ];
  const sends = { js_own: send('js_own') };
  for (const [input, en, de] of rows) {
    const itEn = build({ consents: [input], sends })[0];
    assertEqual([itEn.kind, itEn.sentence, itEn.venueName], [input.action === 'grant' ? 'consent.granted' : 'consent.revoked', en, 'Café Rose'], `${input.source} ${input.action} (en)`);
    assertEqual(build({ consents: [input], sends, lang: 'de' })[0].sentence, de, `${input.source} ${input.action} (de)`);
  }
  const unsubEvent = ev('consent.revoked', { source: 'unsubscribe_page', channel: 'email' }, { id: 'ev_unsub', channel: 'email' });
  const ledger = c({ source: 'unsubscribe_page', channel: 'email', sourceRef: { eventId: 'ev_unsub', sendKey: 'js_own' } });
  const items = build({ events: [unsubEvent], consents: [ledger], sends });
  assertEqual(items.map((i) => i.kind), ['consent.revoked'], 'one item, from the ledger');
});

// The PR D rows as identity/consent.ts (owner stop / resume) and identity/resolve.ts (a splash tick
// while the owner's stop stands) write them.
const lift = (channel: string, over: Partial<TimelineConsentInput> = {}): TimelineConsentInput => ({
  id: `cs_${(seq += 1)}`,
  occurredAt: T,
  venueId: 'v_cafe',
  channel,
  action: 'revoke',
  source: 'owner',
  tenantUserId: TENANT,
  sourceRef: { by: 'uid_actor', kind: 'owner_lift_guest_no', resumes: 'cs_guest_stop' },
  ...over,
});
const heldYes = (channel: string, over: Partial<TimelineConsentInput> = {}): TimelineConsentInput => ({
  id: `cs_${(seq += 1)}`,
  occurredAt: T,
  venueId: 'v_cafe',
  channel,
  action: 'grant',
  source: 'splash',
  tenantUserId: TENANT,
  sourceRef: { guestId: 'g_held', eventId: 'ev_portal_held', consentTextHash: null, heldByOwnerStop: true },
  ...over,
});

test("the owner's resume over the guest's own no (owner_lift_guest_no): it stays off, EN and DE", () => {
  const rows: Array<[string, string, string]> = [
    ['sms', 'You lifted your stop on marketing by SMS; the guest had said no themselves, so it stays off.', 'Du hast deinen Werbestopp per SMS aufgehoben; der Gast hatte selbst abgelehnt, deshalb bleibt sie aus.'],
    ['email', 'You lifted your stop on marketing by email; the guest had said no themselves, so it stays off.', 'Du hast deinen Werbestopp per E-Mail aufgehoben; der Gast hatte selbst abgelehnt, deshalb bleibt sie aus.'],
    ['whatsapp', 'You lifted your stop on marketing by WhatsApp; the guest had said no themselves, so it stays off.', 'Du hast deinen Werbestopp per WhatsApp aufgehoben; der Gast hatte selbst abgelehnt, deshalb bleibt sie aus.'],
  ];
  for (const [channel, en, de] of rows) {
    const itEn = build({ consents: [lift(channel)] })[0];
    assertEqual([itEn.kind, itEn.sentence, itEn.venueName, itEn.channel], ['consent.revoked', en, 'Café Rose', channel], `${channel} (en)`);
    assertEqual(build({ consents: [lift(channel)], lang: 'de' })[0].sentence, de, `${channel} (de)`);
  }
  // Distinct from the plain lift (no yes to give back) and from a plain owner stop.
  const plainLift = build({ consents: [lift('sms', { sourceRef: { by: 'uid_actor', kind: 'owner_lift', resumes: 'cs_x' } })] })[0].sentence;
  assertEqual(plainLift, "You lifted your stop on marketing by SMS (the guest hasn't said yes to SMS here).", 'owner_lift keeps its own words');
  assertEqual(build({ consents: [lift('sms', { sourceRef: { by: 'uid_actor', kind: 'owner_stop' } })] })[0].sentence, 'You stopped marketing by SMS for this guest.', 'owner_stop: the plain stop');
  // The kind is read only on the owner's own rows: a STOP carrying it is still a STOP.
  assertEqual(build({ consents: [lift('sms', { source: 'sms_keyword' })] })[0].sentence, 'Replied STOP: no more SMS.', 'kind on a keyword row is ignored');
  // Another tenant's venue: the neutral other-places sentence, nothing about the owner.
  const foreign = build({ consents: [lift('sms', { venueId: 'v_rival', tenantUserId: OTHER_TENANT })] })[0];
  assertEqual([foreign.sentence, foreign.venueId], ['Said no to messages by SMS (other places).', null], 'other places');
});

test("a splash yes held by the owner's stop says marketing stays stopped until the owner resumes, EN and DE", () => {
  const rows: Array<[string, string, string]> = [
    ['email', 'Said yes to messages by email on the Wi-Fi page. Marketing stays stopped here until you resume it.', 'Hat auf der WLAN-Seite Nachrichten per E-Mail zugestimmt. Werbung bleibt hier gestoppt, bis du sie wieder einschaltest.'],
    ['sms', 'Said yes to messages by SMS on the Wi-Fi page. Marketing stays stopped here until you resume it.', 'Hat auf der WLAN-Seite Nachrichten per SMS zugestimmt. Werbung bleibt hier gestoppt, bis du sie wieder einschaltest.'],
  ];
  for (const [channel, en, de] of rows) {
    const itEn = build({ consents: [heldYes(channel)] })[0];
    assertEqual([itEn.kind, itEn.sentence, itEn.venueName], ['consent.granted', en, 'Café Rose'], `${channel} (en)`);
    assertEqual(build({ consents: [heldYes(channel)], lang: 'de' })[0].sentence, de, `${channel} (de)`);
  }
  // Only a real `true` marks it held; anything else is the ordinary yes.
  for (const held of [false, 'true', 1, null]) {
    const it = build({ consents: [heldYes('email', { sourceRef: { guestId: 'g_held', heldByOwnerStop: held } })] })[0];
    assertEqual(it.sentence, 'Said yes to messages by email on the Wi-Fi page.', `heldByOwnerStop ${JSON.stringify(held)}`);
  }
  // At another tenant's venue the owner learns nothing about the hold.
  const foreign = build({ consents: [heldYes('email', { venueId: 'v_rival', tenantUserId: OTHER_TENANT })], lang: 'de' })[0];
  assertEqual(foreign.sentence, 'Hat Nachrichten per E-Mail zugestimmt (an anderen Orten).', 'other places (de)');
});

test('stop → held splash yes → resume reads as one story, newest first; owners see no ids', () => {
  const consents: TimelineConsentInput[] = [
    lift('email', { id: 'cs_stop', occurredAt: T - 2 * HOUR_MS, sourceRef: { by: 'uid_actor', kind: 'owner_stop' } }),
    heldYes('email', { id: 'cs_held', occurredAt: T - HOUR_MS }),
    { id: 'cs_resume', occurredAt: T, venueId: 'v_cafe', channel: 'email', action: 'grant', source: 'owner', tenantUserId: TENANT, sourceRef: { by: 'uid_actor', kind: 'owner_resume', resumes: 'cs_held' } },
  ];
  // The held tick's own consent event (if one was logged) is not repeated.
  const events = [ev('consent.granted', { source: 'splash', channel: 'email' }, { id: 'ev_portal_held', occurredAt: T - HOUR_MS, channel: 'email' })];
  assertEqual(
    build({ consents, events }).map((i) => i.sentence),
    [
      'You turned marketing by email back on for this guest.',
      'Said yes to messages by email on the Wi-Fi page. Marketing stays stopped here until you resume it.',
      'You stopped marketing by email for this guest.',
    ],
    'en',
  );
  assertEqual(
    build({ consents, events, lang: 'de' }).map((i) => i.sentence),
    [
      'Du hast Werbung per E-Mail für diesen Gast wieder eingeschaltet.',
      'Hat auf der WLAN-Seite Nachrichten per E-Mail zugestimmt. Werbung bleibt hier gestoppt, bis du sie wieder einschaltest.',
      'Du hast Werbung per E-Mail für diesen Gast gestoppt.',
    ],
    'de',
  );
  const guestNo: TimelineConsentInput[] = [
    { id: 'cs_guest_stop', occurredAt: T - 2 * HOUR_MS, venueId: 'v_cafe', channel: 'sms', action: 'revoke', source: 'sms_keyword', tenantUserId: TENANT, sourceRef: { eventId: 'ev_stop_in' } },
    lift('sms', { id: 'cs_mark', occurredAt: T - HOUR_MS, sourceRef: { by: 'uid_actor', kind: 'owner_stop_mark', over: 'cs_guest_stop' } }),
    lift('sms', { id: 'cs_lift', occurredAt: T }),
  ];
  assertEqual(
    build({ consents: guestNo }).map((i) => i.sentence),
    [
      'You lifted your stop on marketing by SMS; the guest had said no themselves, so it stays off.',
      'You stopped marketing by SMS for this guest (they had already said no themselves).',
      'Replied STOP: no more SMS.',
    ],
    'guest said no first (en)',
  );
  const owner = JSON.stringify(build({ consents: [...consents, ...guestNo], events }));
  for (const bad of ['uid_actor', 'cs_guest_stop', 'cs_held', 'g_held', 'ev_portal_held', 'heldByOwnerStop', 'owner_lift_guest_no', 'owner_resume']) {
    assert(!owner.includes(bad), `owner JSON has no ${bad}`);
  }
  const admin = build({ consents: [lift('sms', { id: 'cs_admin' })], audience: 'admin' })[0];
  assertEqual(admin.sentence, 'You lifted your stop on marketing by SMS; the guest had said no themselves, so it stays off.', 'same sentence for admins');
  assertEqual(((admin.detail as Record<string, any>).sourceRef ?? {}).kind, 'owner_lift_guest_no', 'admins see the kind');
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test("another tenant's venue, send or sendKey shows as other places, with no foreign id or name", () => {
  const foreignSends = {
    js_rival_1: send('js_rival_1', { tenantUserId: OTHER_TENANT, venueId: 'v_rival' }),
    js_rival_2: send('js_rival_2', { tenantUserId: OTHER_TENANT, venueId: 'v_rival' }),
  };
  const consents: TimelineConsentInput[] = [
    // A STOP replied to another owner's SMS, applied to this owner's venue.
    { id: 'cs_stop', occurredAt: T, venueId: 'v_cafe', channel: 'sms', action: 'revoke', source: 'sms_keyword', tenantUserId: TENANT, sourceRef: { eventId: 'ev_in', sendKey: 'js_rival_1' } },
    // A sendKey we can't place is treated the same (fail closed).
    { id: 'cs_stop2', occurredAt: T - HOUR_MS, venueId: 'v_ny', channel: 'sms', action: 'revoke', source: 'sms_keyword', tenantUserId: TENANT, sourceRef: { sendKey: 'js_unplaced' } },
    // A ledger row at a venue that isn't this tenant's.
    { id: 'cs_foreign', occurredAt: T - 2 * HOUR_MS, venueId: 'v_rival', channel: 'email', action: 'grant', source: 'splash', tenantUserId: OTHER_TENANT, sourceRef: { guestId: 'g_rival' } },
  ];
  const events = [
    ev('visit.started', { visitNumber: 2, guestId: 'g_rival' }, { venueId: 'v_rival', tenantUserId: OTHER_TENANT }),
    ev('message.sent', { mode: 'live', channel: 'sms', credits: 15 }, { venueId: 'v_rival', tenantUserId: OTHER_TENANT, sendKey: 'js_rival_1', instanceId: 'inst_rival', journeyKey: 'rival_secret_journey' }),
    ev('message.delivered', {}, { venueId: 'v_cafe', sendKey: 'js_rival_2', channel: 'sms' }),
    ev('consent.revoked', { source: 'brevo_unsubscribed', channel: 'email' }, { venueId: 'v_rival', tenantUserId: OTHER_TENANT, sendKey: 'js_rival_2', channel: 'email' }),
    ev('visit.started', { visitNumber: 1, isFirstVisit: true }),
  ];
  for (const lang of ['en', 'de'] as const) {
    const items = build({ events, consents, sends: foreignSends, lang, venues: { ...VENUES } });
    const json = JSON.stringify(items);
    for (const bad of ['v_rival', OTHER_TENANT, 'js_rival', 'js_unplaced', 'inst_rival', 'rival_secret_journey', 'g_rival', 'ev_in', 'Rival Bistro']) {
      assert(!json.includes(bad), `${bad} leaked (${lang}): ${json}`);
    }
    const sentences = items.map((i) => i.sentence);
    if (lang === 'en') {
      assertEqual(
        sentences,
        [
          // At the same instant a consent loss sorts after the visit (it came later).
          'Said no to messages by email (other places).',
          'Replied STOP to a message from another place: no more SMS.',
          'First visit: connected to the Wi-Fi.',
          'Replied STOP to a message from another place: no more SMS.',
          'Said yes to messages by email (other places).',
        ],
        'sentences (en)',
      );
    } else {
      assert(sentences.includes('Hat Nachrichten per E-Mail zugestimmt (an anderen Orten).'), `other places (de): ${sentences}`);
      assert(sentences.includes('Hat auf eine Nachricht eines anderen Orts mit STOP geantwortet: keine SMS mehr.'), `STOP elsewhere (de): ${sentences}`);
    }
    for (const i of items.filter((x) => /other places|anderen Orten/.test(x.sentence))) {
      assertEqual([i.venueId, i.venueName, i.journeyKey], [null, null, null], 'no venue or journey on an other-places item');
    }
  }
});

test('rating feedback, message bodies, addresses and provider error texts never show', () => {
  const events = [
    ev('rating.submitted', { stars: 1, hasFeedback: true, feedback: 'SOUP-WAS-COLD' }, J),
    ev('message.sent', { mode: 'live', channel: 'email', preview: 'BODY-TEXT-HERE', body: 'BODY-TEXT-HERE', subject: 'SUBJECT-HERE' }, { ...J, sendKey: 'js_mail', channel: 'email' }),
    ev('message.unknown', { mode: 'live', channel: 'sms', reason: 'adapter_threw: to +41 79 123 45 67 failed for anna.meier@example.com' }, { ...J, sendKey: 'js_mail', channel: 'sms' }),
    ev('message.failed', { errorCode: '30007', message: 'Carrier says anna.meier@example.com is filtered' }, { ...J, channel: 'sms' }),
  ];
  const sends = { js_mail: send('js_mail', { channel: 'email', toMasked: 'a•••@example.com', decision: decision({ channel: { picked: 'email', rule: 'auto', rejected: [] } }) }) };
  for (const audience of ['owner', 'admin'] as const) {
    for (const lang of ['en', 'de'] as const) {
      const json = JSON.stringify(build({ events, sends, audience, lang }));
      for (const bad of ['SOUP-WAS-COLD', 'hasFeedback', 'feedback', 'BODY-TEXT-HERE', 'SUBJECT-HERE', 'anna.meier@example.com', '+41 79 123 45 67', 'Carrier says']) {
        assert(!json.includes(bad), `${bad} leaked (${audience}, ${lang})`);
      }
      if (audience === 'owner') assert(!json.includes('adapter_threw') && !json.includes('30007') && !json.includes('a•••@example.com'), `owner sees no provider detail (${lang})`);
    }
  }
  const admin = build({ events, sends, audience: 'admin' });
  assert(JSON.stringify(admin).includes('adapter_threw: to [number] failed for [address]'), 'admin keeps the scrubbed provider reason');
});

test('owners get no detail; admins get ids, mode and the decision checks', () => {
  const d = decision({ result: 'skip', rule: 'weekly_limit', reason: 'weekly_limit', checks: [{ rule: 'weekly_limit', ok: false, fact: '3 of 3 in the last 7 days' }] });
  const events = [ev('send.skipped', { decision: d }, { ...J, nodeId: 'n_send', sendKey: 'js_skip' }), ev('visit.started', { visitNumber: 1, isFirstVisit: true, guestId: 'g_1' })];
  const consents: TimelineConsentInput[] = [{ id: 'cs_1', occurredAt: T, venueId: 'v_cafe', channel: 'sms', action: 'grant', source: 'splash', sourceRef: { guestId: 'g_1', eventId: 'ev_portal' } }];
  const owner = build({ events, consents });
  for (const i of owner) assert(!('detail' in i), `owner item ${i.kind} has no detail`);
  for (const bad of ['js_skip', 'inst_1', 'n_send', 'g_1', 'cs_1', 'ev_portal', '3 of 3']) assert(!JSON.stringify(owner).includes(bad), `owner JSON has no ${bad}`);
  const admin = build({ events, consents, audience: 'admin' });
  const skip = admin.find((i) => i.kind === 'send.skipped')!;
  assertEqual(skip.sentence, explainDecision(d, 'en', ZRH), 'same sentence for admins');
  const det = skip.detail as Record<string, any>;
  assertEqual([det.eventId, det.sendKey, det.instanceId, det.nodeId, det.mode], [events[0].id, 'js_skip', 'inst_1', 'n_send', 'live'], 'admin ids');
  assertEqual(det.decision.checks, [{ rule: 'weekly_limit', ok: false, fact: '3 of 3 in the last 7 days' }], 'admin checks');
  assert(!('decision' in det.data), 'the record is not repeated inside data');
  assertEqual((admin.find((i) => i.kind === 'consent.granted')!.detail as Record<string, any>).consentId, 'cs_1', 'admin consent id');
});

// ── Order ────────────────────────────────────────────────────────────────────

test('newest first; at the same instant, the later step comes first', () => {
  const events = [
    ev('visit.started', { visitNumber: 1, isFirstVisit: true }, { occurredAt: T - HOUR_MS }),
    ev('journey.entered', {}, { ...J, mode: 'test' }),
    ev('send.dry_run', { decision: decision({ mode: 'test' }) }, { ...J, mode: 'test' }),
    ev('offer.issued', { days: 14, label: 'Free coffee' }, { ...J, mode: 'test' }),
    ev('journey.exited', { status: 'completed', reason: 'exit:done' }, { ...J, mode: 'test', occurredAt: T + 48 * HOUR_MS }),
  ];
  const consents: TimelineConsentInput[] = [{ id: 'cs_g', occurredAt: T - HOUR_MS, venueId: 'v_cafe', channel: 'sms', action: 'grant', source: 'splash' }];
  const items = build({ events: [...events].reverse(), consents });
  assertEqual(items.map((i) => i.kind), ['journey.exited', 'send.dry_run', 'offer.issued', 'journey.entered', 'visit.started', 'consent.granted'], 'order');
  for (let i = 1; i < items.length; i += 1) assert(items[i - 1].at >= items[i].at, 'times never go up');
  assertEqual(items[0].at, new Date(T + 48 * HOUR_MS).toISOString(), 'ISO time');
});

// ── Offer names in German (PR E follow-up) ───────────────────────────────────

const COFFEE = { en: 'Free coffee', de: 'Gratis-Kaffee' };

test('offerLabelText: German from the menu when it has German; else the stored label; English keeps the stored label', () => {
  assertEqual(offerLabelText('de', 'Free coffee', COFFEE), 'Gratis-Kaffee', 'DE: the menu’s German');
  assertEqual(offerLabelText('de', 'Free coffee', { en: 'Free coffee' }), 'Free coffee', 'DE, no German in the menu: the stored label');
  assertEqual(offerLabelText('de', 'Free coffee', { en: 'Free coffee', de: '  ' }), 'Free coffee', 'DE, blank German: the stored label');
  assertEqual(offerLabelText('de', 'Free coffee', null), 'Free coffee', 'DE, no menu entry: the stored label');
  assertEqual(offerLabelText('en', 'Free coffee', { en: 'Coffee on us', de: 'Gratis-Kaffee' }), 'Free coffee', 'EN: the label as it was issued');
  assertEqual(offerLabelText('en', null, COFFEE), 'Free coffee', 'EN, nothing stored: the menu’s English');
  assertEqual(offerLabelText('de', null, { en: 'Free coffee' }), 'Free coffee', 'DE, nothing stored, no German: the menu’s English');
  assertEqual(offerLabelText('en', null, null), null, 'nothing at all');
});

test('offerLabelsFrom: per venue and offerKey; the active setup wins over others with the same offerKey; bad entries skipped', () => {
  const setups: OfferMenuSetup[] = [
    { venueId: 'v_cafe', playbookKey: 'b_local', state: 'setup', offerMenu: [{ offerKey: 'coffee', label: { en: 'Coffee (b)', de: 'Kaffee (b)' } }] },
    { venueId: 'v_cafe', playbookKey: 'a_stay', state: 'inactive', offerMenu: [{ offerKey: 'coffee', label: { en: 'Coffee (a)', de: 'Kaffee (a)' } }, { offerKey: 'cake', label: { en: 'Cake' } }] },
    { venueId: 'v_cafe', playbookKey: 'z_growth', state: 'active', offerMenu: [{ offerKey: 'coffee', label: COFFEE }, { offerKey: 'bad', label: 'not i18n' }, { label: { en: 'no key' } }] },
    { venueId: 'v_ny', playbookKey: 'z_growth', state: 'setup', offerMenu: [{ offerKey: 'coffee', label: { en: 'NY coffee', de: 'NY-Kaffee' } }] },
    { venueId: 'v_ny', playbookKey: 'guest_info', state: 'active', offerMenu: [] },
  ];
  const labels = offerLabelsFrom(setups);
  assertEqual(labels.v_cafe.coffee, COFFEE, 'the active setup’s label, although it comes last');
  assertEqual(labels.v_cafe.cake, { en: 'Cake' }, 'an offer only another setup has');
  assert(!('bad' in labels.v_cafe), 'a label that is not a translation is skipped');
  assertEqual(Object.keys(labels.v_cafe).sort(), ['cake', 'coffee'], 'nothing without an offerKey');
  assertEqual(labels.v_ny.coffee, { en: 'NY coffee', de: 'NY-Kaffee' }, 'per venue');
  const noActive = offerLabelsFrom(setups.filter((x) => x.state !== 'active'));
  assertEqual(noActive.v_cafe.coffee, { en: 'Coffee (a)', de: 'Kaffee (a)' }, 'no active setup: the others in playbookKey order');
  assertEqual(offerLabelsFrom([]), {}, 'no setups');
});

test('offer.issued: German label in the German timeline; English unchanged; another venue’s menu or no offerKey → the stored label', () => {
  const issued = ev('offer.issued', { offerKey: 'coffee', days: 14, label: 'Free coffee' }, J);
  const offerLabels = offerLabelsFrom([{ venueId: 'v_cafe', playbookKey: 'restaurant_growth', state: 'active', offerMenu: [{ offerKey: 'coffee', label: COFFEE }] }]);
  const de = build({ events: [issued], lang: 'de', offerLabels });
  assertEqual(de[0].sentence, 'Angebot erhalten: „Gratis-Kaffee“, 14 Tage gültig.', 'DE');
  const en = build({ events: [issued], lang: 'en', offerLabels });
  assertEqual(en[0].sentence, 'Got an offer: “Free coffee”, valid for 14 days.', 'EN');
  const elsewhere = offerLabelsFrom([{ venueId: 'v_ny', state: 'active', offerMenu: [{ offerKey: 'coffee', label: COFFEE }] }]);
  assertEqual(build({ events: [issued], lang: 'de', offerLabels: elsewhere })[0].sentence, 'Angebot erhalten: „Free coffee“, 14 Tage gültig.', 'the menu of another venue is not used');
  const noKey = ev('offer.issued', { days: 14, label: 'Free coffee' }, J);
  assertEqual(build({ events: [noKey], lang: 'de', offerLabels })[0].sentence, 'Angebot erhalten: „Free coffee“, 14 Tage gültig.', 'no offerKey');
  assertEqual(build({ events: [issued], lang: 'de' })[0].sentence, 'Angebot erhalten: „Free coffee“, 14 Tage gültig.', 'no offerLabels: as before');
  const dry = build({ events: [ev('offer.issued', { offerKey: 'coffee', days: 14, label: 'Free coffee' }, { ...J, mode: 'test' })], lang: 'de', offerLabels });
  assert(dry[0].sentence.includes('„Gratis-Kaffee“'), `a test run too: ${dry[0].sentence}`);
  const admin = build({ events: [issued], lang: 'de', offerLabels, audience: 'admin' });
  assertEqual(admin[0].sentence, 'Angebot erhalten: „Gratis-Kaffee“, 14 Tage gültig.', 'the admin view');
  assertEqual((admin[0].detail?.data as Record<string, unknown>).label, 'Free coffee', 'the admin detail keeps what was stored');
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('the module is pure: its only runtime imports are the decision sentences and time helpers', () => {
  const src = readFileSync(join(__dirname, '../src/adaptive/core/owner/timeline.ts'), 'utf8');
  const runtime = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assertEqual(runtime.sort(), ['../runtime/decision', '../runtime/time'], 'runtime imports');
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
