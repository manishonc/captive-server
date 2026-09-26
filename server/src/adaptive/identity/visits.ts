/**
 * Visits (PRD VI-1): connects at one venue belong to the same visit until there
 * is a gap longer than `CaptivePortal_Settings/global.revisitGapHours` (today
 * 8 h) — the same number today's analytics use, so both agree on what a visit is.
 *
 * One transaction on `ContactVenues/{contactId}_{venueId}`, which also makes each
 * person's connects at a venue go one at a time. Safe to re-run and to handle out
 * of order:
 *  - a connect that started a visit is recognised by that visit's id (derived from
 *    the connect), so a retry answers "new visit" again even after later connects;
 *  - a connect older than the latest one never opens a visit or moves `lastSeenAt`
 *    back — it joins the current visit, or is ignored if it belongs to an older one;
 *  - a visit doc already removed by the 25-month TTL is simply not closed.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactVenueDoc, VisitDoc } from '../store/engineTypes';
import { SCHEMA_VERSION } from '../core/constants';
import { visitIdFor } from '../core/runtime/ids';
import { HOUR_MS } from '../core/runtime/time';
import { retentionFrom, tsMs } from '../store/time';

const DEFAULT_GAP_HOURS = 8;
let gapCache: { hours: number; at: number } | null = null;

/** The platform's revisit window (1–72 h), cached for 5 minutes. */
export async function revisitGapHours(): Promise<number> {
  if (gapCache && Date.now() - gapCache.at < 5 * 60_000) return gapCache.hours;
  let hours = DEFAULT_GAP_HOURS;
  try {
    const snap = await db.collection(COL.settings).doc('global').get();
    const n = Number(snap.get('revisitGapHours'));
    if (Number.isInteger(n) && n >= 1 && n <= 72) hours = n;
  } catch {
    // default
  }
  gapCache = { hours, at: Date.now() };
  return hours;
}

export interface ConnectInput {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  guestId: string;
  apId: string | null;
  connectEventId: string;
  occurredAt: number;
  gapHours: number;
  /** The mode new guests get at this connect (PR D): stored on a new visit. */
  mode?: 'test' | 'live' | null;
}

export interface VisitOutcome {
  visitId: string;
  /** A new visit started with this connect (→ `visit.started`). */
  isNew: boolean;
  visitNumber: number;
  isFirstVisit: boolean;
  isRevisit: boolean;
  lastSeenAt: number;
}

export async function recordConnect(input: ConnectInput): Promise<VisitOutcome> {
  const cvRef = db.collection(COL.contactVenues).doc(contactVenueId(input.contactId, input.venueId));
  const visits = db.collection(COL.visits);
  const at = new Date(input.occurredAt);

  return db.runTransaction(async (tx) => {
    const cvSnap = await tx.get(cvRef);
    const cv = cvSnap.exists ? (cvSnap.data() as ContactVenueDoc) : null;
    const ownRef = visits.doc(visitIdFor(input.connectEventId));
    const [ownSnap, currentSnap] = await Promise.all([
      tx.get(ownRef),
      cv?.currentVisitId ? tx.get(visits.doc(cv.currentVisitId)) : Promise.resolve(null),
    ]);
    const lastSeen = tsMs(cv?.lastSeenAt);

    // This connect already started a visit (a retry, maybe after later connects).
    if (ownSnap.exists) {
      const own = ownSnap.data() as VisitDoc;
      return {
        visitId: ownRef.id,
        isNew: true,
        visitNumber: own.visitNumber,
        isFirstVisit: Boolean(own.isFirstVisit),
        isRevisit: Boolean(own.isRevisit),
        lastSeenAt: lastSeen ?? input.occurredAt,
      };
    }

    const current = currentSnap?.exists ? (currentSnap.data() as VisitDoc) : null;
    const gapMs = input.gapHours * HOUR_MS;
    const currentFacts = (seen: number): VisitOutcome => ({
      visitId: cv!.currentVisitId!,
      isNew: false,
      visitNumber: current?.visitNumber ?? cv!.visitCount,
      isFirstVisit: Boolean(current?.isFirstVisit),
      isRevisit: Boolean(current?.isRevisit),
      lastSeenAt: seen,
    });

    // Handled already (it joined the current visit), or older than the current visit's
    // window (it belonged to a visit that is over): change nothing.
    if (current && lastSeen !== null && (cv!.lastConnectEventId === input.connectEventId || input.occurredAt < lastSeen - gapMs)) {
      return currentFacts(lastSeen);
    }

    if (current && lastSeen !== null && input.occurredAt - lastSeen <= gapMs) {
      const visitId = cv!.currentVisitId!;
      const seen = Math.max(lastSeen, input.occurredAt);
      tx.update(visits.doc(visitId), {
        lastSeenAt: new Date(seen),
        ...(input.apId ? { apIds: FieldValue.arrayUnion(input.apId) } : {}),
      });
      tx.update(cvRef, { lastSeenAt: new Date(seen), lastConnectEventId: input.connectEventId, updatedAt: new Date() });
      return currentFacts(seen);
    }

    // A new visit: close the previous one at its last sign of life.
    const visitCount = (cv?.visitCount ?? 0) + 1;
    const visitId = visitIdFor(input.connectEventId);
    if (current && cv?.currentVisitId) {
      tx.update(visits.doc(cv.currentVisitId), { status: 'closed', endedAt: cv.lastSeenAt ?? at, endSource: 'next_visit' });
    }
    const visit: VisitDoc = {
      tenantUserId: input.tenantUserId,
      venueId: input.venueId,
      contactId: input.contactId,
      guestId: input.guestId,
      apIds: input.apId ? [input.apId] : [],
      status: 'open',
      startedAt: at,
      lastSeenAt: at,
      endedAt: null,
      endSource: null,
      startEventId: input.connectEventId,
      visitNumber: visitCount,
      isFirstVisit: visitCount === 1,
      isRevisit: visitCount > 1,
      ...(input.mode ? { startMode: input.mode } : {}),
      expireAt: retentionFrom(input.occurredAt),
      schemaVersion: SCHEMA_VERSION,
    };
    tx.set(visits.doc(visitId), visit);
    if (cv) {
      tx.update(cvRef, {
        visitCount,
        currentVisitId: visitId,
        lastVisitAt: at,
        lastVisitEndedAt: cv.currentVisitId ? cv.lastSeenAt ?? null : cv.lastVisitEndedAt ?? null,
        lastSeenAt: at,
        lastConnectEventId: input.connectEventId,
        updatedAt: new Date(),
      });
    } else {
      const doc: ContactVenueDoc = {
        tenantUserId: input.tenantUserId,
        venueId: input.venueId,
        contactId: input.contactId,
        firstVisitAt: at,
        lastVisitAt: at,
        lastVisitEndedAt: null,
        lastSeenAt: at,
        visitCount,
        currentVisitId: visitId,
        lastConnectEventId: input.connectEventId,
        journeys: {},
        lowRatingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      };
      tx.set(cvRef, doc);
    }
    return { visitId, isNew: true, visitNumber: visitCount, isFirstVisit: visitCount === 1, isRevisit: visitCount > 1, lastSeenAt: input.occurredAt };
  });
}
