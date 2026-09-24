/**
 * The adaptive worker (04-engine-runtime §1, §3): leases due tasks from the
 * Firestore queue and runs them. Stateless — kill it at any time and the
 * leases run out and another worker (or the restarted one) picks the tasks up.
 *
 *  - one query every 5 s for due tasks (every 60 s while every account is off);
 *  - up to 4 tasks at a time;
 *  - expired leases put back every 60 s;
 *  - heartbeat to `AdaptiveConfig/engine_status` + a file for Docker's healthcheck;
 *  - a watchdog exits if the loop stalls, so Docker restarts the container;
 *  - SIGTERM: stop taking tasks, finish the ones in hand (≤ 20 s), exit.
 */

import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { anyAccountOn, readEngineSettings, SAFE_SETTINGS, type EngineSettings } from '../store/engineSettings';
import { claimDue, completeTask, failTask, reclaimExpiredLeases, releaseTask, TASK_SCHEMA_VERSION, type ClaimedTask } from '../queue/firestoreQueue';
import { now, refreshClock } from '../engine/clock';
import { routeEvent, handleVisitEnd } from '../engine/route';
import { runTimer } from '../engine/advance';
import { identityReady, keyFingerprint } from '../identity/key';
import { ENGINE_RUNTIME_VERSION } from '../core/runtime/version';
import { checkIndexes, type IndexCheckResult } from './indexCheck';
import { tsMs } from '../store/time';

const POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;
const HEARTBEAT_MS = 60_000;
const CONCURRENCY = 4;
const BATCH = 10;
const STALL_MS = 5 * 60_000;
const HEARTBEAT_FILE = '/tmp/adaptive-heartbeat';
const WORKER_ENTRY_TTL_MS = 24 * 60 * 60_000;

type WorkerState = 'starting' | 'running' | 'idle_identity' | 'idle_indexes' | 'stopping';

export class AdaptiveWorker {
  readonly id = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  private running = false;
  private inflight = 0;
  private lastLoopAt = Date.now();
  private lastBeatAt = 0;
  private lastReclaimAt = 0;
  private settings: EngineSettings = SAFE_SETTINGS;
  private settingsAt = 0;
  private state: WorkerState = 'starting';
  private indexes: IndexCheckResult | null = null;
  private tasksRun = 0;
  private errors = 0;
  private readonly startedAt = Date.now();

  async start(): Promise<void> {
    this.running = true;
    this.installSignals();
    this.startWatchdog();
    await this.pruneOldWorkers().catch(() => undefined);

    while (this.running) {
      this.lastLoopAt = Date.now();
      try {
        await this.tick();
      } catch (err) {
        this.errors += 1;
        console.error('[ADAPTIVE WORKER] loop error:', (err as Error)?.message || err);
        await sleep(POLL_MS);
      }
    }
  }

  private async tick(): Promise<void> {
    await this.heartbeat();

    if (!identityReady()) {
      this.state = 'idle_identity';
      await sleep(IDLE_POLL_MS);
      return;
    }
    if (!this.indexes?.ok) {
      this.indexes = await checkIndexes();
      if (!this.indexes.ok) {
        this.state = 'idle_indexes';
        console.error('[ADAPTIVE WORKER] missing Firestore indexes — staying idle:', this.indexes.missing.map((m) => m.name).join(', '));
        await sleep(IDLE_POLL_MS);
        return;
      }
    }
    this.state = 'running';

    await refreshClock();
    if (Date.now() - this.settingsAt > 10_000) {
      this.settings = await readEngineSettings();
      this.settingsAt = Date.now();
    }
    if (Date.now() - this.lastReclaimAt > 60_000) {
      this.lastReclaimAt = Date.now();
      await reclaimExpiredLeases().catch((err) => console.warn('[ADAPTIVE WORKER] reclaim failed:', err?.message || err));
    }

    const tasks = await claimDue(this.id, now(), BATCH);
    if (!tasks.length) {
      await sleep(anyAccountOn(this.settings) ? POLL_MS : IDLE_POLL_MS);
      return;
    }
    await runLimited(tasks, CONCURRENCY, (t) => this.runTask(t));
  }

