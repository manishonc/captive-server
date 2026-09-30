/**
 * The bandit (PR F1, 04-engine-runtime §9.2): Thompson sampling over the wordings and the time
 * slots one send step may use. Pure — no Firestore. `engine/banditArms.ts` reads the arms,
 * the learner (`bandit/learn.ts`) writes them, `engine/sendPath.ts` asks for a pick.
 *
 *  - An arm is a Beta(α, β): the learner's data from finished sends (clicks, visits, ratings
 *    against sends with no reaction and unsubscribes, all counted when the send's 7 days are over)
 *    plus a prior of 20 pseudo-sends from the pooled numbers of every venue. An arm the pool
 *    doesn't know yet (a new or edited wording) starts at the mean of the wordings it is compared
 *    with, so it gets a fair test; a flat 5 % only while they have no finished sends. The data
 *    level is the guest's segment once it has ≥ 100 finished sends at this step, else the venue.
 *  - Replayable: every draw comes from a generator seeded with the send key (cyrb128 → sfc32),
 *    and the record keeps each candidate's α, β (rounded, and drawn from as rounded) and the
 *    drawn θ. Replay re-checks the pick from the stored θ (always exact) and re-draws θ from the
 *    seed (the same code gives the same θ; another engine version may differ in the last digit).
 *  - Wording arms are keyed on the wording's content (`banditKeys.ts`: `v:` + 12 hex of its hash,
 *    computed from the doc as loaded), so an edited text starts a fresh arm; slot arms on the
 *    slot name. No package import: Replay (`replay.ts`) loads this file and must stay pure.
 */

import { isInWindow } from './time';

// ── Seeded generator ─────────────────────────────────────────────────────────

/** cyrb128: four 32-bit words from a string (the seed of sfc32). */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 seeded from cyrb128(seed): the same seed always gives the same sequence, in (0, 1). */
export function rngFor(seed: string): () => number {
  let [a, b, c, d] = cyrb128(seed);
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return ((t >>> 0) + 0.5) / 4294967296;
  };
  for (let i = 0; i < 12; i += 1) next(); // warm up
  return next;
}

function normal(u: () => number): number {
  return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** Marsaglia–Tsang; shape < 1 via Gamma(shape + 1) · U^(1/shape). Bounded, so it always ends. */
function sampleGamma(shape: number, u: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, u) * Math.pow(u(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i += 1) {
    const x = normal(u);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const w = u();
    if (w < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // the mode: never reached in practice
}

/** One Beta(a, b) draw in (0, 1). */
export function sampleBeta(a: number, b: number, u: () => number): number {
  const x = sampleGamma(Math.max(a, 1e-3), u);
  const y = sampleGamma(Math.max(b, 1e-3), u);
  const t = x / (x + y);
  if (!Number.isFinite(t)) return a / (a + b);
  return Math.min(1 - 1e-9, Math.max(1e-9, t));
}

// ── Thompson pick ────────────────────────────────────────────────────────────

/** α / β as stored and drawn from (3 decimals), θ as stored (6 decimals). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface ArmIn {
  key: string;
  a: number;
  b: number;
  /** The wording's letter (wording arms only), for the admin view. */
  letter?: string;
}

/** One candidate's draw as recorded: key, α, β, θ (and the wording's letter). */
export interface Draw {
  k: string;
  l?: string;
  a: number;
  b: number;
  t: number;
}

/** Candidates sorted by key, one draw each from one seeded stream; the highest θ wins (ties: the smaller key). */
export function thompsonPick(candidates: ArmIn[], seed: string): { picked: string | null; draws: Draw[] } {
  const sorted = [...candidates].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const u = rngFor(seed);
  const draws: Draw[] = sorted.map((c) => {
    const a = round3(c.a);
    const b = round3(c.b);
    return { k: c.key, ...(c.letter ? { l: c.letter } : {}), a, b, t: round6(sampleBeta(a, b, u)) };
  });
  return { picked: pickFromDraws(draws), draws };
}

/** The winner of recorded draws: the highest θ, ties by the smaller key. */
export function pickFromDraws(draws: Draw[]): string | null {
  let best: Draw | null = null;
  for (const d of draws) {
    if (!best || d.t > best.t || (d.t === best.t && d.k < best.k)) best = d;
  }
  return best?.k ?? null;
}

/** Re-draws recorded θs from the seed and the recorded α, β (Replay): the keys whose θ differs. */
export function redrawDifferences(draws: Draw[], seed: string): string[] {
  const u = rngFor(seed);
  const out: string[] = [];
  for (const d of [...draws].sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))) {
    if (round6(sampleBeta(d.a, d.b, u)) !== d.t) out.push(d.k);
  }
  return out;
}

