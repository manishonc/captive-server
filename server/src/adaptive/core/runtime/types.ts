/**
 * Shapes the pure engine works with. Times are epoch milliseconds here; the store
 * turns every `…At` / `at` field into a Firestore Timestamp and back.
 */

import type { Channel } from '../constants';

export type InstanceStatus =
  | 'active'
  | 'completed'
  | 'exhausted'
  | 'converted'
  | 'suppressed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export const ENDED_STATUSES: ReadonlySet<InstanceStatus> = new Set([
  'completed',
  'exhausted',
  'converted',
  'suppressed',
  'cancelled',
  'expired',
  'failed',
]);

/** Frozen when a guest enters a journey: a test-run guest never gets a real message. */
export type RunMode = 'test' | 'live';

export interface InstanceCounters {
  /** Marketing messages sent in this journey (service messages don't count). */
  touches: number;
  clicks: number;
  opens: number;
  /** Position on the journey's channel ladder of the last pick. */
  ladderPos: number;
  consecutiveNoClick: number;
}

export interface LastTouch {
  channel: Channel;
  variantId: string;
  slot: string;
  sendKey: string;
  purpose: 'marketing' | 'service';
  at: number;
}

export interface WaitState {
  /** timer = delay / wait_until; events = wait_for; send_due = a send planned for later or held back. */
  kind: 'timer' | 'events' | 'send_due';
  nodeId: string;
  /** Identifies this wait: a timer task carries it, and is stale once the wait is replaced. */
  token: string;
  untilAt: number | null;
  events?: Array<{ key: string; event: string; where?: Record<string, unknown> }>;
  /** Send bookkeeping: when the send was meant to go (quiet hours / credits move it; a pause does not). */
  intendedAt?: number;
  /** The time slot the send was planned in (now / morning / afternoon / evening / fixed). */
  slot?: string;
  lastDeferReason?: string;
  creditsWaitStartedAt?: number;
  /**
   * The send can't be paid right now (PR D, the results card): set from the credits rule's own
   * check at every look, so quiet hours or a pause winning the gate don't hide it.
   */
  creditsShort?: boolean;
  /** What the shortage was measured for, so a later look that reads the wallet can drop it after a top-up. */
  creditsShortFor?: { channel: string; price: number };
  /** Provider "try again later" answers so far for this send (capped). */
  dispatchAttempts?: number;
}

export interface InstanceState {
  status: InstanceStatus;
  cursor: { nodeId: string; enteredAt: number };
  waiting: WaitState | null;
  counters: InstanceCounters;
  lastTouch: LastTouch | null;
  /** Per-run values: offerKey, offerLabel, offerExpiresAt, ratingStars… */
  vars: Record<string, unknown>;
  goal: { reachedAt: number; eventId: string } | null;
  rev: number;
  trail: Array<{ nodeId: string; outcome: string; at: number }>;
  startedAt: number;
  exitReason: string | null;
  /** The last events delivered to this guest's journey — a replayed webhook is not counted twice. */
  seenEventIds?: string[];
}

export interface EngineEvent {
  id: string;
  type: string;
  occurredAt: number;
  venueId?: string | null;
  contactId?: string | null;
  instanceId?: string | null;
  sendKey?: string | null;
  channel?: string | null;
  data: Record<string, unknown>;
}

export type RuntimeInput =
  | { kind: 'start' }
  /** A timer for this node fired (delay over, wait timed out, wait_until reached). */
  | { kind: 'wake'; nodeId: string }
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'send_result'; nodeId: string; outcome: 'sent' | 'skipped'; touch?: LastTouch | null; ladderPos?: number };

export type Effect =
  /** Wake this node at `at` (a node_run task carrying the wait's token). */
  | { type: 'timer'; nodeId: string; at: number; token: string }
  /** The journey reached a send step: run the send path for it. */
  | { type: 'send'; nodeId: string }
  /** Append a journey.* / offer.* event to the log. */
  | { type: 'emit'; eventType: string; data: Record<string, unknown> };

export interface StepResult {
  state: InstanceState;
  effects: Effect[];
  /** True when nothing changed (e.g. an event the current step doesn't wait for). */
  unchanged: boolean;
}

export const MAX_TRAIL = 30;

export function freshState(startNodeId: string, now: number): InstanceState {
  return {
    status: 'active',
    cursor: { nodeId: startNodeId, enteredAt: now },
    waiting: null,
    counters: { touches: 0, clicks: 0, opens: 0, ladderPos: -1, consecutiveNoClick: 0 },
    lastTouch: null,
    vars: {},
    goal: null,
    rev: 0,
    trail: [],
    startedAt: now,
    exitReason: null,
  };
}
