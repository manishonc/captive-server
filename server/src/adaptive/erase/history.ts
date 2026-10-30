/**
 * Erase step 3 (2026-10-30): when Remove guest has forgotten a person (service/guestForget.ts), their
 * Adaptive history goes too. Plan and Manish's decisions: research/…/erase-step3-plan.md.
 *
 * The forget queues one `erase_history` task per contact, in the batch that deletes the contact, due
 * 20 minutes later so late delivery reports land and are counted first. The task (the worker):
 *
 *  1. Never touches a contact that still exists — it wasn't removed — nor another account's docs.
 *     A journey still running or a message being handed to a provider (never expected after the
 *     forget) fails the task, so it shows as a dead task instead of erasing under a send.
 *  2. Rolls each of their venues up, and erases nothing until the venues' numbers have counted all
 *     their events (the rollup's watermark): until then it waits and tries again. Results, journey
 *     numbers and credits never change.
 *  3. Deletes the alert of each of their ratings (its id comes from the rating's event id), their
 *     bring-a-friend codes and their id on other guests' codes, and clears their ids and click
 *     details from their message links. The links keep redirecting; the offer, rating and info
 *     pages already answer "Not found" once the message is gone.
 *  4. Deletes their messages, journeys, visits and events, in pages. An event that came in while it
 *     ran waits for the next run.
 *
 * Kept: the consent ledger (proof of every yes and STOP: ids, channel, action, times — no name or
 * contact details), the numbers (JourneyStats, bandit arms), the credit ledger (one entry per send,
 * no guest data). Left to their TTL: done tasks (7 days, ids only) and the sign-up breaker's places
 * (2 days). A late report about a deleted message finds no message and is dropped.
 */

import { FieldValue, Timestamp, type Query, type QueryDocumentSnapshot, type WriteBatch } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import { MINUTE_MS } from '../core/runtime/time';
import { hashId } from '../core/checksum';
import { contactInstancesQuery, contactSendsQuery } from '../store/ownerQueries';
import { countedBy, rollupVenue, rollupWatermark, type Watermark } from '../rollups/rollup';
import type { TaskSpec } from '../queue/firestoreQueue';

/** After the forget: late delivery reports land (and are counted) first. */
export const ERASE_DELAY_MS = 20 * MINUTE_MS;
/** A run that found events the numbers haven't counted yet tries again this much later. */
export const ERASE_WAIT_MS = 3 * MINUTE_MS;
const PAGE = 300;
/** A message clears up to four links: its page stays under a batch's 500 writes. */
const SEND_PAGE = 80;
/** Batches per run: a bigger history continues in the next run. */
const MAX_BATCHES = 40;
const SHORT_LINKS = 'CaptivePortal_ShortLinks';

/** One contact's erase. `run` sets the sweep's own tasks apart from the forget's. */
export function eraseHistoryTask(tenantUserId: string, contactId: string, dueAt: number, run?: string): TaskSpec {
  return {
    dedupeKey: run ? `erase_history:${contactId}:${run}` : `erase_history:${contactId}`,
    kind: 'erase_history',
    dueAt,
    payload: { contactId },
    tenantUserId,
    venueId: null,
  };
}

// Equality-only lookups (merged single-field indexes; worker/indexCheck.ts probes them).
export const contactAllEventsQuery = (contactId: string) => db.collection(COL.journeyEvents).where('contactId', '==', contactId);
export const contactVisitsQuery = (contactId: string) => db.collection(COL.visits).where('contactId', '==', contactId);
export const contactReferralCodesQuery = (contactId: string) => db.collection(COL.referralCodes).where('contactId', '==', contactId);
export const friendOnCodesQuery = (contactId: string) => db.collection(COL.referralCodes).where('friendContactIds', 'array-contains', contactId);
export const contactSendsInStatusQuery = (contactId: string, status: string) => contactSendsQuery(contactId).where('status', '==', status);

export interface EraseCounts {
  events: number;
  sends: number;
  instances: number;
  visits: number;
  alerts: number;
  links: number;
  referralCodes: number;
  friendLists: number;
}

export interface EraseResult {
  /**
   * `done` nothing of theirs is left · `waiting` the numbers haven't counted all their events yet
   * (run again in ERASE_WAIT_MS) · `more` the run's batches are used up (run again shortly) ·
   * `kept` the contact still exists: nothing was erased.
   */
  outcome: 'done' | 'waiting' | 'more' | 'kept';
  counts: EraseCounts;
}

export interface EraseOptions {
  /** The rollup's cutoff (default real now − 2 min; the tests pass a later one). */
  cutoffMs?: number;
  pageSize?: number;
  maxBatches?: number;
  onProgress?: () => Promise<void> | void;
}

type Fill = (batch: WriteBatch) => number;

class OutOfBatches extends Error {}

