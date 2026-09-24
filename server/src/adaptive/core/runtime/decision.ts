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

const REASON_WORDS: Record<string, Record<'en' | 'de', string>> = {
  paused: { en: 'HeidiFi has paused all sending for a moment', de: 'HeidiFi hat den Versand kurz pausiert' },
  lapse_unknown: { en: 'the subscription could not be checked', de: 'das Abo konnte nicht geprüft werden' },
  lapsed: { en: 'the subscription has lapsed', de: 'das Abo ist abgelaufen' },
  tenant_inactive: { en: 'the account is being closed', de: 'das Konto wird geschlossen' },
  switched_off: { en: 'this journey or venue was switched off', de: 'diese Journey oder dieser Standort wurde ausgeschaltet' },
  stale: { en: 'it was too late to still send it', de: 'es war zu spät, um sie noch zu senden' },
  channel_not_ready: { en: 'this channel is not set up yet', de: 'dieser Kanal ist noch nicht eingerichtet' },
  venue_ceiling: { en: 'the daily limit for this venue was reached', de: 'das Tageslimit für diesen Standort war erreicht' },
  platform_ceiling: { en: 'the daily sending limit was reached', de: 'das tägliche Versandlimit war erreicht' },
  blocked: { en: 'this address is blocked (bounced or unsubscribed from all messages)', de: 'diese Adresse ist gesperrt (unzustellbar oder abgemeldet)' },
  low_rating: { en: 'the guest gave a low private rating here', de: 'der Gast hat hier privat schlecht bewertet' },
  no_consent: { en: 'the guest has not said yes to this channel', de: 'der Gast hat diesem Kanal nicht zugestimmt' },
  audience: { en: 'you chose to message verified guests only', de: 'du hast nur verifizierte Gäste ausgewählt' },
  max_touches: { en: 'this journey already sent its maximum number of messages', de: 'diese Journey hat schon die maximale Anzahl Nachrichten gesendet' },
  max_clicks: { en: 'the guest already clicked enough', de: 'der Gast hat schon genug geklickt' },
  same_as_last: { en: 'it would have repeated the last message', de: 'sie hätte die letzte Nachricht wiederholt' },
  weekly_limit: { en: 'the guest already got 3 marketing messages this week (including from other places)', de: 'der Gast hat diese Woche schon 3 Werbenachrichten erhalten (auch von anderen Orten)' },
  quiet_hours: { en: 'it was quiet hours', de: 'es war Ruhezeit' },
  quiet_hours_expired: { en: 'quiet hours would have made it too late', de: 'wegen der Ruhezeit wäre es zu spät gewesen' },
  fair_use: { en: 'this venue reached its monthly info-message limit', de: 'dieser Standort hat sein monatliches Limit für Info-Nachrichten erreicht' },
  credits: { en: 'there were not enough credits', de: 'es gab nicht genug Credits' },
  credits_expired: { en: 'there were not enough credits for 72 hours', de: 'es gab 72 Stunden lang nicht genug Credits' },
  no_eligible_channel: { en: 'no channel could be used for this guest', de: 'für diesen Gast konnte kein Kanal genutzt werden' },
  guest_info_missing: { en: 'Guest info is not filled in yet', de: 'die Gästeinfos sind noch nicht ausgefüllt' },
};

function lang2(lang: Lang): 'en' | 'de' {
  return lang === 'de' ? 'de' : 'en';
}

function timeText(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** One sentence for the owner's guest timeline. */
export function explainDecision(record: DecisionRecord, lang: Lang, tz: string): string {
  const l = lang2(lang);
  const channel = record.channel.picked ? CHANNEL_WORDS[record.channel.picked]?.[l] ?? record.channel.picked : null;
  const reason = record.reason ? REASON_WORDS[record.reason]?.[l] ?? record.reason : null;
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
      ? `Zurückgehalten bis ${timeText(record.until, tz)}, weil ${reason}.`
      : `Held back until ${timeText(record.until, tz)} because ${reason}.`;
  }
  return l === 'de' ? `Nicht gesendet, weil ${reason}.` : `Not sent because ${reason}.`;
}
