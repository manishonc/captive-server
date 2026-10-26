/**
 * What comes next in a guest's running journey, in the owner's terms (the cms guest full view,
 * "What will happen"): the next message step and its name, whether a wait or the guest's
 * reaction comes first, or that the journey ends when its wait is over. Plus the journey's goal
 * (what ends it early, and the message that follows).
 *
 * Pure: the journey definition, the instance's state and the step names. Steps are named after
 * their message (the send step's pool), never a code. A branch or a split ahead depends on the
 * guest, so nothing is guessed past one.
 */

import { pickLang, type JourneyDefinition } from '../schemas';
import { durationMs } from '../runtime/time';

export interface OwnerStep {
  key: string;
  name: string;
}

export interface JourneyAhead {
  /** `message`: a message step comes next; `end`: the journey ends when the wait is over. */
  kind: 'message' | 'end';
  /** The message step (kind `message`), when the template names it. */
  step: OwnerStep | null;
  /** A wait comes first (a delay, a date, or a wait for the guest's reaction). */
  afterWait: boolean;
  /** It only comes if the guest doesn't react before the wait is over. */
  ifNoReaction: boolean;
}

export interface JourneyGoal {
  /** The event that reaches the goal (`offer.redeemed`, `visit.started` …). */
  event: string;
  /** The message that follows reaching it (the goal's step), when it has one. */
  step: OwnerStep | null;
}

/** Each send step's name (its message pool's), in `lang`. */
export function stepNamesOf(def: JourneyDefinition, lang: 'en' | 'de'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, node] of Object.entries(def.nodes)) {
    if (node.type !== 'send') continue;
    const poolKey = (node.config as { pool?: unknown } | undefined)?.pool;
    const name = typeof poolKey === 'string' ? def.pools[poolKey]?.name : undefined;
    const words = name ? pickLang(name, lang) : '';
    if (words) out[key] = words;
  }
  return out;
}

/** The single way on from a step that waits or does bookkeeping (no guest choice involved). */
const WAY_ON: Record<string, string> = {
  delay: 'done',
  wait_until: 'done',
  issue_offer: 'done',
  notify_owner: 'done',
  set_tag: 'done',
};

const MAX_HOPS = 12;

export interface AheadState {
  status: string;
  waiting?: { kind?: string | null; nodeId?: string | null } | null;
  cursor?: { nodeId?: string | null } | null;
}

/** What comes next for a running instance; null when it isn't running, isn't waiting, or the way on depends on the guest. */
export function journeyAhead(def: JourneyDefinition, state: AheadState, names: Record<string, string>): JourneyAhead | null {
  if (state.status !== 'active' || !state.waiting) return null;
  const here = state.waiting.nodeId ?? state.cursor?.nodeId ?? null;
  const node = here ? def.nodes[here] : undefined;
  if (!here || !node) return null;
  const stepOf = (key: string): OwnerStep | null => (names[key] ? { key, name: names[key] } : null);

  if (state.waiting.kind === 'send_due') return { kind: 'message', step: stepOf(here), afterWait: false, ifNoReaction: false };

  // Waiting for the guest: what comes if they don't react (the timeout's way).
  const ifNoReaction = state.waiting.kind === 'events';
  let key: string | undefined = ifNoReaction ? node.edges.timeout : node.edges[WAY_ON[node.type] ?? ''];
  for (let hops = 0; key && hops < MAX_HOPS; hops += 1) {
    const next: JourneyDefinition['nodes'][string] | undefined = def.nodes[key];
    if (!next) return null;
    if (next.type === 'send') return { kind: 'message', step: stepOf(key), afterWait: true, ifNoReaction };
    if (next.type === 'exit') return { kind: 'end', step: null, afterWait: true, ifNoReaction };
    const way: string | undefined = WAY_ON[next.type];
    if (!way) return null;
    key = next.edges[way];
  }
  return null;
}

/**
 * The journey waits for its issued offer to run out on some way on from `from` (a wait_until
 * anchored on the offer's end, as Welcome → come back v2 does), so the offer's end is also when
 * the journey ends. False for a journey that ends earlier whatever the offer (v1 ends ~5 days in).
 */
export function waitsForOfferEnd(def: JourneyDefinition, from: string | null | undefined): boolean {
  if (!from || !def.nodes[from]) return false;
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const key = queue.shift() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = def.nodes[key];
    if (!node) continue;
    if (node.type === 'wait_until' && (node.config as { anchor?: unknown }).anchor === 'offer.expiresAt') return true;
    queue.push(...Object.values(node.edges));
  }
  return false;
}

/**
 * The goal can still end the journey early: not reached yet (a reached goal leaves the journey
 * running only until its thank-you goes, often held overnight), and its window (`within`,
 * counted from the start) not over.
 */
export function goalStillOpen(def: JourneyDefinition, inst: { goal?: unknown; startedAtMs: number | null }, nowMs: number): boolean {
  if (!def.goal || inst.goal) return false;
  let within: number | null = null;
  try {
    within = durationMs(def.goal.within);
  } catch {
    within = null;
  }
  return !(within !== null && inst.startedAtMs !== null && nowMs - inst.startedAtMs > within);
}

/** The journey's goal and the message after it; null for a journey without a goal. */
export function journeyGoal(def: JourneyDefinition, names: Record<string, string>): JourneyGoal | null {
  const event = def.goal?.event;
  if (!event) return null;
  const onReach = def.goal?.onReach;
  return { event, step: onReach && names[onReach] ? { key: onReach, name: names[onReach] } : null };
}