export async function eraseHistory(tenantUserId: string, contactId: string, opts: EraseOptions = {}): Promise<EraseResult> {
  const counts: EraseCounts = { events: 0, sends: 0, instances: 0, visits: 0, alerts: 0, links: 0, referralCodes: 0, friendLists: 0 };
  if ((await db.collection(COL.contacts).doc(contactId).get()).exists) return { outcome: 'kept', counts };

  const [running, sending] = await Promise.all([
    contactInstancesQuery(contactId).where('status', '==', 'active').limit(1).get(),
    contactSendsInStatusQuery(contactId, 'dispatching').limit(1).get(),
  ]);
  if (!running.empty) throw new Error(`a journey of contact ${contactId} is still running — not erased`);
  if (!sending.empty) throw new Error(`a message to contact ${contactId} is being sent — not erased`);

  const pageSize = opts.pageSize ?? PAGE;
  const mine = (d: QueryDocumentSnapshot) => {
    const t = d.get('tenantUserId');
    return t === tenantUserId || t === null || t === undefined;
  };
  let batches = 0;
  /** Commits one batch; past the run's budget it stops the run (`more`). */
  const commit = async (fill: Fill): Promise<number> => {
    if (batches >= (opts.maxBatches ?? MAX_BATCHES)) throw new OutOfBatches();
    const batch = db.batch();
    const n = fill(batch);
    if (n > 0) {
      await batch.commit();
      batches += 1;
      await opts.onProgress?.();
    }
    return n;
  };
  const deleteEach = (docs: QueryDocumentSnapshot[]): Fill => (b) => (docs.forEach((d) => b.delete(d.ref)), docs.length);

  try {
    // Their events, read once: the venues to roll up, and the ratings that raised an alert.
    const events = (await contactAllEventsQuery(contactId).select('tenantUserId', 'venueId', 'type', 'recordedAt').get()).docs.filter(mine);
    const marks = new Map<string, Watermark | null>();
    for (const venueId of new Set(events.map((d) => d.get('venueId')).filter((v): v is string => typeof v === 'string' && v.length > 0))) {
      if ((await rollupVenue(venueId, { cutoffMs: opts.cutoffMs })).more) return { outcome: 'more', counts };
      marks.set(venueId, await rollupWatermark(venueId));
    }
    // Nothing goes before the numbers have it all. An event the rollup never reads (no venue, no
    // commit time) counts nowhere.
    const counted = (d: QueryDocumentSnapshot) => {
      const venueId = d.get('venueId');
      const at = d.get('recordedAt');
      if (typeof venueId !== 'string' || !venueId || !(at instanceof Timestamp)) return true;
      return countedBy(marks.get(venueId) ?? null, at, d.id);
    };
    if (!events.every(counted)) return { outcome: 'waiting', counts };

    // The alerts of their ratings (the owner's email copy of the feedback), before the events go.
    const alertRefs = events.filter((d) => d.get('type') === 'rating.submitted').map((d) => db.collection(COL.alerts).doc(hashId('al', `rating:${d.id}`)));
    for (let i = 0; i < alertRefs.length; i += pageSize) {
      const found = (await db.getAll(...alertRefs.slice(i, i + pageSize))).filter((s) => s.exists);
      counts.alerts += await commit((b) => (found.forEach((s) => b.delete(s.ref)), found.length));
    }

    // Their bring-a-friend codes (the forget expired them), and their id on other guests' codes.
    const codes = (await contactReferralCodesQuery(contactId).get()).docs.filter(mine);
    for (let i = 0; i < codes.length; i += pageSize) counts.referralCodes += await commit(deleteEach(codes.slice(i, i + pageSize)));
    const lists = (await friendOnCodesQuery(contactId).get()).docs;
    for (let i = 0; i < lists.length; i += pageSize) {
      const page = lists.slice(i, i + pageSize);
      counts.friendLists += await commit((b) => (page.forEach((d) => b.update(d.ref, { friendContactIds: FieldValue.arrayRemove(contactId) })), page.length));
    }

    // Their messages: their links lose the guest's ids first, then the messages go.
    const sendPage = Math.min(pageSize, SEND_PAGE);
    for (;;) {
      const snap = await contactSendsQuery(contactId).select('tenantUserId', 'shortCodes').limit(sendPage).get();
      const page = snap.docs.filter(mine);
      if (!page.length) break;
      const codesOf = page.flatMap((d) => (Array.isArray(d.get('shortCodes')) ? (d.get('shortCodes') as unknown[]) : [])).filter((c): c is string => typeof c === 'string' && c.length > 0);
      const links = codesOf.length
        ? (await db.getAll(...codesOf.map((c) => db.collection(SHORT_LINKS).doc(c)))).filter((s) => s.exists && s.get('sendKind') === 'journey' && s.get('contactId') === contactId)
        : [];
      await commit((b) => {
        for (const s of links) b.update(s.ref, { contactId: null, wifiGuestId: null, instanceId: null, lastClickIpHash: null, lastClickUserAgent: null, lastBotClickUserAgent: null });
        for (const d of page) b.delete(d.ref);
        return links.length + page.length;
      });
      counts.links += links.length;
      counts.sends += page.length;
      if (snap.size < sendPage) break;
    }

    // Their journeys (none running: checked above), visits and events.
    counts.instances += await deleteAll(contactInstancesQuery(contactId), pageSize, mine, commit);
    counts.visits += await deleteAll(contactVisitsQuery(contactId), pageSize, mine, commit);
    for (let i = 0; i < events.length; i += pageSize) counts.events += await commit(deleteEach(events.slice(i, i + pageSize)));

    // One that came in while this ran (a late report) waits for the next run and its rollup.
    const late = (await contactAllEventsQuery(contactId).select('tenantUserId').limit(pageSize).get()).docs.filter(mine);
    return { outcome: late.length ? 'waiting' : 'done', counts };
  } catch (err) {
    if (err instanceof OutOfBatches) return { outcome: 'more', counts };
    throw err;
  }
}

/** Deletes a query's docs of this account, page by page; how many went. */
async function deleteAll(query: Query, pageSize: number, mine: (d: QueryDocumentSnapshot) => boolean, commit: (fill: Fill) => Promise<number>): Promise<number> {
  let n = 0;
  for (;;) {
    const snap = await query.select('tenantUserId').limit(pageSize).get();
    const page = snap.docs.filter(mine);
    if (!page.length) return n;
    n += await commit((b) => (page.forEach((d) => b.delete(d.ref)), page.length));
    if (snap.size < pageSize) return n;
  }
}
