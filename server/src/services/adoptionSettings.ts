/**
 * Runtime switch for the /adoption rate limits.
 *
 * The limits exist because /adoption is public and unauthenticated. Turning them off is
 * therefore a real reduction in protection, and the whole design here is about making that
 * reduction impossible to leave in place by accident:
 *
 *   - It is a DEADLINE, not a boolean. There is no "off" state to forget about — the pause
 *     carries an expiry and lapses on its own. A flag someone flips during an onboarding call
 *     and never flips back is the failure mode this exists to prevent.
 *   - The deadline is capped server-side (`MAX_PAUSE_MINUTES`), whatever the caller asks for.
 *   - It is reported by GET /adoption/health, so "are the limits on right now" is answerable
 *     without database access.
 *   - Every bypass is logged, throttled to once a minute so it is visible in the log without
 *     drowning it.
 *
 * The daily per-tenant claim cap is deliberately NOT pausable — see the router. That one is
 * the durable bound on what a compromised code can actually do, and no amount of testing
 * convenience justifies switching it off.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { clampPauseMinutes, DEFAULT_PAUSE_MINUTES, MAX_PAUSE_MINUTES } from './adoptionPause';

export { DEFAULT_PAUSE_MINUTES, MAX_PAUSE_MINUTES };

const SETTINGS_COLLECTION = 'CaptivePortal_Settings';
const SETTINGS_DOC = 'global';
const FIELD = 'adoptionRateLimitPausedUntil';

/**
 * Short TTL rather than the 5 minutes entitlements uses: an admin pausing limits mid-call
 * expects it to take effect now, and resuming to take effect now too.
 */
const CACHE_TTL_MS = 15_000;
let cached: { until: number | null; readAt: number } | null = null;

let lastBypassLog = 0;
const BYPASS_LOG_INTERVAL_MS = 60_000;

export interface PauseState {
  paused: boolean;
  /** ISO timestamp, or null when not paused. */
  pausedUntil: string | null;
  secondsRemaining: number;
  /** True when paused by env rather than by an admin — local dev, not the CMS switch. */
  viaEnv: boolean;
}

function envDisabled(): boolean {
  return process.env.ADOPTION_RATE_LIMIT_DISABLED === 'true';
}

async function readPausedUntil(): Promise<number | null> {
  const now = Date.now();
  if (cached && now - cached.readAt < CACHE_TTL_MS) return cached.until;

  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    const value = snap.data()?.[FIELD] as Timestamp | undefined;
    const until = value?.toMillis?.() ?? null;
    cached = { until, readAt: now };
    return until;
  } catch (error) {
    // Fail CLOSED, unlike most things here: an unreadable settings document must leave the
    // limits ON. The cost of being wrong in this direction is an installer waiting; the cost
    // of the other direction is an unauthenticated endpoint with no brute-force protection.
    console.error('[ADOPTION LIMIT] Could not read pause state; limits stay enforced:', error);
    return null;
  }
}

/** Current state, for the health endpoint and the CMS panel. */
export async function getPauseState(): Promise<PauseState> {
  if (envDisabled()) {
    return { paused: true, pausedUntil: null, secondsRemaining: 0, viaEnv: true };
  }
  const until = await readPausedUntil();
  const now = Date.now();
  if (!until || until <= now) {
    return { paused: false, pausedUntil: null, secondsRemaining: 0, viaEnv: false };
  }
  return {
    paused: true,
    pausedUntil: new Date(until).toISOString(),
    secondsRemaining: Math.ceil((until - now) / 1000),
    viaEnv: false,
  };
}

/**
 * Whether limits should be skipped for this request. Logs at most once a minute while
 * active, so a pause left running is obvious in the logs without flooding them.
 */
export async function rateLimitsPaused(): Promise<boolean> {
  const state = await getPauseState();
  if (!state.paused) return false;

  const now = Date.now();
  if (now - lastBypassLog > BYPASS_LOG_INTERVAL_MS) {
    lastBypassLog = now;
    console.warn(
      '[ADOPTION LIMIT] Rate limits are PAUSED —',
      state.viaEnv
        ? 'ADOPTION_RATE_LIMIT_DISABLED=true is set in the environment'
        : `expires ${state.pausedUntil} (${state.secondsRemaining}s)`,
    );
  }
  return true;
}

/** Pause for `minutes`, clamped to MAX_PAUSE_MINUTES. Returns the resulting state. */
export async function pauseRateLimits(minutes?: number): Promise<PauseState> {
  const clamped = clampPauseMinutes(minutes);
  const until = Timestamp.fromMillis(Date.now() + clamped * 60_000);

  await db
    .collection(SETTINGS_COLLECTION)
    .doc(SETTINGS_DOC)
    .set({ [FIELD]: until, adoptionRateLimitPausedAt: FieldValue.serverTimestamp() }, { merge: true });

  cached = null;
  console.warn(`[ADOPTION LIMIT] Rate limits PAUSED for ${clamped} minutes, until ${until.toDate().toISOString()}`);
  return getPauseState();
}

/** Re-enable immediately, without waiting for the deadline. */
export async function resumeRateLimits(): Promise<PauseState> {
  await db
    .collection(SETTINGS_COLLECTION)
    .doc(SETTINGS_DOC)
    .set({ [FIELD]: null }, { merge: true });

  cached = null;
  console.warn('[ADOPTION LIMIT] Rate limits RESUMED by an admin');
  return getPauseState();
}

/** Test seam. */
export function __resetPauseCache(): void {
  cached = null;
  lastBypassLog = 0;
}
