/**
 * Start sending (plan §2.4 stage 4, PR D decision D-D1). Owners who turned a venue on
 * before HeidiFi launched sending for their account saw "nothing is sent until HeidiFi
 * launches sending". When their account goes live, such a venue waits for ONE click on
 * Start sending before anything starts there — and then only guests after the click start
 * (nobody is backfilled).
 *
 * While it waits, the venue acts like launch `off` for new guests: no contact, no visit, no
 * journey, no stay link, and the login hook writes nothing. Running journeys (there are
 * none in a live mode before the click) and calendar syncing are unaffected.
 *
 * Pure: the same rule runs in the login hook, the worker, the API and the tests.
 *
 *  - "Turned on" = the venue's never-moving first turn-on (`AdaptiveVenues.firstOnAt`,
 *    real time); older docs fall back to their earliest turn-on stamp. `activatedAt` and
 *    Guest info's `enabledAt` move on routine saves, so they can't be the basis.
 *  - "Went live" = the account's `launch.liveSince` (real time), stamped by the admin launch
 *    card each time the account moves into live.
 *  - Unknown on either side → held (fail closed).
 *  - The click (`sendingConfirmedAt`, engine clock) lifts it for events at or after it.
 *
 * Never model "held" as a null install `liveSince`: enrolment reads null as "no filter".
 */

export type LaunchModeValue = 'off' | 'test' | 'live';

export interface HoldVenue {
  status?: string | null;
  utility?: { enabled?: boolean | null; enabledAt?: number | null } | null;
  firstOnAt?: number | null;
  activatedAt?: number | null;
  sendingConfirmedAt?: number | null;
}

/** Something is switched on at the venue (a marketing playbook running or paused, or Guest info). */
export function venueHasSomethingOn(v: HoldVenue): boolean {
  return v.status === 'on' || v.status === 'paused' || v.utility?.enabled === true;
}

/** When the venue was first turned on: `firstOnAt`, else the earliest turn-on stamp an older doc has. */
export function firstOnMs(v: HoldVenue): number | null {
  if (typeof v.firstOnAt === 'number') return v.firstOnAt;
  const stamps = [v.activatedAt, v.utility?.enabledAt].filter((t): t is number => typeof t === 'number');
  return stamps.length ? Math.min(...stamps) : null;
}

/**
 * Does the venue need the owner's Start sending at all? (Its account is live, something is on,
 * and it was turned on before the account went live — or either time is unknown.)
 */
export function needsStartSending(mode: LaunchModeValue, accountLiveSince: number | null, v: HoldVenue): boolean {
  if (mode !== 'live') return false;
  if (!venueHasSomethingOn(v)) return false;
  const firstOn = firstOnMs(v);
  return firstOn === null || accountLiveSince === null || firstOn < accountLiveSince;
}

/** Is an event at `atMs` (engine clock) held at this venue? */
export function sendingHeld(mode: LaunchModeValue, accountLiveSince: number | null, v: HoldVenue, atMs: number): boolean {
  if (!needsStartSending(mode, accountLiveSince, v)) return false;
  const confirmed = typeof v.sendingConfirmedAt === 'number' ? v.sendingConfirmedAt : null;
  return confirmed === null || atMs < confirmed;
}

/** The mode new guests at this venue get: the account's, or `off` while the venue waits for Start sending. */
export function venueMode(mode: LaunchModeValue, accountLiveSince: number | null, v: HoldVenue, atMs: number): LaunchModeValue {
  return sendingHeld(mode, accountLiveSince, v, atMs) ? 'off' : mode;
}
