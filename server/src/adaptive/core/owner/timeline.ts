/**
 * A guest's history in plain sentences (PR D; plan §5/§6, PRD RE-4, spec R71): the owner's
 * guest drawer, the MCP tool `explain_adaptive_guest`, and — with `audience: 'admin'` — the
 * admin guest view, which gets the same sentences plus a `detail` object per item.
 *
 * Pure: no Firestore. The caller reads the events, the sends they name, the consent ledger
 * and this tenant's venues, and passes them in.
 *
 * Rules kept here:
 *  - One sentence per item, English or German (anything else falls back to English). Times
 *    inside a sentence are in the item's venue time zone.
 *  - A step that carries a decision record is worded by `explainDecision` from that stored
 *    record, never recalculated. A test-run step says so ("Test run: …").
 *  - A live `message.sent` is worded from the send's status first: a send that failed,
 *    bounced, was cancelled or isn't confirmed never says "sent".
 *  - Owners never see addresses, message bodies, rating feedback, provider error texts or
 *    ids. Anything at a venue that isn't one of this tenant's (`venues`) says "other places"
 *    with no name or id (consent changes), or is left out (everything else). A consent
 *    change triggered through another tenant's message says so without naming it.
 *  - `detail` is filled for admins only (ids, mode, decision checks — still no bodies or
 *    feedback, and free text is scrubbed of addresses and phone numbers).
 *  - An issued offer is named in German from the venue's offer menu when it has a German label
 *    (`offerLabels`, PR E follow-up): the event itself stores only the English label.
 */

import { creditsWord, explainDecision, type DecisionRecord } from '../runtime/decision';
import { isValidTimeZone } from '../runtime/time';
import type { I18n } from '../schemas';

export type TimelineLang = 'en' | 'de';

export interface TimelineEventInput {
  id: string;
  type: string;
  occurredAt: number;
  venueId: string | null;
  tenantUserId?: string | null;
  contactId?: string | null;
  instanceId?: string | null;
  journeyKey?: string | null;
  nodeId?: string | null;
  sendKey?: string | null;
  channel?: string | null;
  mode?: 'test' | 'live' | null;
  source?: string | null;
  data: Record<string, unknown>;
}

export interface TimelineSendInput {
  sendKey: string;
  status: string;
  channel: string | null;
  purpose?: string | null;
  mode?: 'test' | 'live' | null;
  /** The credits priced for this send (`JourneySends.credits.amount`). */
  credits?: number | null;
  toMasked?: string | null;
  tenantUserId?: string | null;
  venueId?: string | null;
  /** The stored "why" record (`JourneySends.decision`). */
  decision?: DecisionRecord | null;
  /** `reply_notice` for the automatic answer to a plain SMS reply. */
  kind?: string | null;
}

export interface TimelineConsentInput {
  id: string;
  occurredAt: number;
  venueId: string;
  channel: string;
  action: 'grant' | 'revoke';
  source: string;
  tenantUserId?: string | null;
  /**
   * The ledger's `sourceRef`. Read only to tell whether the change came through another
   * tenant's message (`sendKey` not among this tenant's `sends` → "another place") and to
   * drop the `consent.*` event it duplicates (`eventId`). Never shown to owners.
   */
  sourceRef?: Record<string, unknown> | null;
}

export interface TimelineVenue {
  name: string;
  tz: string;
}

export interface TimelineItem {
  /** ISO time the thing happened. */
  at: string;
  /** The event type, or `consent.granted` / `consent.revoked` for the consent ledger. */
  kind: string;
  venueId: string | null;
  venueName: string | null;
  journeyKey: string | null;
  sentence: string;
  /** 'test' for a test-run step, 'live' for a real one, null when it doesn't apply. */
  mode: 'test' | 'live' | null;
  channel: string | null;
  /** Credits this item spent (live sends only; 0 = free). */
  credits: number | null;
  /** Admins only. */
  detail?: Record<string, unknown>;
}

export interface BuildTimelineArgs {
  tenantUserId: string;
  events: TimelineEventInput[];
  /** By sendKey: the sends the events name (and those a consent `sourceRef` names). */
  sends: Record<string, TimelineSendInput>;
  consents: TimelineConsentInput[];
  /** ONLY this tenant's venues. */
  venues: Record<string, TimelineVenue>;
  /** Journey display names, already in the right language. */
  journeyNames: Record<string, string>;
  lang: TimelineLang;
  audience: 'owner' | 'admin';
  defaultTz?: string;
  /**
   * By venueId, then offerKey: the offer's label in the languages the owner wrote (see
   * `offerLabelsFrom`). Only this tenant's venues. Left out → the label the event stored.
   */
  offerLabels?: OfferLabels;
}

/** Offer labels by venueId, then offerKey. */
export type OfferLabels = Record<string, Record<string, I18n>>;

/** What `offerLabelsFrom` reads of a venue setup (`CaptivePortal_VenuePlaybooks`). */
export interface OfferMenuSetup {
  venueId: string;
  playbookKey?: string | null;
  state?: string | null;
  offerMenu?: ReadonlyArray<{ offerKey?: unknown; label?: unknown }> | null;
}

function asI18n(v: unknown): I18n | null {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as I18n).en === 'string' ? (v as I18n) : null;
}

/**
 * The offer labels of a tenant's venue setups. A venue can hold several setups that share an
 * offerKey (every seeded playbook has `dessert`, `coffee`, …): the venue's active setup wins,
 * then the others in playbookKey order.
 */
