/**
 * The journey interpreter (04-engine-runtime §2–§3, 03-playbook-format §3–§4).
 *
 * Pure: it gets the instance state, one input (start / a timer / an event / a
 * send result) and the context, and returns the new state plus effects for the
 * worker to carry out (timers to schedule, a send to run, events to log). It never
 * reads Firestore or calls a provider — the worker does — so tests, the CMS
 * preview and Replay run exactly the same logic.
 *
 * Step handlers exist for the types this round's journeys use: delay, wait_for,
 * wait_until, branch, send, issue_offer, exit. Any other type fails the guest's
 * journey (and the worker alerts) rather than guessing.
 */

import { getNodeContract } from '../registry';
import { pickLang, type JourneyDefinition, type Offer, type SlotValue } from '../schemas';
import { evaluateCondition, getPath, matchesWhere, type FactGetter } from './conditions';
import { DAY_MS, atLocalTime, durationMs, offsetMs } from './time';
import {
  MAX_TRAIL,
  type Effect,
  type EngineEvent,
  type InstanceState,
  type InstanceStatus,
  type LastTouch,
  type RuntimeInput,
  type StepResult,
  type WaitState,
} from './types';

export interface InterpreterContext {
  now: number;
  definition: JourneyDefinition;
  venueTz: string;
  /** The owner's blank values from the pinned config version. */
  slots: Record<string, SlotValue>;
  /** The offers the owner approved for this playbook setup. */
  offers: Offer[];
  /** Facts for `branch` conditions: contact.*, visit.*, venue.*, stay.*, instance.* */
  facts: FactGetter;
  stay: { checkInAt: number; checkOutAt: number; nights: number } | null;
}

type NodeResult =
  | { go: string; vars?: Record<string, unknown>; emit?: Effect[] }
  | { wait: WaitState }
  | { send: true }
  | { exit: InstanceStatus; reason: string }
  | { fail: string };

const MAX_STEPS = 60;

function cloneState(state: InstanceState): InstanceState {
  return JSON.parse(JSON.stringify(state)) as InstanceState;
}

function parseConfig<T>(type: string, config: unknown): T | null {
  const contract = getNodeContract(type);
  if (!contract) return null;
  const parsed = contract.configSchema.safeParse(config ?? {});
  return parsed.success ? (parsed.data as T) : null;
}

// ── Step handlers ────────────────────────────────────────────────────────────

function enterNode(nodeId: string, state: InstanceState, ctx: InterpreterContext): NodeResult {
  const node = ctx.definition.nodes[nodeId];
  if (!node) return { fail: `missing_node:${nodeId}` };
  const { now } = ctx;

  switch (node.type) {
    case 'delay': {
      const c = parseConfig<{ for: string }>('delay', node.config);
      if (!c) return { fail: 'bad_step_config' };
      return { wait: { kind: 'timer', nodeId, token: `${nodeId}@${now}`, untilAt: now + durationMs(c.for) } };
    }

    case 'wait_for': {
      const c = parseConfig<{ events: WaitState['events']; timeout: string }>('wait_for', node.config);
      if (!c) return { fail: 'bad_step_config' };
      return { wait: { kind: 'events', nodeId, token: `${nodeId}@${now}`, untilAt: now + durationMs(c.timeout), events: c.events } };
    }

    case 'wait_until': {
      const c = parseConfig<{ at?: string; day?: 'same_or_next' | 'next'; anchor?: string; offset?: string }>(
        'wait_until',
        node.config,
      );
      if (!c) return { fail: 'bad_step_config' };
      let target: number;
      if (c.anchor) {
        if (!ctx.stay) return { fail: 'no_stay' };
        target = stayTarget(c, ctx.stay, ctx.venueTz);
        if (target <= now) return { go: 'past' };
        // A wait counted from arrival that would end after checkout (the stay was shortened)
        // is over: a during-the-stay message never goes after the guest has left.
        if (c.anchor === 'stay.checkInAt' && target >= ctx.stay.checkOutAt) return { go: 'past' };
      } else {
        if (!c.at) return { fail: 'bad_step_config' };
        const today = atLocalTime(new Date(now), ctx.venueTz, c.at, 0).getTime();
        target = c.day === 'next' || today <= now ? atLocalTime(new Date(now), ctx.venueTz, c.at, 1).getTime() : today;
      }
      return { wait: { kind: 'timer', nodeId, token: `${nodeId}@${now}`, untilAt: target } };
    }

    case 'send':
      if (!parseConfig('send', node.config)) return { fail: 'bad_step_config' };
      return { send: true };

    case 'branch': {
      const c = parseConfig<{ cases: Array<{ when: any; edge: string }> }>('branch', node.config);
      if (!c) return { fail: 'bad_step_config' };
      for (const k of c.cases) {
        if (evaluateCondition(k.when, ctx.facts)) return { go: k.edge };
      }
      return { go: 'default' };
    }

    case 'issue_offer': {
      const c = parseConfig<{ slot: string; expiryDays?: number }>('issue_offer', node.config);
      if (!c) return { fail: 'bad_step_config' };
      const chosen = ctx.slots[c.slot];
      const offer = typeof chosen === 'string' ? ctx.offers.find((o) => o.offerKey === chosen) : undefined;
      if (!offer) return { go: 'none' };
      const slotDays = typeof ctx.slots.offer_days === 'number' ? ctx.slots.offer_days : undefined;
      const days = c.expiryDays ?? slotDays ?? offer.expiryDays;
      const vars = {
        offerKey: offer.offerKey,
        offerLabel: offer.label,
        offerKind: offer.kind,
        offerValue: offer.value,
        offerDays: days,
        offerExpiresAt: now + days * DAY_MS,
      };
      return {
        go: 'done',
        vars,
        emit: [{ type: 'emit', eventType: 'offer.issued', data: { offerKey: offer.offerKey, days, label: pickLang(offer.label) } }],
      };
    }

    case 'exit': {
      const c = parseConfig<{ status: 'completed' | 'exhausted' | 'converted' }>('exit', node.config);
      if (!c) return { fail: 'bad_step_config' };
      return { exit: c.status, reason: `exit:${nodeId}` };
    }

    default:
      return { fail: `unsupported_step:${node.type}` };
  }
}

