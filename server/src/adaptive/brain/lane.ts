/**
 * The worker's AI lane (PR F2a). The worker claims up to 10 tasks and waits for all of them before
 * it claims more (worker/worker.ts), so a model call inside that batch would hold back every due
 * send for as long as the model thinks. An `agent_run` task therefore only starts here, and the
 * batch moves on at once:
 *
 *  - one run at a time per worker; another `agent_run` claimed meanwhile goes back to the queue
 *    for a minute (no attempt counted), one for an agent this build doesn't know for ten. The task
 *    the lane is already running, handed back to this same worker after its lease ran out, stays
 *    with the run (never released, never started twice);
 *  - the lease is renewed as the run starts and every 30 s after, only while this worker still
 *    holds it, and the run record is written under it (brain/run.ts): a lost lease stops the run
 *    (before the model call, or by aborting it) — the next attempt then finds the started run and
 *    skips, so the model is never called twice for one task. A renewal that fails or hangs
 *    (Firestore unreachable; each is awaited at most 10 s, and one that lands later still counts)
 *    stops the run once the last good one is more than three intervals old — within about 100 s
 *    of when that one was asked, inside the 2-minute lease;
 *  - the model call is aborted at the lane's deadline, and a run that still hasn't returned 30 s
 *    later is given up (the lane is free again);
 *  - the task is done whatever the run's outcome — a failed call is in the run log and is tried
 *    again at its next due time, never in a loop. Only an unexpected error (Firestore down, a bug)
 *    fails the task, and the queue hands it out again (maxAttempts 3; a later attempt never calls
 *    the model once an earlier one started);
 *  - the worker's loop, heartbeat and healthcheck never wait for it. On SIGTERM the worker aborts
 *    the run (`abortForShutdown`) and waits for it to record what happened (within its 20 s); an
 *    `agent_run` claimed after that goes straight back to the queue for the next worker.
 */

import { completeTask, failTask, releaseTask, renewLease, type ClaimedTask } from '../queue/firestoreQueue';
import { now as engineNow } from '../engine/clock';
import type { EngineSettings } from '../store/engineSettings';
import { jobFor } from './registry';
import { relayConfigured } from './modelClient';
import { RUN_DEADLINE_MS, runAgent, type RunRequest, type RunResult } from './run';
import { requestOf } from './tasks';

export type RunFn = (
  req: RunRequest,
  opts: { settings: EngineSettings; signal: AbortSignal; deadlineAt: number; lease: { taskId: string; workerId: string } },
) => Promise<RunResult>;

const LEASE_RENEW_MS = 30_000;
export const LANE_DEADLINE_MS = RUN_DEADLINE_MS + 10_000;
const GIVE_UP_AFTER_MS = 30_000;
const BUSY_RETRY_MS = 60_000;
const UNKNOWN_AGENT_RETRY_MS = 10 * 60_000;

export class AiLane {
  private current: { taskId: string; run: Promise<void>; controller: AbortController } | null = null;
  private lastRun: { at: number; outcome: string } | null = null;
  /** Set on SIGTERM: nothing new starts. */
  private closed = false;

  constructor(
    private readonly workerId: string,
    private readonly runFn: RunFn = (req, opts) => runAgent(req, opts),
    /** Tests: a shorter lease renewal. */
    private readonly renewMs: number = LEASE_RENEW_MS,
    /** Tests: the renewal itself. */
    private readonly renew: (taskId: string, workerId: string) => Promise<'held' | 'lost' | 'error'> = renewLease,
  ) {}

  get busy(): boolean {
    return this.current !== null;
  }

  /** For the worker's heartbeat: booleans and times only (never an env value). */
  status() {
    const relay = relayConfigured();
    return {
      busy: this.busy,
      lastRunAt: this.lastRun ? new Date(this.lastRun.at) : null,
      lastOutcome: this.lastRun?.outcome ?? null,
      relayUrlSet: relay.url,
      relaySecretSet: relay.secret,
    };
  }