export function offerLabelsFrom(setups: ReadonlyArray<OfferMenuSetup>): OfferLabels {
  const rank = (s: OfferMenuSetup) => (s.state === 'active' ? 0 : 1);
  const ordered = [...setups].sort((a, b) => rank(a) - rank(b) || String(a.playbookKey ?? '').localeCompare(String(b.playbookKey ?? '')));
  const out: OfferLabels = {};
  for (const s of ordered) {
    if (typeof s?.venueId !== 'string' || !s.venueId) continue;
    for (const o of s.offerMenu ?? []) {
      const label = asI18n(o?.label);
      if (typeof o?.offerKey !== 'string' || !o.offerKey || !label) continue;
      const byKey = (out[s.venueId] ??= {});
      if (!Object.prototype.hasOwnProperty.call(byKey, o.offerKey)) byKey[o.offerKey] = label;
    }
  }
  return out;
}

function menuLabel(labels: OfferLabels, venueId: string | null, offerKey: string | null): I18n | null {
  const has = (o: object, k: string | null): k is string => k !== null && Object.prototype.hasOwnProperty.call(o, k);
  if (!has(labels, venueId)) return null;
  const byKey = labels[venueId];
  return has(byKey, offerKey) ? asI18n(byKey[offerKey]) : null;
}

/**
 * An issued offer's name: in German the menu's German label when there is one; otherwise the
 * label the event stored (English, as it was when issued), then the menu's English label.
 */
export function offerLabelText(l: TimelineLang, stored: string | null, menu: I18n | null | undefined): string | null {
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return (l === 'de' ? clean(menu?.de) : null) ?? clean(stored) ?? clean(menu?.en);
}

/** Every event type with its own sentence (anything else is "Something else happened"). */
export const TIMELINE_EVENT_TYPES = [
  'wifi.connected',
  'visit.started',
  'visit.ended',
  'journey.entered',
  'journey.exited',
  'journey.converted',
  'journey.config_updated',
  'journey.not_started',
  'journey.resumed',
  'offer.issued',
  'offer.redeemed',
  'send.dry_run',
  'message.sent',
  'send.deferred',
  'send.skipped',
  'send.blocked',
  'send.retry',
  'message.delivered',
  'message.opened',
  'message.read',
  'message.clicked',
  'message.bounced',
  'message.failed',
  'message.unknown',
  'message.replied',
  'rating.submitted',
  'consent.granted',
  'consent.revoked',
  'stay.created',
  'stay.changed',
  'stay.cancelled',
  'stay.linked',
  'stay.unlinked',
  'stay.relinked',
  'stay.overlap_flagged',
  'stay.moment',
  'stay.moment_skipped',
  'moment.passed',
] as const;

type L = TimelineLang;

const FALLBACK_TZ = 'Europe/Zurich';

// ── Small readers (event data is whatever the engine stored) ─────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function t(l: L, en: string, de: string): string {
  return l === 'de' ? de : en;
}

// ── Words ────────────────────────────────────────────────────────────────────

/** As in decision.ts, so "Sent by SMS" reads the same everywhere. */
const CHANNEL_WORDS: Record<string, Record<L, string>> = {
  sms: { en: 'SMS', de: 'SMS' },
  email: { en: 'email', de: 'E-Mail' },
  whatsapp: { en: 'WhatsApp', de: 'WhatsApp' },
};

/** "the SMS" / "die SMS": every German noun here is feminine. */
const MESSAGE_NOUNS: Record<string, Record<L, string>> = {
  sms: { en: 'SMS', de: 'SMS' },
  email: { en: 'email', de: 'E-Mail' },
  whatsapp: { en: 'WhatsApp message', de: 'WhatsApp-Nachricht' },
};

function channelWord(l: L, channel: string | null): string {
  if (!channel) return t(l, 'message', 'Nachricht');
  return CHANNEL_WORDS[channel]?.[l] ?? t(l, 'message', 'Nachricht');
}

function messageNoun(l: L, channel: string | null): string {
  return (channel && MESSAGE_NOUNS[channel]?.[l]) || t(l, 'message', 'Nachricht');
}

function quoted(l: L, s: string): string {
  return l === 'de' ? `„${s}“` : `“${s}”`;
}

function plural(l: L, n: number, en: [string, string], de: [string, string]): string {
  const [one, many] = l === 'de' ? de : en;
  return `${n} ${n === 1 ? one : many}`;
}

