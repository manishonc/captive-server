/**
 * Decision Replay (plan §5 `POST /admin/decisions/replay`): feed a stored
 * decision's inputs back through the pure rules and compare the result.
 *
 * The decision record keeps facts (sentences), not inputs, so every new decision
 * also stores a small snapshot of what the rules read (`JourneySends.replay`,
 * `JourneyEvents.data.replay`): counts, flags, ids, zone names — never an
 * address, a name or message text; numbers in ms, never a Date; `null`, never
 * `undefined` (Firestore rejects it and the send would fail). The fields the
 * decision already holds are not repeated: `now` = `at`, `mode`, `purpose`,
 * `channel` = `channel.picked`, `intendedAt` = `slot.plannedAt`, and the jitter
 * key is the send key (the JourneySends doc id, the event's `sendKey`).
 *
 * Pure: no Firestore. `service/replay.ts` loads the docs.
 */

import type { Channel } from '../constants';
import { buildDecision, explainDecision, type DecisionRecord } from './decision';
import { checkSystem, runGate, type GateInput, type GateResult, type RuleCheck, type RuleName } from './gate';
import { checkChannel, pickChannel, type ChannelCheck, type ChannelFacts, type ChannelRule } from './pickers';
import { ENGINE_RUNTIME_VERSION } from './version';

export const REPLAY_VERSION = 1;
/** A snapshot stays under this (the decision itself stays under 2 KB). */
export const REPLAY_MAX_BYTES = 1536;
/** Rule 1 runs before a channel is picked; the send path passes this placeholder channel. */
export const SYSTEM_PRECHECK_CHANNEL: Channel = 'email';

/** GateInput fields the decision record already holds. */
type InDecision = 'now' | 'mode' | 'purpose' | 'channel' | 'intendedAt' | 'jitterKey';

/**
 * A GateInput part as stored: every optional field becomes required and nullable, so
 * adding a GateInput field fails to compile here until the builder records it.
 */
export type Stored<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]-?: Stored<Exclude<T[K], undefined>> | (undefined extends T[K] ? null : never) }
    : T;

export type ReplaySystem = Stored<GateInput['system']>;
export type ReplayGate = Stored<Omit<GateInput, InDecision | 'system'>>;
export type ReplayChannelFacts = Stored<ChannelFacts>;

/** What the channel pick read (stage `channel`: no channel could be used, the gate never ran). */
export interface ReplayChannel {
  facts: ReplayChannelFacts[];
  rule: ChannelRule;
  ladder: Channel[];
  ladderPos: number;
  lastTouchChannel: Channel | null;
  preferredChannel: Channel | null;
  consecutiveNoClickOnPreferred: number;
  lastClickChannel: Channel | null;
}

/** Where the decision was made: rule 1 alone, the channel pick, or the full gate. */
export type ReplayStage = 'system' | 'channel' | 'gate';

export interface ReplaySnapshot {
  v: number;
  stage: ReplayStage;
  /** Rule 1's inputs (every stage). */
  system: ReplaySystem;
  /** Stage `gate`: the other nine rules' inputs. */
  gate: ReplayGate | null;
  /** Stage `channel`: the channel pick's inputs. */
  channel: ReplayChannel | null;
}

export type ReplayArgs =
  | { stage: 'system'; system: GateInput['system'] }
  | { stage: 'channel'; system: GateInput['system']; channel: Omit<ReplayChannel, 'facts'> & { facts: ChannelFacts[] } }
  | { stage: 'gate'; input: GateInput };

// ── Building the snapshot ────────────────────────────────────────────────────

function storedSystem(s: GateInput['system']): ReplaySystem {
  return {
    paused: s.paused,
    lapsed: s.lapsed,
    tenantActive: s.tenantActive,
    venueOn: s.venueOn,
    journeyOn: s.journeyOn,
    offSinceAt: s.offSinceAt,
    freezeWindowMs: s.freezeWindowMs ?? null,
    staleAfterMs: s.staleAfterMs,
    venueSendsToday: s.venueSendsToday,
    venueCeiling: s.venueCeiling,
    platformSendsToday: s.platformSendsToday,
    platformCeiling: s.platformCeiling,
    channelReady: s.channelReady,
    stayCancelled: s.stayCancelled ?? null,
    stayUnlinked: s.stayUnlinked ?? null,
  };
}

