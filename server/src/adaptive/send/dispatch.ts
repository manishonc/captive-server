/**
 * Sending exactly once (plan §3.7) — the three phases of a live send:
 *
 *  1. One transaction: re-read what can change between the gate and now (the
 *     pause, consent, blocks, the weekly limit, a low rating) and run the gate
 *     again on it; then create the send record `dispatching`, add the weekly
 *     touch, bump the instance and park it on the send with a backstop timer.
 *  2. The provider call — one request, no automatic retries, 15 s timeout.
 *  3. Record the answer (only moves forward), then charge:
 *       accepted → `sent`; debitOne(debit_auto_{sendKey}) — idempotent
 *       rejected → `failed`, not charged (21610 also STOP-blocks the number)
 *       retry    → the record is removed (nothing left the building), try later
 *       unknown  → `unknown`: never resent, not charged, the journey carries on
 *
 * A worker that dies anywhere in between leaves the record behind: the retried
 * task resumes from it instead of sending again, and a sent-but-not-charged send
 * is charged on resume or by the `send_sweep` repair task.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ContactDoc, ContactPointDoc, ContactVenueDoc, JourneySendDoc, MarketingTouch, NetworkPersonDoc } from '../store/engineTypes';
import { runGate, type GateInput, type GateResult } from '../core/runtime/gate';
import { DAY_MS, MINUTE_MS } from '../core/runtime/time';
import { eventIdFor } from '../core/runtime/ids';
import { parseEngineSettings } from '../store/engineSettings';
import { CONFIG_DOC_ID } from '../store/collections';
import { consentFor } from '../identity/resolve';
import { tsMs } from '../store/time';
import { debitOne, onCreditsSpent } from '../../services/credits';
import { firestoreScheduler, LEASE_MS } from '../queue/firestoreQueue';
import { appendEvent, appendEventInTx, eventDoc, eventRef, type EventInput } from '../engine/events';
import { instanceRef, stateUpdate, type LoadedInstance } from '../engine/instanceStore';
import { applyPhoneStop } from '../engine/optouts';
import { raiseAlert, dayKey } from '../engine/alerts';
import type { ChannelAdapter, Outbound, ProviderResult } from './adapters/types';

/** A provider "try again later" answer is retried this many times, then the step is skipped. */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** If phase 3 never commits (the worker died), the parked instance wakes after this and resumes. */
const BACKSTOP_MS = 3 * MINUTE_MS;
const TOUCH_WINDOW_MS = 30 * DAY_MS;
const MAX_TOUCHES = 20;

const sendRef = (sendKey: string) => db.collection(COL.journeySends).doc(sendKey);

export interface LiveSend {
  inst: LoadedInstance;
  nodeId: string;
  sendKey: string;
  now: number;
  workerId: string;
  channel: 'email' | 'sms';
  purpose: 'marketing' | 'service';
  adapter: ChannelAdapter;
  /** The record to create (status dispatching, mode live, decision, prices…). */
  doc: JourneySendDoc;
  message: Outbound;
  gateInput: GateInput;
  /** The contact point of the address used (its blocks are re-checked). */
  pointId: string | null;
  intendedAt: number;
  slot: string;
  variantId: string;
  ladderPos: number;
  common: Record<string, unknown>;
  /** Events from earlier steps of this run (written with the claim, so a lost final commit keeps them). */
  pendingEvents: EventInput[];
}

export type Phase1Result = { kind: 'ok'; revAfter: number } | { kind: 'conflict' } | { kind: 'gate'; gate: GateResult };