/** The share of `n` seeded Thompson rounds each arm wins ("chance of being best"). */
export function probabilityBest(arms: ArmIn[], n: number, seed: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!arms.length) return out;
  const sorted = [...arms].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const a of sorted) out[a.key] = 0;
  const u = rngFor(seed);
  for (let i = 0; i < n; i += 1) {
    let bestKey = sorted[0].key;
    let bestT = -1;
    for (const a of sorted) {
      const t = sampleBeta(a.a, a.b, u);
      if (t > bestT) {
        bestT = t;
        bestKey = a.key;
      }
    }
    out[bestKey] += 1;
  }
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / n) * 1000) / 1000;
  return out;
}

// ── Arms, priors and levels ──────────────────────────────────────────────────

export type BanditLevel = 'segment' | 'venue' | 'pool' | 'prior';
export type Segment = 'new' | 'returning' | 'stay' | 'unknown';
export const SEGMENTS: Segment[] = ['new', 'returning', 'stay', 'unknown'];

/** A venue arm as stored: the data part only (the prior is added at pick time). */
export interface ArmData {
  a: number;
  b: number;
  pulls: number;
  closed: number;
  rewards?: { click?: number; visit?: number; rating?: number };
  penalties?: { unsub?: number };
  retired?: boolean;
  /** The last weekly retire check found it under 1 % chance of being best (a second one retires it). */
  low?: boolean;
}

/** One block of arms (a segment, or `all`): wordings by arm key, slots by name. */
export interface ArmBlock {
  variant?: Record<string, ArmData>;
  slot?: Record<string, ArmData>;
}

/** The weight of the pooled prior (pseudo-sends), the flat prior (5 %), and when each level counts. */
export const PRIOR_WEIGHT = 20;
export const FLAT_PRIOR = { a0: 1, b0: 19 };
export const POOL_MIN_CLOSED = 200;
export const SEGMENT_MIN_CLOSED = 100;
export const VENUE_MIN_CLOSED = 30;

export interface Prior {
  a0: number;
  b0: number;
  from: 'pool' | 'step' | 'flat';
}

/**
 * The reward rate of the compared arms — Σα / Σ(α+β) over `keys` in a block (so retired and
 * edited-away texts don't count) — once they have `minClosed` finished sends between them; else null.
 */
export function stepMean(block: Record<string, ArmData> | undefined, minClosed: number, keys?: readonly string[]): number | null {
  let a = 0;
  let b = 0;
  let closed = 0;
  for (const [k, v] of Object.entries(block ?? {})) {
    if (keys && !keys.includes(k)) continue;
    a += Math.max(0, Number(v?.a) || 0);
    b += Math.max(0, Number(v?.b) || 0);
    closed += Number(v?.closed) || 0;
  }
  return closed >= minClosed && a + b > 0 ? a / (a + b) : null;
}

/**
 * The prior of an arm the pool doesn't know yet: the compared arms' mean as 20 pseudo-sends. The
 * rewards put that mean far above 5 % (a return visit alone is α+4), so a new wording started at
 * a flat 5 % would almost never beat one with numbers. Flat 5 % while there is no mean.
 */
export function fallbackPrior(mean: number | null): Prior {
  if (mean === null) return { ...FLAT_PRIOR, from: 'flat' };
  const p = Math.min(0.95, Math.max(0.05, mean));
  return { a0: PRIOR_WEIGHT * p, b0: PRIOR_WEIGHT * (1 - p), from: 'step' };
}

