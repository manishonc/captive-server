/**
 * The decision record: "why did (or didn't) this guest get this message?"
 * (04-engine-runtime §6.1). Written once when the decision is made, never edited,
 * and kept under ~2 KB. The owner's sentence and the admin checklist are built
 * from it — numbers are copied from the record, never recomputed.
 */

import type { Channel, Lang } from '../constants';
import type { GateResult, RuleName, Verdict } from './gate';
import type { ChannelCheck } from './pickers';
import type { RunMode } from './types';

export const DECISION_VERSION = 1;

export interface DecisionRecord {
  v: number;
  at: number;
  mode: RunMode;
  /** allow = sent (or dry run in test mode). */
  result: Verdict;
  rule: RuleName | null;
  reason: string | null;
  until: number | null;
  poolKey: string;
  purpose: 'marketing' | 'service';
  checks: Array<{ rule: RuleName; ok: boolean; fact: string }>;
  channel: { picked: Channel | null; rule: string; rejected: Array<{ channel: Channel; reason: string }> };
  variant: { picked: string | null; method: string };
  slot: { picked: string; rule: string; plannedAt: number };
  credits: { price: number; balance: number | null } | null;
  versions: { template: number; config: number; playbook: string | null; engine: string };
}

export function buildDecision(args: {
  now: number;
  mode: RunMode;
  poolKey: string;
  purpose: 'marketing' | 'service';
  gate: GateResult | null;
  channelChecks: ChannelCheck[];
  channel: { picked: Channel | null; rule: string };
  variant: { picked: string | null; method: string };
  slot: { picked: string; rule: string; plannedAt: number };
  credits: { price: number; balance: number | null } | null;
  versions: DecisionRecord['versions'];
  /** When no channel was usable, the gate never ran: say which rule stopped it. */
  noChannel?: { rule: RuleName; reason: string; fact: string };
}): DecisionRecord {
  const rejected = args.channelChecks.filter((c) => !c.ok).map((c) => ({ channel: c.channel, reason: c.reason ?? 'unknown' }));
  if (!args.gate) {
    const nc = args.noChannel ?? { rule: 'channel_rules' as RuleName, reason: 'no_eligible_channel', fact: 'no channel can be used' };
    return {
      v: DECISION_VERSION,
      at: args.now,
      mode: args.mode,
      result: 'skip',
      rule: nc.rule,
      reason: nc.reason,
      until: null,
      poolKey: args.poolKey,
      purpose: args.purpose,
      checks: [{ rule: nc.rule, ok: false, fact: nc.fact }],
      channel: { ...args.channel, rejected },
      variant: args.variant,
      slot: args.slot,
      credits: args.credits,
      versions: args.versions,
    };
  }
  return {
    v: DECISION_VERSION,
    at: args.now,
    mode: args.mode,
    result: args.gate.verdict,
    rule: args.gate.rule,
    reason: args.gate.reason,
    until: args.gate.until,
    poolKey: args.poolKey,
    purpose: args.purpose,
    checks: args.gate.checks.map((c) => ({ rule: c.rule, ok: c.verdict === 'allow', fact: c.fact.slice(0, 140) })),
    channel: { ...args.channel, rejected },
    variant: args.variant,
    slot: args.slot,
    credits: args.credits,
    versions: args.versions,
  };
}

// ── Plain sentences for the owner (RE-4) ─────────────────────────────────────

const CHANNEL_WORDS: Record<string, Record<'en' | 'de', string>> = {
  sms: { en: 'SMS', de: 'SMS' },
  email: { en: 'email', de: 'E-Mail' },
  whatsapp: { en: 'WhatsApp', de: 'WhatsApp' },
};

