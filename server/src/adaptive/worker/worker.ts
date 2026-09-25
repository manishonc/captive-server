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
 *  - SIGTERM: stop taking tasks, finish the ones in hand (≤ 20 s), exit;
 *  - after a task for a venue, that venue's 15-minute rollup is armed (rollups/rollup.ts).
 *
 * Identity-key guard (the key is derived from GUEST_OTP_PEPPER, see identity/key.ts).
 * The first connect task whose key (the API's, carried on the task) equals this
 * worker's pins it in `engine_status.identity`. Then:
 *  - this worker's key differs from the pinned one → the pepper changed and every
 *    guest would become a stranger: stay idle (after a deliberate change, delete
 *    `identity` there to re-pin);
 *  - a connect task carries another key and none is pinned yet → it can't be told
 *    which app is wrong: hold that connect (retried every 10 min) and warn;
 *  - a connect task carries another key but this worker's is the pinned one → the
 *    API was misconfigured; the task's data is fine, so handle it and warn.
 */

import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { anyAccountOn, readEngineSettingsStrict, SAFE_SETTINGS, type EngineSettings } from '../store/engineSettings';
import { claimDue, completeTask, failTask, reclaimExpiredLeases, releaseTask, TASK_SCHEMA_VERSION, type ClaimedTask } from '../queue/firestoreQueue';
import { now, refreshClock } from '../engine/clock';
import { routeEvent, handleVisitEnd } from '../engine/route';
import { runTimer } from '../engine/advance';
import { handleSignal } from '../engine/signals';
import { channelAdapters } from '../engine/sendPath';
import { registerAdapters } from '../send/adapters';
import { chargeSend, ensureSentEvent } from '../send/dispatch';
import { identityReady, keyFingerprint } from '../identity/key';
import { ENGINE_RUNTIME_VERSION } from '../core/runtime/version';
import { checkIndexes, type IndexCheckResult } from './indexCheck';
import { ensureRollup, rollupVenue } from '../rollups/rollup';
import { applyConfigInFlight } from '../engine/applyInFlight';
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

  constructor() {
    // Brevo / Twilio (or the local sandbox) — only the worker sends.
    registerAdapters(channelAdapters);
  }
  private running = false;
  private inflight = 0;
  private lastLoopAt = Date.now();
  private lastBeatAt = 0;
  private lastReclaimAt = 0;
  private settings: EngineSettings = SAFE_SETTINGS;
  private settingsAt = 0;
  private state: WorkerState = 'starting';
  private indexes: IndexCheckResult | null = null;
  /** Why this worker won't run tasks (identity guard), shown on the admin status. */
  private identityProblem: string | null = null;
  /** The last connect task that carried another identity key than this worker's. */
  private keyWarning: { message: string; at: Date } | null = null;
  private pinned: { fingerprint: string | null; at: number } | null = null;
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
      this.identityProblem = 'GUEST_OTP_PEPPER is not set';
      await sleep(IDLE_POLL_MS);
      return;
    }
    const problem = await this.identityCheck();
    if (problem) {
      if (this.identityProblem !== problem) console.error(`[ADAPTIVE WORKER] identity key problem — staying idle: ${problem}`);
      this.state = 'idle_identity';
      this.identityProblem = problem;
      await sleep(IDLE_POLL_MS);
      return;
    }
    this.identityProblem = null;
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
      try {
        this.settings = await readEngineSettingsStrict();
        this.settingsAt = Date.now();
      } catch (err) {
        // Keep the last good copy and take no tasks until a read works: a task run
        // as "everything off" would be marked done without its work being done.
        console.error('[ADAPTIVE WORKER] engine settings read failed — no tasks this round:', (err as Error)?.message || err);
        await sleep(POLL_MS);
        return;
      }
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
      this.settings = await readEngineSettingsStrict();
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
        case 'event_route': {
          const apiKey = typeof task.payload.keyFingerprint === 'string' ? task.payload.keyFingerprint : null;
          const own = keyFingerprint();
          if (apiKey && apiKey !== own) {
            const pinned = await this.pinnedFingerprint();
            if (pinned !== own) {
              this.warnKey(`a connect task carried identity key ${apiKey}, this worker has ${own}${pinned ? `, the pinned one is ${pinned}` : ' and none is pinned yet'} — check GUEST_OTP_PEPPER on both apps`);
              await releaseTask(task.id, this.id, 10 * 60_000, env.now);
              return;
            }
            this.warnKey(`a connect task carried identity key ${apiKey}, not the pinned ${own} — check GUEST_OTP_PEPPER on the server app`);
          }
          await routeEvent(task.payload as any, env);
          if (apiKey && apiKey === own) await this.pinKey(own).catch((err) => console.warn('[ADAPTIVE WORKER] pinning the identity key failed:', err?.message || err));
          break;
        }
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
        case 'signal':
          await handleSignal(task.payload as any, env);
          break;
        case 'send_sweep':
          // A send the provider accepted but the debit failed: charge it (idempotent).
          if (task.payload.action === 'charge' && typeof task.payload.sendKey === 'string') {
            await chargeSend(task.payload.sendKey);
            await ensureSentEvent(task.payload.sendKey); // a send whose recording failed still counts in the daily numbers
          }
          break;
        case 'rollup_venue': {
          // The venue's daily numbers (rollups/rollup.ts); a big backlog continues shortly.
          const r = typeof task.payload.venueId === 'string' ? await rollupVenue(task.payload.venueId) : { more: false };
          if (r.more) {
            await releaseTask(task.id, this.id, 5_000, env.now);
            return;
          }
          break;
        }
        case 'apply_config_inflight':
          // An owner's "apply to guests already in these journeys" save.
          await applyConfigInFlight(task.payload as any);
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
      // Whatever this task wrote for the venue is counted by its next rollup.
      if (task.kind !== 'rollup_venue') await ensureRollup(task.venueId, task.tenantUserId).catch((err) => console.warn('[ADAPTIVE WORKER] arming the rollup failed:', err?.message || err));
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
              identityProblem: this.identityProblem,
              keyWarning: this.keyWarning,
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

  /** The pinned identity-key fingerprint (read at most once a minute). */
  private async pinnedFingerprint(): Promise<string | null> {
    if (!this.pinned || Date.now() - this.pinned.at > HEARTBEAT_MS) {
      const snap = await db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get();
      const fp = snap.get('identity.keyFingerprint');
      this.pinned = { fingerprint: typeof fp === 'string' ? fp : null, at: Date.now() };
    }
    return this.pinned.fingerprint;
  }

  /** Null when this worker's identity key may be used; otherwise why not. */
  private async identityCheck(): Promise<string | null> {
    const pinned = await this.pinnedFingerprint();
    const own = keyFingerprint();
    if (pinned && pinned !== own) {
      return `this worker's identity key (${own}) differs from the pinned one (${pinned}) — GUEST_OTP_PEPPER changed`;
    }
    return null;
  }

  private warnKey(message: string): void {
    if (this.keyWarning?.message !== message) console.error(`[ADAPTIVE WORKER] ${message}`);
    this.keyWarning = { message, at: new Date() };
  }

  /** Pins the key the first time the API and this worker agree on it. */
  private async pinKey(fingerprint: string): Promise<void> {
    // Confirmed within the last minute: nothing to do (the pin may have been cleared since — then re-pin).
    if (this.pinned?.fingerprint === fingerprint && Date.now() - this.pinned.at < HEARTBEAT_MS) return;
    const ref = db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID);
    const stored = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.get('identity.keyFingerprint');
      if (typeof existing === 'string') return existing;
      tx.set(ref, { identity: { keyFingerprint: fingerprint, pinnedAt: new Date() } }, { merge: true });
      return fingerprint;
    });
    this.pinned = { fingerprint: stored, at: Date.now() };
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