function wakeNode(nodeId: string, state: InstanceState, ctx: InterpreterContext): NodeResult | null {
  const node = ctx.definition.nodes[nodeId];
  if (!node || state.waiting?.nodeId !== nodeId) return null;
  if (node.type === 'delay' && state.waiting.kind === 'timer') return { go: 'done' };
  if (node.type === 'wait_until' && state.waiting.kind === 'timer') return { go: 'done' };
  if (node.type === 'wait_for' && state.waiting.kind === 'events') return { go: 'timeout' };
  return null;
}

function eventForNode(event: EngineEvent, state: InstanceState): NodeResult | null {
  const w = state.waiting;
  if (!w || w.kind !== 'events' || !w.events) return null;
  for (const e of w.events) {
    if (e.event === event.type && matchesWhere(e.where, event)) return { go: e.key };
  }
  return null;
}

/** When a `wait_until` anchored on the stay ends: the anchor ± offset, at the local time on that day. */
function stayTarget(c: { anchor?: string; offset?: string; at?: string }, stay: NonNullable<InterpreterContext['stay']>, tz: string): number {
  const base = c.anchor === 'stay.checkInAt' ? stay.checkInAt : stay.checkOutAt;
  const shifted = base + offsetMs(c.offset);
  return c.at ? atLocalTime(new Date(shifted), tz, c.at, 0).getTime() : shifted;
}

/** Waiting in a `wait_until` anchored on the stay's dates. */
function isAnchoredTimerWait(state: InstanceState, def: JourneyDefinition): boolean {
  const w = state.waiting;
  const node = def.nodes[state.cursor.nodeId];
  if (!w || w.kind !== 'timer' || w.nodeId !== state.cursor.nodeId || node?.type !== 'wait_until') return false;
  return Boolean((node.config as { anchor?: unknown } | undefined)?.anchor);
}

// ── The loop ─────────────────────────────────────────────────────────────────

function within(startedAt: number, window: string, now: number): boolean {
  return now - startedAt <= durationMs(window);
}

