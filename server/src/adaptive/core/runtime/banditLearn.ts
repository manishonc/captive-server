/**
 * What the bandit learns from one send (PR F1, the brief's DF1). Pure — the learner
 * (`bandit/learn.ts`) reads the events and sends and applies these deltas.
 *
 *  - A send's whole reward lands when it closes (its 7 days + 12 hours are over), so the draw only
 *    ever sees finished sends: counting a click the day it happens but "no click" a week later
 *    would make any arm with young sends look good, and the bandit would lock onto whichever
 *    wording is getting the traffic. Until then the learner only keeps the counts the admin
 *    numbers show (sends, clicks, visits, ratings, unsubscribes) and remembers which sends were
 *    clicked, rated, came back or unsubscribed (`SendFacts`, by the event's own time).
 *  - At close: a click within 7 days α+1; a rating α+2 whatever the stars (rewarding high stars
 *    only would be review gating), once per send; a return visit to the venue within 7 days α+4,
 *    once per journey, credited to that journey's last live marketing send before the visit
 *    (nothing when that send can't train: it is the one the guest came back after); no click
 *    β+1; an email unsubscribe or spam report β+10, once per send; an SMS STOP β+10 when this send
 *    was the number's last live SMS and the STOP came within 7 days; a hard bounce nothing (a bad
 *    address says nothing about the wording).
 *  - Only live marketing sends with a bandit block train; test runs never do. Rewards count
 *    within 7 days of the send (engine clock). A slot arm learns only from sends that went inside
 *    their slot (`slot.in`): a send held past its slot says nothing about that slot.
 */

import { FLAT_PRIOR, POOL_MIN_CLOSED, VENUE_MIN_CLOSED, fallbackPrior, priorFor, probabilityBest, round3, stepMean, type ArmBlock, type ArmData, type BanditBlock, type Segment } from './bandit';
import { DAY_MS, HOUR_MS } from './time';

export const LEARN_WINDOW_MS = 7 * DAY_MS;
/**
 * A send closes this long after its 7 days, so a late signal (a click, rating or Wi-Fi connect
 * the worker handles hours late, counted by its own time) is in before its reward lands.
 */
export const CLOSE_MARGIN_MS = 12 * HOUR_MS;
export const REWARD = { click: 1, visit: 4, rating: 2, unsub: 10, noClick: 1 } as const;

/** The send fields the learner reads. */
export interface LearnSend {
  sendKey: string;
  mode: 'live' | 'test';
  purpose: 'marketing' | 'service';
  status: string;
  channel: string;
  journeyKey: string;
  nodeId: string;
  instanceId: string;
  sentAt: number | null;
  firstClickAt: number | null;
  bandit: BanditBlock | null;
}

/** One arm's change. */
export interface ArmDelta {
  a?: number;
  b?: number;
  pulls?: number;
  closed?: number;
  click?: number;
  visit?: number;
  rating?: number;
  unsub?: number;
}

export interface Delta {
  journeyKey: string;
  nodeId: string;
  seg: Segment;
  kind: 'variant' | 'slot';
  arm: string;
  d: ArmDelta;
}

/** A send that can train: live, marketing, accepted by the provider, with a block. */
export function trains(s: LearnSend | null | undefined): s is LearnSend & { bandit: BanditBlock; sentAt: number } {
  return Boolean(s && s.mode === 'live' && s.purpose === 'marketing' && s.bandit && typeof s.sentAt === 'number' && !['failed', 'cancelled', 'dispatching'].includes(s.status));
}

/** A live marketing message the guest got (block or not): what a return visit is credited to. */
function reached(s: LearnSend): s is LearnSend & { sentAt: number } {
  return s.mode === 'live' && s.purpose === 'marketing' && typeof s.sentAt === 'number' && !['failed', 'cancelled', 'dispatching', 'bounced'].includes(s.status);
}