function storedGate(i: GateInput): ReplayGate {
  const last = i.diff.lastTouch;
  return {
    urgent: i.urgent,
    enteredAt: i.enteredAt,
    expireAfterMs: i.expireAfterMs,
    address: { blocked: i.address.blocked, lowRatingAt: i.address.lowRatingAt },
    consent: { state: i.consent.state },
    channelRules: { audienceOk: i.channelRules.audienceOk, audienceFact: i.channelRules.audienceFact, ruleFail: i.channelRules.ruleFail },
    caps: { touches: i.caps.touches, maxTouches: i.caps.maxTouches, clicks: i.caps.clicks, stopAfterClicks: i.caps.stopAfterClicks },
    diff: {
      lastTouch: last ? { channel: last.channel, variantId: last.variantId, slot: last.slot, sendKey: last.sendKey, purpose: last.purpose, at: last.at } : null,
      variantId: i.diff.variantId,
      slot: i.diff.slot,
    },
    weekly: { count: i.weekly.count, limit: i.weekly.limit },
    quiet: {
      venueTz: i.quiet.venueTz,
      phoneTz: i.quiet.phoneTz,
      window: { start: i.quiet.window.start, end: i.quiet.window.end },
      utilityWindow: { start: i.quiet.utilityWindow.start, end: i.quiet.utilityWindow.end },
      jitterMinutes: [i.quiet.jitterMinutes[0], i.quiet.jitterMinutes[1]],
    },
    fairUse: { count: i.fairUse.count, limit: i.fairUse.limit },
    credits: { price: i.credits.price, spendable: i.credits.spendable, waitStartedAt: i.credits.waitStartedAt, queueHours: i.credits.queueHours },
  };
}

function storedFacts(f: ChannelFacts): ReplayChannelFacts {
  return { channel: f.channel, hasAddress: f.hasAddress, consent: f.consent, suppressed: f.suppressed, audienceOk: f.audienceOk, hasWording: f.hasWording, ruleFail: f.ruleFail };
}

/**
 * A value Firestore can store as it is: `undefined` → null (the types say it can't
 * happen; loaded docs sometimes disagree), a Date or Timestamp → ms.
 */
export function storable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(storable);
  if (value && typeof value === 'object') {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === 'function') return (toMillis as () => number).call(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = storable(v);
    return out;
  }
  return value;
}

export function buildReplaySnapshot(args: ReplayArgs): ReplaySnapshot {
  let snap: ReplaySnapshot;
  if (args.stage === 'system') {
    snap = { v: REPLAY_VERSION, stage: 'system', system: storedSystem(args.system), gate: null, channel: null };
  } else if (args.stage === 'channel') {
    const c = args.channel;
    snap = {
      v: REPLAY_VERSION,
      stage: 'channel',
      system: storedSystem(args.system),
      gate: null,
      channel: {
        facts: c.facts.map(storedFacts),
        rule: typeof c.rule === 'object' ? { fixed: c.rule.fixed } : c.rule,
        ladder: [...c.ladder],
        ladderPos: c.ladderPos,
        lastTouchChannel: c.lastTouchChannel,
        preferredChannel: c.preferredChannel,
        consecutiveNoClickOnPreferred: c.consecutiveNoClickOnPreferred,
        lastClickChannel: c.lastClickChannel,
      },
    };
  } else {
    snap = { v: REPLAY_VERSION, stage: 'gate', system: storedSystem(args.input.system), gate: storedGate(args.input), channel: null };
  }
  return storable(snap) as ReplaySnapshot;
}

/** A snapshot read back from Firestore, or null when there is none (older records) or it is not one. */
export function readReplaySnapshot(raw: unknown): ReplaySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = storable(raw) as Partial<ReplaySnapshot>;
  if (s.v !== REPLAY_VERSION || !s.system || typeof s.system !== 'object') return null;
  if (s.stage === 'gate' && s.gate && typeof s.gate === 'object') return { ...s, channel: null } as ReplaySnapshot;
  if (s.stage === 'channel' && s.channel && Array.isArray(s.channel.facts)) return { ...s, gate: null } as ReplaySnapshot;
  if (s.stage === 'system') return { ...s, gate: null, channel: null } as ReplaySnapshot;
  return null;
}

// ── Shared with the send path (so a replay decides exactly like it) ──────────

/** Rule 1 on its own, as a gate result (the send path's pre-check). */
export function systemGate(pre: RuleCheck): GateResult {
  if (pre.verdict === 'allow') return { verdict: 'allow', rule: null, reason: null, until: null, checks: [pre] };
  return { verdict: pre.verdict, rule: 'system', reason: pre.reason ?? null, until: pre.until ?? null, checks: [pre] };
}

