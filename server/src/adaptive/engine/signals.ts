/**
 * Signals, worker side (plan §3.9): what a delivery report, an open, a click, a
 * bounce, a STOP, an unsubscribe, a reply or a rating changes.
 *
 * Each effect is applied once: the event doc gets `appliedAt` in the same
 * transaction as its effects, so a retried task changes nothing twice. Message
 * events then go to the journey that owns the send (a click wakes "wait for
 * click"; the journey's own dedupe counts it once).
 *
 *  delivered → send `delivered` (an `unknown` send is repaired — and charged,
 *              the provider evidently took it)
 *  failed    → send `failed` (21610 → STOP-block the number)
 *  opened    → openedAt, the guest's opens + time-slot histogram
 *  bounced   → send `bounced`; the address's hard-bounce count; 2 (or invalid) → blocked for everyone
 *  clicked   → firstClickAt; the guest's favourite channel = this channel
 *  consent.* → STOP / START / unsubscribe / spam (engine/optouts.ts)
 *  replied   → repliedAt on the last live SMS; one "not monitored" notice per 30 days
 *  rating    → ≤ 2★ no more marketing at this venue; ≤ 3★ the owner is told
 */

import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactDoc, ContactPointDoc, JourneySendDoc } from '../store/engineTypes';
import { DAY_MS } from '../core/runtime/time';
import { contactPointId } from '../identity/key';
import { tsMs } from '../store/time';
import { normalizeEmail } from '../../services/phone';
import { eventDoc, loadEvent } from './events';
import { eventIdFor } from '../core/runtime/ids';
import { deliverEvent } from './advance';
import { mustDeliver, __clearLegacyCaches } from './route';
import { applyEmailRevoke, applyPhoneStart, applyPhoneStop } from './optouts';
import { chargeRepairTask, chargeSend } from '../send/dispatch';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { sendReplyNotice } from './replyNotice';
import { raiseAlert } from './alerts';
import { loadVenueContext } from './context';
import type { EngineSettings } from '../store/engineSettings';
import type { EngineEvent } from '../core/runtime/types';

export interface SignalEnv {
  now: number;
  settings: EngineSettings;
  workerId: string;
}

const REPLY_WINDOW_MS = 30 * DAY_MS;
const RANK: Record<string, number> = { dispatching: 0, unknown: 1, sent: 1, delivered: 3, read: 4 };

/** The send-status change for a message event, only ever forward (never touches dry runs). */
function nextStatus(current: JourneySendDoc['status'], type: string): JourneySendDoc['status'] | null {
  if (current === 'dry_run' || current === 'cancelled' || current === 'dispatching') return null;
  if (type === 'message.delivered') return (RANK[current] ?? 9) < RANK.delivered ? 'delivered' : null;
  if (type === 'message.failed') return current === 'sent' || current === 'unknown' ? 'failed' : null;
  if (type === 'message.bounced') return current === 'bounced' || current === 'failed' ? null : 'bounced';
  return null;
}

export async function handleSignal(payload: { eventId: string; guest?: Record<string, unknown> }, env: SignalEnv): Promise<void> {
  const event = await loadEvent(payload.eventId);
  if (!event) return;
  const guest = payload.guest ?? {};
  switch (event.type) {
    case 'message.delivered':
    case 'message.failed':
    case 'message.opened':
    case 'message.bounced':
    case 'message.clicked':
      await applySendSignal(event, env);
      if (event.instanceId) mustDeliver(await deliverEvent(event.instanceId, event, env));
      return;
    case 'consent.revoked':
    case 'consent.granted':
      await applyConsentSignal(event, guest, env);
      return;
    case 'message.replied':
      await applyReply(event, guest, env);
      return;
    case 'rating.submitted':
      await applyRating(event, guest, env);
      if (event.instanceId) mustDeliver(await deliverEvent(event.instanceId, event, env));
      return;
    default:
      return;
  }
}

