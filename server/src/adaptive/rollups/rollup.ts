/**
 * The JourneyStats rollup (plan §4.1): every 15 minutes, 2 minutes behind real time,
 * only for venues that had engine activity, the venue's new events are added into
 * its daily docs (journeyStats.ts says what counts where).
 *
 *  - The log is read in `(recordedAt, id)` order from the venue's watermark
 *    (`JourneyStats/{venueId}_rollup`) up to real "now − 2 min". `recordedAt` is the
 *    commit time, so nothing can land behind the watermark later. Each event counts on
 *    its `occurredAt` day: a connect the worker handles late still counts on the day of
 *    the visit; a webhook is dated when it reaches us, so it counts on the day it arrived.
 *  - One transaction per page (≤ 500 events): re-read the watermark, add the counts
 *    (`FieldValue.increment` into nested maps, `set(…, {merge: true})`), move the
 *    watermark. A page is counted exactly once, so re-running changes nothing and
 *    two workers on the same venue can't double count.
 *  - The worker arms a `rollup_venue` task (`rollup:{venueId}:{15-min bucket}`, create
 *    semantics) after each task it runs for a venue; it's due 2 min after the bucket.
 *
 * `recordedAt` is real time while `occurredAt` may be the sandbox's fake clock, so the
 * lag is always measured with `Date.now()`.
 */

