/**
 * Stays and calendar feeds in Firestore: refs, loaders, and every query the stays code
 * runs — as exported builders, so worker/indexCheck.ts probes exactly these (the
 * emulator doesn't enforce indexes; the probe is the only guard in production).
 */

import type { Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, stayFeedId } from '../store/collections';
import type { StayDoc } from '../store/engineTypes';
import { tsMs } from '../store/time';
import { eventIdFor } from '../core/runtime/ids';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { eventDoc, eventRef } from '../engine/events';
import type { StaySnap } from './plan';

export const stayRef = (stayId: string) => db.collection(COL.stays).doc(stayId);
export const feedRef = (feedId: string) => db.collection(COL.stayFeeds).doc(feedId);
export const venueFeedRef = (venueId: string) => feedRef(stayFeedId(venueId));

/** A Stay with its owner fields, times in epoch ms. */
export interface LoadedStay extends StaySnap {
  tenantUserId: string;
  venueId: string;
  feedId: string;
  externalUid: string;
  linkedGuestId: string | null;
}

export function toStay(id: string, d: Partial<StayDoc>): LoadedStay {
  return {
    id,
    tenantUserId: String(d.tenantUserId ?? ''),
    venueId: String(d.venueId ?? ''),
    feedId: String(d.feedId ?? ''),
    externalUid: String(d.externalUid ?? ''),
    status: d.status === 'cancelled' || d.status === 'overlap_flagged' ? d.status : 'confirmed',
    checkIn: String(d.checkIn ?? ''),
    checkOut: String(d.checkOut ?? ''),
    checkInAt: tsMs(d.checkInAt) ?? 0,
    checkOutAt: tsMs(d.checkOutAt) ?? 0,
    nights: Number(d.nights) || 0,
    datesVersion: Number(d.datesVersion) || 1,
    missingCount: Number(d.missingCount) || 0,
    lastMissAt: tsMs(d.lastMissAt),
    contactId: typeof d.contactId === 'string' && d.contactId ? d.contactId : null,
    linkedAt: tsMs(d.linkedAt),
    linkMode: d.linkMode === 'live' || d.linkMode === 'test' ? d.linkMode : null,
    linkedGuestId: typeof d.linkedGuestId === 'string' ? d.linkedGuestId : null,
    overlapWith: Array.isArray(d.overlapWith) ? d.overlapWith.map(String) : [],
    lastSeenInFeedAt: tsMs(d.lastSeenInFeedAt),
  };
}

export async function loadStay(stayId: string, tx?: Transaction): Promise<LoadedStay | null> {
  const snap = tx ? await tx.get(stayRef(stayId)) : await stayRef(stayId).get();
  return snap.exists ? toStay(snap.id, snap.data() as StayDoc) : null;
}

// ── Queries (each probed in worker/indexCheck.ts) ────────────────────────────

/** Every stay of a feed — equality only (single-field index on `feedId`). */
export const staysOfFeedQuery = (feedId: string) => db.collection(COL.stays).where('feedId', '==', feedId);

/**
 * Stays a connecting guest could be linked to (index venueId↑ status↑ checkOutAt↑): the ones
 * checking out soonest — the stay in its window and, on a turnover day, the previous stays
 * come first — not every booking of the year on every connect.
 */
export const linkCandidatesQuery = (venueId: string, checkOutAfter: Date) =>
  db.collection(COL.stays).where('venueId', '==', venueId).where('status', 'in', ['confirmed', 'overlap_flagged']).where('checkOutAt', '>', checkOutAfter).orderBy('checkOutAt').limit(20);

/** A guest's stays at a venue — equality only (merged single-field indexes). */
export const contactStaysQuery = (venueId: string, contactId: string) =>
  db.collection(COL.stays).where('venueId', '==', venueId).where('contactId', '==', contactId);

/** The running journeys of one stay — equality only (merged single-field indexes; `context` isn't exempted). */
export const stayInstancesQuery = (stayId: string) =>
  db.collection(COL.journeyInstances).where('context.stayId', '==', stayId).where('status', '==', 'active');

/** Feeds the watchdog looks after — single field. */
export const watchedFeedsQuery = () => db.collection(COL.stayFeeds).where('status', 'in', ['active', 'failing']);

/** Failing feeds, for the admin status — single field. */
export const failingFeedsQuery = () => db.collection(COL.stayFeeds).where('status', '==', 'failing');

export async function loadFeedStays(feedId: string): Promise<LoadedStay[]> {
  const snap = await staysOfFeedQuery(feedId).get();
  return snap.docs.map((d) => toStay(d.id, d.data() as StayDoc));
}

// ── Stay events ──────────────────────────────────────────────────────────────

export interface StayEvent {
  type: 'stay.created' | 'stay.changed' | 'stay.cancelled' | 'stay.overlap_flagged';
  /** The external key after `stay:` (unique per change: it carries the dates version). */
  key: string;
  stay: Pick<LoadedStay, 'id' | 'tenantUserId' | 'venueId' | 'contactId'>;
  occurredAt: number;
  data: Record<string, unknown>;
}

export const stayEventId = (key: string) => eventIdFor('engine', `stay:${key}`);

/**
 * Reads the event's doc — call it among the transaction's reads. A change already
 * written (its event exists) is never written again.
 */
export async function stayEventExists(tx: Transaction, key: string): Promise<boolean> {
  return (await tx.get(eventRef(stayEventId(key)))).exists;
}

/**
 * Writes a stay event in the transaction that changes the Stay (brief §2 "Atomicity"),
 * plus — for `stay.changed` / `stay.cancelled`, linked or not — the `event_route` task
 * that carries it to the guest's journeys. The caller has checked the event is new, so
 * the task id is new too. Stay events carry no test/live mode: they count outside
 * `dryRun`.
 */
export function writeStayEventInTx(tx: Transaction, e: StayEvent): string {
  const id = stayEventId(e.key);
  tx.set(
    eventRef(id),
    eventDoc({
      type: e.type,
      occurredAt: e.occurredAt,
      tenantUserId: e.stay.tenantUserId,
      venueId: e.stay.venueId,
      contactId: e.stay.contactId,
      source: 'scanner',
      data: { stayId: e.stay.id, ...e.data },
    }),
  );
  if (e.type === 'stay.changed' || e.type === 'stay.cancelled') {
    firestoreScheduler.scheduleInTx(tx, {
      dedupeKey: `event:${id}`,
      kind: 'event_route',
      dueAt: e.occurredAt,
      payload: { eventId: id },
      tenantUserId: e.stay.tenantUserId,
      venueId: e.stay.venueId,
    });
  }
  return id;
}
