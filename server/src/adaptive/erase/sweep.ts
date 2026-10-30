/**
 * "Erase leftover history" (erase step 3, the admin's Launch & health tab): finds guests whose
 * Adaptive history is still there though their record is gone — removed before the erase existed
 * (28 Oct until step 3 shipped), or an erase that died — and queues the erase for each. Run it once
 * after the deploy; it stays as the safety net.
 *
 *  - The admin starts it (POST /admin/erase-sweep); the worker runs it as one `erase_sweep` task, so
 *    no request waits for it. One sweep at a time.
 *  - It reads every journey, visit and message (pages of 500, two fields each), looks up each contact
 *    they name, and queues an `erase_history` task, due now, for each one that no longer exists —
 *    unless the forget's own erase is still on its way. Events aren't read: a guest with events has
 *    a visit, a journey or a message too.
 *  - The erase keeps its rules (erase/history.ts): it waits for the numbers, and never touches a
 *    contact that exists.
 *  - Its state is `AdaptiveConfig/erase_sweep`, shown on the admin card (GET /admin/engine `eraseSweep`).
 */

import { randomBytes } from 'crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, ERASE_SWEEP_DOC_ID } from '../store/collections';
import { tsMs } from '../store/time';
import { taskIdFor } from '../core/runtime/ids';
import type { Actor } from '../core/schemas';
import { conflict } from '../api/errors';
import { now, refreshClock } from '../engine/clock';
import { LIVE_TASK_STATES, firestoreScheduler, taskStatusInTx, taskStatuses, type TaskSpec } from '../queue/firestoreQueue';
import { eraseHistoryTask } from './history';

const SCAN_PAGE = 500;
const LOOKUP_CHUNK = 100;

const stateRef = () => db.collection(COL.config).doc(ERASE_SWEEP_DOC_ID);

/** The erase tasks in one state — equality only (merged single-field indexes). Not probed: the card shows "—" if it fails. */
export const eraseTasksQuery = (status: string) => db.collection(COL.journeyTasks).where('kind', '==', 'erase_history').where('status', '==', status);

function sweepTask(runId: string, dueAt: number): TaskSpec {
  return { dedupeKey: `erase_sweep:${runId}`, kind: 'erase_sweep', dueAt, payload: { runId }, tenantUserId: null, venueId: null, maxAttempts: 3 };
}