/** Phase 1: re-check and claim the send. */
export async function claimSend(p: LiveSend): Promise<Phase1Result> {
  const { inst, sendKey } = p;
  const marketing = p.purpose === 'marketing';
  const readRev = inst.state.rev;
  return db.runTransaction(async (tx) => {
    const [instSnap, sendSnap, cfgSnap, contactSnap, cpSnap, npSnap, cvSnap] = await Promise.all([
      tx.get(instanceRef(inst.id)),
      tx.get(sendRef(sendKey)),
      tx.get(db.collection(COL.config).doc(CONFIG_DOC_ID)),
      tx.get(db.collection(COL.contacts).doc(inst.meta.contactId)),
      p.pointId ? tx.get(db.collection(COL.contactPoints).doc(p.pointId)) : Promise.resolve(null),
      tx.get(db.collection(COL.networkPeople).doc(inst.meta.networkId)),
      tx.get(db.collection(COL.contactVenues).doc(`${inst.meta.contactId}_${inst.meta.venueId}`)),
    ]);
    if (!instSnap.exists || Number(instSnap.get('rev')) !== readRev || instSnap.get('status') !== 'active') return { kind: 'conflict' } as const;
    if (sendSnap.exists) return { kind: 'conflict' } as const;

    const settings = parseEngineSettings(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined);
    const contact = (contactSnap.data() ?? {}) as ContactDoc;
    const point = (cpSnap?.data() ?? null) as ContactPointDoc | null;
    const np = (npSnap.data() ?? null) as NetworkPersonDoc | null;
    const cv = (cvSnap.data() ?? {}) as Partial<ContactVenueDoc>;
    const weekAgo = p.now - 7 * DAY_MS;
    const touches = (np?.recentMarketingTouches ?? []).filter((t) => t.sendKey !== sendKey && (tsMs(t.at) ?? 0) >= p.now - TOUCH_WINDOW_MS);
    const gi: GateInput = {
      ...p.gateInput,
      system: { ...p.gateInput.system, paused: settings.paused },
      address: { blocked: point?.suppression?.[p.channel]?.reason ?? null, lowRatingAt: tsMs(cv.lowRatingAt) },
      consent: { state: consentFor(contact, inst.meta.venueId)[p.channel]?.state ?? 'none' },
      weekly: { ...p.gateInput.weekly, count: touches.filter((t) => (tsMs(t.at) ?? 0) >= weekAgo).length },
    };
    const gate = runGate(gi);
    if (gate.verdict !== 'allow') return { kind: 'gate', gate } as const;

    tx.create(sendRef(sendKey), p.doc);
    if (marketing) {
      const touch: MarketingTouch = { at: new Date(p.now), channel: p.channel, tenantUserId: inst.meta.tenantUserId, venueId: inst.meta.venueId, sendKey };
      const next = [...touches, touch].slice(-MAX_TOUCHES);
      tx.set(db.collection(COL.networkPeople).doc(inst.meta.networkId), { recentMarketingTouches: next, updatedAt: new Date() }, { merge: true });
    }
    // Park the instance on this send with everything this run did so far (offer, trail,
    // counters…): if the final commit is lost, the backstop wakes it and the resume path
    // finishes the step from the send record — nothing earlier in the run is lost.
    const token = `${p.nodeId}@dispatch:${sendKey}`;
    const prev = inst.state.waiting;
    tx.update(
      instanceRef(inst.id),
      stateUpdate(
        {
          ...inst.state,
          rev: readRev + 1,
          cursor: { nodeId: p.nodeId, enteredAt: inst.state.cursor.nodeId === p.nodeId ? inst.state.cursor.enteredAt : p.now },
          waiting: {
            kind: 'send_due',
            nodeId: p.nodeId,
            token,
            untilAt: p.now + BACKSTOP_MS,
            intendedAt: p.intendedAt,
            slot: p.slot,
            ...(prev?.nodeId === p.nodeId && prev.lastDeferReason ? { lastDeferReason: prev.lastDeferReason } : {}),
            ...(prev?.nodeId === p.nodeId && prev.creditsWaitStartedAt !== undefined ? { creditsWaitStartedAt: prev.creditsWaitStartedAt } : {}),
            ...(prev?.nodeId === p.nodeId && prev.dispatchAttempts !== undefined ? { dispatchAttempts: prev.dispatchAttempts } : {}),
          },
        },
        p.now,
        null,
      ),
    );
    for (const e of p.pendingEvents) appendEventInTx(tx, e);
    firestoreScheduler.scheduleInTx(tx, {
      dedupeKey: `node:${inst.id}:${token}`,
      kind: 'node_run',
      dueAt: p.now + BACKSTOP_MS,
      payload: { instanceId: inst.id, input: 'send_due', nodeId: p.nodeId, token },
      tenantUserId: inst.meta.tenantUserId,
      venueId: inst.meta.venueId,
    });
    return { kind: 'ok', revAfter: readRev + 1 } as const;
  });
}

/** Phase 2: one provider request. Nothing an adapter throws can escape as "sent twice". */
export async function callProvider(adapter: ChannelAdapter, message: Outbound): Promise<ProviderResult> {
  try {
    return await adapter.send(message);
  } catch (err) {
    return { kind: 'unknown', provider: adapter.provider, reason: `adapter_threw:${(err as Error)?.message ?? err}`.slice(0, 200) };
  }
}