// Each phrase follows "because" / "weil", so the German ones end with the verb.
const REASON_WORDS: Record<string, Record<'en' | 'de', string>> = {
  paused: { en: 'HeidiFi has paused all sending for a moment', de: 'HeidiFi den Versand kurz pausiert hat' },
  lapse_unknown: { en: 'the subscription could not be checked', de: 'das Abo nicht geprüft werden konnte' },
  lapsed: { en: 'the subscription has lapsed', de: 'das Abo abgelaufen ist' },
  tenant_inactive: { en: 'the account is being closed', de: 'das Konto geschlossen wird' },
  switched_off: { en: 'this journey or venue was switched off', de: 'diese Journey oder dieser Standort ausgeschaltet wurde' },
  stale: { en: 'it was too late to still send it', de: 'es zu spät war, sie noch zu senden' },
  channel_not_ready: { en: 'this channel is not set up yet', de: 'dieser Kanal noch nicht eingerichtet ist' },
  venue_ceiling: { en: 'the daily limit for this venue was reached', de: 'das Tageslimit für diesen Standort erreicht war' },
  platform_ceiling: { en: 'the daily sending limit was reached', de: 'das tägliche Versandlimit erreicht war' },
  blocked: { en: 'this address is blocked (bounced or unsubscribed from all messages)', de: 'diese Adresse gesperrt ist (unzustellbar oder abgemeldet)' },
  low_rating: { en: 'the guest gave a low private rating here', de: 'der Gast hier privat schlecht bewertet hat' },
  no_consent: { en: 'the guest has not said yes to this channel', de: 'der Gast diesem Kanal nicht zugestimmt hat' },
  audience: { en: 'you chose to message verified guests only', de: 'du nur verifizierte Gäste ausgewählt hast' },
  max_touches: { en: 'this journey already sent its maximum number of messages', de: 'diese Journey schon die maximale Anzahl Nachrichten gesendet hat' },
  max_clicks: { en: 'the guest already clicked enough', de: 'der Gast schon genug geklickt hat' },
  same_as_last: { en: 'it would have repeated the last message', de: 'sie die letzte Nachricht wiederholt hätte' },
  weekly_limit: { en: 'the guest already got the most marketing messages allowed this week (including from other places)', de: 'der Gast diese Woche schon die erlaubte Zahl Werbenachrichten erhalten hat (auch von anderen Orten)' },
  quiet_hours: { en: 'it was quiet hours', de: 'Ruhezeit war' },
  quiet_hours_expired: { en: 'quiet hours would have made it too late', de: 'es wegen der Ruhezeit zu spät gewesen wäre' },
  fair_use: { en: 'this venue reached its monthly info-message limit', de: 'dieser Standort sein monatliches Limit für Info-Nachrichten erreicht hat' },
  credits: { en: 'there were not enough credits', de: 'nicht genug Credits vorhanden waren' },
  credits_expired: { en: 'there were not enough credits for too long', de: 'zu lange nicht genug Credits vorhanden waren' },
  no_eligible_channel: { en: 'no channel could be used for this guest', de: 'für diesen Gast kein Kanal genutzt werden konnte' },
  guest_info_missing: { en: 'the Guest info page is not filled in yet', de: 'die Gästeinfos noch nicht ausgefüllt sind' },
  booking_link_missing: { en: 'no direct-booking link is set in Guest info', de: 'in den Gästeinfos kein Link für Direktbuchungen hinterlegt ist' },
  missing_value: { en: 'a value this message needs is missing', de: 'ein Wert fehlt, den diese Nachricht braucht' },
  rate_card_invalid: { en: 'the price list could not be read', de: 'die Preisliste nicht gelesen werden konnte' },
  provider_unavailable: { en: 'the message service did not accept it after several tries', de: 'der Versanddienst sie nach mehreren Versuchen nicht angenommen hat' },
  provider_retry: { en: 'the message service asked to try again later', de: 'der Versanddienst um einen späteren Versuch gebeten hat' },
  unsupported_format: { en: 'this wording has a format that cannot be sent yet', de: 'dieser Text ein Format hat, das noch nicht versendet werden kann' },
  no_address: { en: 'the guest has no address for this channel', de: 'der Gast für diesen Kanal keine Adresse hat' },
};

const UNKNOWN_REASON: Record<'en' | 'de', string> = { en: 'a sending rule stopped it', de: 'eine Versandregel es verhindert hat' };

function lang2(lang: Lang): 'en' | 'de' {
  return lang === 'de' ? 'de' : 'en';
}

function timeText(ms: number, tz: string, l: 'en' | 'de'): string {
  return new Intl.DateTimeFormat(l === 'de' ? 'de-CH' : 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** The reason in words; limits are read from the rule's stored fact, not assumed. */
function reasonText(record: DecisionRecord, l: 'en' | 'de'): string {
  const reason = record.reason ?? '';
  const fact = record.checks.find((c) => c.rule === record.rule)?.fact ?? '';
  if (reason === 'weekly_limit') {
    const m = /^(\d+) of (\d+)/.exec(fact);
    if (m) {
      return l === 'de'
        ? `der Gast in den letzten 7 Tagen schon ${m[1]} Werbenachrichten erhalten hat (Limit ${m[2]}, auch von anderen Orten)`
        : `the guest already got ${m[1]} marketing messages in the last 7 days (limit ${m[2]}, including from other places)`;
    }
  }
  if (reason === 'credits_expired') {
    const m = /for (\d+) h/.exec(fact);
    if (m) return l === 'de' ? `${m[1]} Stunden lang nicht genug Credits vorhanden waren` : `there were not enough credits for ${m[1]} hours`;
  }
  const key = reason.startsWith('missing_value:') ? 'missing_value' : reason;
  return REASON_WORDS[key]?.[l] ?? UNKNOWN_REASON[l];
}

/** One sentence for the owner's guest timeline. */
export function explainDecision(record: DecisionRecord, lang: Lang, tz: string): string {
  const l = lang2(lang);
  const channel = record.channel.picked ? CHANNEL_WORDS[record.channel.picked]?.[l] ?? record.channel.picked : null;
  const reason = reasonText(record, l);
  const credits = record.credits && record.purpose === 'marketing' ? record.credits.price : 0;

  if (record.result === 'allow') {
    if (record.mode === 'test') {
      return l === 'de'
        ? `Testlauf: hätte per ${channel} gesendet${credits ? ` (${credits} Credits)` : ''} — nichts wurde gesendet.`
        : `Test run: would have sent by ${channel}${credits ? ` (${credits} credits)` : ''} — nothing was sent.`;
    }
    return l === 'de'
      ? `Per ${channel} gesendet${credits ? ` (${credits} Credits)` : ' (gratis)'}.`
      : `Sent by ${channel}${credits ? ` (${credits} credits)` : ' (free)'}.`;
  }
  if (record.result === 'defer' && record.until !== null) {
    return l === 'de'
      ? `Zurückgehalten bis ${timeText(record.until, tz, l)}, weil ${reason}.`
      : `Held back until ${timeText(record.until, tz, l)} because ${reason}.`;
  }
  return l === 'de' ? `Nicht gesendet, weil ${reason}.` : `Not sent because ${reason}.`;
}