/** POST /admin/erase-sweep — queues a sweep; 409 while one is on its way. */
export async function startEraseSweep(actor: Actor) {
  await refreshClock();
  const runId = `sw_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const task = sweepTask(runId, now());
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef());
    const taskId = snap.get('taskId');
    const status = typeof taskId === 'string' ? await taskStatusInTx(tx, taskId) : null;
    if (status && LIVE_TASK_STATES.has(status)) throw conflict('A sweep is already running. Refresh in a minute to see what it found.');
    firestoreScheduler.scheduleInTx(tx, task);
    tx.set(stateRef(), {
      runId,
      taskId: taskIdFor(task.dedupeKey),
      state: 'queued',
      requestedAt: new Date(),
      requestedBy: actor.uid,
      startedAt: null,
      finishedAt: null,
      scanned: null,
      contacts: null,
      found: null,
      queued: null,
      alreadyQueued: null,
    });
  });
  return { started: true, eraseSweep: await eraseSweepStatus() };
}

export interface SweepResult {
  /** Journeys, visits and messages read. */
  scanned: number;
  /** Contacts they name. */
  contacts: number;
  /** …of which no longer exist. */
  found: number;
  /** Erases queued by this sweep. */
  queued: number;
  /** Erases the forget had queued already (still on their way). */
  alreadyQueued: number;
}

/** The `erase_sweep` task. Null when a newer sweep replaced this one (nothing done). */
export async function runEraseSweep(runId: string, env: { now: number; onProgress?: () => Promise<void> | void }): Promise<SweepResult | null> {
  // Only the sweep the card shows writes its state (a late retry of an older one doesn't).
  const ours = (patch: Record<string, unknown>) =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef());
      if (snap.get('runId') !== runId) return false;
      tx.update(stateRef(), patch);
      return true;
    });
  if (!(await ours({ state: 'running', startedAt: new Date() }))) return null;

  const named = new Map<string, string>(); // contactId → tenantUserId
  let scanned = 0;
  for (const name of [COL.journeyInstances, COL.visits, COL.journeySends]) {
    let after: string | null = null;
    for (;;) {
      let q = db.collection(name).orderBy(FieldPath.documentId()).select('contactId', 'tenantUserId').limit(SCAN_PAGE);
      if (after) q = q.startAfter(after);
      const page = await q.get();
      for (const d of page.docs) {
        const contactId = d.get('contactId');
        const tenantUserId = d.get('tenantUserId');
        if (typeof contactId === 'string' && contactId && typeof tenantUserId === 'string' && tenantUserId && !named.has(contactId)) named.set(contactId, tenantUserId);
      }
      scanned += page.size;
      await env.onProgress?.();
      if (page.size < SCAN_PAGE) break;
      after = page.docs[page.docs.length - 1].id;
    }
  }

  const result: SweepResult = { scanned, contacts: named.size, found: 0, queued: 0, alreadyQueued: 0 };
  const ids = [...named.keys()];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const snaps = await db.getAll(...ids.slice(i, i + LOOKUP_CHUNK).map((id) => db.collection(COL.contacts).doc(id)));
    const gone = snaps.filter((s) => !s.exists).map((s) => s.id);
    result.found += gone.length;
    const forgetTask = (id: string) => taskIdFor(eraseHistoryTask(named.get(id)!, id, 0).dedupeKey);
    const statuses = await taskStatuses(gone.map(forgetTask));
    for (const id of gone) {
      if (LIVE_TASK_STATES.has(statuses.get(forgetTask(id)) ?? '')) {
        result.alreadyQueued += 1;
        continue;
      }
      await firestoreScheduler.schedule(eraseHistoryTask(named.get(id)!, id, env.now, `sweep:${runId}`));
      result.queued += 1;
    }
    await env.onProgress?.();
  }
  await ours({ state: 'done', finishedAt: new Date(), ...result });
  return result;
}

function iso(v: unknown): string | null {
  const ms = tsMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

const count = (v: unknown) => (typeof v === 'number' ? v : null);

/** Erases still on their way (queued or running), or null if they can't be counted right now. */
async function pendingErases(): Promise<number | null> {
  try {
    const [queued, leased] = await Promise.all([eraseTasksQuery('queued').count().get(), eraseTasksQuery('leased').count().get()]);
    return queued.data().count + leased.data().count;
  } catch {
    return null;
  }
}

/**
 * For the admin card: the last sweep and the erases still on their way. A sweep whose task is no
 * longer on its way without having finished shows as `failed` (its task is on the dead-task list).
 */
export async function eraseSweepStatus() {
  const [snap, pending] = await Promise.all([stateRef().get(), pendingErases()]);
  if (!snap.exists) return { state: 'never' as const, pending };
  let state = String(snap.get('state') ?? 'never');
  const taskId = snap.get('taskId');
  if ((state === 'queued' || state === 'running') && typeof taskId === 'string') {
    const status = (await taskStatuses([taskId])).get(taskId);
    if (!status || !LIVE_TASK_STATES.has(status)) state = 'failed';
  }
  return {
    state,
    requestedAt: iso(snap.get('requestedAt')),
    requestedBy: typeof snap.get('requestedBy') === 'string' ? (snap.get('requestedBy') as string) : null,
    startedAt: iso(snap.get('startedAt')),
    finishedAt: iso(snap.get('finishedAt')),
    scanned: count(snap.get('scanned')),
    contacts: count(snap.get('contacts')),
    found: count(snap.get('found')),
    queued: count(snap.get('queued')),
    alreadyQueued: count(snap.get('alreadyQueued')),
    pending,
  };
}