function sendEvent(p: LiveSend, type: string, data: Record<string, unknown>): { id: string; doc: Record<string, unknown> } {
  const e: EventInput = { ...(p.common as any), type, occurredAt: p.now, source: 'engine', data: { mode: 'live', ...data } };
  return { id: eventIdFor('engine', `${p.sendKey}:${type}`), doc: eventDoc(e) };
}

async function removeTouch(tx: FirebaseFirestore.Transaction, networkId: string, sendKey: string, np: NetworkPersonDoc | null): Promise<void> {
  if (!np) return;
  const kept = (np.recentMarketingTouches ?? []).filter((t) => t.sendKey !== sendKey);
  if (kept.length !== (np.recentMarketingTouches ?? []).length) {
    tx.update(db.collection(COL.networkPeople).doc(networkId), { recentMarketingTouches: kept, updatedAt: new Date() });
  }
}

export type Phase3Result =
  | { kind: 'sent'; unknown: boolean }
  | { kind: 'failed'; code: string }
  | { kind: 'retry'; delayMs: number; reason: string; config: boolean };

/** Phase 3: record the provider's answer. Returns what the journey should do. */
export async function recordResult(p: LiveSend, result: ProviderResult, attempts: number): Promise<Phase3Result> {
  const { sendKey } = p;
  const marketing = p.purpose === 'marketing';

  if (result.kind === 'accepted') {
    const record = () => db.runTransaction(async (tx) => {
      const ev = sendEvent(p, 'message.sent', {
        channel: p.channel,
        purpose: p.purpose,
        credits: p.doc.credits?.amount ?? 0,
        providerCostMinor: p.doc.providerCostMinor,
        segments: result.segments ?? p.doc.smsSegments,
        slot: p.slot,
        variantId: p.variantId,
      });
      const [sSnap, cSnap, eSnap] = await Promise.all([
        tx.get(sendRef(sendKey)),
        tx.get(db.collection(COL.contacts).doc(p.inst.meta.contactId)),
        tx.get(eventRef(ev.id)),
      ]);
      const s = sSnap.data() as JourneySendDoc | undefined;
      if (!s) return;
      const update: Record<string, unknown> = {
        provider: result.provider,
        sentAt: new Date(p.now),
        dispatchLease: null,
        updatedAt: new Date(),
      };
      if (s.status === 'dispatching' || s.status === 'unknown') update.status = 'sent';
      if (!s.providerMessageId && result.providerMessageId) update.providerMessageId = result.providerMessageId;
      if (typeof result.segments === 'number') update.smsSegments = result.segments;
      tx.update(sendRef(sendKey), update);
      if (!eSnap.exists) tx.set(eventRef(ev.id), ev.doc);
      // A plain reply to this number is matched to its last live SMS.
      if (p.channel === 'sms' && p.pointId) {
        tx.set(
          db.collection(COL.contactPoints).doc(p.pointId),
          { lastLiveSms: { sendKey, tenantUserId: p.inst.meta.tenantUserId, at: new Date(p.now) } },
          { merge: true },
        );
      }
      // The favourite channel is dropped after two touches on it without a click.
      const contact = cSnap.data() as ContactDoc | undefined;
      if (marketing && contact?.engagement?.preferredChannel === p.channel) {
        tx.update(db.collection(COL.contacts).doc(p.inst.meta.contactId), {
          'engagement.consecutiveNoClickOnPreferred': FieldValue.increment(1),
        });
      }
      // The charge repair is queued together with "sent": if the debit below fails
      // (or the worker dies before it), the repair task still charges it — once.
      if (marketing && !s.credits?.ledgerId) firestoreScheduler.scheduleInTx(tx, chargeRepairTask(p.inst.meta.tenantUserId, p.inst.meta.venueId, sendKey, p.now));
    });
    let recorded = false;
    for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
      try {
        await record();
        recorded = true;
      } catch (err) {
        console.error('[ADAPTIVE] recording an accepted send failed:', sendKey, attempt + 1, (err as Error)?.message || err);
      }
    }
    if (!recorded) {
      // At least keep the proof the provider took it (so it is charged and webhooks match it).
      await sendRef(sendKey)
        .update({ status: 'sent', provider: result.provider, providerMessageId: result.providerMessageId, sentAt: new Date(p.now), dispatchLease: null, updatedAt: new Date() })
        .catch((err) => console.error('[ADAPTIVE] could not record an accepted send:', sendKey, (err as Error)?.message || err));
      // The repair charges a marketing send and, for every send, writes its message.sent (the
      // daily numbers count from it) if the try below fails too.
      await scheduleChargeRepair(p.inst.meta.tenantUserId, p.inst.meta.venueId, sendKey, p.now);
      await ensureSentEvent(sendKey).catch((err) => console.warn('[ADAPTIVE] message.sent not written:', sendKey, (err as Error)?.message || err));
    }
    await chargeSend(sendKey).catch((err) => {
      console.error('[ADAPTIVE] debit failed after a send — the queued repair will charge it:', sendKey, (err as Error)?.message || err);
    });
    return { kind: 'sent', unknown: false };
  }

  if (result.kind === 'unknown') {
    await db.runTransaction(async (tx) => {
      const ev = sendEvent(p, 'message.unknown', { channel: p.channel, reason: result.reason });
      const [sSnap, eSnap] = await Promise.all([tx.get(sendRef(sendKey)), tx.get(eventRef(ev.id))]);
      if (sSnap.get('status') === 'dispatching') {
        tx.update(sendRef(sendKey), { status: 'unknown', provider: result.provider, errorMessage: result.reason.slice(0, 300), dispatchLease: null, updatedAt: new Date() });
      }
      if (!eSnap.exists) tx.set(eventRef(ev.id), ev.doc);
    });
    return { kind: 'sent', unknown: true };
  }

  if (result.kind === 'rejected' && !result.config) {
    const recordFailed = db.runTransaction(async (tx) => {
      const ev = sendEvent(p, 'message.failed', { channel: p.channel, code: result.code });
      const [sSnap, npSnap, eSnap] = await Promise.all([
        tx.get(sendRef(sendKey)),
        marketing ? tx.get(db.collection(COL.networkPeople).doc(p.inst.meta.networkId)) : Promise.resolve(null),
        tx.get(eventRef(ev.id)),
      ]);
      if (sSnap.get('status') === 'dispatching' || sSnap.get('status') === 'unknown') {
        tx.update(sendRef(sendKey), {
          status: 'failed',
          provider: result.provider,
          errorCode: result.code.slice(0, 60),
          errorMessage: result.message.slice(0, 300),
          dispatchLease: null,
          updatedAt: new Date(),
        });
      }
      // A message that never went out doesn't count toward the weekly limit.
      if (marketing) await removeTouch(tx, p.inst.meta.networkId, sendKey, (npSnap?.data() ?? null) as NetworkPersonDoc | null);
      if (!eSnap.exists) tx.set(eventRef(ev.id), ev.doc);
    });
    // 21610 = the number said STOP at the carrier: block it even if recording the failure didn't work.
    try {
      await recordFailed;
    } finally {
      if (result.suppress === 'stop' && p.pointId) await applyPhoneStop(p.pointId, 'provider_stop', p.now, { sendKey, errorCode: result.code });
    }
    return { kind: 'failed', code: result.code };
  }

  // retry, or an account problem (treated as "later" + alert, not the guest's fault)
  const config = result.kind === 'rejected';
  const reason = result.kind === 'retry' ? result.reason : `provider_config:${result.code}`;
  await db.runTransaction(async (tx) => {
    const [sSnap, npSnap] = await Promise.all([
      tx.get(sendRef(sendKey)),
      marketing ? tx.get(db.collection(COL.networkPeople).doc(p.inst.meta.networkId)) : Promise.resolve(null),
    ]);
    // Nothing left the building: remove the claim, so the next attempt runs the gate afresh.
    if (sSnap.get('status') === 'dispatching' && sSnap.get('dispatchLease.owner') === p.workerId) tx.delete(sendRef(sendKey));
    if (marketing) await removeTouch(tx, p.inst.meta.networkId, sendKey, (npSnap?.data() ?? null) as NetworkPersonDoc | null);
    const ev = sendEvent(p, 'send.retry', { channel: p.channel, reason, attempt: attempts + 1 });
    tx.set(eventRef(eventIdFor('engine', `${sendKey}:retry:${attempts + 1}`)), ev.doc);
  });
  if (config) {
    await raiseAlert({
      kind: 'provider_config',
      dedupeKey: `provider_config:${result.provider}:${dayKey(p.now, 'Europe/Zurich')}`,
      audience: 'heidifi',
      subject: `Adaptive: ${result.provider} refused the credentials`,
      text: `${result.provider} answered ${result.kind === 'rejected' ? result.code : ''} to a ${p.channel} send. Sends on this channel wait and retry; check the provider credentials of the adaptive-worker app.`,
    });
  }
  const retryAfter = result.kind === 'retry' ? result.retryAfterMs ?? null : null;
  const delayMs = config ? 60 * MINUTE_MS : Math.min(30 * MINUTE_MS, retryAfter ?? 2 * MINUTE_MS * 2 ** attempts);
  return { kind: 'retry', delayMs, reason, config };
}