async function applySendSignal(event: EngineEvent, env: SignalEnv): Promise<void> {
  if (!event.sendKey) return;
  const sendKey = event.sendKey;
  const sendRef = db.collection(COL.journeySends).doc(sendKey);
  const evRef = db.collection(COL.journeyEvents).doc(event.id);
  const send = await db.runTransaction(async (tx) => {
    const [evSnap, sSnap] = await Promise.all([tx.get(evRef), tx.get(sendRef)]);
    if (!sSnap.exists) return null;
    const s = sSnap.data() as JourneySendDoc;
    if (!evSnap.exists || evSnap.get('appliedAt')) return s;
    const contactRef = db.collection(COL.contacts).doc(s.contactId);
    const needsContact = event.type === 'message.opened' || event.type === 'message.clicked';
    const needsPoint = event.type === 'message.bounced' && s.toPointId;
    const repairs = event.type === 'message.delivered' && (s.status === 'unknown' || s.status === 'dispatching');
    const sentEventRef = db.collection(COL.journeyEvents).doc(eventIdFor('engine', `${sendKey}:message.sent`));
    const [cSnap, cpSnap, sentEventSnap] = await Promise.all([
      needsContact ? tx.get(contactRef) : Promise.resolve(null),
      needsPoint ? tx.get(db.collection(COL.contactPoints).doc(s.toPointId!)) : Promise.resolve(null),
      repairs ? tx.get(sentEventRef) : Promise.resolve(null),
    ]);
    const at = new Date(env.now);
    const upd: Record<string, unknown> = { updatedAt: new Date() };
    const status = nextStatus(s.status, event.type);
    if (status) upd.status = status;
    if (event.type === 'message.delivered') {
      if (!tsMs(s.engagement?.deliveredAt)) upd['engagement.deliveredAt'] = at;
      // The provider evidently took it — also when the worker died mid-send (still
      // `dispatching`, or already marked `unknown`): record that, and charge it once.
      if (s.status === 'unknown' || s.status === 'dispatching') {
        upd.status = 'delivered';
        upd.dispatchLease = null;
        if (!s.sentAt) upd.sentAt = at;
        const mid = event.data.messageId;
        if (!s.providerMessageId && typeof mid === 'string' && mid) upd.providerMessageId = mid;
        if (s.purpose === 'marketing' && !s.credits?.ledgerId) firestoreScheduler.scheduleInTx(tx, chargeRepairTask(s.tenantUserId, s.venueId, sendKey, env.now));
        // It went out after all: the daily numbers count it as sent (and its credits), once.
        if (sentEventSnap && !sentEventSnap.exists) {
          tx.set(
            sentEventRef,
            eventDoc({
              type: 'message.sent',
              occurredAt: env.now,
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
            }),
          );
        }
      }
    }
    if (event.type === 'message.failed') {
      const code = event.data.errorCode;
      if (typeof code === 'string' && code) upd.errorCode = code.slice(0, 60);
    }
    if (event.type === 'message.opened' && !tsMs(s.engagement?.openedAt)) {
      upd['engagement.openedAt'] = at;
      const c = cSnap?.data() as ContactDoc | undefined;
      if (c) {
        const hist = { ...(c.engagement?.slotHistogram ?? {}) } as Record<string, number>;
        hist[s.slot] = (hist[s.slot] ?? 0) + 1;
        tx.update(contactRef, { 'engagement.opens': (c.engagement?.opens ?? 0) + 1, 'engagement.slotHistogram': hist, updatedAt: new Date() });
      }
    }
    if (event.type === 'message.clicked') {
      if (!tsMs(s.engagement?.firstClickAt)) upd['engagement.firstClickAt'] = at;
      const c = cSnap?.data() as ContactDoc | undefined;
      if (c) {
        tx.update(contactRef, {
          'engagement.preferredChannel': s.channel,
          'engagement.preferredChannelSetAt': at,
          'engagement.consecutiveNoClickOnPreferred': 0,
          'engagement.clicks': (c.engagement?.clicks ?? 0) + 1,
          'engagement.lastClickAt': at,
          'engagement.lastClickChannel': s.channel,
          updatedAt: new Date(),
        });
      }
    }
    if (event.type === 'message.bounced' && s.status !== 'bounced' && s.toPointId && cpSnap?.exists) {
      const point = cpSnap.data() as ContactPointDoc;
      const count = (point?.hardBounceCount ?? 0) + 1;
      const cpUpd: Record<string, unknown> = { hardBounceCount: count, lastBounceAt: at, updatedAt: new Date() };
      const invalid = event.data.invalid === true;
      if ((invalid || count >= 2) && !point?.suppression?.email) {
        cpUpd['suppression.email'] = { reason: invalid ? 'invalid' : 'hard_bounce', source: 'brevo', at, sendKey: event.sendKey };
      }
      tx.update(db.collection(COL.contactPoints).doc(s.toPointId), cpUpd);
    }
    tx.update(sendRef, upd);
    tx.update(evRef, { appliedAt: new Date() });
    return { ...s, ...(upd.sentAt ? { sentAt: upd.sentAt } : {}) } as JourneySendDoc;
  });
  if (!send) return;
  // Follow-ups are idempotent and run on every attempt: a failure throws, the task is
  // retried, and they run again (the effects above are not applied twice).
  if (event.type === 'message.delivered' && send.sentAt) await chargeSend(sendKey);
  if (event.type === 'message.failed' && event.data.errorCode === '21610' && send.toPointId) {
    await applyPhoneStop(send.toPointId, 'provider_stop', event.occurredAt, { sendKey, errorCode: '21610' });
  }
}

