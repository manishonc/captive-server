/**
 * Remove guest, erase step 2 (2026-10-28): when the owner removes a guest from the CMS guest list,
 * Adaptive forgets that person for this account, so their next Wi-Fi login is a new guest
 * (visit 1, Welcome and the Wi-Fi card again, consent asked again). Plan and gotchas:
 * research/…/adaptive-engine-task-guest-anonymisation.md (step 2).
 *
 * In this order — the engine's own writes would bring deleted docs back otherwise:
 *  1. Hold and cancel the running journeys (`cancelAllOf`, as Cancel journeys does).
 *  2. Cancel the person's logins still queued, dropping their details. A login being processed
 *     right now, or a message being sent, answers 409: the CMS doesn't remove the guest and the
 *     owner tries again (Manish: don't remove, retry).
 *  3. On each of their hashed email / phone points: this account's key and its "last live SMS"
 *     come off, and `forgottenAt[account]` is stamped — a login from before it is dropped
 *     (engine/route.ts), so a late retry can't bring them back. The global blocks (STOP, 21610,
 *     spam, bounces) stay: they are the number's, for every owner.
 *  4. Their entries in the cross-owner touch list are anonymised in place (time and channel stay,
 *     so other owners' weekly limit still counts them); their stays are unlinked; their
 *     bring-a-friend codes expire.
 *  5. Nothing running any more (checked again) → their per-venue rows and the contact are
 *     deleted, then the points are stripped once more (a send that finished meanwhile may have
 *     written to one).
 *
 * Kept until the full erase (step 3) or the 25-month TTL: journeys, messages, events, visits and
 * the consent ledger, by id (no name or address, apart from names inside old message previews).
 * Reports don't change. Another owner's contact for the same person is never touched.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ContactDoc, MarketingTouch } from '../store/engineTypes';
import type { Actor } from '../core/schemas';
import { conflict, notFound } from '../api/errors';
import { now, refreshClock } from '../engine/clock';
import { contactPointId } from '../identity/key';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { TASK_DONE_TTL_MS, cancelAllOf, contactIdOfGuest, guestIdSchema } from './guestJourneys';
import { unlinkContactStays } from './stays';

const BUSY = 'Adaptive is handling a login or a message for this guest right now. Try again in a minute.';

/** POST …/guests/by-guest/:guestId/forget — the CMS calls it before deleting the guest row. */
export async function forgetGuest(tenantUserId: string, guestIdRaw: string, actor: Actor) {
  const guestId = guestIdSchema.parse(guestIdRaw);
  const contactId = await contactIdOfGuest(tenantUserId, guestId);
  // Adaptive never saw them (or already forgot them): nothing to remove.
  if (!contactId) return { guestId, contactId: null, forgotten: false, cancelled: 0 };
  return { guestId, ...(await forgetContact(tenantUserId, contactId, actor)) };
}

async function forgetContact(tenantUserId: string, contactId: string, actor: Actor) {
  const contactRef = db.collection(COL.contacts).doc(contactId);
  const snap = await contactRef.get();
  if (!snap.exists || snap.get('tenantUserId') !== tenantUserId) throw notFound('No such guest in this account');
  const contact = snap.data() as ContactDoc;

  const stopped = await cancelAllOf(tenantUserId, contactId, 'en', actor);
  if (stopped.running.length) throw conflict(BUSY);

  const pointIds = await pointsOf(contact);
  await dropQueuedLogins(tenantUserId, new Set(pointIds));
  if (await sendingNow(contactId)) throw conflict(BUSY);

  await refreshClock();
  const at = now();
  for (const pointId of pointIds) await stripPoint(pointId, tenantUserId, contactId, at);
  await anonymiseTouches(contact.networkId, contactId);
  await unlinkContactStays(tenantUserId, contactId, actor.uid);
  await expireReferralCodes(contactId, at);

  const running = await db.collection(COL.journeyInstances).where('contactId', '==', contactId).where('status', '==', 'active').limit(1).get();
  if (!running.empty) throw conflict(BUSY);
  const venues = await db.collection(COL.contactVenues).where('contactId', '==', contactId).get();
  const batch = db.batch();
  for (const doc of venues.docs) batch.delete(doc.ref);
  batch.delete(contactRef);
  await batch.commit();
  for (const pointId of pointIds) await stripPoint(pointId, tenantUserId, contactId, at);
  return { contactId, forgotten: true, cancelled: stopped.cancelled };
}

