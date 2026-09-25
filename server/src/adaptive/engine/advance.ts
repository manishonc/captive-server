/**
 * Moving one guest through one journey (04-engine-runtime §2–§3, §6).
 *
 * `advance` takes an input (start / a timer / an event / a due send), runs the
 * pure interpreter, carries out its effects (a send goes through the send path),
 * and commits the new state + follow-up tasks + events in ONE transaction that
 * checks the instance `rev`. A conflict (someone else moved the instance) means
 * re-read and try again — a click is never lost, a stale timer never acts.
 */

import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import { step, type InterpreterContext } from '../core/runtime/interpreter';
import { ENDED_STATUSES, type EngineEvent, type InstanceState, type RuntimeInput } from '../core/runtime/types';
import { firestoreScheduler, type TaskSpec } from '../queue/firestoreQueue';
import { loadCatalogue, templateVersion } from '../service/catalogue';
import type { EngineSettings } from '../store/engineSettings';
import { retentionFrom } from '../store/time';
import { appendEventInTx, type EventInput } from './events';
import { loadContact, loadVenueContext, pinnedConfig } from './context';
import { journeyFacts } from './enrol';
import { instanceRef, loadInstance, stateUpdate, type LoadedInstance } from './instanceStore';
import { runSend } from './sendPath';
import { decideConfigSwap } from '../core/runtime/configSwap';
import { MINUTE_MS } from '../core/runtime/time';

export type AdvanceInput =
  | { kind: 'start' }
  | { kind: 'wake'; nodeId: string }
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'send_due'; nodeId: string };

export type AdvanceResult = { status: 'done' } | { status: 'conflict' } | { status: 'retry'; atMs: number };

const MAX_LOOPS = 20;
const MAX_CONFLICT_RETRIES = 5;