  /** Starts the run of a claimed `agent_run` task and returns at once (or puts the task back). */
  async take(task: ClaimedTask, env: { now: number; settings: EngineSettings }): Promise<'started' | 'released' | 'running'> {
    if (this.current?.taskId === task.id) {
      // Our own run's task, reclaimed after its lease ran out and claimed by us again: the run
      // goes on and completes it (the new lease is ours).
      return 'running';
    }
    if (this.closed) {
      // Shutting down: the next worker (after the deploy) takes it at once.
      await releaseTask(task.id, this.workerId, 0, env.now);
      return 'released';
    }
    if (!jobFor(task.payload?.agentKey)) {
      // Written by a newer build during a deploy: leave it for a worker that knows the agent.
      await releaseTask(task.id, this.workerId, UNKNOWN_AGENT_RETRY_MS, env.now);
      return 'released';
    }
    if (this.current) {
      await releaseTask(task.id, this.workerId, BUSY_RETRY_MS, env.now);
      return 'released';
    }
    const controller = new AbortController();
    const entry = { taskId: task.id, controller, run: Promise.resolve() };
    entry.run = this.run(task, env, controller).finally(() => {
      if (this.current === entry) this.current = null;
    });
    this.current = entry;
    return 'started';
  }

  /** Resolves when no run is going (tests, the sandbox's runDue and the shutdown wait for it). */
  whenIdle(): Promise<void> {
    return this.current?.run ?? Promise.resolve();
  }

  /** SIGTERM: stop the model call now, so the run records what happened before the worker exits. */
  abortForShutdown(): void {
    this.closed = true;
    this.current?.controller.abort('shutdown');
  }

  private async run(task: ClaimedTask, env: { now: number; settings: EngineSettings }, controller: AbortController): Promise<void> {
    const started = Date.now();
    let lastHeld = started;
    // Held since `lastHeld` (when its renewal was asked: the new lease was set after that).
    const heldAt = (asked: number) => {
      lastHeld = Math.max(lastHeld, asked);
    };
    const keep = async () => {
      // Not confirmed for three intervals (a little headroom, so the third renewal is still
      // tried): the lease may be someone else's by now.
      if (Date.now() - lastHeld > 3 * this.renewMs + this.renewMs / 6) {
        controller.abort('lease_lost');
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const asked = Date.now();
      const renewal = this.renew(task.id, this.workerId);
      // A renewal that lands after its race still extended the lease.
      void renewal.then((h) => {
        if (h === 'held') heldAt(asked);
      });
      const held = await Promise.race([
        renewal,
        new Promise<'error'>((r) => {
          timer = setTimeout(() => r('error'), Math.min(this.renewMs / 3, 10_000));
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (held === 'held') heldAt(asked);
      else if (held === 'lost' || Date.now() - lastHeld > 3 * this.renewMs) controller.abort('lease_lost');
    };
    // The lease was taken when the batch was claimed, maybe a while ago: renew it before anything
    // (once more after a second if Firestore didn't answer).
    let asked = Date.now();
    let first = await this.renew(task.id, this.workerId);
    if (first === 'error') {
      await new Promise((r) => setTimeout(r, 1000));
      asked = Date.now();
      first = await this.renew(task.id, this.workerId);
    }
    if (first !== 'held') {
      console.warn('[ADAPTIVE AI] no lease on', task.id, `before the run started (${first}) — not running it`);
      return;
    }
    lastHeld = asked;
    const renew = setInterval(() => void keep(), this.renewMs);
    const abortTimer = setTimeout(() => controller.abort('deadline'), LANE_DEADLINE_MS);
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    try {
      const req: RunRequest = { ...requestOf(task), waitedMs: Math.max(0, engineNow() - task.dueAt) };
      const result = await Promise.race([
        this.runFn(req, {
          settings: env.settings,
          signal: controller.signal,
          deadlineAt: started + RUN_DEADLINE_MS,
          lease: { taskId: task.id, workerId: this.workerId },
        }),
        new Promise<never>((_, reject) => {
          giveUp = setTimeout(() => reject(new Error('the agent run did not finish in time')), LANE_DEADLINE_MS + GIVE_UP_AFTER_MS);
        }),
      ]);
      this.lastRun = { at: Date.now(), outcome: result.outcome };
      // Stopped by the shutdown before its call: the next worker takes the task at once.
      if (result.reason === 'shutdown') await releaseTask(task.id, this.workerId, 0, engineNow());
      else await completeTask(task.id, this.workerId);
    } catch (err) {
      this.lastRun = { at: Date.now(), outcome: 'error' };
      const message = String((err as Error)?.message ?? err).slice(0, 300);
      console.error('[ADAPTIVE AI] agent run failed:', task.id, message);
      await failTask(task.id, this.workerId, message, engineNow()).catch(() => undefined);
    } finally {
      clearInterval(renew);
      clearTimeout(abortTimer);
      if (giveUp) clearTimeout(giveUp);
    }
  }
}
