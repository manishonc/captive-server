/**
 * The event log (`CaptivePortal_JourneyEvents`, 02 §6.4): append-only. Events the
 * engine derives get deterministic ids, so a re-run of the same task writes the
 * same doc again instead of a second one.
 */

import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import { retentionFrom } from '../store/time';
import { SCHEMA_VERSION } from '../core/constants';
import type { JourneyEventDoc } from '../store/engineTypes';
import type { EngineEvent } from '../core/runtime/types';
import { tsMs } from '../store/time';

export interface EventInput {
  type: string;
  occurredAt: number;
  tenantUserId?: string | null;
  venueId?: string | null;
  contactId?: string | null;
  guestId?: string | null;
  instanceId?: string | null;
  journeyKey?: string | null;
  nodeId?: string | null;
  sendKey?: string | null;
  variantId?: string | null;
  channel?: string | null;
  slot?: string | null;
  /** The instance's run mode (test / live): the rollups keep test runs apart. */
  mode?: 'test' | 'live' | null;
  source?: JourneyEventDoc['source'];
  data?: Record<string, unknown>;
}

export const eventRef = (id?: string) => (id ? db.collection(COL.journeyEvents).doc(id) : db.collection(COL.journeyEvents).doc());

export function eventDoc(e: EventInput): Record<string, unknown> {
  return {
    type: e.type,
    tenantUserId: e.tenantUserId ?? null,
    venueId: e.venueId ?? null,
    contactId: e.contactId ?? null,
    guestId: e.guestId ?? null,
    instanceId: e.instanceId ?? null,
    journeyKey: e.journeyKey ?? null,
    nodeId: e.nodeId ?? null,
    sendKey: e.sendKey ?? null,
    variantId: e.variantId ?? null,
    channel: e.channel ?? null,
    slot: e.slot ?? null,
    source: e.source ?? 'engine',
    ...(e.mode ? { mode: e.mode } : {}),
    occurredAt: new Date(e.occurredAt),
    // The commit time (not when this object was built): the rollups read the log in
    // `recordedAt` order up to "now − 2 min", which is only exact if nothing lands later
    // with an earlier stamp.
    recordedAt: FieldValue.serverTimestamp(),
    data: stripUndefinedDeep(e.data ?? {}),
    expireAt: retentionFrom(e.occurredAt),
    schemaVersion: SCHEMA_VERSION,
  };
}

function stripUndefinedDeep(value: unknown): any {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : stripUndefinedDeep(v)));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = stripUndefinedDeep(v);
    return out;
  }
  return value;
}

/** Inside a transaction (a same-id rewrite is harmless). */
export function appendEventInTx(tx: Transaction, e: EventInput, id?: string): string {
  const ref = eventRef(id);
  tx.set(ref, eventDoc(e));
  return ref.id;
}

/** Outside a transaction; an existing deterministic id is left as it is. */
export async function appendEvent(e: EventInput, id?: string): Promise<string> {
  const ref = eventRef(id);
  try {
    await ref.create(eventDoc(e));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 6 && !/ALREADY_EXISTS/i.test(String((err as Error).message))) throw err;
  }
  return ref.id;
}

export async function loadEvent(id: string): Promise<EngineEvent | null> {
  const snap = await db.collection(COL.journeyEvents).doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data() as JourneyEventDoc;
  return {
    id,
    type: d.type,
    occurredAt: tsMs(d.occurredAt) ?? Date.now(),
    venueId: d.venueId,
    contactId: d.contactId,
    instanceId: d.instanceId,
    sendKey: d.sendKey,
    channel: d.channel,
    data: { ...(d.data ?? {}), guestId: d.guestId },
  };
}
