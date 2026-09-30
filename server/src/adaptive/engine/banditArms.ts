/**
 * The bandit's arms for one send step (PR F1): the venue's doc and the pooled doc, read by id
 * (no query, no index) through a 5-minute in-process cache with a short timeout. Any failure
 * reads as "unavailable" for 30 seconds: the send falls back to the rotation — it never waits
 * on or fails because of the bandit, and a slow Firestore doesn't hold every send for the
 * timeout. A pool not rebuilt for 48 hours is left out. Only the learner writes these docs
 * (bandit/learn.ts).
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { tsMs } from '../store/time';
import { banditArmsIdFor, banditPoolIdFor } from '../core/runtime/ids';
import type { BanditArmsDoc, BanditPoolDoc } from '../store/engineTypes';

export interface StepArms {
  venue: BanditArmsDoc | null;
  pool: BanditPoolDoc | null;
}

const TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;
const TIMEOUT_MS = 1_500;
/** A pool not rebuilt for this long is ignored (it could still hold a deleted account's share). */
export const POOL_MAX_AGE_MS = 48 * 60 * 60_000;

/** A pool doc's `rebuiltAt` is recent enough to use (the send path and the retire check). */
export function poolFresh(rebuiltAt: unknown): boolean {
  const at = tsMs(rebuiltAt);
  return at !== null && Date.now() - at < POOL_MAX_AGE_MS;
}
const cache = new Map<string, { value: StepArms | null; at: number; venueId: string }>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bandit arms read timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The arms of (venue, journey, step), or null when they can't be read in time (→ rotation). */
export async function loadStepArms(venueId: string, journeyKey: string, nodeId: string): Promise<StepArms | null> {
  const id = banditArmsIdFor(venueId, journeyKey, nodeId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : FAILED_TTL_MS)) return hit.value;
  try {
    const [v, p] = await withTimeout(
      Promise.all([db.collection(COL.banditArms).doc(id).get(), db.collection(COL.banditArms).doc(banditPoolIdFor(journeyKey, nodeId)).get()]),
      TIMEOUT_MS,
    );
    const venue = v.exists && v.get('scope') === 'venue' ? (v.data() as BanditArmsDoc) : null;
    const pool = p.exists && p.get('scope') === 'pool' && poolFresh(p.get('rebuiltAt')) ? (p.data() as BanditPoolDoc) : null;
    const value = { venue, pool };
    cache.set(id, { value, at: Date.now(), venueId });
    return value;
  } catch (err) {
    console.warn('[ADAPTIVE] bandit arms unavailable, using the rotation:', (err as Error)?.message ?? err);
    cache.set(id, { value: null, at: Date.now(), venueId });
    return null;
  }
}

/** Tests and the pool rebuild: forget every cached arm. */
export function __clearBanditArmsCache(): void {
  cache.clear();
}

/** The learner, after it wrote a venue's arms: forget that venue's cached arms only. */
export function clearBanditArmsFor(venueId: string): void {
  for (const [id, hit] of cache) if (hit.venueId === venueId) cache.delete(id);
}