/** A pooled arm's prior: its mean over every venue as 20 pseudo-sends; under 200 finished sends, `fallback` (flat 5 % by default). */
export function priorFor(pooled: Pick<ArmData, 'a' | 'b' | 'closed'> | null | undefined, fallback: Prior = { ...FLAT_PRIOR, from: 'flat' }): Prior {
  if (!pooled || !(pooled.closed >= POOL_MIN_CLOSED) || !(pooled.a + pooled.b > 0)) return fallback;
  const p = pooled.a / (pooled.a + pooled.b);
  return { a0: PRIOR_WEIGHT * p, b0: PRIOR_WEIGHT * (1 - p), from: 'pool' };
}

function closedOf(block: Record<string, ArmData> | undefined, keys: string[]): number {
  return keys.reduce((s, k) => s + (Number(block?.[k]?.closed) || 0), 0);
}

/**
 * The arms to draw from: prior (the pooled arm in this segment, else in `all`, else the step's
 * mean, else flat) + the venue's data (this segment's once it has ≥ 100 finished sends among
 * these candidates, else all segments'). The level names the most specific source that has
 * enough data.
 */
export function effectiveArms(args: {
  kind: 'variant' | 'slot';
  keys: Array<{ key: string; letter?: string }>;
  segment: Segment;
  venue: Partial<Record<Segment | 'all', ArmBlock>> | null;
  pool: Partial<Record<Segment | 'all', ArmBlock>> | null;
}): { level: BanditLevel; arms: ArmIn[] } {
  const keyList = args.keys.map((k) => k.key);
  const vSeg = args.venue?.[args.segment]?.[args.kind];
  const vAll = args.venue?.all?.[args.kind];
  const useSegment = closedOf(vSeg, keyList) >= SEGMENT_MIN_CLOSED;
  const data = useSegment ? vSeg : vAll;
  let level: BanditLevel = useSegment ? 'segment' : closedOf(vAll, keyList) >= VENUE_MIN_CLOSED ? 'venue' : 'prior';
  const pSeg = args.pool?.[args.segment]?.[args.kind];
  const pAll = args.pool?.all?.[args.kind];
  // A new arm starts where the candidates are at the level it's compared at (this segment's or
  // the venue's finished sends), else where the pool has them.
  const fallback = fallbackPrior(stepMean(data, useSegment ? SEGMENT_MIN_CLOSED : VENUE_MIN_CLOSED, keyList) ?? stepMean(pAll, POOL_MIN_CLOSED, keyList));
  const arms = args.keys.map(({ key, letter }) => {
    const segPrior = priorFor(pSeg?.[key], fallback);
    const prior = segPrior.from === 'pool' ? segPrior : priorFor(pAll?.[key], fallback);
    if (level === 'prior' && prior.from === 'pool') level = 'pool';
    const d = data?.[key];
    return { key, ...(letter ? { letter } : {}), a: prior.a0 + Math.max(0, Number(d?.a) || 0), b: prior.b0 + Math.max(0, Number(d?.b) || 0) };
  });
  return { level, arms };
}

/** Arms the venue has retired (never the last one: the learner guarantees it, this re-checks). */
export function withoutRetired<T extends { key: string }>(candidates: T[], block: Record<string, ArmData> | undefined): T[] {
  const kept = candidates.filter((c) => block?.[c.key]?.retired !== true);
  return kept.length ? kept : candidates;
}

// ── Keys, segments, slots ────────────────────────────────────────────────────

/** The guest's segment, from the journey's frozen context: a stay, a first visit or a return. */
export function segmentOf(ctx: { stayId?: string | null; visitNumber?: number | null; isFirstVisit?: boolean | null }): Segment {
  if (ctx.stayId) return 'stay';
  if (typeof ctx.visitNumber === 'number' && ctx.visitNumber > 0) return ctx.visitNumber === 1 ? 'new' : 'returning';
  if (ctx.isFirstVisit === true && ctx.visitNumber === undefined) return 'new';
  return 'unknown';
}

export const SLOT_NAMES = ['morning', 'afternoon', 'evening'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** Whether a send at `at` went inside the slot's window (a held send doesn't train the slot). */
export function sentInSlot(at: number, tz: string, window: [string, string] | undefined): boolean {
  if (!window) return false;
  return isInWindow(new Date(at), tz, { start: window[0], end: window[1] });
}