/** The same format as the decision sentences ("Fri 2 Oct, 09:00"). */
function timeText(ms: number, tz: string, l: L): string {
  return new Intl.DateTimeFormat(l === 'de' ? 'de-CH' : 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** A stay's local date (`YYYY-MM-DD`, already local to the venue) as "Fri 2 Oct". */
function dateText(v: unknown, l: L): string | null {
  const s = str(v);
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(l === 'de' ? 'de-CH' : 'en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

function dateRange(l: L, from: unknown, to: unknown): string | null {
  const a = dateText(from, l);
  const b = dateText(to, l);
  if (!a || !b) return null;
  return t(l, `${a} to ${b}`, `${a} bis ${b}`);
}

/** Ends a sentence once, also after a German date like "5. Okt.". */
function stop(s: string): string {
  return s.endsWith('.') ? s : `${s}.`;
}

function testRun(l: L, sentence: string): string {
  if (/^(Test run|Testlauf)\b/.test(sentence)) return sentence;
  // English continues in lower case after the colon ("Test run: held back…"), but not an acronym ("SMS").
  const rest = l !== 'de' && /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
  return `${t(l, 'Test run: ', 'Testlauf: ')}${rest}`;
}

// ── The decision record ──────────────────────────────────────────────────────

/** The stored record, or null when it isn't one explainDecision can read. */
function asDecision(v: unknown): DecisionRecord | null {
  const d = rec(v) as Partial<DecisionRecord>;
  if (typeof d.result !== 'string' || !Array.isArray(d.checks) || !d.channel || typeof d.channel !== 'object') return null;
  return d as DecisionRecord;
}

function explain(d: DecisionRecord, l: L, tz: string): string | null {
  if (d.result === 'allow' && !d.channel?.picked) return null; // "sent by null" helps nobody
  try {
    return explainDecision(d, l, tz);
  } catch {
    return null;
  }
}

// ── Sentences per event type ─────────────────────────────────────────────────

interface Ctx {
  l: L;
  tz: string;
  admin: boolean;
  journey: (key: string | null) => string;
  send: TimelineSendInput | null;
  offerLabels: OfferLabels;
}

const EXIT_ON_WORDS: Record<string, Record<L, string>> = {
  'rating.submitted': { en: 'the guest gave a rating', de: 'der Gast hat bewertet' },
  'visit.started': { en: 'the guest came back', de: 'der Gast kam wieder' },
  'message.clicked': { en: 'the guest clicked a link', de: 'der Gast hat auf einen Link geklickt' },
  'message.replied': { en: 'the guest replied', de: 'der Gast hat geantwortet' },
  'offer.redeemed': { en: 'the offer was used', de: 'das Angebot wurde eingelöst' },
  'stay.changed': { en: 'the booking changed', de: 'die Buchung hat sich geändert' },
};

const GOAL_WORDS: Record<string, Record<L, string>> = {
  'visit.started': { en: 'the guest came back', de: 'der Gast kam wieder' },
  'offer.redeemed': { en: 'the offer was used', de: 'das Angebot wurde eingelöst' },
  'message.clicked': { en: 'the guest clicked', de: 'der Gast hat geklickt' },
  'rating.submitted': { en: 'the guest gave a rating', de: 'der Gast hat bewertet' },
  'booking.direct': { en: 'the guest booked directly', de: 'der Gast hat direkt gebucht' },
};

function journeyExited(c: Ctx, j: string, data: Record<string, unknown>): string {
  const { l } = c;
  const status = str(data.status) ?? '';
  const reason = str(data.reason) ?? '';
  if (reason === 'stay_cancelled') return t(l, `Journey ${j} ended: the booking was cancelled.`, `Journey ${j} beendet: die Buchung wurde storniert.`);
  if (reason === 'stay_unlinked') return t(l, `Journey ${j} ended: the booking was unlinked from this guest.`, `Journey ${j} beendet: die Buchung wurde von diesem Gast getrennt.`);
  if (reason === 'switched_off') return t(l, `Journey ${j} ended: it or the venue was switched off.`, `Journey ${j} beendet: sie oder der Standort wurde ausgeschaltet.`);
  if (reason === 'goal' || status === 'converted') return t(l, `Journey ${j} finished: goal reached.`, `Journey ${j} abgeschlossen: Ziel erreicht.`);
  if (reason.startsWith('exit_on:')) {
    const why = EXIT_ON_WORDS[reason.slice('exit_on:'.length)]?.[l] ?? t(l, 'something the guest did ended it', 'etwas, das der Gast getan hat, hat sie beendet');
    return t(l, `Journey ${j} ended early: ${why}.`, `Journey ${j} vorzeitig beendet: ${why}.`);
  }
  switch (status) {
    case 'failed':
      return t(l, `Journey ${j} stopped because of a problem in its setup.`, `Journey ${j} wegen eines Problems in der Einrichtung gestoppt.`);
    case 'expired':
      return t(l, `Journey ${j} expired.`, `Journey ${j} abgelaufen.`);
    case 'exhausted':
      return t(l, `Journey ${j} finished: nothing more to send.`, `Journey ${j} abgeschlossen: nichts mehr zu senden.`);
    case 'completed':
      return t(l, `Journey ${j} finished.`, `Journey ${j} abgeschlossen.`);
    case 'cancelled':
      return t(l, `Journey ${j} was cancelled.`, `Journey ${j} abgebrochen.`);
    case 'suppressed':
      return t(l, `Journey ${j} stopped.`, `Journey ${j} gestoppt.`);
    default:
      return t(l, `Journey ${j} ended.`, `Journey ${j} beendet.`);
  }
}

/** Status first: a send that didn't (or may not have) reach the guest never says "sent". */
function notArrived(c: Ctx, status: string, channel: string | null): string | null {
  const { l } = c;
  const noun = messageNoun(l, channel);
  switch (status) {
    case 'failed':
      return t(l, `The ${noun} did not arrive.`, `Die ${noun} kam nicht an.`);
    case 'bounced':
      return t(l, `The ${noun} did not arrive: it bounced.`, `Die ${noun} kam nicht an: sie kam zurück.`);
    case 'cancelled':
      return t(l, `The ${noun} was cancelled before it went out.`, `Die ${noun} wurde abgebrochen, bevor sie rausging.`);
    case 'unknown':
    case 'dispatching':
      return t(l, `Not confirmed yet whether the ${noun} went out.`, `Noch nicht bestätigt, ob die ${noun} rausging.`);
    default:
      return null;
  }
}

function messageSent(c: Ctx, data: Record<string, unknown>, channel: string | null): { sentence: string; credits: number | null } {
  const { l } = c;
  const s = c.send;
  const replyNotice = s?.kind === 'reply_notice' || data.kind === 'reply_notice';
  const prefix = replyNotice ? t(l, "Automatic answer to the guest's text: ", 'Automatische Antwort auf eine SMS des Gastes: ') : '';
  const failed = s ? notArrived(c, s.status, channel) : null;
  if (failed) return { sentence: `${prefix}${failed}`, credits: null };
  const purpose = s?.purpose ?? str(data.purpose);
  const credits = purpose === 'service' ? 0 : num(s?.credits) ?? num(data.credits) ?? 0;
  // The stored record words it — when it is the record of this send going out.
  const decision = asDecision(s?.decision);
  const fromRecord = decision && decision.result === 'allow' ? explain(decision, l, c.tz) : null;
  if (fromRecord) return { sentence: `${prefix}${fromRecord}`, credits };
  const ch = channelWord(l, channel);
  const plain = t(l, `Sent by ${ch}${credits ? ` (${creditsWord(credits, 'en')})` : ' (free)'}.`, `Per ${ch} gesendet${credits ? ` (${creditsWord(credits, 'de')})` : ' (gratis)'}.`);
  return { sentence: `${prefix}${plain}`, credits };
}

/** A skip/block/deferral without a decision record (e.g. the guest was erased). */
function stepWithoutRecord(c: Ctx, type: string, data: Record<string, unknown>): string {
  const { l } = c;
  if (type === 'send.dry_run') return t(l, 'Test run: a message would have been sent — nothing was sent.', 'Testlauf: eine Nachricht wäre gesendet worden — nichts wurde gesendet.');
  if (type === 'send.deferred') {
    const until = num(data.until);
    return until !== null ? t(l, `Held back until ${timeText(until, c.tz, l)}.`, `Zurückgehalten bis ${timeText(until, c.tz, l)}.`) : t(l, 'Held back for now.', 'Vorerst zurückgehalten.');
  }
  const reason = str(data.reason);
  if (reason === 'contact_gone') return t(l, "Not sent because the guest's details were removed.", 'Nicht gesendet, weil die Daten des Gastes entfernt wurden.');
  if (reason === 'bad_step_config') return t(l, "Not sent because of a problem in the journey's setup.", 'Nicht gesendet wegen eines Problems in der Einrichtung der Journey.');
  return t(l, 'Not sent because a sending rule stopped it.', 'Nicht gesendet, weil eine Versandregel es verhindert hat.');
}

function consentEventSentence(c: Ctx, type: string, data: Record<string, unknown>, channel: string | null): string {
  const { l } = c;
  const source = str(data.source) ?? '';
  const granted = type === 'consent.granted';
  if (source === 'sms_keyword') return granted ? startSentence(l) : stopSentence(l, false);
  if (!granted && source === 'brevo_spam') return spamSentence(l);
  if (!granted && (source === 'brevo_unsubscribed' || source === 'unsubscribe_page')) return unsubscribeSentence(l);
  const ch = channelWord(l, channel);
  return granted ? t(l, `Said yes to messages by ${ch}.`, `Hat Nachrichten per ${ch} zugestimmt.`) : t(l, `Said no to messages by ${ch}.`, `Hat Nachrichten per ${ch} abgelehnt.`);
}

function stopSentence(l: L, viaOtherPlace: boolean): string {
  return viaOtherPlace
    ? t(l, 'Replied STOP to a message from another place: no more SMS.', 'Hat auf eine Nachricht eines anderen Orts mit STOP geantwortet: keine SMS mehr.')
    : t(l, 'Replied STOP: no more SMS.', 'Hat mit STOP geantwortet: keine SMS mehr.');
}

function startSentence(l: L): string {
  return t(l, 'Texted START: SMS are allowed again.', 'Hat START geschickt: SMS sind wieder erlaubt.');
}

function spamSentence(l: L): string {
  return t(l, 'Marked an email as spam: no more emails.', 'Hat eine E-Mail als Spam markiert: keine E-Mails mehr.');
}

function unsubscribeSentence(l: L): string {
  return t(l, 'Unsubscribed from emails.', 'Hat sich von E-Mails abgemeldet.');
}

function eventSentence(c: Ctx, ev: TimelineEventInput, journeyKey: string | null, channel: string | null): { sentence: string; credits: number | null } {
  const { l } = c;
  const data = ev.data ?? {};
  const j = c.journey(journeyKey);
  const one = (sentence: string) => ({ sentence, credits: null });

  switch (ev.type) {
    case 'wifi.connected':
      return one(t(l, 'Connected to the Wi-Fi.', 'Mit dem WLAN verbunden.'));

    case 'visit.started': {
      const n = num(data.visitNumber);
      if (data.isFirstVisit === true || n === 1) return one(t(l, 'First visit: connected to the Wi-Fi.', 'Erster Besuch: mit dem WLAN verbunden.'));
      if (n !== null && n > 1) return one(t(l, `Came back (visit ${n}).`, `Wieder da (Besuch ${n}).`));
      return one(t(l, 'Connected to the Wi-Fi.', 'Mit dem WLAN verbunden.'));
    }

    case 'visit.ended':
      return one(t(l, 'The visit ended.', 'Der Besuch ist zu Ende.'));

    case 'journey.entered':
      return one(t(l, `Journey ${j} started.`, `Journey ${j} gestartet.`));

    case 'journey.exited':
      return one(journeyExited(c, j, data));

    case 'journey.converted': {
      const goal = str(data.goalEvent);
      const why = goal ? GOAL_WORDS[goal]?.[l] : undefined;
      return one(t(l, `Journey ${j} reached its goal${why ? ` (${why})` : ''}.`, `Journey ${j} hat ihr Ziel erreicht${why ? ` (${why})` : ''}.`));
    }

    case 'journey.config_updated':
      return one(t(l, `Journey ${j} now uses your latest changes.`, `Journey ${j} nutzt jetzt deine neuesten Änderungen.`));

    case 'journey.resumed':
      return one(t(l, `Journey ${j} runs on: you linked this guest to the booking again.`, `Journey ${j} läuft weiter: du hast diesen Gast wieder mit der Buchung verbunden.`));

    case 'journey.not_started': {
      const reason = str(data.reason);
      const why =
        reason === 'signup_breaker'
          ? t(l, 'unusually many new guests signed up at this access point within the hour', 'an diesem Access Point haben sich in dieser Stunde ungewöhnlich viele neue Gäste angemeldet')
          : reason === 'late_connect'
            ? t(l, 'this visit was processed too late to still send anything', 'dieser Besuch wurde zu spät verarbeitet, um noch etwas zu senden')
            : null;
      const head = journeyKey ? t(l, `Journey ${j} didn't start`, `Journey ${j} nicht gestartet`) : t(l, 'No journey started', 'Keine Journey gestartet');
      return one(why ? `${head}: ${why}.` : `${head}.`);
    }

    case 'offer.issued': {
      const menu = menuLabel(c.offerLabels, ev.venueId ?? c.send?.venueId ?? null, str(data.offerKey));
      const label = offerLabelText(l, str(data.label), menu);
      const days = num(data.days);
      const valid = days !== null ? t(l, `valid for ${plural(l, days, ['day', 'days'], ['Tag', 'Tage'])}`, `${plural(l, days, ['day', 'days'], ['Tag', 'Tage'])} gültig`) : null;
      const parts = [label ? quoted(l, label) : null, valid].filter(Boolean).join(', ');
      return one(t(l, parts ? `Got an offer: ${parts}.` : 'Got an offer.', parts ? `Angebot erhalten: ${parts}.` : 'Angebot erhalten.'));
    }

    case 'offer.redeemed':
      return one(
        data.redeemedVia === 'revisit_auto'
          ? t(l, 'Came back while the offer was valid: counted as used.', 'Kam wieder, solange das Angebot galt: zählt als eingelöst.')
          : t(l, 'Used the offer.', 'Angebot eingelöst.'),
      );

    case 'send.dry_run':
    case 'send.deferred':
    case 'send.skipped':
    case 'send.blocked': {
      const decision = asDecision(data.decision) ?? asDecision(c.send?.decision);
      const fromRecord = decision ? explain(decision, l, c.tz) : null;
      return one(fromRecord ?? stepWithoutRecord(c, ev.type, data));
    }

    case 'message.sent':
      return messageSent(c, data, channel);

    case 'send.retry': {
      const attempt = num(data.attempt);
      const ch = channelWord(l, channel);
      return one(
        t(
          l,
          `Sending by ${ch} will be tried again later${attempt !== null ? ` (attempt ${attempt})` : ''}.`,
          `Versand per ${ch} wird später nochmals versucht${attempt !== null ? ` (Versuch ${attempt})` : ''}.`,
        ),
      );
    }

    case 'message.delivered':
      return one(t(l, `The ${messageNoun(l, channel)} was delivered.`, `Die ${messageNoun(l, channel)} wurde zugestellt.`));

    case 'message.opened':
      return one(t(l, `Opened the ${messageNoun(l, channel)}.`, `Hat die ${messageNoun(l, channel)} geöffnet.`));

    case 'message.read':
      return one(t(l, `Read the ${messageNoun(l, channel)}.`, `Hat die ${messageNoun(l, channel)} gelesen.`));

    case 'message.clicked':
      return one(t(l, `Clicked the link in the ${messageNoun(l, channel)}.`, `Hat auf den Link in der ${messageNoun(l, channel)} geklickt.`));

    case 'message.bounced': {
      const noun = messageNoun(l, channel);
      return one(
        data.invalid === true
          ? t(l, `The ${noun} bounced: the address is invalid.`, `Die ${noun} kam zurück: die Adresse ist ungültig.`)
          : t(l, `The ${noun} bounced: the address can't receive it.`, `Die ${noun} kam zurück: die Adresse kann sie nicht empfangen.`),
      );
    }

    case 'message.failed': {
      const noun = messageNoun(l, channel);
      if (data.errorCode === '21610') return one(t(l, `The ${noun} did not arrive: this number has said STOP to texts.`, `Die ${noun} kam nicht an: diese Nummer hat SMS mit STOP abbestellt.`));
      if (data.blocked === true) return one(t(l, `The ${noun} did not arrive: the email service blocked it.`, `Die ${noun} kam nicht an: der E-Mail-Dienst hat sie blockiert.`));
      return one(t(l, `The ${noun} did not arrive.`, `Die ${noun} kam nicht an.`));
    }

    case 'message.unknown':
      return one(t(l, `Not confirmed yet whether the ${messageNoun(l, channel)} went out.`, `Noch nicht bestätigt, ob die ${messageNoun(l, channel)} rausging.`));

    case 'message.replied':
      return one(t(l, `Replied to the ${messageNoun(l, channel)}.`, `Hat auf die ${messageNoun(l, channel)} geantwortet.`));

    case 'rating.submitted': {
      // Stars only: never the feedback, never whether there was any.
      const stars = num(data.stars);
      if (stars === null || stars < 1 || stars > 5) return one(t(l, 'Gave a rating.', 'Hat eine Bewertung abgegeben.'));
      const low = stars <= 2 ? t(l, ' No more marketing messages from here.', ' Keine Werbenachrichten mehr von hier.') : '';
      return one(t(l, `Rated ${stars} of 5 stars.${low}`, `Mit ${stars} von 5 Sternen bewertet.${low}`));
    }

    case 'consent.granted':
    case 'consent.revoked':
      return one(consentEventSentence(c, ev.type, data, channel));

    case 'stay.created': {
      const range = dateRange(l, data.checkIn, data.checkOut);
      const nights = num(data.nights);
      const n = nights !== null ? ` (${plural(l, nights, ['night', 'nights'], ['Nacht', 'Nächte'])})` : '';
      return one(range ? stop(t(l, `New booking: ${range}${n}`, `Neue Buchung: ${range}${n}`)) : t(l, 'New booking.', 'Neue Buchung.'));
    }

    case 'stay.changed': {
      const from = rec(data.from);
      const to = rec(data.to);
      const now = dateRange(l, to.checkIn, to.checkOut);
      const was = dateRange(l, from.checkIn, from.checkOut);
      if (data.reinstated === true) return one(now ? stop(t(l, `Booking back in the calendar: ${now}`, `Buchung wieder im Kalender: ${now}`)) : t(l, 'Booking back in the calendar.', 'Buchung wieder im Kalender.'));
      if (now && was) return one(t(l, `Booking moved to ${now} (was ${was}).`, `Buchung verschoben auf ${now} (vorher ${was}).`));
      return one(now ? stop(t(l, `Booking changed: now ${now}`, `Buchung geändert: jetzt ${now}`)) : t(l, 'Booking changed.', 'Buchung geändert.'));
    }

    case 'stay.cancelled': {
      const range = dateRange(l, data.checkIn, data.checkOut);
      const head = range ? t(l, `Booking ${range} cancelled`, `Buchung ${range} storniert`) : t(l, 'Booking cancelled', 'Buchung storniert');
      const reason = str(data.reason);
      if (reason === 'missing') return one(`${head}${t(l, ': it is no longer in the calendar.', ': sie ist nicht mehr im Kalender.')}`);
      if (reason === 'feed_deleted') return one(`${head}${t(l, ': the calendar link was removed.', ': der Kalender-Link wurde entfernt.')}`);
      return one(stop(head));
    }

    case 'stay.linked': {
      const range = dateRange(l, data.checkIn, data.checkOut);
      const booking = range ? t(l, `the booking ${range}`, `der Buchung ${range}`) : t(l, 'a booking', 'einer Buchung');
      const byOwner = data.linkedBy === 'owner';
      return one(byOwner ? t(l, `Linked by you to ${booking}.`, `Von dir mit ${booking} verknüpft.`) : t(l, `Linked to ${booking}.`, `Mit ${booking} verknüpft.`));
    }

    case 'stay.unlinked':
      return one(t(l, 'You unlinked this guest from the booking.', 'Du hast diesen Gast von der Buchung getrennt.'));

    case 'stay.relinked':
      return one(t(l, 'You linked this guest back to the booking: their stay messages run on from where they stopped.', 'Du hast diesen Gast wieder mit der Buchung verbunden: seine Aufenthalts-Nachrichten laufen dort weiter, wo sie aufgehört haben.'));

    case 'stay.overlap_flagged': {
      const range = dateRange(l, data.checkIn, data.checkOut);
      const head = range ? t(l, `Booking ${range}`, `Buchung ${range}`) : t(l, 'This booking', 'Diese Buchung');
      return one(t(l, `${head} overlaps another booking: guests aren't linked to it automatically.`, `${head} überschneidet sich mit einer anderen: Gäste werden nicht automatisch verknüpft.`));
    }

    case 'stay.moment': {
      const at = num(data.momentAt);
      return one(at !== null ? t(l, `Time for journey ${j} (${timeText(at, c.tz, l)}).`, `Zeit für Journey ${j} (${timeText(at, c.tz, l)}).`) : t(l, `Time for journey ${j}.`, `Zeit für Journey ${j}.`));
    }

    case 'stay.moment_skipped': {
      const reason = str(data.reason);
      const why =
        reason === 'too_late'
          ? t(l, 'it was too late', 'es war zu spät')
          : reason === 'switched_off'
            ? t(l, 'it was switched off', 'sie war ausgeschaltet')
            : null;
      return one(why ? t(l, `Journey ${j} skipped for this booking: ${why}.`, `Journey ${j} für diese Buchung übersprungen: ${why}.`) : t(l, `Journey ${j} skipped for this booking.`, `Journey ${j} für diese Buchung übersprungen.`));
    }

    case 'moment.passed': {
      const what = journeyKey ? t(l, `Journey ${j}`, `Journey ${j}`) : t(l, 'A planned message', 'Eine geplante Nachricht');
      const reason = str(data.reason);
      return one(
        reason === 'checked_out_before_live'
          ? t(l, `${what} didn't run: the guest had checked out before it was turned on.`, `${what} lief nicht: der Gast war ausgecheckt, bevor sie eingeschaltet wurde.`)
          : reason === 'checked_out_before_start_sending'
            ? t(l, `${what} didn't run: the guest had checked out before you started sending.`, `${what} lief nicht: der Gast war ausgecheckt, bevor du den Versand gestartet hast.`)
            : t(l, `${what} didn't run: its time passed.`, `${what} lief nicht: der Zeitpunkt ist vorbei.`),
      );
    }

    default:
      return one(c.admin ? ev.type : t(l, 'Something else happened.', 'Etwas anderes ist passiert.'));
  }
}

function consentLedgerSentence(l: L, c: TimelineConsentInput, viaOtherPlace: boolean): string {
  const ch = channelWord(l, c.channel);
  if (c.action === 'grant') {
    switch (c.source) {
      case 'splash': {
        const said = t(l, `Said yes to messages by ${ch} on the Wi-Fi page.`, `Hat auf der WLAN-Seite Nachrichten per ${ch} zugestimmt.`);
        // A yes while the owner's stop stands (PR D): kept for the owner's resume.
        return c.sourceRef?.heldByOwnerStop === true
          ? `${said} ${t(l, 'Marketing stays stopped here until you resume it.', 'Werbung bleibt hier gestoppt, bis du sie wieder einschaltest.')}`
          : said;
      }
      case 'sms_keyword':
        // A START while the owner's stop stands (PR D): kept for the owner's resume.
        return c.sourceRef?.heldByOwnerStop === true
          ? t(l, 'Texted START, but marketing stays stopped here until you resume it.', 'Hat START geschickt, aber Werbung bleibt hier gestoppt, bis du sie wieder einschaltest.')
          : startSentence(l);
      case 'owner':
        return t(l, `You turned marketing by ${ch} back on for this guest.`, `Du hast Werbung per ${ch} für diesen Gast wieder eingeschaltet.`);
      default:
        return t(l, `Said yes to messages by ${ch}.`, `Hat Nachrichten per ${ch} zugestimmt.`);
    }
  }
  // The owner's stop / resume bookkeeping (PR D): the consent itself didn't change.
  const kind = typeof c.sourceRef?.kind === 'string' ? c.sourceRef.kind : null;
  if (c.source === 'owner' && kind === 'owner_lift') {
    return t(l, `You lifted your stop on marketing by ${ch} (the guest hasn't said yes to ${ch} here).`, `Du hast deinen Werbestopp per ${ch} aufgehoben (der Gast hat ${ch} hier nicht zugestimmt).`);
  }
  if (c.source === 'owner' && kind === 'owner_lift_guest_no') {
    return t(l, `You lifted your stop on marketing by ${ch}; the guest had said no themselves, so it stays off.`, `Du hast deinen Werbestopp per ${ch} aufgehoben; der Gast hatte selbst abgelehnt, deshalb bleibt sie aus.`);
  }
  if (c.source === 'owner' && kind === 'owner_stop_mark') {
    return t(l, `You stopped marketing by ${ch} for this guest (they had already said no themselves).`, `Du hast Werbung per ${ch} für diesen Gast gestoppt (er hatte selbst schon abgelehnt).`);
  }
  if (c.source === 'owner' && kind === 'owner_stop_all') {
    return t(l, `Marketing by ${ch} stays stopped here too (you stopped it at all your venues).`, `Werbung per ${ch} bleibt auch hier gestoppt (du hast sie an allen deinen Orten gestoppt).`);
  }
  switch (c.source) {
    case 'sms_keyword':
      return stopSentence(l, viaOtherPlace);
    case 'provider_stop':
      return t(l, 'The phone network reports that this number said STOP: no more SMS.', 'Das Mobilfunknetz meldet ein STOP für diese Nummer: keine SMS mehr.');
    case 'unsubscribe_page':
    case 'brevo_unsubscribed':
      return unsubscribeSentence(l);
    case 'brevo_spam':
      return spamSentence(l);
    case 'owner':
      return t(l, `You stopped marketing by ${ch} for this guest.`, `Du hast Werbung per ${ch} für diesen Gast gestoppt.`);
    case 'import_legacy':
      return t(l, `Had already said no to messages by ${ch} before (carried over).`, `Hatte Nachrichten per ${ch} schon früher abgelehnt (übernommen).`);
    default:
      return t(l, `Said no to messages by ${ch}.`, `Hat Nachrichten per ${ch} abgelehnt.`);
  }
}

function otherPlacesConsentSentence(l: L, c: TimelineConsentInput): string {
  const ch = channelWord(l, c.channel);
  return c.action === 'grant'
    ? t(l, `Said yes to messages by ${ch} (other places).`, `Hat Nachrichten per ${ch} zugestimmt (an anderen Orten).`)
    : t(l, `Said no to messages by ${ch} (other places).`, `Hat Nachrichten per ${ch} abgelehnt (an anderen Orten).`);
}

// ── Admin detail (no bodies, no feedback, free text scrubbed) ────────────────

const DENY_KEYS = new Set([
  'feedback',
  'hasFeedback',
  'body',
  'text',
  'preview',
  'content',
  'subject',
  'message',
  'errorMessage',
  'guest',
  'phone',
  'phoneE164',
  'email',
  'to',
  'address',
  'decision',
  'replay',
]);

/** Email addresses and phone-like digit runs (9+ digits) out of free text. */
function scrubText(s: string): string {
  return s
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[address]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m))
    .slice(0, 200);
}

function isIdKey(key: string): boolean {
  return /(Id|Key|Ids|Keys)$/.test(key) || key === 'overlapWith';
}

function safeValue(key: string, v: unknown, depth: number): unknown {
  if (typeof v === 'string') return isIdKey(key) ? v.slice(0, 200) : scrubText(v);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => safeValue(key, x, depth + 1));
  if (typeof v === 'object') return safeData(v as Record<string, unknown>, depth + 1);
  return undefined;
}

function safeData(data: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (DENY_KEYS.has(k)) continue;
    const s = safeValue(k, v, depth);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function decisionDetail(d: DecisionRecord | null): Record<string, unknown> | undefined {
  if (!d) return undefined;
  return {
    result: d.result,
    rule: d.rule ?? null,
    reason: d.reason ?? null,
    until: typeof d.until === 'number' ? new Date(d.until).toISOString() : null,
    mode: d.mode,
    purpose: d.purpose,
    poolKey: d.poolKey,
    checks: (d.checks ?? []).map((c) => ({ rule: c.rule, ok: c.ok, fact: scrubText(String(c.fact ?? '')) })),
    channel: d.channel,
    variant: d.variant,
    slot: d.slot,
    credits: d.credits,
    versions: d.versions,
  };
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/** For items at the same instant: what happened first (a visit before the journey it starts, a step before the journey's end). */
const SAME_TIME_ORDER: Record<string, number> = {
  'wifi.connected': 0,
  'consent.granted': 1,
  'visit.started': 2,
  'offer.redeemed': 3,
  'stay.linked': 3,
  'stay.moment': 4,
  'journey.not_started': 5,
  'journey.entered': 5,
  'journey.config_updated': 6,
  'journey.resumed': 6,
  'offer.issued': 7,
  'journey.converted': 10,
  'consent.revoked': 10,
  'journey.exited': 11,
};

function orderOf(kind: string): number {
  return SAME_TIME_ORDER[kind] ?? 8;
}

// ── The builder ──────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/** The guest's history, newest first. */
export function buildTimeline(args: BuildTimelineArgs): TimelineItem[] {
  const l: L = args.lang === 'de' ? 'de' : 'en';
  const admin = args.audience === 'admin';
  const venues = args.venues ?? {};
  const sends = args.sends ?? {};
  const names = args.journeyNames ?? {};
  const offerLabels = args.offerLabels ?? {};
  const fallbackTz = isValidTimeZone(args.defaultTz) ? args.defaultTz : FALLBACK_TZ;
  const own = (venueId: string | null | undefined) => typeof venueId === 'string' && Object.prototype.hasOwnProperty.call(venues, venueId);
  const tzOf = (venueId: string | null | undefined) => {
    const tz = own(venueId) ? venues[venueId as string].tz : null;
    return isValidTimeZone(tz) ? tz : fallbackTz;
  };
  const nameOf = (venueId: string | null | undefined) => (own(venueId) ? venues[venueId as string].name || null : null);
  const journey = (key: string | null) => (key ? quoted(l, str(names[key]) ?? key) : t(l, 'a journey', 'eine Journey'));
  /** A send of this tenant (a sendKey we can't place counts as another place's: fail closed). */
  const ownSend = (sendKey: unknown) => {
    const s = typeof sendKey === 'string' ? sends[sendKey] : undefined;
    return Boolean(s && (!s.tenantUserId || s.tenantUserId === args.tenantUserId) && (!s.venueId || own(s.venueId)));
  };

  const items: Array<TimelineItem & { _ms: number; _id: string }> = [];

  // The consent ledger is the record of what changed; a consent.* event it came from is not repeated.
  const ledgerEventIds = new Set<string>();
  for (const c of args.consents ?? []) {
    const ref = rec(c.sourceRef);
    if (typeof ref.eventId === 'string') ledgerEventIds.add(ref.eventId);
  }

  for (const c of args.consents ?? []) {
    const kind = c.action === 'grant' ? 'consent.granted' : 'consent.revoked';
    const foreign = !own(c.venueId) || (Boolean(c.tenantUserId) && c.tenantUserId !== args.tenantUserId);
    const ref = rec(c.sourceRef);
    const viaOtherPlace = typeof ref.sendKey === 'string' && !ownSend(ref.sendKey);
    const hide = foreign && !admin;
    const item: TimelineItem & { _ms: number; _id: string } = {
      at: iso(c.occurredAt),
      kind,
      venueId: hide ? null : c.venueId ?? null,
      venueName: hide ? null : nameOf(c.venueId),
      journeyKey: null,
      sentence: hide ? otherPlacesConsentSentence(l, c) : consentLedgerSentence(l, c, viaOtherPlace),
      mode: null,
      channel: c.channel ?? null,
      credits: null,
      _ms: Number.isFinite(c.occurredAt) ? c.occurredAt : 0,
      _id: `c:${c.id}`,
    };
    if (admin) {
      item.detail = stripUndefined({ consentId: c.id, action: c.action, source: c.source, channel: c.channel, venueId: c.venueId, tenantUserId: c.tenantUserId ?? undefined, sourceRef: safeData(ref) });
    }
    items.push(item);
  }

  for (const ev of args.events ?? []) {
    if (!ev || typeof ev.type !== 'string') continue;
    if ((ev.type === 'consent.granted' || ev.type === 'consent.revoked') && ledgerEventIds.has(ev.id)) continue;
    const data = rec(ev.data);
    const send = typeof ev.sendKey === 'string' ? sends[ev.sendKey] ?? null : null;
    const foreign =
      (ev.venueId !== null && ev.venueId !== undefined && !own(ev.venueId)) ||
      (Boolean(ev.tenantUserId) && ev.tenantUserId !== args.tenantUserId) ||
      Boolean(send && ((send.tenantUserId && send.tenantUserId !== args.tenantUserId) || (send.venueId && !own(send.venueId))));
    const isConsent = ev.type === 'consent.granted' || ev.type === 'consent.revoked';
    // Another tenant's step says nothing useful to this owner (and would name their journey): left out.
    if (foreign && !admin && !isConsent) continue;

    const decision = asDecision(data.decision) ?? asDecision(send?.decision);
    const dataMode = data.mode === 'test' || data.mode === 'live' ? data.mode : null;
    const linkMode = ev.type === 'stay.linked' && (data.linkMode === 'test' || data.linkMode === 'live') ? data.linkMode : null;
    const mode: 'test' | 'live' | null = ev.mode ?? dataMode ?? (decision ? decision.mode : null) ?? send?.mode ?? linkMode ?? null;
    const test = mode === 'test' || ev.type === 'send.dry_run';
    const journeyKey = str(ev.journeyKey) ?? str(data.journeyKey);
    const channel = str(ev.channel) ?? str(data.channel) ?? send?.channel ?? (decision?.channel?.picked ?? null);
    const tz = tzOf(ev.venueId ?? send?.venueId);
    const ctx: Ctx = { l, tz, admin, journey, send, offerLabels };

    let sentence: string;
    let credits: number | null = null;
    if (foreign && !admin) {
      // Only consent changes get here.
      sentence = otherPlacesConsentSentence(l, { id: ev.id, occurredAt: ev.occurredAt, venueId: '', channel: channel ?? '', action: ev.type === 'consent.granted' ? 'grant' : 'revoke', source: '' });
    } else {
      const out = eventSentence(ctx, ev, journeyKey, channel);
      sentence = out.sentence;
      credits = test ? null : out.credits;
      if (test) sentence = testRun(l, sentence);
    }

    const hide = foreign && !admin;
    const item: TimelineItem & { _ms: number; _id: string } = {
      at: iso(ev.occurredAt),
      kind: ev.type,
      venueId: hide ? null : ev.venueId ?? null,
      venueName: hide ? null : nameOf(ev.venueId),
      journeyKey: hide ? null : journeyKey,
      sentence,
      mode: hide ? null : mode,
      channel: channel ?? null,
      credits,
      _ms: Number.isFinite(ev.occurredAt) ? ev.occurredAt : 0,
      _id: `e:${ev.id}`,
    };
    if (admin) {
      item.detail = stripUndefined({
        eventId: ev.id,
        type: ev.type,
        venueId: ev.venueId ?? null,
        tenantUserId: ev.tenantUserId ?? undefined,
        instanceId: ev.instanceId ?? null,
        journeyKey,
        nodeId: ev.nodeId ?? null,
        sendKey: ev.sendKey ?? null,
        channel,
        mode,
        source: ev.source ?? null,
        data: safeData(data),
        decision: decisionDetail(decision),
        send: send
          ? stripUndefined({ status: send.status, channel: send.channel, purpose: send.purpose ?? null, mode: send.mode ?? null, credits: send.credits ?? null, toMasked: send.toMasked ?? null, kind: send.kind ?? undefined })
          : undefined,
      });
    }
    items.push(item);
  }

  items.sort((a, b) => b._ms - a._ms || orderOf(b.kind) - orderOf(a.kind) || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  return items.map(({ _ms, _id, ...item }) => item);
}
