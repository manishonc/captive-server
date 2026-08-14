/**
 * Pause-duration arithmetic for the /adoption rate limits.
 *
 * Split out of adoptionSettings.ts — which imports ../firebase and so cannot be loaded
 * without credentials — purely so this can be unit-tested. The same split as
 * subscriptionState.ts and accountCode.ts, and for the same reason.
 *
 * The clamp is the only thing standing between a fat-fingered value and a public,
 * unauthenticated endpoint running without brute-force protection for a week.
 */

/** Longest pause we will honour, however far ahead the caller asks for. */
export const MAX_PAUSE_MINUTES = 120;
/** Used when the caller does not say. Long enough for an onboarding call. */
export const DEFAULT_PAUSE_MINUTES = 30;

/**
 * Clamp a requested pause to something sane.
 *
 * Anything non-finite — undefined, NaN, Infinity — falls back to the default rather than
 * propagating: `Infinity` minutes would otherwise become an expiry that never arrives, which
 * is precisely the "off state you forget about" this design exists to prevent.
 */
export function clampPauseMinutes(minutes?: number): number {
  const requested = Number.isFinite(minutes) ? Number(minutes) : DEFAULT_PAUSE_MINUTES;
  return Math.min(Math.max(1, Math.round(requested)), MAX_PAUSE_MINUTES);
}
