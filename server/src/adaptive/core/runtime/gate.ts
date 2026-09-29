/**
 * The send gate (04-engine-runtime §4): eleven rules, in order, first "no" wins.
 * PR F0 added `spacing` after `quiet_hours`: at least N hours (AdaptiveConfig
 * `marketingGapHours`, 4) between two marketing messages to one person, across
 * every venue and owner — the weekly limit's scope.
 *
 * Every rule is evaluated every time, so the decision record always holds the
 * full checklist ("touches 1/5", "21:40 Europe/Zurich is inside 21:00–09:00 →
 * 09:07") — that is what the owner's "why" sentence and the admin checklist are
 * built from. Pure: the worker loads the facts, this decides.
 */

import type { Channel } from '../constants';
import { HOUR_MS, MINUTE_MS, isInWindow, localParts, windowEnd } from './time';
import { afterQuietHours, spacingSpread } from './pickers';
import type { LastTouch, RunMode } from './types';

export type Verdict = 'allow' | 'defer' | 'skip' | 'block';

export type RuleName =
  | 'system'
  | 'blocked_address'
  | 'consent'
  | 'channel_rules'
  | 'journey_caps'
  | 'must_differ'
  | 'weekly_limit'
  | 'quiet_hours'
  | 'spacing'
  | 'fair_use'
  | 'credits';

export interface RuleCheck {
  rule: RuleName;
  verdict: Verdict;
  fact: string;
  /** For `defer`: when to try again. */
  until?: number;
  /** Machine reason for skip/block/defer (e.g. `paused`, `quiet_hours_expired`). */
  reason?: string;
}

export interface GateResult {
  verdict: Verdict;
  rule: RuleName | null;
  reason: string | null;
  until: number | null;
  checks: RuleCheck[];
}

export interface GateInput {
  now: number;
  mode: RunMode;
  purpose: 'marketing' | 'service';
  channel: Channel;
  urgent: boolean;
  /** When the step was entered and how long it may slip (quiet hours, credits) before it's pointless. */
  enteredAt: number;
  expireAfterMs: number | null;
  /** When this send was meant to go; a pause or a stopped worker doesn't move it. */
  intendedAt: number;
  jitterKey: string;
  system: {
    paused: boolean;
    /** true / false, or 'unknown' when the lookup failed (treated as "wait"). */
    lapsed: boolean | 'unknown';
    tenantActive: boolean;
    venueOn: boolean;
    journeyOn: boolean;
    /** When the venue / journey was switched off (sends due within the freeze window of that still go). */
    offSinceAt: number | null;
    /** The freeze window (AdaptiveConfig `freezeWindowMinutes`, seeded 60); 60 min when not given. */
    freezeWindowMs?: number;
    staleAfterMs: number;
    venueSendsToday: number;
    venueCeiling: number;
    platformSendsToday: number;
    platformCeiling: number;
    /** Sending code for this channel exists and is configured (false in test builds without adapters). */
    channelReady: boolean;
    /** A stay journey whose booking was cancelled (or is gone): skipped, no freeze grace, test runs too. */
    stayCancelled?: boolean;
    /** A stay journey whose booking the owner unlinked from this guest (PR D): skipped the same way. */
    stayUnlinked?: boolean;
  };
  address: { blocked: string | null; lowRatingAt: number | null };
  consent: { state: 'granted' | 'revoked' | 'none' };
  channelRules: { audienceOk: boolean; audienceFact: string; ruleFail: string | null };
  caps: { touches: number; maxTouches: number; clicks: number; stopAfterClicks: number };
  diff: { lastTouch: LastTouch | null; variantId: string | null; slot: string };
  weekly: { count: number; limit: number };
  quiet: {
    venueTz: string;
    phoneTz: string | null;
    window: { start: string; end: string };
    utilityWindow: { start: string; end: string };
    jitterMinutes: [number, number];
  };
  /**
   * PR F0: when this person's newest other marketing message went (any venue, any owner;
   * null = none in the window) and the gap to keep after it (0 = off). Required, so a new
   * builder can't forget it; a replay snapshot from before the rule reads as gap 0.
   */
  spacing: { lastAt: number | null; minGapMs: number };
  fairUse: { count: number; limit: number };
  credits: {
    price: number;
    /** Spendable credits for this channel, or null when unknown (treated as "wait"). */
    spendable: number | null;
    waitStartedAt: number | null;
    queueHours: number;
  };
}

