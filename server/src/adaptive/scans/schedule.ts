/**
 * The daily venue scan (PR S, 04-engine-runtime §3): one `scan_venue` task per venue and
 * venue-local day, due 03:00 venue time (engine clock). Each scan arms the next day's first,
 * so the chain survives a failed run; a watchdog (worker start + hourly, like the calendar
 * chains' watchdog) arms today's scan for every venue that is on, so a venue turned on, or a
 * chain that stopped while it was paused, starts again. Keys carry the local date and are
 * create-only: arming twice is a no-op.
 *
 * Weekly work (the slow times) runs in Monday's scan, so there is one chain per venue.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { AdaptiveVenueDoc } from '../store/types';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { atLocalTime, isValidTimeZone, localDateKey, zonedTime } from '../core/runtime/time';
import { addDays } from '../core/scans/holidays';
import { modeFor, type EngineSettings } from '../store/engineSettings';

export const SCAN_AT = '03:00';
const DEFAULT_TZ = 'Europe/Zurich';

export interface ScanVenuePayload {
  venueId: string;
  /** The venue-local day this scan is for (YYYY-MM-DD). */
  date: string;
}

export const scanKey = (venueId: string, date: string) => `scan:${venueId}:${date}`;

/** 03:00 venue time on a local date. */
export function scanDueAt(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = SCAN_AT.split(':').map(Number);
  return zonedTime(y, m, d, hh, mm, tz).getTime();
}

export async function armScan(venue: { venueId: string; tenantUserId: string }, date: string, tz: string): Promise<void> {
  await firestoreScheduler.schedule({
    dedupeKey: scanKey(venue.venueId, date),
    kind: 'scan_venue',
    dueAt: scanDueAt(date, tz),
    payload: { venueId: venue.venueId, date } satisfies ScanVenuePayload,
    tenantUserId: venue.tenantUserId,
    venueId: venue.venueId,
  });
}

/** The time zone the engine uses for a venue (the Adaptive setting, the venue's, else Zurich). */
export function venueTz(av: Partial<AdaptiveVenueDoc>, venueDocTz: unknown): string {
  return [av.timezone, venueDocTz].find((z) => isValidTimeZone(z)) as string | undefined ?? DEFAULT_TZ;
}

/**
 * Arms today's scan (due now if 03:00 has passed) and tomorrow's for every venue whose
 * marketing playbook is on and whose account isn't off. Cheap: one query plus one read per
 * such venue, then create-only writes.
 */
export async function scanWatchdog(env: { now: number; settings: EngineSettings }): Promise<{ armed: number }> {
  const snap = await db.collection(COL.adaptiveVenues).where('status', '==', 'on').get();
  const venues = snap.docs.map((d) => d.data() as AdaptiveVenueDoc).filter((av) => av.venueId && av.tenantUserId && modeFor(env.settings, av.tenantUserId) !== 'off');
  let armed = 0;
  // A few venues at a time: the worker claims no tasks while this runs.
  for (let i = 0; i < venues.length; i += 8) {
    await Promise.all(
      venues.slice(i, i + 8).map(async (av) => {
        const venueSnap = await db.collection(COL.venues).doc(av.venueId).get();
        const tz = venueTz(av, venueSnap.get('timezone'));
        const today = localDateKey(new Date(env.now), tz);
        await Promise.all([today, addDays(today, 1)].map((date) => armScan({ venueId: av.venueId, tenantUserId: av.tenantUserId }, date, tz)));
        armed += 2;
      }),
    );
  }
  return { armed };
}

/** For docs and tests: when today's scan is due in this zone. */
export function todaysScanAt(now: number, tz: string): number {
  return atLocalTime(new Date(now), tz, SCAN_AT, 0).getTime();
}