export async function advance(
  inst: LoadedInstance,
  input: AdvanceInput,
  env: { now: number; settings: EngineSettings; workerId: string; taskDueAt: number },
): Promise<AdvanceResult> {
  const { now } = env;
  // A replayed webhook or a retried task delivers the same event again: count it once.
  if (input.kind === 'event' && (inst.state.seenEventIds ?? []).includes(input.event.id)) return { status: 'done' };
  const cat = await loadCatalogue();
  const found = templateVersion(cat, inst.meta.journeyKey, inst.meta.templateVersion);
  // An owner edit applied to running guests (plan §3.10): the guest moves to the new values
  // at its first step after the freeze window of the save — nothing within 60 minutes of
  // the save, and no send planned within them, uses the new values.
  const freezeMinutes = Number.isFinite(cat.config.freezeWindowMinutes) ? cat.config.freezeWindowMinutes : 60;
  const swap = decideConfigSwap(
    { configVersion: inst.meta.configVersion, pendingConfigVersion: inst.meta.pendingConfigVersion, pendingConfigAt: inst.meta.pendingConfigAt ?? null },
    inst.state.waiting,
    freezeMinutes * MINUTE_MS,
    now,
  );
  // Everything below (the pinned values, the send record, the "why" record) sees the version actually used.
  if (swap.kind === 'swap') inst = { ...inst, meta: { ...inst.meta, configVersion: swap.use, pendingConfigVersion: null, pendingConfigAt: null } };
  const [ctx, pinned, contact] = await Promise.all([
    loadVenueContext(inst.meta.venueId),
    pinnedConfig(inst.meta.installId, swap.use, inst.meta.journeyKey),
    loadContact(inst.meta.contactId),
  ]);

  let state: InstanceState = inst.state;
  let expectedRev = inst.state.rev;
  let changed = false;
  const tasks: TaskSpec[] = [];
  const events: EventInput[] = [];
  const common = { tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, contactId: inst.meta.contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, mode: inst.meta.mode };

  if (!found) {
    changed = true;
    state = { ...state, status: 'failed', exitReason: 'template_version_missing', waiting: null };
    events.push({ ...common, type: 'journey.exited', occurredAt: now, data: { status: 'failed', reason: 'template_version_missing' } });
  } else {
    const interp: InterpreterContext = {
      now,
      definition: found.definition,
      venueTz: inst.meta.context.venueTz,
      slots: pinned.slots,
      offers: pinned.offers,
      // instance.* is overlaid by the interpreter from its working state.
      facts: ctx
        ? journeyFacts(ctx, contact, {
            isFirstVisit: inst.meta.context.isFirstVisit,
            visitNumber: inst.meta.context.visitNumber ?? undefined,
            isRevisit: inst.meta.context.isRevisit ?? undefined,
          })
        : () => undefined,
      stay: null,
    };

    let pending: RuntimeInput | null = null;
    let sendNode: string | null = null;
    let dueRun = false;
    // A step is as old as what reached it: a timer's due time, or when the event
    // happened — so a revisit handled hours late can't produce a late thank-you.
    const reachedAt = input.kind === 'event' ? Math.min(now, input.event.occurredAt) : Math.min(now, env.taskDueAt);
    if (input.kind === 'send_due') {
      sendNode = input.nodeId;
      dueRun = true;
    } else if (input.kind === 'start') pending = { kind: 'start' };
    else if (input.kind === 'wake') pending = { kind: 'wake', nodeId: input.nodeId };
    else pending = { kind: 'event', event: input.event };

    for (let i = 0; i < MAX_LOOPS; i += 1) {
      if (sendNode) {
        const outcome = await runSend({
          inst: { ...inst, state: { ...state, rev: expectedRev } },
          nodeId: sendNode,
          definition: found.definition,
          ctx,
          pinned,
          now,
          dueRun,
          reachedAt,
          taskDueAt: env.taskDueAt,
          settings: env.settings,
          workerId: env.workerId,
          pendingEvents: events,
        });
        if (outcome.kind === 'conflict') return { status: 'conflict' };
        if (outcome.kind === 'busy') return { status: 'retry', atMs: outcome.retryAt };
        changed = true;
        events.push(...outcome.events.map((e) => ({ ...common, ...e })));
        if (outcome.kind === 'later') {
          // A live dispatch that has to wait already bumped the instance.
          if (outcome.revAfter !== undefined && outcome.revAfter !== null) expectedRev = outcome.revAfter;
          const token = `${sendNode}@${now}:${outcome.reason}`;
          state = {
            ...state,
            waiting: {
              kind: 'send_due',
              nodeId: sendNode,
              token,
              untilAt: outcome.at,
              intendedAt: outcome.intendedAt,
              slot: outcome.slot,
              lastDeferReason: outcome.reason,
              ...(outcome.creditsWaitStartedAt !== undefined ? { creditsWaitStartedAt: outcome.creditsWaitStartedAt } : {}),
              ...(outcome.dispatchAttempts !== undefined ? { dispatchAttempts: outcome.dispatchAttempts } : {}),
            },
          };
          tasks.push(nodeTask(inst, 'send_due', sendNode, token, outcome.at));
          break;
        }
        if (outcome.revAfter !== null) expectedRev = outcome.revAfter;
        if (outcome.suppress) {
          state = { ...state, status: 'suppressed', exitReason: 'switched_off', waiting: null };
          events.push({ ...common, type: 'journey.exited', occurredAt: now, data: { status: 'suppressed', reason: 'switched_off' } });
          break;
        }
        pending = { kind: 'send_result', nodeId: sendNode, outcome: outcome.outcome, touch: outcome.touch, ladderPos: outcome.ladderPos };
        sendNode = null;
        dueRun = false;
      }

      if (!pending) break;
      const handled = pending.kind === 'event' ? pending.event.id : null;
      const r = step(state, pending, { ...interp, now });
      pending = null;
      if (r.unchanged) break;
      changed = true;
      state = r.state;
      if (handled) state = { ...state, seenEventIds: [...(state.seenEventIds ?? []), handled].slice(-20) };
      for (const e of r.effects) {
        if (e.type === 'timer') tasks.push(nodeTask(inst, 'wake', e.nodeId, e.token, e.at));
        else if (e.type === 'emit') events.push({ ...common, nodeId: state.cursor.nodeId, type: e.eventType, occurredAt: now, data: e.data });
        else if (e.type === 'send') sendNode = e.nodeId;
      }
      if (!sendNode) break;
    }
  }

  if (!changed) return { status: 'done' };
  if (swap.kind === 'swap') {
    events.push({ ...common, type: 'journey.config_updated', occurredAt: now, data: { from: swap.from, to: swap.use } });
  }

  // ── commit ──
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(instanceRef(inst.id));
    if (!snap.exists || Number(snap.get('rev')) !== expectedRev) return false;
    const next = { ...state, rev: expectedRev + 1 };
    const ended = ENDED_STATUSES.has(next.status);
    const update = stateUpdate(next, now, ended ? retentionFrom(now) : null);
    if (swap.kind === 'swap' || swap.kind === 'stale') {
      if (swap.kind === 'swap') update.configVersion = swap.use;
      // A newer save may have marked the guest since we read it: keep that one for the next step.
      const pendingNow = snap.get('pendingConfigVersion');
      if (!(typeof pendingNow === 'number' && pendingNow > swap.use)) {
        update.pendingConfigVersion = null;
        update.pendingConfigAt = null;
      }
    }
    tx.update(instanceRef(inst.id), update);
    for (const t of tasks) firestoreScheduler.scheduleInTx(tx, t);
    for (const e of events) appendEventInTx(tx, e);
    if (ended) {
      const cvRef = db.collection(COL.contactVenues).doc(contactVenueId(inst.meta.contactId, inst.meta.venueId));
      tx.update(
        cvRef,
        new FieldPath('journeys', inst.meta.journeyKey, 'activeInstanceId'),
        null,
        new FieldPath('journeys', inst.meta.journeyKey, 'lastExitAt'),
        new Date(now),
        new FieldPath('journeys', inst.meta.journeyKey, 'lastExitReason'),
        next.exitReason ?? next.status,
      );
    }
    return true;
  });
  return ok ? { status: 'done' } : { status: 'conflict' };
}