const FREEZE_WINDOW_MS = 60 * MINUTE_MS;
const PAUSE_RECHECK_MS = 15 * MINUTE_MS;
const CREDIT_RECHECK_MS = HOUR_MS;

function hhmm(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function allow(rule: RuleName, fact: string): RuleCheck {
  return { rule, verdict: 'allow', fact };
}

// ── The rules ────────────────────────────────────────────────────────────────

/** Rule 1 on its own — the send path runs it before picking a channel (a paused venue stops everyone). */
export function checkSystem(i: GateInput): RuleCheck {
  return ruleSystem(i);
}

function ruleSystem(i: GateInput): RuleCheck {
  const s = i.system;
  const late = i.now - i.intendedAt;
  if (!s.tenantActive) return { rule: 'system', verdict: 'skip', fact: 'account is being deleted', reason: 'tenant_inactive' };
  if (s.stayCancelled) return { rule: 'system', verdict: 'skip', fact: 'the booking was cancelled', reason: 'stay_cancelled' };
  if (s.stayUnlinked) return { rule: 'system', verdict: 'skip', fact: 'the booking was unlinked from this guest', reason: 'stay_unlinked' };
  if (!s.venueOn || !s.journeyOn) {
    const withinFreeze = s.offSinceAt !== null && i.intendedAt <= s.offSinceAt + (s.freezeWindowMs ?? FREEZE_WINDOW_MS);
    if (!withinFreeze) {
      return { rule: 'system', verdict: 'skip', fact: !s.venueOn ? 'venue is paused or off' : 'journey was switched off', reason: 'switched_off' };
    }
  }
  if (late > s.staleAfterMs) {
    return { rule: 'system', verdict: 'skip', fact: `planned ${Math.round(late / HOUR_MS)} h ago — too late`, reason: 'stale' };
  }
  if (i.mode === 'test') {
    return allow('system', `test run${s.paused ? ' (pause ignored — nothing is sent)' : ''}`);
  }
  if (s.paused) {
    return { rule: 'system', verdict: 'defer', fact: 'all sending paused by HeidiFi', reason: 'paused', until: i.now + PAUSE_RECHECK_MS };
  }
  if (s.lapsed === 'unknown') {
    return { rule: 'system', verdict: 'defer', fact: 'could not check the subscription — trying again', reason: 'lapse_unknown', until: i.now + PAUSE_RECHECK_MS };
  }
  if (s.lapsed) return { rule: 'system', verdict: 'skip', fact: 'subscription lapsed', reason: 'lapsed' };
  if (!s.channelReady) return { rule: 'system', verdict: 'block', fact: `${i.channel} sending isn't set up`, reason: 'channel_not_ready' };
  if (s.platformSendsToday >= s.platformCeiling) {
    return { rule: 'system', verdict: 'defer', fact: `platform daily ceiling ${s.platformSendsToday}/${s.platformCeiling}`, reason: 'platform_ceiling', until: i.now + HOUR_MS };
  }
  if (s.venueSendsToday >= s.venueCeiling) {
    return { rule: 'system', verdict: 'defer', fact: `venue daily ceiling ${s.venueSendsToday}/${s.venueCeiling}`, reason: 'venue_ceiling', until: i.now + HOUR_MS };
  }
  return allow('system', 'live');
}

function ruleBlocked(i: GateInput): RuleCheck {
  if (i.address.blocked) return { rule: 'blocked_address', verdict: 'skip', fact: `${i.channel} address blocked (${i.address.blocked})`, reason: 'blocked' };
  if (i.purpose === 'marketing' && i.address.lowRatingAt !== null) {
    return { rule: 'blocked_address', verdict: 'skip', fact: 'gave a private rating of 2★ or less here', reason: 'low_rating' };
  }
  return allow('blocked_address', 'not blocked');
}

function ruleConsent(i: GateInput): RuleCheck {
  if (i.purpose === 'service') return allow('consent', 'info message — the guest gave us this address');
  if (i.consent.state === 'granted') return allow('consent', `said yes to ${i.channel} from this venue`);
  return {
    rule: 'consent',
    verdict: 'skip',
    fact: i.consent.state === 'revoked' ? `said no to ${i.channel} (unsubscribed)` : `no yes for ${i.channel} from this venue`,
    reason: 'no_consent',
  };
}

function ruleChannel(i: GateInput): RuleCheck {
  if (!i.channelRules.audienceOk) return { rule: 'channel_rules', verdict: 'skip', fact: i.channelRules.audienceFact, reason: 'audience' };
  if (i.channelRules.ruleFail) return { rule: 'channel_rules', verdict: 'skip', fact: i.channelRules.ruleFail, reason: i.channelRules.ruleFail };
  return allow('channel_rules', i.channelRules.audienceFact);
}

function ruleCaps(i: GateInput): RuleCheck {
  if (i.purpose === 'service') return allow('journey_caps', 'info message — not counted');
  const { touches, maxTouches, clicks, stopAfterClicks } = i.caps;
  if (touches >= maxTouches) return { rule: 'journey_caps', verdict: 'skip', fact: `touches ${touches}/${maxTouches}`, reason: 'max_touches' };
  if (clicks >= stopAfterClicks) return { rule: 'journey_caps', verdict: 'skip', fact: `clicks ${clicks}/${stopAfterClicks}`, reason: 'max_clicks' };
  return allow('journey_caps', `touches ${touches}/${maxTouches}`);
}

function ruleDiffer(i: GateInput): RuleCheck {
  const last = i.diff.lastTouch;
  if (i.purpose === 'service' || !last || last.purpose === 'service') return allow('must_differ', 'first touch');
  const differs: string[] = [];
  if (last.channel !== i.channel) differs.push('channel');
  if (i.diff.variantId && last.variantId !== i.diff.variantId) differs.push('wording');
  if (last.slot !== i.diff.slot) differs.push('time');
  if (!differs.length) return { rule: 'must_differ', verdict: 'skip', fact: 'same channel, wording and time as last touch', reason: 'same_as_last' };
  return allow('must_differ', `differs in ${differs.join(', ')}`);
}

function ruleWeekly(i: GateInput): RuleCheck {
  if (i.purpose === 'service') return allow('weekly_limit', 'info message — not counted');
  const { count, limit } = i.weekly;
  if (count >= limit) return { rule: 'weekly_limit', verdict: 'skip', fact: `${count} of ${limit} marketing messages in the last 7 days`, reason: 'weekly_limit' };
  return allow('weekly_limit', `${count} of ${limit} in the last 7 days`);
}

/** The venue's zone, plus the guest's phone zone when it differs (quiet hours hold in both). */
function quietZones(i: GateInput): string[] {
  return [i.quiet.venueTz, ...(i.quiet.phoneTz && i.quiet.phoneTz !== i.quiet.venueTz ? [i.quiet.phoneTz] : [])];
}

/** From `start` (inside quiet hours somewhere), the moment every zone is out of them (no jitter). */
function quietWindowEnd(zones: string[], window: { start: string; end: string }, start: number): number {
  let until = start;
  for (let pass = 0; pass < 3; pass += 1) {
    const inside = zones.filter((tz) => isInWindow(new Date(until), tz, window));
    if (!inside.length) break;
    // Each zone's end from the same moment: measured from an already-moved time, a
    // zone east of the venue would find its window over and jump to its next one.
    const from = until;
    for (const tz of inside) until = Math.max(until, windowEnd(new Date(from), tz, window).getTime());
  }
  return until;
}

function ruleQuiet(i: GateInput): RuleCheck {
  if (i.purpose === 'service' && i.urgent) return allow('quiet_hours', 'urgent info message');
  const window = i.purpose === 'service' ? i.quiet.utilityWindow : i.quiet.window;
  const now = new Date(i.now);
  const zones = quietZones(i);
  const quietIn = zones.filter((tz) => isInWindow(now, tz, window));
  if (!quietIn.length) return allow('quiet_hours', `${hhmm(now, i.quiet.venueTz)} ${i.quiet.venueTz} is outside ${window.start}–${window.end}`);

  // Wait until every zone is out of quiet hours, plus the morning jitter.
  let until = quietWindowEnd(zones, window, i.now);
  until = afterQuietHours(new Date(until), i.quiet.jitterMinutes, i.jitterKey);
  const tz = quietIn[0];
  const fact = `${hhmm(now, tz)} ${tz} is inside ${window.start}–${window.end} → ${hhmm(new Date(until), tz)}`;
  if (i.expireAfterMs !== null && until > i.enteredAt + i.expireAfterMs) {
    return { rule: 'quiet_hours', verdict: 'skip', fact: `${fact}, too late for this step`, reason: 'quiet_hours_expired' };
  }
  return { rule: 'quiet_hours', verdict: 'defer', fact, reason: 'quiet_hours', until };
}

/** "35 min", "4 h", "1 h 20 min" (never negative; rounded down, so a hold never reads "4 h ago, gap 4 h"). */
function spanText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * PR F0: no two marketing messages to one person within `minGapMs`, whichever venue or
 * owner sent the first (quiet hours alone let every held message go at 09:00–09:20).
 * Waits for the gap plus a repeatable 0–20 min; a gap that ends inside quiet hours goes on
 * to their end (one hop). Past the step's `expireAfter` the message is skipped.
 */
function ruleSpacing(i: GateInput): RuleCheck {
  if (i.purpose === 'service') return allow('spacing', 'info message — not counted');
  const s = i.spacing;
  if (!s || !(s.minGapMs > 0)) return allow('spacing', 'no gap between messages is set');
  const gap = spanText(s.minGapMs);
  if (s.lastAt === null) return allow('spacing', `no other marketing message in the last ${gap}`);
  const ago = spanText(i.now - s.lastAt);
  const readyAt = s.lastAt + s.minGapMs;
  if (i.now >= readyAt) return allow('spacing', `last marketing message ${ago} ago (gap ${gap})`);

  let until = spacingSpread(readyAt, i.quiet.jitterMinutes, i.jitterKey);
  const zones = quietZones(i);
  if (zones.some((tz) => isInWindow(new Date(until), tz, i.quiet.window))) {
    until = afterQuietHours(new Date(quietWindowEnd(zones, i.quiet.window, until)), i.quiet.jitterMinutes, i.jitterKey);
  }
  const fact = `last marketing message ${ago} ago, gap ${gap} → ${hhmm(new Date(until), i.quiet.venueTz)}`;
  if (i.expireAfterMs !== null && until > i.enteredAt + i.expireAfterMs) {
    return { rule: 'spacing', verdict: 'skip', fact: `${fact}, too late for this step`, reason: 'spacing_expired' };
  }
  return { rule: 'spacing', verdict: 'defer', fact, reason: 'spacing', until };
}

function ruleFairUse(i: GateInput): RuleCheck {
  if (i.purpose === 'marketing') return allow('fair_use', 'marketing — not counted');
  const { count, limit } = i.fairUse;
  if (count >= limit) return { rule: 'fair_use', verdict: 'skip', fact: `${count} of ${limit} info messages this month`, reason: 'fair_use' };
  return allow('fair_use', `${count} of ${limit} info messages this month`);
}

function ruleCredits(i: GateInput): RuleCheck {
  if (i.purpose === 'service') return allow('credits', 'info message — free');
  const { price, spendable, waitStartedAt, queueHours } = i.credits;
  if (i.mode === 'test') {
    return allow('credits', `would cost ${price} credits${spendable === null ? '' : ` (balance ${spendable})`} — test run, not charged`);
  }
  if (spendable !== null && spendable >= price) return allow('credits', `${price} credits (balance ${spendable})`);
  const since = waitStartedAt ?? i.now;
  if (i.now - since >= queueHours * HOUR_MS) {
    return { rule: 'credits', verdict: 'skip', fact: `not enough credits for ${queueHours} h`, reason: 'credits_expired' };
  }
  const fact = spendable === null ? 'could not read the credit balance — trying again' : `needs ${price} credits, balance ${spendable} — waiting for a top-up`;
  return { rule: 'credits', verdict: 'defer', fact, reason: 'credits', until: i.now + CREDIT_RECHECK_MS };
}

const RULES: Array<(i: GateInput) => RuleCheck> = [
  ruleSystem,
  ruleBlocked,
  ruleConsent,
  ruleChannel,
  ruleCaps,
  ruleDiffer,
  ruleWeekly,
  ruleQuiet,
  ruleSpacing,
  ruleFairUse,
  ruleCredits,
];

export function runGate(input: GateInput): GateResult {
  const checks = RULES.map((rule) => rule(input));
  const first = checks.find((c) => c.verdict !== 'allow');
  if (!first) return { verdict: 'allow', rule: null, reason: null, until: null, checks };
  return { verdict: first.verdict, rule: first.rule, reason: first.reason ?? null, until: first.until ?? null, checks };
}

export const GATE_RULE_ORDER: RuleName[] = [
  'system',
  'blocked_address',
  'consent',
  'channel_rules',
  'journey_caps',
  'must_differ',
  'weekly_limit',
  'quiet_hours',
  'spacing',
  'fair_use',
  'credits',
];