  /**
   * Runs everything that is due right now, then returns how many tasks ran —
   * for tests and the local sandbox (no sleeping, no index check).
   */
  async runDue(maxRounds = 200): Promise<number> {
    let total = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      await refreshClock(true);
      this.settings = await readEngineSettings();
      this.settingsAt = Date.now();
      const tasks = await claimDue(this.id, now(), 50);
      if (!tasks.length) break;
      await runLimited(tasks, CONCURRENCY, (t) => this.runTask(t));
      total += tasks.length;
    }
    return total;
  }

  private async runTask(task: ClaimedTask): Promise<void> {
    this.inflight += 1;
    const env = { now: now(), settings: this.settings, workerId: this.id };
    try {
      const version = Number(task.payload.schemaVersion ?? 1);
      if (version > TASK_SCHEMA_VERSION) {
        await releaseTask(task.id, this.id, 10 * 60_000, env.now); // written by a newer build: leave it
        return;
      }
      switch (task.kind) {
        case 'event_route':
          await routeEvent(task.payload as any, env);
          break;
        case 'node_run': {
          const r = await runTimer(task.payload as any, { ...env, taskDueAt: task.dueAt });
          if (r.status === 'retry') {
            await releaseTask(task.id, this.id, Math.max(5_000, r.atMs - env.now), env.now);
            return;
          }
          break;
        }
        case 'visit_end':
          await handleVisitEnd(task.payload as any, env);
          break;
        default:
          await releaseTask(task.id, this.id, 10 * 60_000, env.now); // a kind this build doesn't know yet
          return;
      }
      await completeTask(task.id, this.id);
      this.tasksRun += 1;
    } catch (err) {
      this.errors += 1;
      const message = (err as Error)?.stack || String(err);
      console.error(`[ADAPTIVE WORKER] task ${task.kind} ${task.id} failed:`, (err as Error)?.message || err);
      await failTask(task.id, this.id, message, env.now).catch(() => undefined);
    } finally {
      this.inflight -= 1;
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch {
      // not fatal (read-only /tmp in some sandboxes)
    }
    if (Date.now() - this.lastBeatAt < HEARTBEAT_MS) return;
    this.lastBeatAt = Date.now();
    await db
      .collection(COL.config)
      .doc(ENGINE_STATUS_DOC_ID)
      .set(
        {
          workers: {
            [this.id]: {
              lastBeatAt: new Date(),
              startedAt: new Date(this.startedAt),
              version: ENGINE_RUNTIME_VERSION,
              keyFingerprint: keyFingerprint(),
              state: this.state,
              tasksRun: this.tasksRun,
              errors: this.errors,
            },
          },
          indexCheck: this.indexes ? { ok: this.indexes.ok, missing: this.indexes.missing, at: new Date() } : null,
          updatedAt: new Date(),
        },
        { merge: true },
      )
      .catch((err) => console.warn('[ADAPTIVE WORKER] heartbeat failed:', err?.message || err));
  }

  private async pruneOldWorkers(): Promise<void> {
    const snap = await db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get();
    const workers = (snap.get('workers') ?? {}) as Record<string, { lastBeatAt?: unknown }>;
    const stale = Object.entries(workers).filter(([, w]) => Date.now() - (tsMs(w?.lastBeatAt) ?? 0) > WORKER_ENTRY_TTL_MS);
    if (!stale.length) return;
    const update: Record<string, unknown> = {};
    for (const [id] of stale) update[`workers.${id}`] = FieldValue.delete();
    await snap.ref.update(update);
  }

  private startWatchdog(): void {
    const timer = setInterval(() => {
      if (this.running && Date.now() - this.lastLoopAt > STALL_MS) {
        console.error('[ADAPTIVE WORKER] loop stalled for 5 minutes — exiting so Docker restarts the worker');
        process.exit(1);
      }
    }, 60_000);
    timer.unref();
  }

  private installSignals(): void {
    const stop = async (signal: string) => {
      if (!this.running) return;
      console.log(`[ADAPTIVE WORKER] ${signal}: finishing tasks in hand`);
      this.running = false;
      this.state = 'stopping';
      const deadline = Date.now() + 20_000;
      while (this.inflight > 0 && Date.now() < deadline) await sleep(250);
      process.exit(0);
    };
    process.on('SIGTERM', () => void stop('SIGTERM'));
    process.on('SIGINT', () => void stop('SIGINT'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      await fn(item);
    }
  });
  await Promise.all(lanes);
}
