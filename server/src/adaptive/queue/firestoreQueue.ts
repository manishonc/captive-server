/**
 * The work queue (04-engine-runtime §3): every future action is a task in
 * `CaptivePortal_JourneyTasks` with a due time, so a restart loses nothing.
 *
 *  - Task ids are hashes of a dedupe key: scheduling the same thing twice is a no-op.
 *  - A worker claims a due task in a transaction (queued → leased, 2-minute lease).
 *  - Done tasks keep `expireAt` (+7 days) for the TTL policy — no hot deletes.
 *  - Failures retry with backoff (30 s … 1 h); after `maxAttempts` → `dead` (admin
 *    view, kept 30 days).
 *  - A guest's raw contact details (`payload.guest`, connect tasks only) are removed
 *    as soon as the task is done or dead.
 *  - A lease that runs out (worker died) is put back in the queue.
 *
 * Behind the `Scheduler` interface, so Cloud Tasks can replace it later.
 */

import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import { shardOf, taskIdFor } from '../core/runtime/ids';
import { DAY_MS, HOUR_MS } from '../core/runtime/time';

export type TaskKind = 'event_route' | 'node_run' | 'visit_end' | 'send_sweep' | 'signal';

export const TASK_SCHEMA_VERSION = 1;
export const LEASE_MS = 2 * 60_000;
const DONE_TTL_MS = 7 * DAY_MS;
const DEAD_TTL_MS = 30 * DAY_MS;
const DEFAULT_MAX_ATTEMPTS = 8;

export interface TaskSpec {
  dedupeKey: string;
  kind: TaskKind;
  dueAt: number;
  payload: Record<string, unknown>;
  tenantUserId?: string | null;
  venueId?: string | null;
  maxAttempts?: number;
}

export interface ClaimedTask {
  id: string;
  kind: string;
  dueAt: number;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  tenantUserId: string | null;
  venueId: string | null;
}

export interface Scheduler {
  /** Same dedupe key twice = no-op. */
  schedule(task: TaskSpec): Promise<string>;
  /** Inside a transaction (all reads must already be done). */
  scheduleInTx(tx: Transaction, task: TaskSpec): string;
  cancel(taskId: string): Promise<void>;
}

const col = () => db.collection(COL.journeyTasks);

function taskDoc(task: TaskSpec, id: string) {
  return {
    kind: task.kind,
    shard: shardOf(id),
    status: 'queued',
    dueAt: new Date(task.dueAt),
    leaseOwner: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts: task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    lastError: null,
    payload: { ...task.payload, schemaVersion: TASK_SCHEMA_VERSION },
    tenantUserId: task.tenantUserId ?? null,
    venueId: task.venueId ?? null,
    createdAt: new Date(),
    doneAt: null,
    expireAt: null,
  };
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || e?.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(e?.message));
}

function toMs(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

export const firestoreScheduler: Scheduler = {
  async schedule(task) {
    const id = taskIdFor(task.dedupeKey);
    try {
      await col().doc(id).create(taskDoc(task, id));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    return id;
  },
  scheduleInTx(tx, task) {
    const id = taskIdFor(task.dedupeKey);
    // Dedupe keys carry the instance rev, so inside a commit this id is new; a
    // retried transaction writes the same doc again, which is harmless.
    tx.set(col().doc(id), taskDoc(task, id));
    return id;
  },
  async cancel(taskId) {
    await col()
      .doc(taskId)
      .update({ status: 'cancelled', doneAt: new Date(), expireAt: new Date(Date.now() + DONE_TTL_MS) })
      .catch(() => undefined);
  },
};

/** Claims up to `limit` due tasks for this worker. `engineNow` may be the sandbox clock. */
export async function claimDue(workerId: string, engineNow: number, limit: number): Promise<ClaimedTask[]> {
  const snap = await col()
    .where('status', '==', 'queued')
    .where('dueAt', '<=', new Date(engineNow))
    .orderBy('dueAt')
    .limit(limit)
    .get();
  const claimed: ClaimedTask[] = [];
  for (const doc of snap.docs) {
    const task = await db
      .runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists || fresh.get('status') !== 'queued') return null;
        const attempts = Number(fresh.get('attempts') || 0) + 1;
        tx.update(doc.ref, { status: 'leased', leaseOwner: workerId, leaseUntil: new Date(Date.now() + LEASE_MS), attempts });
        return {
          id: doc.id,
          kind: String(fresh.get('kind')),
          dueAt: toMs(fresh.get('dueAt')),
          attempts,
          maxAttempts: Number(fresh.get('maxAttempts') || DEFAULT_MAX_ATTEMPTS),
          payload: (fresh.get('payload') || {}) as Record<string, unknown>,
          tenantUserId: (fresh.get('tenantUserId') as string) ?? null,
          venueId: (fresh.get('venueId') as string) ?? null,
        } satisfies ClaimedTask;
      })
      .catch((err) => {
        console.warn('[ADAPTIVE] claim failed:', doc.id, err?.message || err);
        return null;
      });
    if (task) claimed.push(task);
  }
  return claimed;
}