/**
 * No usable channel: say why in the owner's words when the only obstacle was their own
 * audience choice — among the ladder's channels this guest could be reached on at all
 * (has an address, not switched off).
 */
export function noChannelFor(checks: ChannelCheck[], ladder: Channel[]): { rule: RuleName; reason: string; fact: string } | undefined {
  const reachable = checks.filter((c) => !c.ok && ladder.includes(c.channel) && c.reason !== 'no_address' && c.reason !== 'whatsapp_off');
  const onlyAudience = reachable.length > 0 && reachable.every((c) => c.reason === 'audience');
  if (onlyAudience) return { rule: 'channel_rules', reason: 'audience', fact: 'the owner chose to message verified guests only' };
  // Every channel this guest has lacks a yes: say it's consent, not "no channel could be used".
  // All taken back — by the guest (STOP, unsubscribe) or by the owner's "Stop marketing" (PR D) —
  // is "stopped"; otherwise no yes was given here (or the owner lifted a stop with none behind it).
  const consentOnly = reachable.length > 0 && reachable.every((c) => c.reason === 'consent_revoked' || c.reason === 'no_consent');
  if (!consentOnly) return undefined;
  if (reachable.every((c) => c.reason === 'consent_revoked')) return { rule: 'consent', reason: 'no_consent', fact: 'marketing to this guest was stopped' };
  return { rule: 'consent', reason: 'no_consent', fact: `no yes for ${[...new Set(reachable.map((c) => c.channel))].join(', ')} from this venue` };
}

// ── Re-running ───────────────────────────────────────────────────────────────

function systemFrom(s: ReplaySystem): GateInput['system'] {
  return { ...s, freezeWindowMs: s.freezeWindowMs ?? undefined, stayCancelled: s.stayCancelled ?? undefined, stayUnlinked: s.stayUnlinked ?? undefined };
}

function systemInput(stored: DecisionRecord, snap: ReplaySnapshot): GateInput {
  // Rule 1 reads only these (the send path passes the same partial input).
  return { now: stored.at, mode: stored.mode, purpose: stored.purpose, channel: SYSTEM_PRECHECK_CHANNEL, intendedAt: stored.slot.plannedAt, system: systemFrom(snap.system) } as GateInput;
}

function gateInputFrom(stored: DecisionRecord, gate: ReplayGate, system: ReplaySystem, sendKey: string): GateInput {
  return {
    ...gate,
    now: stored.at,
    mode: stored.mode,
    purpose: stored.purpose,
    channel: stored.channel.picked ?? SYSTEM_PRECHECK_CHANNEL,
    intendedAt: stored.slot.plannedAt,
    jitterKey: sendKey,
    system: systemFrom(system),
  };
}

/** Rebuilds the record with `buildDecision` (same 140-char cut); what isn't re-run is copied. */
function rebuild(
  stored: DecisionRecord,
  over: { gate: GateResult | null; channelChecks?: ChannelCheck[]; channel?: { picked: Channel | null; rule: string }; noChannel?: { rule: RuleName; reason: string; fact: string } },
): DecisionRecord {
  return buildDecision({
    now: stored.at,
    mode: stored.mode,
    poolKey: stored.poolKey,
    purpose: stored.purpose,
    gate: over.gate,
    channelChecks: over.channelChecks ?? (stored.channel.rejected ?? []).map((r) => ({ channel: r.channel, ok: false, reason: r.reason })),
    channel: over.channel ?? { picked: stored.channel.picked, rule: stored.channel.rule },
    variant: stored.variant,
    slot: stored.slot,
    credits: stored.credits,
    versions: stored.versions,
    ...(over.noChannel ? { noChannel: over.noChannel } : {}),
  });
}

/** A live send stopped after the gate allowed it (channel not ready, no address…): every check is ok. */
export function isDispatchStop(stored: DecisionRecord): boolean {
  return stored.result !== 'allow' && stored.checks.length > 0 && stored.checks.every((c) => c.ok);
}

export type ReplayResultStage = ReplayStage | 'dispatch';

export interface Difference {
  field: string;
  stored: unknown;
  replayed: unknown;
}

export interface ReplayOutcome {
  stage: ReplayResultStage;
  replayed: DecisionRecord;
  same: boolean;
  differences: Difference[];
  /** When the replay can't say everything (a later stage wasn't recorded) or the send stopped at dispatch. */
  note: string | null;
}

