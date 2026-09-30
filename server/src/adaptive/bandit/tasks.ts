/**
 * The bandit learner's tasks (PR F1). Engine clock throughout (the sandbox's fake clock too):
 *
 *  - `learn_arms` per venue and hour (`learn:{venueId}:{hour}`, create semantics): armed with the
 *    venue's rollup while the bandit is on for its account, and 7 days + 12 hours (+ 10 minutes)
 *    after each bandit send, so a venue that goes quiet still closes its last sends.
 *  - `learn_pool` once a day (`learn_pool:{day}`), armed by the worker while the bandit is on
 *    anywhere (and by a learner run): rebuilds the pooled priors from every venue's arms.
 */

import type { TaskSpec } from '../queue/firestoreQueue';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../core/runtime/time';
import { CLOSE_MARGIN_MS, LEARN_WINDOW_MS } from '../core/runtime/banditLearn';

export function learnTask(venueId: string, tenantUserId: string | null, atMs: number): TaskSpec {
  const hour = Math.floor(atMs / HOUR_MS);
  return {
    dedupeKey: `learn:${venueId}:${hour}`,
    kind: 'learn_arms',
    dueAt: (hour + 1) * HOUR_MS + 5 * MINUTE_MS,
    payload: { venueId, hour },
    tenantUserId,
    venueId,
  };
}

/** The run that closes a bandit send: its 7 days + the close margin + 10 minutes, rounded to that hour's run. */
export function learnCloseTask(venueId: string, tenantUserId: string | null, sentAt: number): TaskSpec {
  return learnTask(venueId, tenantUserId, sentAt + LEARN_WINDOW_MS + CLOSE_MARGIN_MS + 10 * MINUTE_MS);
}

export function poolTask(engineNow: number): TaskSpec {
  const day = Math.floor(engineNow / DAY_MS);
  return { dedupeKey: `learn_pool:${day}`, kind: 'learn_pool', dueAt: (day + 1) * DAY_MS + 30 * MINUTE_MS, payload: { day }, tenantUserId: null, venueId: null };
}