// ── A send's picks ───────────────────────────────────────────────────────────

export interface StepArmsIn {
  venue: Partial<Record<Segment | 'all', ArmBlock>> | null;
  pool: Partial<Record<Segment | 'all', ArmBlock>> | null;
}

/**
 * The wording of one send. `requireDiff: variant` is enforced here: the last touch's wording is
 * never a candidate (one left → `forced:require_diff`, no draws: that send depends on the one
 * before, so it doesn't train an arm). Retired arms are left out (never the last): when only one
 * is left it goes out as `forced:retired` and still trains (one draw), so the step keeps
 * learning. A pool with a single wording → null: nothing to choose, the rotation decides as before.
 */
export function pickWording(args: {
  candidates: Array<{ id: string; letter: string; armKey: string }>;
  lastVariantId: string | null;
  requireDiffVariant: boolean;
  segment: Segment;
  arms: StepArmsIn;
  seed: string;
}): { vid: string; method: string; part: NonNullable<BanditBlock['var']> | null } | null {
  let cands = [...args.candidates].sort((x, y) => x.letter.localeCompare(y.letter));
  // The last touch's text: `requireDiff` means another text, not only another letter.
  const lastKey = args.lastVariantId ? (args.candidates.find((c) => c.id === args.lastVariantId)?.armKey ?? null) : null;
  // Two wordings with the same text are one arm: keep the first letter.
  cands = cands.filter((c, i) => cands.findIndex((o) => o.armKey === c.armKey) === i);
  if (args.requireDiffVariant && args.lastVariantId) {
    const before = cands.length;
    cands = cands.filter((c) => c.id !== args.lastVariantId && c.armKey !== lastKey);
    if (!cands.length) return null;
    if (cands.length === 1 && before > 1) return { vid: cands[0].id, method: 'forced:require_diff', part: null };
  }
  if (cands.length < 2) return null;
  const active = withoutRetired(cands.map((c) => ({ ...c, key: c.armKey })), args.arms.venue?.all?.variant);
  const eff = effectiveArms({ kind: 'variant', keys: active.map((c) => ({ key: c.armKey, letter: c.letter })), segment: args.segment, venue: args.arms.venue, pool: args.arms.pool });
  const pick = thompsonPick(eff.arms, args.seed);
  const chosen = active.find((c) => c.armKey === pick.picked) ?? active[0];
  const method = active.length === 1 ? 'forced:retired' : `bandit:${eff.level}`;
  return { vid: chosen.id, method, part: { lvl: eff.level, pick: chosen.armKey, vid: chosen.id, d: pick.draws } };
}

/** The slot of a `slot` step: Thompson over morning / afternoon / evening (`requireDiff: slot` drops the last one). */
export function pickSlot(args: {
  lastSlot: string | null;
  requireDiffSlot: boolean;
  segment: Segment;
  arms: StepArmsIn;
  seed: string;
}): { slot: SlotName; method: string; part: NonNullable<BanditBlock['slot']> } | null {
  const cands = SLOT_NAMES.filter((s) => !(args.requireDiffSlot && s === args.lastSlot));
  if (cands.length < 2) return null;
  const eff = effectiveArms({ kind: 'slot', keys: cands.map((key) => ({ key })), segment: args.segment, venue: args.arms.venue, pool: args.arms.pool });
  const pick = thompsonPick(eff.arms, args.seed);
  const slot = (pick.picked ?? cands[0]) as SlotName;
  return { slot, method: `bandit:${eff.level}`, part: { lvl: eff.level, pick: slot, d: pick.draws } };
}

// ── The record ───────────────────────────────────────────────────────────────

/**
 * `JourneySends.bandit` / `JourneyEvents.data.bandit` (next to `decision` and `replay`):
 * the segment, and per part (wording, slot) the level, the picked arm and every draw.
 * `vid` is the picked wording's id (it must equal `decision.variant.picked`); `in` whether the
 * send went inside the picked slot (set on the live send; only such sends train the slot).
 */
export interface BanditBlock {
  v: 1;
  seg: Segment;
  var: { lvl: BanditLevel; pick: string | null; vid: string | null; d: Draw[] } | null;
  slot: { lvl: BanditLevel; pick: string | null; d: Draw[]; in?: boolean } | null;
}