/** Re-runs the stored decision from its snapshot. `sendKey` is the jitter key (quiet-hours `until`). */
export function replayDecision(stored: DecisionRecord, snapshot: ReplaySnapshot, sendKey: string): ReplayOutcome {
  let stage: ReplayResultStage = snapshot.stage;
  let replayed: DecisionRecord;
  let note: string | null = null;

  if (snapshot.stage === 'gate' && snapshot.gate) {
    const g = runGate(gateInputFrom(stored, snapshot.gate, snapshot.system, sendKey));
    replayed = rebuild(stored, { gate: g });
    if (isDispatchStop(stored)) {
      stage = 'dispatch';
      if (g.verdict === 'allow') {
        // The gate's part replays; the stop after it (the adapter, the address…) isn't a rule.
        replayed = { ...replayed, result: stored.result, rule: stored.rule, reason: stored.reason };
        note = `the gate allowed it; then the send was stopped (${stored.reason ?? 'unknown'})`;
      } else {
        note = 'recorded as stopped after the gate allowed it, but the gate no longer allows it';
      }
    }
  } else {
    const pre = checkSystem(systemInput(stored, snapshot));
    if (snapshot.stage === 'system' || pre.verdict !== 'allow' || !snapshot.channel) {
      replayed = rebuild(stored, { gate: systemGate(pre), channelChecks: [], channel: { picked: null, rule: 'not reached' } });
      if (snapshot.stage === 'system' && pre.verdict === 'allow') note = 'rule 1 now lets it through; the channel pick and the gate after it were not recorded';
      if (snapshot.stage === 'channel' && pre.verdict !== 'allow') note = 'rule 1 now stops it before the channel pick';
    } else {
      const c = snapshot.channel;
      const checks = c.facts.map((f) => checkChannel(stored.purpose, f));
      const pick = pickChannel({
        rule: c.rule,
        eligible: checks.filter((x) => x.ok).map((x) => x.channel),
        ladder: c.ladder,
        state: {
          counters: { touches: 0, clicks: 0, opens: 0, ladderPos: c.ladderPos, consecutiveNoClick: 0 },
          lastTouch: c.lastTouchChannel ? { channel: c.lastTouchChannel, variantId: '', slot: '', sendKey: '', purpose: stored.purpose, at: 0 } : null,
        },
        preferredChannel: c.preferredChannel,
        consecutiveNoClickOnPreferred: c.consecutiveNoClickOnPreferred,
        lastClickChannel: c.lastClickChannel,
      });
      if (!pick.channel) {
        replayed = rebuild(stored, { gate: null, channelChecks: checks, channel: { picked: null, rule: pick.rule }, noChannel: noChannelFor(checks, c.ladder) });
      } else {
        replayed = rebuild(stored, { gate: { verdict: 'allow', rule: null, reason: null, until: null, checks: [] }, channelChecks: checks, channel: { picked: pick.channel, rule: pick.rule } });
        note = `the channel pick now finds ${pick.channel}; the gate after it was not recorded, so it can't be re-run`;
      }
    }
  }

  const { same, differences } = compareDecisions(stored, replayed);
  return { stage, replayed, same, differences, note };
}

// ── Comparing ────────────────────────────────────────────────────────────────

const orNull = (v: unknown) => (v === undefined ? null : v);

/**
 * Field by field (Firestore doesn't keep map key order, so never JSON.stringify):
 * the verdict, the checklist by rule, and the channel pick.
 */