/** The arms a send's outcome lands on: its wording (always), its slot (only if it went in the slot). */
function armsOf(s: LearnSend & { bandit: BanditBlock }, d: ArmDelta): Delta[] {
  const out: Delta[] = [];
  const b = s.bandit;
  if (b.var?.pick) out.push({ journeyKey: s.journeyKey, nodeId: s.nodeId, seg: b.seg, kind: 'variant', arm: b.var.pick, d });
  if (b.slot?.pick && b.slot.in === true) out.push({ journeyKey: s.journeyKey, nodeId: s.nodeId, seg: b.seg, kind: 'slot', arm: b.slot.pick, d });
  return out;
}

const inWindow = (s: { sentAt: number }, at: number) => at >= s.sentAt && at - s.sentAt <= LEARN_WINDOW_MS;

/** An event that charges its send β+10 (an email unsubscribe or spam report): once per send. */
export function isPenalty(ev: { type: string; data?: Record<string, unknown> }): boolean {
  return ev.type === 'consent.revoked' && String(ev.data?.source ?? '') !== 'sms_keyword';
}

/** What the learner remembers about a send until it closes (its reward lands then). */
export interface SendFacts {
  clicked: boolean;
  rated: boolean;
  visited: boolean;
  penalized: boolean;
}

/**
 * A log event's counts for the send it names (`sendKey`): the pull, and the reactions the admin
 * numbers show (no α or β: they land at close, `deltasForClose`). The learner also remembers a
 * rating or an unsubscribe (`SendFacts`), once per send.
 */
export function deltasForEvent(ev: { type: string; occurredAt: number; data?: Record<string, unknown> }, s: LearnSend | null): Delta[] {
  if (!trains(s)) return [];
  switch (ev.type) {
    case 'message.sent':
      return armsOf(s, { pulls: 1 });
    case 'message.clicked':
      return inWindow(s, ev.occurredAt) ? armsOf(s, { click: 1 }) : [];
    case 'rating.submitted':
      return inWindow(s, ev.occurredAt) ? armsOf(s, { rating: 1 }) : [];
    case 'consent.revoked':
      // The unsubscribe page and Brevo's unsubscribe / spam carry the send; an SMS STOP doesn't (see deltasForClose).
      return inWindow(s, ev.occurredAt) && isPenalty(ev) ? armsOf(s, { unsub: 1 }) : [];
    default:
      return [];
  }
}

/**
 * A return visit: for each of the guest's journeys at the venue, its last live marketing send in
 * the 7 days before the visit (sends of other journeys never share it), unless that journey was
 * credited already. The journey's one credit goes to that send — to nothing when it can't train
 * (no block: sent with the bandit off, forced, a rotation) — never to an earlier send. `sends`
 * are the credited sends that train (their α+4 lands at close); `deltas` the visit counts shown.
 */
export function deltasForVisit(visitAt: number, sends: LearnSend[], credited: Set<string>): { deltas: Delta[]; instances: string[]; sends: string[] } {
  const last = new Map<string, LearnSend & { sentAt: number }>();
  for (const s of sends) {
    if (!reached(s) || s.sentAt >= visitAt || visitAt - s.sentAt > LEARN_WINDOW_MS || credited.has(s.instanceId)) continue;
    const prev = last.get(s.instanceId);
    if (!prev || s.sentAt > prev.sentAt) last.set(s.instanceId, s);
  }
  const deltas: Delta[] = [];
  const trained: string[] = [];
  for (const s of last.values()) {
    if (!trains(s)) continue;
    deltas.push(...armsOf(s, { visit: 1 }));
    trained.push(s.sendKey);
  }
  return { deltas, instances: [...last.keys()], sends: trained };
}

/**
 * A send whose 7 days (+ 12 hours) are over: one more finished send and its whole reward — α for a
 * click in the window (the send's first click), a rating and a return visit it got; β+1 without
 * a click; β+10 for an email unsubscribe or spam report on it, or an SMS STOP it caused (the
 * number's block came in the window while this send was its last live SMS).
 */