/** The contact's own two points plus every point their person lists (a second email or phone). */
async function pointsOf(contact: ContactDoc): Promise<string[]> {
  const ids = [contact.emailPointId, contact.phonePointId];
  if (contact.networkId) {
    const person = await db.collection(COL.networkPeople).doc(contact.networkId).get();
    const listed = person.get('pointIds');
    if (Array.isArray(listed)) ids.push(...listed.map(String));
  }
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * The person's logins still waiting in the queue (raw details in `payload.guest`): cancelled and
 * their details dropped, like a finished task. Matched on the hashed email / phone, so a login
 * from a guest row the contact doesn't list yet is caught too. One being processed → busy.
 */
async function dropQueuedLogins(tenantUserId: string, pointIds: Set<string>): Promise<void> {
  // Equality only (merged single-field indexes; `payload` is exempt but only read here).
  const waiting = (status: string) =>
    db.collection(COL.journeyTasks).where('tenantUserId', '==', tenantUserId).where('kind', '==', 'event_route').where('status', '==', status).get();
  const [queued, leased] = await Promise.all([waiting('queued'), waiting('leased')]);
  for (const task of [...queued.docs, ...leased.docs]) {
    const guest = task.get('payload.guest') as Record<string, unknown> | undefined;
    if (!guest || !loginPoints(guest).some((id) => pointIds.has(id))) continue;
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(task.ref);
      if (fresh.get('status') === 'leased') throw conflict(BUSY);
      if (fresh.get('status') !== 'queued') return;
      const t = Date.now();
      tx.update(task.ref, { status: 'cancelled', doneAt: new Date(t), expireAt: new Date(t + TASK_DONE_TTL_MS), 'payload.guest': FieldValue.delete() });
    });
  }
}

/** The points a queued login would resolve to (as engine/route.ts reads its details). */
function loginPoints(guest: Record<string, unknown>): string[] {
  const email = normalizeEmail(String(guest.email ?? ''));
  const phone = typeof guest.phoneE164 === 'string' && guest.phoneE164 ? guest.phoneE164 : normalizeE164(String(guest.phoneCountryCode ?? ''), String(guest.phone ?? ''));
  return [email ? contactPointId('email', email) : null, phone ? contactPointId('phone', phone) : null].filter((id): id is string => id !== null);
}

/** A message to them being handed to the provider right now (it rewrites the point when done). */
async function sendingNow(contactId: string): Promise<boolean> {
  const snap = await db.collection(COL.journeySends).where('contactId', '==', contactId).where('status', '==', 'dispatching').limit(1).get();
  return !snap.empty;
}

/**
 * Takes this account off one point and stamps when it forgot the person. In a transaction because
 * the engine rewrites `tenantContacts` and `lastLiveSms` in its own; `update` with a FieldPath
 * delete, never a merge (a merge can't remove a map key, and it would recreate a missing point).
 * A point this account maps to another of its contacts is left alone.
 */
async function stripPoint(pointId: string, tenantUserId: string, contactId: string, at: number): Promise<void> {
  const ref = db.collection(COL.contactPoints).doc(pointId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const mapped = (snap.get('tenantContacts') as Record<string, string> | undefined)?.[tenantUserId];
    if (mapped && mapped !== contactId) return;
    const more: unknown[] = [];
    if (mapped) more.push(new FieldPath('tenantContacts', tenantUserId), FieldValue.delete());
    if (snap.get('lastLiveSms.tenantUserId') === tenantUserId) more.push('lastLiveSms', null);
    tx.update(ref, new FieldPath('forgottenAt', tenantUserId), new Date(at), 'updatedAt', new Date(), ...more);
  });
}

/**
 * Their touches from this account's messages, anonymised in place: what's left is a time and a
 * channel, so the weekly limit across owners still counts them. Never the person's pointIds.
 */
async function anonymiseTouches(networkId: string | null | undefined, contactId: string): Promise<void> {
  if (!networkId) return;
  const sends = await db.collection(COL.journeySends).where('contactId', '==', contactId).select().get();
  const keys = new Set(sends.docs.map((d) => d.id));
  if (!keys.size) return;
  const ref = db.collection(COL.networkPeople).doc(networkId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const touches = snap.get('recentMarketingTouches') as MarketingTouch[] | undefined;
    if (!snap.exists || !Array.isArray(touches) || !touches.some((t) => keys.has(t?.sendKey))) return;
    tx.update(ref, {
      recentMarketingTouches: touches.map((t) =>
        keys.has(t?.sendKey) ? { at: t.at ?? null, channel: t.channel ?? null, tenantUserId: null, venueId: null, sendKey: null } : t,
      ),
      updatedAt: new Date(),
    });
  });
}

/** Their bring-a-friend codes stop working now (a friend typing one gets no offer). */
async function expireReferralCodes(contactId: string, at: number): Promise<void> {
  const codes = await db.collection(COL.referralCodes).where('contactId', '==', contactId).get();
  for (const code of codes.docs) {
    const expires = code.get('expiresAt')?.toMillis?.() ?? 0;
    if (expires > at) await code.ref.update({ expiresAt: new Date(at), updatedAt: new Date() });
  }
}