export function compareDecisions(stored: DecisionRecord, replayed: DecisionRecord): { same: boolean; differences: Difference[] } {
  const differences: Difference[] = [];
  const cmp = (field: string, a: unknown, b: unknown) => {
    if (orNull(a) !== orNull(b)) differences.push({ field, stored: orNull(a), replayed: orNull(b) });
  };
  cmp('result', stored.result, replayed.result);
  cmp('rule', stored.rule, replayed.rule);
  cmp('reason', stored.reason, replayed.reason);
  cmp('until', stored.until, replayed.until);

  const sChecks = stored.checks ?? [];
  const rChecks = replayed.checks ?? [];
  const rules = Array.from(new Set([...sChecks.map((c) => c.rule), ...rChecks.map((c) => c.rule)]));
  for (const rule of rules) {
    const s = sChecks.find((c) => c.rule === rule);
    const r = rChecks.find((c) => c.rule === rule);
    if (!s || !r) {
      differences.push({ field: `checks.${rule}`, stored: s ? { ok: s.ok, fact: s.fact } : null, replayed: r ? { ok: r.ok, fact: r.fact } : null });
      continue;
    }
    cmp(`checks.${rule}.ok`, s.ok, r.ok);
    cmp(`checks.${rule}.fact`, s.fact, r.fact);
  }
  if (!differences.some((d) => d.field.startsWith('checks.'))) cmp('checks.order', sChecks.map((c) => c.rule).join(','), rChecks.map((c) => c.rule).join(','));

  cmp('channel.picked', stored.channel?.picked, replayed.channel?.picked);
  cmp('channel.rule', stored.channel?.rule, replayed.channel?.rule);
  const sRej = stored.channel?.rejected ?? [];
  const rRej = replayed.channel?.rejected ?? [];
  for (const ch of Array.from(new Set([...sRej.map((x) => x.channel), ...rRej.map((x) => x.channel)]))) {
    cmp(`channel.rejected.${ch}`, sRej.find((x) => x.channel === ch)?.reason, rRej.find((x) => x.channel === ch)?.reason);
  }
  return { same: differences.length === 0, differences };
}

/** What the admin sees of a decision next to its replay. */
export function decisionSummary(d: DecisionRecord): Pick<DecisionRecord, 'result' | 'rule' | 'reason' | 'until' | 'checks'> {
  return { result: d.result, rule: orNull(d.rule) as RuleName | null, reason: orNull(d.reason) as string | null, until: orNull(d.until) as number | null, checks: d.checks ?? [] };
}

/**
 * For a record without a snapshot: the cheap check. The first failing check is the
 * stored rule (an allow has none and no rule; a stop after an allow has none either).
 */
export function consistencyCheck(stored: DecisionRecord): { firstFailingCheckIsRule: boolean } {
  const firstFail = (stored.checks ?? []).find((c) => !c.ok);
  if (firstFail) return { firstFailingCheckIsRule: firstFail.rule === stored.rule };
  return { firstFailingCheckIsRule: stored.result === 'allow' ? orNull(stored.rule) === null : isDispatchStop(stored) };
}

// ── The admin answer ─────────────────────────────────────────────────────────

type Summary = ReturnType<typeof decisionSummary>;

export const NOT_REPLAYABLE_REASON = 'recorded before replay inputs were kept';

export type ReplayAnswer =
  | {
      replayable: true;
      sendKey: string;
      same: boolean;
      stage: ReplayResultStage;
      /** A difference with `sameCode: true` is a bug; with `false` the code changed since. */
      engine: { recorded: string | null; current: string; sameCode: boolean };
      stored: Summary;
      replayed: Summary;
      differences: Difference[];
      sentence: { stored: string; replayed: string };
      /** Set when the send stopped after the gate allowed it, or a later stage wasn't recorded. */
      note: string | null;
    }
  | {
      replayable: false;
      sendKey: string | null;
      reason: string;
      consistency: { firstFailingCheckIsRule: boolean };
      stored: Summary;
      sentence: { stored: string };
    };

/** The answer for one stored decision (`replay` as read from Firestore; sentences in `tz`). */
export function replayAnswer(args: { stored: DecisionRecord; replay: unknown; sendKey: string | null; lang: 'en' | 'de'; tz: string }): ReplayAnswer {
  const { stored, sendKey, lang, tz } = args;
  const snapshot = readReplaySnapshot(args.replay);
  if (!snapshot || !sendKey) {
    return {
      replayable: false,
      sendKey,
      reason: NOT_REPLAYABLE_REASON,
      consistency: consistencyCheck(stored),
      stored: decisionSummary(stored),
      sentence: { stored: explainDecision(stored, lang, tz) },
    };
  }
  const out = replayDecision(stored, snapshot, sendKey);
  const recorded = stored.versions?.runtime ?? null;
  return {
    replayable: true,
    sendKey,
    same: out.same,
    stage: out.stage,
    engine: { recorded, current: ENGINE_RUNTIME_VERSION, sameCode: recorded === ENGINE_RUNTIME_VERSION },
    stored: decisionSummary(stored),
    replayed: decisionSummary(out.replayed),
    differences: out.differences,
    sentence: { stored: explainDecision(stored, lang, tz), replayed: explainDecision(out.replayed, lang, tz) },
    note: out.note,
  };
}