/**
 * Charges an accepted marketing send once (ledger `debit_auto_{sendKey}`), with
 * the amounts priced in phase 1. Safe to call again: debitOne's first write wins.
 */
export async function chargeSend(sendKey: string): Promise<'charged' | 'nothing'> {
  const snap = await sendRef(sendKey).get();
  const s = snap.data() as JourneySendDoc | undefined;
  if (!s || s.mode !== 'live' || s.purpose !== 'marketing' || !s.credits || s.credits.amount < 1 || s.credits.ledgerId) return 'nothing';
  if (!s.sentAt) return 'nothing'; // only a send the provider accepted is charged
  await debitOne({
    tenantUserId: s.tenantUserId,
    sendId: sendKey,
    credits: s.credits.amount,
    channel: s.channel,
    segments: s.smsSegments ?? undefined,
    rateCardVersion: s.credits.rateCardVersion ?? 0,
    providerCostMinorSnapshot: s.providerCostMinor ?? 0,
  });
  await sendRef(sendKey).update({ 'credits.ledgerId': `debit_auto_${sendKey}`, updatedAt: new Date() });
  void onCreditsSpent(s.tenantUserId).catch(() => undefined);
  return 'charged';
}

/**
 * Writes a send's `message.sent` event if the provider took it and the event is missing
 * (its recording transaction failed): the daily numbers count sends and credits from it.
 * Create-only, so it is never counted twice.
 */