function nodeTask(inst: LoadedInstance, input: 'wake' | 'send_due', nodeId: string, token: string, at: number): TaskSpec {
  return {
    dedupeKey: `node:${inst.id}:${token}`,
    kind: 'node_run',
    dueAt: at,
    payload: { instanceId: inst.id, input, nodeId, token },
    tenantUserId: inst.meta.tenantUserId,
    venueId: inst.meta.venueId,
  };
}

/** A timer task (start / wake / send_due): only acts if its wait is still the current one. */
export async function runTimer(
  payload: { instanceId: string; input: 'start' | 'wake' | 'send_due'; nodeId?: string; token: string },
  env: { now: number; settings: EngineSettings; workerId: string; taskDueAt: number },
): Promise<AdvanceResult> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const inst = await loadInstance(payload.instanceId);
    if (!inst || inst.state.status !== 'active') return { status: 'done' };
    if (inst.state.waiting?.token !== payload.token) return { status: 'done' }; // stale: the wait moved on
    const input: AdvanceInput =
      payload.input === 'start'
        ? { kind: 'start' }
        : payload.input === 'send_due'
          ? { kind: 'send_due', nodeId: payload.nodeId! }
          : { kind: 'wake', nodeId: payload.nodeId! };
    const r = await advance(inst, input, env);
    if (r.status !== 'conflict') return r;
  }
  return { status: 'retry', atMs: env.now + 30_000 };
}

/** An event for one instance (a visit, an offer redeemed, a click): re-read and retry on conflict. */
export async function deliverEvent(
  instanceId: string,
  event: EngineEvent,
  env: { now: number; settings: EngineSettings; workerId: string },
): Promise<AdvanceResult> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const inst = await loadInstance(instanceId);
    if (!inst || inst.state.status !== 'active') return { status: 'done' };
    const r = await advance(inst, { kind: 'event', event }, { ...env, taskDueAt: env.now });
    if (r.status !== 'conflict') return r;
  }
  return { status: 'retry', atMs: env.now + 30_000 };
}
