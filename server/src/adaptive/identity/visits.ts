/**
 * Visits (PRD VI-1): connects at one venue belong to the same visit until there
 * is a gap longer than `CaptivePortal_Settings/global.revisitGapHours` (today
 * 8 h) — the same number today's analytics use, so both agree on what a visit is.
 *
 * One transaction on `ContactVenues/{contactId}_{venueId}`, which also makes each
 * person's connects at a venue go one at a time. Safe to re-run: the connect
 * event id is remembered, and a replay returns the same answer.
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

    // Replay of a connect we already handled: answer the same way.
    if (cv?.lastConnectEventId === input.connectEventId && cv.currentVisitId) {
      const v = await tx.get(visits.doc(cv.currentVisitId));
      const visit = v.data() as VisitDoc | undefined;
      return {
        visitId: cv.currentVisitId,
        isNew: visit?.startEventId === input.connectEventId,
        visitNumber: visit?.visitNumber ?? cv.visitCount,
        isFirstVisit: Boolean(visit?.isFirstVisit),
        isRevisit: Boolean(visit?.isRevisit),
        lastSeenAt: tsMs(cv.lastSeenAt) ?? input.occurredAt,
      };
    }

    const lastSeen = tsMs(cv?.lastSeenAt);
    const sameVisit =
      cv?.currentVisitId && lastSeen !== null && input.occurredAt - lastSeen <= input.gapHours * HOUR_MS && input.occurredAt >= lastSeen - HOUR_MS;

    if (sameVisit) {
      const visitId = cv!.currentVisitId!;
      const v = await tx.get(visits.doc(visitId));
      const visit = v.data() as VisitDoc | undefined;
      const seen = Math.max(lastSeen!, input.occurredAt);
      tx.update(visits.doc(visitId), {
        lastSeenAt: new Date(seen),
        ...(input.apId ? { apIds: FieldValue.arrayUnion(input.apId) } : {}),
      });
      tx.update(cvRef, { lastSeenAt: new Date(seen), lastConnectEventId: input.connectEventId, updatedAt: new Date() });
      return {
        visitId,
        isNew: false,
        visitNumber: visit?.visitNumber ?? cv!.visitCount,
        isFirstVisit: Boolean(visit?.isFirstVisit),
        isRevisit: Boolean(visit?.isRevisit),
        lastSeenAt: seen,
      };
    }

    // A new visit: close the previous one at its last sign of life.
    const visitCount = (cv?.visitCount ?? 0) + 1;
    const visitId = visitIdFor(input.connectEventId);
    if (cv?.currentVisitId) {
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