export function step(stateIn: InstanceState, input: RuntimeInput, ctxIn: InterpreterContext): StepResult {
  if (stateIn.status !== 'active') return { state: stateIn, effects: [], unchanged: true };

  const state = cloneState(stateIn);
  // `instance.*` facts come from the working state, so a branch sees what earlier
  // steps of this same run changed (an issued offer, a send's counters).
  const ctx: InterpreterContext = {
    ...ctxIn,
    facts: (path) =>
      path === 'instance' || path.startsWith('instance.')
        ? getPath({ instance: { counters: state.counters, vars: state.vars, lastTouch: state.lastTouch } }, path)
        : ctxIn.facts(path),
  };
  const effects: Effect[] = [];
  const def = ctx.definition;
  const now = ctx.now;
  let result: NodeResult | null = null;

  const moveTo = (nodeId: string): NodeResult => {
    state.cursor = { nodeId, enteredAt: now };
    state.waiting = null;
    return enterNode(nodeId, state, ctx);
  };

  switch (input.kind) {
    case 'start':
      result = moveTo(def.start);
      break;

    case 'wake':
      result = wakeNode(input.nodeId, state, ctx);
      break;

    case 'send_result':
      if (state.cursor.nodeId !== input.nodeId) break;
      if (typeof input.ladderPos === 'number') state.counters.ladderPos = input.ladderPos;
      if (input.touch) {
        state.lastTouch = input.touch;
        if (input.touch.purpose === 'marketing' && input.outcome === 'sent') state.counters.touches += 1;
      }
      result = { go: input.outcome };
      break;

    case 'event': {
      const event = input.event;
      if (event.type === 'message.clicked') {
        state.counters.clicks += 1;
        state.counters.consecutiveNoClick = 0;
      } else if (event.type === 'message.opened') {
        state.counters.opens += 1;
      }
      // Exit rules are checked before the step, so e.g. a rating ends a journey mid-wait.
      // A cancelled booking ends its stay journeys as `cancelled` (D-C19), not completed.
      if (def.exitOn.some((x) => x.event === event.type && matchesWhere(x.where, event))) {
        result = event.type === 'stay.cancelled' ? { exit: 'cancelled', reason: 'stay_cancelled' } : { exit: 'completed', reason: `exit_on:${event.type}` };
        break;
      }
      // The goal is checked continuously and counted once per instance.
      // The window is judged by when the event happened, not when it was handled.
      if (def.goal && !state.goal && event.type === def.goal.event && within(state.startedAt, def.goal.within, Math.min(now, event.occurredAt))) {
        state.goal = { reachedAt: now, eventId: event.id };
        effects.push({ type: 'emit', eventType: 'journey.converted', data: { goalEvent: event.type, eventId: event.id } });
        result = def.goal.onReach ? moveTo(def.goal.onReach) : { exit: def.goal.exit, reason: 'goal' };
        break;
      }
      // New stay dates move a wait anchored on them (plan §3.3 item 3): the step is entered
      // again with the new dates — a new target and token (the old timer then does nothing),
      // or `past` when the new target has gone by.
      if (event.type === 'stay.changed' && isAnchoredTimerWait(state, def)) {
        // The wait was already due and this anchor didn't move (the other date or a time
        // changed): it simply fires, rather than being re-entered as "past" and skipped.
        const w = state.waiting!;
        const c = parseConfig<{ anchor?: string; offset?: string; at?: string }>('wait_until', def.nodes[state.cursor.nodeId]?.config);
        if (c && ctx.stay && w.untilAt !== null && w.untilAt <= now && stayTarget(c, ctx.stay, ctx.venueTz) === w.untilAt) {
          result = { go: 'done' };
          break;
        }
        result = moveTo(state.cursor.nodeId);
        break;
      }
      result = eventForNode(event, state);
      break;
    }
  }

  if (!result) {
    const changed = JSON.stringify(state.counters) !== JSON.stringify(stateIn.counters);
    return { state: changed ? state : stateIn, effects, unchanged: !changed };
  }

  for (let i = 0; i < MAX_STEPS && result; i += 1) {
    const r: NodeResult = result;
    result = null;

    if ('go' in r) {
      const from = state.cursor.nodeId;
      const node = def.nodes[from];
      const target = node?.edges?.[r.go];
      if (r.vars) Object.assign(state.vars, r.vars);
      if (r.emit) effects.push(...r.emit);
      state.trail.push({ nodeId: from, outcome: r.go, at: now });
      if (state.trail.length > MAX_TRAIL) state.trail.splice(0, state.trail.length - MAX_TRAIL);
      if (!target) {
        state.status = 'failed';
        state.exitReason = `missing_edge:${from}.${r.go}`;
        state.waiting = null;
        break;
      }
      result = moveTo(target);
      continue;
    }

    if ('wait' in r) {
      state.waiting = r.wait;
      if (r.wait.untilAt !== null) effects.push({ type: 'timer', nodeId: r.wait.nodeId, at: r.wait.untilAt, token: r.wait.token });
      break;
    }

    if ('send' in r) {
      state.waiting = { kind: 'send_due', nodeId: state.cursor.nodeId, token: `${state.cursor.nodeId}@${now}:send`, untilAt: null };
      effects.push({ type: 'send', nodeId: state.cursor.nodeId });
      break;
    }

    if ('exit' in r) {
      state.status = r.exit;
      state.exitReason = r.reason;
      state.waiting = null;
      effects.push({ type: 'emit', eventType: 'journey.exited', data: { status: r.exit, reason: r.reason } });
      break;
    }

    // fail
    state.status = 'failed';
    state.exitReason = r.fail;
    state.waiting = null;
    effects.push({ type: 'emit', eventType: 'journey.exited', data: { status: 'failed', reason: r.fail } });
    break;
  }

  if (state.status === 'active' && result) {
    // A loop in a published journey — the validator forbids it, so stop rather than spin.
    state.status = 'failed';
    state.exitReason = 'too_many_steps';
    state.waiting = null;
  }

  state.rev = stateIn.rev + 1;
  return { state, effects, unchanged: false };
}

/** A touch record for `send_result`, built by the send path. */
export function touchOf(args: Omit<LastTouch, 'at'> & { at: number }): LastTouch {
  return { ...args };
}
