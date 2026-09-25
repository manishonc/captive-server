/**
 * Choosing the channel, the wording and the time of one send (04-engine-runtime §5).
 * P0 rules only — no bandit, no AI. Pure.
 */

import type { Channel } from '../constants';
import type { AdaptiveConfig } from '../schemas';
import { MINUTE_MS, atLocalTime, nextLocalTime, nextSlotWindow, unitFromKey } from './time';
import type { InstanceState } from './types';

// ── Channel ──────────────────────────────────────────────────────────────────

/** Why a channel can or can't carry this message — kept for the decision record. */
export interface ChannelCheck {
  channel: Channel;
  ok: boolean;
  /** Short reason when not ok: no_address, no_consent, blocked:<why>, audience, no_wording, <channel rule>. */
  reason: string | null;
}

export interface ChannelFacts {
  channel: Channel;
  hasAddress: boolean;
  consent: 'granted' | 'revoked' | 'none';
  /** Why the address is blocked (hard bounce, spam, STOP, erasure) or null. */
  suppressed: string | null;
  /** The owner's "only verified" choice passes for this guest. */
  audienceOk: boolean;
  /** The pool has active wording for this channel (in the guest's language or English). */
  hasWording: boolean;
  /** A channel rule that fails (email unsubscribe not configured, country not allowed, whatsapp off…). */
  ruleFail: string | null;
}

export function checkChannel(purpose: 'marketing' | 'service', f: ChannelFacts): ChannelCheck {
  const no = (reason: string): ChannelCheck => ({ channel: f.channel, ok: false, reason });
  if (!f.hasAddress) return no('no_address');
  if (purpose === 'marketing' && f.consent !== 'granted') return no(f.consent === 'revoked' ? 'consent_revoked' : 'no_consent');
  if (f.suppressed) return no(`blocked:${f.suppressed}`);
  if (!f.audienceOk) return no('audience');
  if (!f.hasWording) return no('no_wording');
  if (f.ruleFail) return no(f.ruleFail);
  return { channel: f.channel, ok: true, reason: null };
}

export type ChannelRule = 'auto' | 'next_on_ladder' | 'same_as_last_click' | 'same_as_last' | { fixed: Channel };

export interface ChannelPick {
  channel: Channel | null;
  /** Which rule decided it, in words for the record. */
  rule: string;
  ladderPos: number;
}

export interface ChannelPickInput {
  rule: ChannelRule;
  eligible: Channel[];
  ladder: Channel[];
  state: Pick<InstanceState, 'counters' | 'lastTouch'>;
  preferredChannel: Channel | null;
  consecutiveNoClickOnPreferred: number;
  lastClickChannel: Channel | null;
}

/**
 * The 04 §5.1 order: fixed → same as last click → same as last → favourite
 * channel (unless it stopped working: 2 touches in a row with no click) →
 * the journey's ladder from the current position (one rung down for
 * `next_on_ladder`). Nothing eligible → null (the send is skipped).
 */
export function pickChannel(input: ChannelPickInput): ChannelPick {
  const { rule, eligible, ladder, state } = input;
  const has = (c: Channel | null | undefined): c is Channel => Boolean(c) && eligible.includes(c as Channel);
  const posOf = (c: Channel) => {
    const i = ladder.indexOf(c);
    return i >= 0 ? i : state.counters.ladderPos;
  };

  if (typeof rule === 'object') {
    return has(rule.fixed)
      ? { channel: rule.fixed, rule: `fixed:${rule.fixed}`, ladderPos: posOf(rule.fixed) }
      : { channel: null, rule: `fixed:${rule.fixed}`, ladderPos: state.counters.ladderPos };
  }
  if (rule === 'same_as_last_click' && has(input.lastClickChannel)) {
    return { channel: input.lastClickChannel, rule: 'same_as_last_click', ladderPos: posOf(input.lastClickChannel) };
  }
  if (rule === 'same_as_last' && has(state.lastTouch?.channel)) {
    const c = state.lastTouch!.channel;
    return { channel: c, rule: 'same_as_last', ladderPos: posOf(c) };
  }
  if (rule !== 'next_on_ladder' && has(input.preferredChannel) && input.consecutiveNoClickOnPreferred < 2) {
    return { channel: input.preferredChannel, rule: 'favourite_channel', ladderPos: posOf(input.preferredChannel) };
  }
  const current = Math.max(state.counters.ladderPos, 0);
  const start = rule === 'next_on_ladder' ? state.counters.ladderPos + 1 : current;
  for (let i = Math.max(start, 0); i < ladder.length; i += 1) {
    if (has(ladder[i])) return { channel: ladder[i], rule: rule === 'next_on_ladder' ? 'next_on_ladder' : 'ladder', ladderPos: i };
  }
  return { channel: null, rule: rule === 'next_on_ladder' ? 'next_on_ladder' : 'ladder', ladderPos: state.counters.ladderPos };
}

// ── Wording ──────────────────────────────────────────────────────────────────

export interface VariantOption {
  id: string;
  letter: string;
}

/** P0 rotation: the next variant after the one used last time (by letter), never the same one twice in a row if another exists. */
export function pickVariant(options: VariantOption[], lastVariantId: string | null): { variantId: string | null; method: string } {
  if (!options.length) return { variantId: null, method: 'none' };
  const sorted = [...options].sort((a, b) => a.letter.localeCompare(b.letter));
  if (!lastVariantId) return { variantId: sorted[0].id, method: 'rotation:first' };
  const idx = sorted.findIndex((o) => o.id === lastVariantId);
  if (idx < 0) return { variantId: sorted[0].id, method: 'rotation:first' };
  const next = sorted[(idx + 1) % sorted.length];
  return { variantId: next.id, method: sorted.length > 1 ? 'rotation:next' : 'rotation:only_one' };
}

// ── Time ─────────────────────────────────────────────────────────────────────

export interface TimingConfig {
  mode: 'now' | 'slot' | 'local_time';
  default?: 'morning' | 'afternoon' | 'evening';
  at?: string;
}

export interface TimePick {
  /** When the send should go. */
  at: number;
  slot: string;
  rule: string;
}

/**
 * `now`, the step's slot window in the venue's time zone (a random-looking but
 * repeatable minute inside it), or a fixed local time.
 */
export function pickTime(timing: TimingConfig, now: number, tz: string, slots: AdaptiveConfig['slots'], jitterKey: string): TimePick {
  if (timing.mode === 'now') return { at: now, slot: 'now', rule: 'now' };
  if (timing.mode === 'local_time') {
    const at = timing.at ? nextLocalTime(new Date(now), tz, timing.at).getTime() : now;
    return { at, slot: 'fixed', rule: `local_time:${timing.at ?? '—'}` };
  }
  const slotName = timing.default ?? 'afternoon';
  const window = slots[slotName];
  const { from, to } = nextSlotWindow(new Date(now), tz, window);
  const span = Math.max(0, to.getTime() - from.getTime() - MINUTE_MS);
  const at = from.getTime() + Math.floor(unitFromKey(jitterKey) * span / MINUTE_MS) * MINUTE_MS;
  return { at, slot: slotName, rule: `slot:${slotName}` };
}

/** 09:00 + a repeatable 0–20 min, so the morning wave is spread out. */
export function afterQuietHours(end: Date, jitterMinutes: [number, number], jitterKey: string): number {
  const [lo, hi] = jitterMinutes;
  const minutes = lo + Math.floor(unitFromKey(`${jitterKey}:q`) * (Math.max(hi, lo) - lo + 1));
  return end.getTime() + minutes * MINUTE_MS;
}

export { atLocalTime };
