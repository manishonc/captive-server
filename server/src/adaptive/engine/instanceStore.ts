/**
 * Journey instances in Firestore (`CaptivePortal_JourneyInstances`).
 *
 * The pure core works in epoch ms; Firestore keeps Timestamps. Every field whose
 * key is `at` or ends in `At` is converted both ways, so the whole state can be
 * stored as it is.
 *
 * Concurrency: `rev` is bumped on every write and every commit checks it
 * (optimistic locking). Timer tasks don't use `rev` — they carry the token of
 * the wait they belong to, so a click counted in between never cancels a timer.
 */

import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { InstanceState, RunMode } from '../core/runtime/types';
import type { Lang } from '../core/constants';
import { SCHEMA_VERSION } from '../core/constants';

export interface InstanceMeta {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  networkId: string;
  playbookKey: string;
  installId: string;
  journeyKey: string;
  entryKey: string;
  entryEventId: string;
  templateVersion: number;
  configVersion: number;
  pendingConfigVersion: number | null;
  /** When the owner saved `pendingConfigVersion` (an "apply to guests already in this journey" edit). */
  pendingConfigAt?: number | null;
  purpose: 'marketing' | 'service' | 'mixed';
  mode: RunMode;
  context: {
    lang: Lang;
    venueTz: string;
    phoneTz: string | null;
    isFirstVisit: boolean;
    stayId: string | null;
    /** The guest doc of the connect that started the journey (the unsubscribe link names it). */
    guestId?: string | null;
    /** The visit that started the journey (older instances may lack these). */
    visitNumber?: number | null;
    isRevisit?: boolean | null;
  };
}

export interface LoadedInstance {
  id: string;
  meta: InstanceMeta;
  state: InstanceState;
}

const TIME_KEY = /(^at$|At$)/;

/** Deep copy with epoch-ms time fields turned into Dates (for writing). */
export function timesToDates<T>(value: T): T {
  return convert(value, (key, v) => (TIME_KEY.test(key) && typeof v === 'number' ? new Date(v) : v)) as T;
}

/** Deep copy with Timestamps / Dates turned into epoch ms (after reading). */
export function timesToMs<T>(value: T): T {
  return convert(value, (_key, v) => {
    if (v instanceof Timestamp) return v.toMillis();
    if (v instanceof Date) return v.getTime();
    return v;
  }) as T;
}

function convert(value: unknown, leaf: (key: string, v: unknown) => unknown, key = ''): unknown {
  const mapped = leaf(key, value);
  if (mapped !== value) return mapped;
  if (value instanceof Timestamp || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => convert(v, leaf, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = convert(v, leaf, k);
    }
    return out;
  }
  return value;
}

export const instanceRef = (id: string) => db.collection(COL.journeyInstances).doc(id);

const STATE_KEYS: Array<keyof InstanceState> = [
  'status',
  'cursor',
  'waiting',
  'counters',
  'lastTouch',
  'vars',
  'goal',
  'rev',
  'trail',
  'startedAt',
  'exitReason',
  'seenEventIds',
];

export function fromDoc(id: string, data: Record<string, unknown>): LoadedInstance {
  const plain = timesToMs(data) as Record<string, any>;
  const state = {} as InstanceState;
  for (const k of STATE_KEYS) (state as any)[k] = plain[k] ?? null;
  state.vars = state.vars ?? {};
  state.trail = state.trail ?? [];
  state.seenEventIds = state.seenEventIds ?? [];
  state.rev = Number(state.rev) || 0;
  const meta: InstanceMeta = {
    tenantUserId: plain.tenantUserId,
    venueId: plain.venueId,
    contactId: plain.contactId,
    networkId: plain.networkId,
    playbookKey: plain.playbookKey,
    installId: plain.installId,
    journeyKey: plain.journeyKey,
    entryKey: plain.entryKey,
    entryEventId: plain.entryEventId,
    templateVersion: plain.templateVersion,
    configVersion: plain.configVersion,
    pendingConfigVersion: plain.pendingConfigVersion ?? null,
    pendingConfigAt: typeof plain.pendingConfigAt === 'number' ? plain.pendingConfigAt : null,
    purpose: plain.purpose ?? 'marketing',
    mode: plain.mode === 'live' ? 'live' : 'test',
    context: plain.context,
  };
  return { id, meta, state };
}

export async function loadInstance(id: string, tx?: Transaction): Promise<LoadedInstance | null> {
  const snap = tx ? await tx.get(instanceRef(id)) : await instanceRef(id).get();
  return snap.exists ? fromDoc(id, snap.data() as Record<string, unknown>) : null;
}

/** The full doc for a brand-new instance. */
export function newInstanceDoc(meta: InstanceMeta, state: InstanceState, now: number): Record<string, unknown> {
  return timesToDates({
    ...meta,
    ...state,
    updatedAt: now,
    endedAt: null,
    expireAt: null,
    schemaVersion: SCHEMA_VERSION,
  });
}

/** The fields a state change writes (rev is set by the caller). */
export function stateUpdate(state: InstanceState, now: number, endedExpireAt: Date | null): Record<string, unknown> {
  const ended = state.status !== 'active';
  const update: Record<string, unknown> = timesToDates({
    status: state.status,
    cursor: state.cursor,
    waiting: state.waiting,
    counters: state.counters,
    lastTouch: state.lastTouch,
    vars: state.vars,
    goal: state.goal,
    rev: state.rev,
    trail: state.trail,
    exitReason: state.exitReason,
    seenEventIds: state.seenEventIds ?? [],
    updatedAt: now,
  });
  if (ended) {
    update.endedAt = new Date(now);
    update.expireAt = endedExpireAt;
  }
  return update;
}