export async function ensureSentEvent(sendKey: string): Promise<'written' | 'nothing'> {
  const id = eventIdFor('engine', `${sendKey}:message.sent`);
  const [sSnap, eSnap] = await Promise.all([sendRef(sendKey).get(), eventRef(id).get()]);
  const s = sSnap.data() as JourneySendDoc | undefined;
  // sentAt is only ever set once the provider took it (the same rule charges it): a later
  // failure or bounce is counted by its own event.
  if (eSnap.exists || !s || s.mode !== 'live' || !s.sentAt) return 'nothing';
  await appendEvent(
    {
      type: 'message.sent',
      occurredAt: tsMs(s.sentAt) ?? Date.now(),
      tenantUserId: s.tenantUserId,
      venueId: s.venueId,
      contactId: s.contactId,
      instanceId: s.instanceId,
      journeyKey: s.journeyKey,
      nodeId: s.nodeId,
      sendKey,
      variantId: s.variantId,
      channel: s.channel,
      slot: s.slot,
      mode: 'live',
      data: { mode: 'live', repaired: true, channel: s.channel, purpose: s.purpose, credits: s.credits?.amount ?? 0, providerCostMinor: s.providerCostMinor ?? 0, segments: s.smsSegments, slot: s.slot, variantId: s.variantId },
    },
    id,
  );
  return 'written';
}

export function chargeRepairTask(tenantUserId: string, venueId: string, sendKey: string, now: number) {
  return { dedupeKey: `charge:${sendKey}`, kind: 'send_sweep' as const, dueAt: now + 5 * MINUTE_MS, payload: { action: 'charge', sendKey }, tenantUserId, venueId };
}

export async function scheduleChargeRepair(tenantUserId: string, venueId: string, sendKey: string, now: number): Promise<void> {
  await firestoreScheduler
    .schedule(chargeRepairTask(tenantUserId, venueId, sendKey, now))
    .catch((err) => console.error('[ADAPTIVE] could not queue a charge repair:', sendKey, (err as Error)?.message || err));
}

/** The resume path's "dispatching, lease ran out" → `unknown`, only if that is still true. */
export async function markStuckUnknown(sendKey: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sendRef(sendKey));
    if (snap.get('status') !== 'dispatching') return;
    const until = tsMs(snap.get('dispatchLease.until')) ?? 0;
    if (until > Date.now()) return;
    tx.update(sendRef(sendKey), { status: 'unknown', errorMessage: 'dispatch lease expired', dispatchLease: null, updatedAt: new Date() });
  });
}

/** The dispatch lease on a new record: the task lease, so a crashed worker's send is resumed after it. */
export function dispatchLease(workerId: string): { owner: string; until: Date } {
  return { owner: workerId, until: new Date(Date.now() + LEASE_MS) };
}