import { FieldPath, FieldValue, Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import { MINUTE_MS } from '../core/runtime/time';
import { firestoreScheduler, type TaskSpec } from '../queue/firestoreQueue';
import { loadVenueContext } from '../engine/context';
import { aggregate, STATS_SCHEMA_VERSION, type Counts, type RollupEvent } from './journeyStats';

export const ROLLUP_LAG_MS = 2 * MINUTE_MS;
export const ROLLUP_BUCKET_MS = 15 * MINUTE_MS;
const PAGE = 500;
const MAX_PAGES = 20;

export const rollupStateId = (venueId: string) => `${venueId}_rollup`;
const statsCol = () => db.collection(COL.journeyStats);

interface Watermark {
  at: Timestamp;
  eventId: string;
}

/** The venue's log from a watermark, in commit order (index venueId↑ recordedAt↑). */
export function venueEventsQuery(venueId: string, cutoff: Date, after: Watermark | null, limit: number) {
  let q = db
    .collection(COL.journeyEvents)
    .where('venueId', '==', venueId)
    .where('recordedAt', '<=', cutoff)
    .orderBy('recordedAt')
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (after) q = q.startAfter(after.at, after.eventId);
  return q;
}

function readWatermark(snap: DocumentSnapshot): Watermark | null {
  const w = snap.get('watermark') as { at?: unknown; eventId?: unknown } | undefined;
  return w && w.at instanceof Timestamp && typeof w.eventId === 'string' ? { at: w.at, eventId: w.eventId } : null;
}

function sameWatermark(a: Watermark | null, b: Watermark | null): boolean {
  if (!a || !b) return a === b;
  return a.eventId === b.eventId && a.at.isEqual(b.at);
}

function increments(c: Counts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[k] = typeof v === 'number' ? FieldValue.increment(v) : increments(v);
  return out;
}

export interface RollupResult {
  events: number;
  pages: number;
  /** Stopped at the page limit: run again. */
  more: boolean;
}

/**
 * Rolls a venue's new events into its daily docs. `cutoffMs` defaults to real now − 2 min
 * (the local stack's /dev/rollup and the tests pass a later one).
 */
export async function rollupVenue(venueId: string, opts: { cutoffMs?: number; pageSize?: number; maxPages?: number } = {}): Promise<RollupResult> {
  const cutoff = new Date(opts.cutoffMs ?? Date.now() - ROLLUP_LAG_MS);
  const pageSize = opts.pageSize ?? PAGE;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const ctx = await loadVenueContext(venueId);
  const tz = ctx?.tz ?? 'Europe/Zurich';
  const stateRef = statsCol().doc(rollupStateId(venueId));
  const modes = new Map<string, 'test' | 'live' | null>();
  let events = 0;
  let pages = 0;

  for (let round = 0; round < maxPages * 3 && pages < maxPages; round += 1) {
    const from = readWatermark(await stateRef.get());
    const page = await venueEventsQuery(venueId, cutoff, from, pageSize).get();
    if (page.empty) return { events, pages, more: false };

    const list: RollupEvent[] = [];
    for (const d of page.docs) list.push(await toRollupEvent(d, modes));
    const deltas = aggregate(venueId, tz, list);
    const last = page.docs[page.docs.length - 1];
    const to: Watermark = { at: last.get('recordedAt') as Timestamp, eventId: last.id };
    const tenantUserId = ctx?.tenantUserId ?? (page.docs.map((d) => d.get('tenantUserId')).find((t) => typeof t === 'string') as string | undefined) ?? null;

    const counted = await db.runTransaction(async (tx) => {
      // Someone else counted this page meanwhile: start again from where they stopped.
      if (!sameWatermark(readWatermark(await tx.get(stateRef)), from)) return false;
      const at = new Date();
      for (const d of deltas) {
        tx.set(
          statsCol().doc(d.docId),
          { tenantUserId, venueId, journeyKey: d.journeyKey, date: d.date, ...increments(d.counts), rollupWatermark: to, updatedAt: at, schemaVersion: STATS_SCHEMA_VERSION },
          { merge: true },
        );
      }
      tx.set(
        stateRef,
        { tenantUserId, venueId, kind: 'rollup_state', watermark: to, eventsCounted: FieldValue.increment(page.size), updatedAt: at, schemaVersion: STATS_SCHEMA_VERSION },
        { merge: true },
      );
      return true;
    });
    if (!counted) continue;
    pages += 1;
    events += page.size;
    if (page.size < pageSize) return { events, pages, more: false };
  }
  return { events, pages, more: true };
}

async function toRollupEvent(d: DocumentSnapshot, modes: Map<string, 'test' | 'live' | null>): Promise<RollupEvent> {
  const data = (d.get('data') ?? {}) as Record<string, unknown>;
  const occurred = d.get('occurredAt');
  const instanceId = (d.get('instanceId') as string | null) ?? null;
  let mode = asMode(d.get('mode')) ?? asMode(data.mode);
  // Events written before they carried a mode: the guest's journey knows it.
  if (!mode && instanceId) {
    if (!modes.has(instanceId)) modes.set(instanceId, asMode((await db.collection(COL.journeyInstances).doc(instanceId).get()).get('mode')));
    mode = modes.get(instanceId) ?? null;
  }
  return {
    id: d.id,
    type: String(d.get('type') ?? ''),
    journeyKey: (d.get('journeyKey') as string | null) ?? null,
    instanceId,
    channel: (d.get('channel') as string | null) ?? null,
    slot: (d.get('slot') as string | null) ?? null,
    variantId: (d.get('variantId') as string | null) ?? null,
    occurredAt: occurred instanceof Timestamp ? occurred.toMillis() : occurred instanceof Date ? occurred.getTime() : Date.now(),
    mode,
    data,
  };
}

function asMode(v: unknown): 'test' | 'live' | null {
  return v === 'test' || v === 'live' ? v : null;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * The rollup for the 15-minute bucket `realNow` falls in, due 2 min (+5 s) after it ends.
 * Its due time is real time (the rollup's cutoff is real time too). Under the sandbox's
 * fake clock, which runs ahead, it runs at once and counts only events older than 2 real
 * minutes; the latest ones wait for the venue's next rollup (locally: POST /dev/rollup).
 */
export function rollupTask(venueId: string, tenantUserId: string | null, realNow: number): TaskSpec {
  const bucket = Math.floor(realNow / ROLLUP_BUCKET_MS);
  return {
    dedupeKey: `rollup:${venueId}:${bucket}`,
    kind: 'rollup_venue',
    dueAt: (bucket + 1) * ROLLUP_BUCKET_MS + ROLLUP_LAG_MS + 5_000,
    payload: { venueId, bucket },
    tenantUserId,
    venueId,
  };
}

const armed = new Set<string>();
let armedBucket = -1;

/**
 * Makes sure this venue's rollup for the current bucket exists (at most one write per
 * venue and bucket per process; the task id dedupes across workers).
 */
export async function ensureRollup(venueId: string | null | undefined, tenantUserId: string | null | undefined): Promise<void> {
  if (!venueId) return;
  const realNow = Date.now();
  const bucket = Math.floor(realNow / ROLLUP_BUCKET_MS);
  if (bucket !== armedBucket) {
    armed.clear();
    armedBucket = bucket;
  }
  if (armed.has(venueId)) return;
  await firestoreScheduler.schedule(rollupTask(venueId, tenantUserId ?? null, realNow));
  armed.add(venueId);
}

/** Tests: forget what was armed (the emulator is wiped between tests). */
export function __clearRollupArming(): void {
  armed.clear();
  armedBucket = -1;
}