/** Marks a task done — only if this worker still holds its lease. */
export async function completeTask(taskId: string, workerId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = col().doc(taskId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'leased' || snap.get('leaseOwner') !== workerId) return;
    const now = Date.now();
    tx.update(ref, { status: 'done', doneAt: new Date(now), expireAt: new Date(now + DONE_TTL_MS), leaseUntil: null, 'payload.guest': FieldValue.delete() });
  });
}

function deadUpdate(lastError: string) {
  const now = Date.now();
  return { status: 'dead', lastError, leaseUntil: null, doneAt: new Date(now), expireAt: new Date(now + DEAD_TTL_MS), 'payload.guest': FieldValue.delete() };
}

/** Retry with backoff, or `dead` after the last attempt. */
export async function failTask(taskId: string, workerId: string, error: string, engineNow: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = col().doc(taskId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'leased' || snap.get('leaseOwner') !== workerId) return;
    const attempts = Number(snap.get('attempts') || 1);
    const max = Number(snap.get('maxAttempts') || DEFAULT_MAX_ATTEMPTS);
    const lastError = error.slice(0, 500);
    if (attempts >= max) {
      tx.update(ref, deadUpdate(lastError));
      return;
    }
    const backoff = Math.min(HOUR_MS, 30_000 * 2 ** (attempts - 1));
    tx.update(ref, { status: 'queued', lastError, leaseOwner: null, leaseUntil: null, dueAt: new Date(engineNow + backoff) });
  });
}

/**
 * Puts a task back without counting an attempt — for a task kind this worker
 * doesn't know yet (a newer API wrote it during a deploy).
 */
export async function releaseTask(taskId: string, workerId: string, retryInMs: number, engineNow: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = col().doc(taskId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('leaseOwner') !== workerId) return;
    tx.update(ref, {
      status: 'queued',
      leaseOwner: null,
      leaseUntil: null,
      attempts: Math.max(0, Number(snap.get('attempts') || 1) - 1),
      dueAt: new Date(engineNow + retryInMs),
    });
  });
}

/** Leases that ran out (the worker died): back to the queue, or dead after the last attempt. */
export async function reclaimExpiredLeases(limit = 50): Promise<number> {
  const snap = await col().where('status', '==', 'leased').where('leaseUntil', '<=', new Date()).limit(limit).get();
  let n = 0;
  for (const doc of snap.docs) {
    await db
      .runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (fresh.get('status') !== 'leased' || toMs(fresh.get('leaseUntil')) > Date.now()) return;
        const attempts = Number(fresh.get('attempts') || 1);
        const max = Number(fresh.get('maxAttempts') || DEFAULT_MAX_ATTEMPTS);
        if (attempts >= max) {
          tx.update(doc.ref, deadUpdate('lease expired on the last attempt'));
        } else {
          tx.update(doc.ref, { status: 'queued', leaseOwner: null, leaseUntil: null });
        }
        n += 1;
      })
      .catch(() => undefined);
  }
  return n;
}

/** Keeps a long task's lease alive. */
export async function extendLease(taskId: string, workerId: string): Promise<void> {
  await col()
    .doc(taskId)
    .update({ leaseUntil: new Date(Date.now() + LEASE_MS) })
    .catch(() => undefined);
  void workerId;
}