export function deltasForClose(s: LearnSend, phone: { stopAt: number | null; lastLiveSmsKey: string | null } | null, facts: SendFacts): Delta[] {
  if (!trains(s) || s.status === 'bounced') return [];
  // The click's own time (the fact); the send doc's first click is when the worker applied it.
  const clicked = facts.clicked || (typeof s.firstClickAt === 'number' && inWindow(s, s.firstClickAt));
  const stopAt = phone?.stopAt ?? null;
  const stopped = s.channel === 'sms' && stopAt !== null && inWindow(s, stopAt) && phone?.lastLiveSmsKey === s.sendKey;
  const d: ArmDelta = { closed: 1 };
  const a = (clicked ? REWARD.click : 0) + (facts.rated ? REWARD.rating : 0) + (facts.visited ? REWARD.visit : 0);
  let b = clicked ? 0 : REWARD.noClick;
  if (facts.penalized || stopped) b += REWARD.unsub;
  // An SMS STOP has no event of its own: its unsubscribe count lands here.
  if (stopped) d.unsub = 1;
  if (a) d.a = a;
  if (b) d.b = b;
  return armsOf(s, d);
}

/** Sums deltas per arms doc (journey + step), segment (and `all`), kind and arm. */
export function groupDeltas(deltas: Delta[]): Map<string, { journeyKey: string; nodeId: string; blocks: Record<string, Record<string, Record<string, ArmDelta>>> }> {
  const out = new Map<string, { journeyKey: string; nodeId: string; blocks: Record<string, Record<string, Record<string, ArmDelta>>> }>();
  for (const x of deltas) {
    const key = `${x.journeyKey}\u0000${x.nodeId}`;
    const doc = out.get(key) ?? { journeyKey: x.journeyKey, nodeId: x.nodeId, blocks: {} };
    for (const seg of ['all', x.seg]) {
      const kinds = (doc.blocks[seg] ??= {});
      const arms = (kinds[x.kind] ??= {});
      const cur = (arms[x.arm] ??= {});
      for (const [k, v] of Object.entries(x.d) as Array<[keyof ArmDelta, number]>) cur[k] = (cur[k] ?? 0) + v;
    }
    out.set(key, doc);
  }
  return out;
}

// ── Drift, retire, pool ──────────────────────────────────────────────────────

/** Weekly: the data part × 0.95 (the prior, added at pick time, keeps its weight), so old wins fade. */
export const DRIFT = 0.95;
export const RETIRE_MIN_CLOSED = 200;
export const RETIRE_BELOW = 0.01;

/** A block with every arm's α and β drifted (counts stay: they are what happened). */
export function drifted(block: ArmBlock | undefined): ArmBlock {
  const out: ArmBlock = {};
  for (const kind of ['variant', 'slot'] as const) {
    const arms = block?.[kind];
    if (!arms) continue;
    out[kind] = {};
    for (const [k, v] of Object.entries(arms)) out[kind]![k] = { ...v, a: round3((Number(v.a) || 0) * DRIFT), b: round3((Number(v.b) || 0) * DRIFT) };
  }
  return out;
}

/**
 * The weekly retire check of a venue's wordings at one step. A wording with ≥ 200 finished sends
 * and under 1 % chance of being best among the active ones (prior + data, the priors the pick
 * uses) is `low`; one that was low at the last check too retires (never the last active one).
 * Retiring is for good, and near-equal wordings each dip low now and then: one check at 5 % retired
 * a wording as good as the other at 4 venues in 10 within a quarter; two in a row at 1 % almost
 * never does, and Thompson already sends a hopeless wording rarely. Only today's texts (`current`,
 * arm keys) compete: an arm whose text was edited away is never sent again, so it can't push the
 * others out. Slots are never retired.
 */