async function applyConsentSignal(event: EngineEvent, guest: Record<string, unknown>, env: SignalEnv): Promise<void> {
  const source = String(event.data.source ?? '');
  const ref = { eventId: event.id, sendKey: event.sendKey ?? null };
  if (source === 'sms_keyword') {
    const phone = typeof guest.phone === 'string' ? guest.phone : null;
    if (!phone) return;
    const pointId = contactPointId('phone', phone);
    // Applied by when the text arrived, so a retried START can't undo a later STOP.
    if (event.type === 'consent.granted') {
      await applyPhoneStart(pointId, event.occurredAt, ref);
      __clearLegacyCaches(); // the old STOP flag was just cleared too: don't re-import it from the cache
    } else await applyPhoneStop(pointId, 'sms_keyword', event.occurredAt, ref);
    return;
  }
  if (event.type !== 'consent.revoked') return;
  const emailSource = source === 'brevo_spam' ? 'brevo_spam' : source === 'brevo_unsubscribed' ? 'brevo_unsubscribed' : 'unsubscribe_page';
  if (event.contactId && event.venueId) {
    await applyEmailRevoke({ contactId: event.contactId, venueId: event.venueId, source: emailSource, at: env.now, ref });
    return;
  }
  // An unsubscribe from a legacy email: guest doc → address → this owner's contact.
  const guestId = typeof guest.guestId === 'string' ? guest.guestId : null;
  if (!guestId || !event.venueId) return;
  const [guestSnap, ctx] = await Promise.all([db.collection(COL.guests).doc(guestId).get(), loadVenueContext(event.venueId)]);
  const email = normalizeEmail(String(guestSnap.get('email') ?? ''));
  if (!email || !ctx) return;
  const cp = await db.collection(COL.contactPoints).doc(contactPointId('email', email)).get();
  const contactId = (cp.get('tenantContacts') ?? {})[ctx.tenantUserId];
  if (typeof contactId !== 'string') return;
  await applyEmailRevoke({ contactId, venueId: event.venueId, source: 'unsubscribe_page', at: env.now, ref: { ...ref, guestId } });
}

async function applyReply(event: EngineEvent, guest: Record<string, unknown>, env: SignalEnv): Promise<void> {
  const phone = typeof guest.phone === 'string' ? guest.phone : null;
  if (!phone) return;
  const pointId = contactPointId('phone', phone);
  const cp = await db.collection(COL.contactPoints).doc(pointId).get();
  const last = cp.get('lastLiveSms') as { sendKey?: string; at?: unknown } | undefined;
  const lastAt = tsMs(last?.at);
  // Only a reply to one of our live SMS (a reply to a Marketing-tab SMS is not ours).
  if (!last?.sendKey || lastAt === null || env.now - lastAt > REPLY_WINDOW_MS) return;
  const sendRef = db.collection(COL.journeySends).doc(last.sendKey);
  const sSnap = await sendRef.get();
  const s = sSnap.data() as JourneySendDoc | undefined;
  if (!s) return;
  if (!tsMs(s.engagement?.repliedAt)) await sendRef.update({ 'engagement.repliedAt': new Date(env.now), updatedAt: new Date() });
  if (s.instanceId) {
    const replied: EngineEvent = { ...event, instanceId: s.instanceId, sendKey: last.sendKey, venueId: s.venueId, contactId: s.contactId };
    mustDeliver(await deliverEvent(s.instanceId, replied, env));
  }
  const ctx = await loadVenueContext(s.venueId);
  await sendReplyNotice({
    inboundId: event.id,
    contactId: s.contactId,
    pointId,
    tenantUserId: s.tenantUserId,
    venueId: s.venueId,
    venueName: ctx?.venueName ?? '',
    now: env.now,
    settings: env.settings,
    workerId: env.workerId,
  });
}

async function applyRating(event: EngineEvent, guest: Record<string, unknown>, env: SignalEnv): Promise<void> {
  const stars = Number(event.data.stars);
  if (!event.contactId || !event.venueId || !Number.isFinite(stars)) return;
  const evRef = db.collection(COL.journeyEvents).doc(event.id);
  const cvRef = db.collection(COL.contactVenues).doc(contactVenueId(event.contactId, event.venueId));
  const first = await db.runTransaction(async (tx) => {
    const [evSnap, cvSnap] = await Promise.all([tx.get(evRef), tx.get(cvRef)]);
    if (!evSnap.exists || evSnap.get('appliedAt')) return false;
    // ≤ 2★: no more marketing to this guest at this venue (gate rule 2).
    if (stars <= 2 && cvSnap.exists && !cvSnap.get('lowRatingAt')) tx.update(cvRef, { lowRatingAt: new Date(env.now), updatedAt: new Date() });
    tx.update(evRef, { appliedAt: new Date() });
    return true;
  });
  if (!first || stars > 3) return;
  const ctx = await loadVenueContext(event.venueId);
  const feedback = typeof guest.feedback === 'string' ? guest.feedback : '';
  await raiseAlert({
    kind: 'low_rating',
    dedupeKey: `rating:${event.id}`,
    audience: 'owner',
    tenantUserId: ctx?.tenantUserId ?? null,
    venueId: event.venueId,
    subject: `A guest rated ${ctx?.venueName || 'your venue'} ${stars} of 5`,
    text:
      `A guest who received one of your Adaptive messages rated ${ctx?.venueName || 'your venue'} ${stars} of 5 stars.` +
      (feedback ? `\n\nTheir feedback:\n${feedback}` : '') +
      (stars <= 2 ? `\n\nThey won't receive marketing messages from this venue any more.` : ''),
  });
}