export const BANDIT_VERSION = 1;
/** The block's own cap (8 wordings + 3 slots with α, β in the thousands stay under it; `fitBanditBlock`). */
export const BANDIT_MAX_BYTES = 1024;

/** The seeds of a send's two draws (Replay uses the same). */
export const banditSeed = (sendKey: string, part: 'var' | 'slot') => `${sendKey}:bandit:${part}`;

/** The block as read back from Firestore, or null when it isn't one. */
export function readBanditBlock(raw: unknown): BanditBlock | null {
  const b = raw as Partial<BanditBlock> | null | undefined;
  if (!b || typeof b !== 'object' || b.v !== BANDIT_VERSION || typeof b.seg !== 'string') return null;
  const okPart = (p: unknown) => p === null || p === undefined || (typeof p === 'object' && Array.isArray((p as { d?: unknown }).d));
  if (!okPart(b.var) || !okPart(b.slot)) return null;
  return { v: 1, seg: b.seg as Segment, var: (b.var as BanditBlock['var']) ?? null, slot: (b.slot as BanditBlock['slot']) ?? null };
}

/** The wording method a recorded part stands for (`forced:retired`: one candidate was left). */
export function banditMethod(part: NonNullable<BanditBlock['var']>): string {
  return part.d.length === 1 ? 'forced:retired' : `bandit:${part.lvl}`;
}

/** What Replay finds wrong with a recorded block (empty = the picks, the methods and every θ check out). */
export function checkBanditBlock(
  block: BanditBlock,
  sendKey: string,
  decision: { variant: { picked: string | null; method?: string }; slot: { picked: string; rule?: string } },
): Array<{ field: string; stored: unknown; replayed: unknown }> {
  const out: Array<{ field: string; stored: unknown; replayed: unknown }> = [];
  for (const part of ['var', 'slot'] as const) {
    const p = block[part];
    if (!p || !p.d.length) continue;
    const winner = pickFromDraws(p.d);
    if (winner !== p.pick) out.push({ field: `bandit.${part}.pick`, stored: p.pick, replayed: winner });
    for (const k of redrawDifferences(p.d, banditSeed(sendKey, part))) {
      const d = p.d.find((x) => x.k === k)!;
      out.push({ field: `bandit.${part}.draw.${k}`, stored: d.t, replayed: 'drawn again differently' });
    }
  }
  if (block.var?.pick && block.var.vid !== decision.variant.picked) out.push({ field: 'bandit.var.vid', stored: block.var.vid, replayed: decision.variant.picked });
  // A wording sent in English for another language carries `:en_fallback` (the pick is the same).
  const method = decision.variant.method?.replace(/:en_fallback$/, '');
  if (block.var?.pick && method !== undefined && method !== banditMethod(block.var)) {
    out.push({ field: 'variant.method', stored: decision.variant.method, replayed: banditMethod(block.var) });
  }
  if (block.slot?.pick && block.slot.pick !== decision.slot.picked) out.push({ field: 'bandit.slot.pick', stored: block.slot.pick, replayed: decision.slot.picked });
  if (block.slot?.pick && decision.slot.rule !== undefined && decision.slot.rule !== `bandit:${block.slot.lvl}`) {
    out.push({ field: 'slot.rule', stored: decision.slot.rule, replayed: `bandit:${block.slot.lvl}` });
  }
  return out;
}

/**
 * The block trimmed toward its cap at run time: past 1 KB (a pool with many wordings) the letters
 * go (Replay never reads them); every draw, α, β and θ stays, so a pool with more than about 12
 * wordings still goes over (a few hundred bytes more on the send doc).
 */
export function fitBanditBlock(block: BanditBlock): BanditBlock {
  if (JSON.stringify(block).length <= BANDIT_MAX_BYTES) return block;
  const bare = <P extends { d: Draw[] }>(p: P): P => ({ ...p, d: p.d.map(({ l: _l, ...d }) => d) });
  return { ...block, var: block.var ? bare(block.var) : null, slot: block.slot ? bare(block.slot) : null };
}
