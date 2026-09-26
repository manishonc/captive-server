/**
 * `AdaptiveVenues.firstOnAt` (PR D, Start sending): when anything was first switched on at
 * the venue — set once and never moved, unlike `activatedAt` (every activation) and Guest
 * info's `enabledAt` (every wizard save). Written inside `applyVenueChanges`' transaction.
 */

import type { AdaptiveVenueDoc } from './types';
import { tsMs } from './time';
import { firstOnMs, venueHasSomethingOn } from '../core/runtime/hold';

/** A doc written before PR D: take its earliest turn-on stamp, so the first save after PR D doesn't move it. */
export function backfillFirstOnAt(av: AdaptiveVenueDoc): void {
  if (av.firstOnAt) return;
  const t = firstOnMs({ activatedAt: tsMs(av.activatedAt), utility: { enabledAt: tsMs(av.utility?.enabledAt) } });
  if (t !== null) av.firstOnAt = new Date(t);
}

/** After this change: the first time anything is on, stamp it. */
export function stampFirstOnAt(av: AdaptiveVenueDoc, now: Date): void {
  if (av.firstOnAt) return;
  if (venueHasSomethingOn({ status: av.status, utility: { enabled: av.utility?.enabled === true } })) av.firstOnAt = now;
}