export function toRetire(variant: Record<string, ArmData> | undefined, pooled: Record<string, ArmData> | undefined, seed: string, current: string[]): { retire: string[]; low: string[] } {
  const now = new Set(current);
  const active = Object.entries(variant ?? {}).filter(([key, v]) => now.has(key) && v.retired !== true);
  if (active.length < 2) return { retire: [], low: [] };
  const keys = active.map(([key]) => key);
  const fallback = fallbackPrior(stepMean(variant, VENUE_MIN_CLOSED, keys) ?? stepMean(pooled, POOL_MIN_CLOSED, keys));
  const arms = active.map(([key, v]) => {
    const prior = priorFor(pooled?.[key], fallback);
    return { key, a: prior.a0 + Math.max(0, Number(v.a) || 0), b: prior.b0 + Math.max(0, Number(v.b) || 0) };
  });
  const best = probabilityBest(arms, 2000, seed);
  const retire: string[] = [];
  const low: string[] = [];
  for (const [key, v] of active) {
    if (!((Number(v.closed) || 0) >= RETIRE_MIN_CLOSED && (best[key] ?? 0) < RETIRE_BELOW)) continue;
    if (v.low === true && retire.length < active.length - 1) retire.push(key);
    else low.push(key);
  }
  return { retire, low };
}

/** A venue's `all.variant` block after the weekly check: retired ones marked, `low` set on this week's low ones and cleared on the others. */
export function applyRetire(variant: Record<string, ArmData> | undefined, result: { retire: string[]; low: string[] }): Record<string, ArmData> {
  const out: Record<string, ArmData> = {};
  for (const [key, arm] of Object.entries(variant ?? {})) {
    const { low: _low, ...rest } = arm;
    out[key] = result.retire.includes(key) ? { ...rest, retired: true } : result.low.includes(key) ? { ...rest, low: true } : rest;
  }
  return out;
}

/** The pooled numbers of one journey step: every venue's data summed (the pool doc is rebuilt from this daily). */
export function poolFrom(docs: Array<{ journeyKey: string; nodeId: string; segments?: Partial<Record<Segment | 'all', ArmBlock>> }>): Map<string, { journeyKey: string; nodeId: string; venues: number; segments: Partial<Record<Segment | 'all', ArmBlock>> }> {
  const out = new Map<string, { journeyKey: string; nodeId: string; venues: number; segments: Partial<Record<Segment | 'all', ArmBlock>> }>();
  for (const doc of docs) {
    const key = `${doc.journeyKey}\u0000${doc.nodeId}`;
    const pool = out.get(key) ?? { journeyKey: doc.journeyKey, nodeId: doc.nodeId, venues: 0, segments: {} };
    pool.venues += 1;
    for (const [seg, block] of Object.entries(doc.segments ?? {}) as Array<[Segment | 'all', ArmBlock]>) {
      for (const kind of ['variant', 'slot'] as const) {
        for (const [arm, v] of Object.entries(block?.[kind] ?? {})) {
          const segBlock = (pool.segments[seg] ??= {});
          const arms = (segBlock[kind] ??= {});
          const cur = (arms[arm] ??= { a: 0, b: 0, pulls: 0, closed: 0, rewards: { click: 0, visit: 0, rating: 0 }, penalties: { unsub: 0 } });
          cur.a = round3(cur.a + (Number(v.a) || 0));
          cur.b = round3(cur.b + (Number(v.b) || 0));
          cur.pulls += Number(v.pulls) || 0;
          cur.closed += Number(v.closed) || 0;
          cur.rewards!.click! += Number(v.rewards?.click) || 0;
          cur.rewards!.visit! += Number(v.rewards?.visit) || 0;
          cur.rewards!.rating! += Number(v.rewards?.rating) || 0;
          cur.penalties!.unsub! += Number(v.penalties?.unsub) || 0;
        }
      }
    }
    out.set(key, pool);
  }
  return out;
}

export { FLAT_PRIOR };

