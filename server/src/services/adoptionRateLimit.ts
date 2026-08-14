/**
 * Abuse limits for the public /adoption endpoints.
 *
 * These are unauthenticated and internet-facing, and the only thing standing between a
 * caller and creating an access point inside someone's account is an 8-character code. So
 * the limits here are the brute-force control, not a politeness measure.
 *
 * NO PER-IP LIMITS, DELIBERATELY. The Adoption Helper is a desktop app that dials
 * captive-server directly, so it sends no `x-portal-secret` and `clientIpOf` falls through
 * to `req.ip` — which, because `app.set('trust proxy')` is never called, is the Coolify
 * proxy's address, identical for every installer on earth. A per-IP limiter here would be a
 * global limiter that one attacker could saturate to lock out every venue in the fleet.
 * (If `trust proxy` is ever configured correctly, revisit — a real per-IP tier belongs here.)
 *
 * FAILURES AND SUCCESSES ARE COUNTED SEPARATELY, and that is what stops the lockout being
 * weaponizable. Codes get shared in installer WhatsApp groups; if a wrong guess and a
 * correct use drew from the same budget, anyone could disable a tenant's setup by spamming
 * bad codes at it. Instead:
 *   - `code_fail` is charged only on a FAILED resolution, keyed by the hash of whatever was
 *     submitted. Someone without the code can only ever burn their own guesses' budget.
 *   - the success-path limits are generous, and someone who holds the code could already
 *     claim legitimately, so throttling them buys nothing beyond bounding controller load.
 *
 * `unknown_code_global` is the real enumeration control, since without a usable IP there is
 * nothing else to key on: it caps total failed resolutions fleet-wide. It CAN be saturated
 * by an attacker, which would block new failed guesses globally — that is the intended
 * trade, because it never blocks a caller holding a valid code.
 *
 * Two tiers, matching services/otpRateLimit.ts: in-memory sliding windows (correct while
 * this runs as a single container — docker-compose declares no replicas), plus a Firestore
 * per-tenant daily cap that survives restarts and stays correct under replication.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';

export type AdoptionLimitKind =
  /** Failed code resolutions, keyed by hash of the submitted code. */
  | 'code_fail'
  /** Failed code resolutions fleet-wide, single key. Enumeration control. */
  | 'unknown_code_global'
  /** Cheap reads on the success path. */
  | 'session'
  | 'precheck'
  /** Polled during provisioning — must allow ~1 poll per 5s for 10 minutes. */
  | 'status'
  /** Writes plus controller work. */
  | 'claim'
  | 'claim_mac';

interface Window {
  max: number;
  windowMs: number;
}

const LIMITS: Record<AdoptionLimitKind, Window> = {
  // 10 guesses per code per 10 min. Against 31^8 (~8.5e11) this is not the primary
  // defence — the primary defence is that claiming also requires physical possession of a
  // device already informing our controller — but it makes online search hopeless.
  code_fail: { max: 10, windowMs: 10 * 60_000 },
  unknown_code_global: { max: 60, windowMs: 5 * 60_000 },
  session: { max: 30, windowMs: 10 * 60_000 },
  precheck: { max: 60, windowMs: 10 * 60_000 },
  status: { max: 120, windowMs: 10 * 60_000 },
  // A big venue rollout is a handful of access points in an afternoon, not dozens.
  claim: { max: 10, windowMs: 60 * 60_000 },
  claim_mac: { max: 5, windowMs: 60 * 60_000 },
};

const hits = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 5000;

export interface LimitVerdict {
  limited: boolean;
  retryAfterSeconds: number;
}

export function adoptionRateLimited(kind: AdoptionLimitKind, key: string): LimitVerdict {
  const { max, windowMs } = LIMITS[kind];
  const mapKey = `${kind}:${key}`;
  const now = Date.now();
  const recent = (hits.get(mapKey) || []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    const oldest = recent[0];
    hits.set(mapKey, recent);
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  recent.push(now);
  hits.set(mapKey, recent);

  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [k, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length) hits.set(k, live);
      else hits.delete(k);
    }
  }

  return { limited: false, retryAfterSeconds: 0 };
}

// ── Firestore daily cap ───────────────────────────────────────────────────────

const CLAIM_COUNTER_COLLECTION = 'CaptivePortal_AdoptionCounters';
const DAILY_CLAIM_CAP = Number(process.env.ADOPTION_DAILY_CLAIM_CAP || 20);

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Per-tenant per-UTC-day claim cap, transactional so concurrent claims cannot both slip
 * past the limit. Fails OPEN: a Firestore blip must not strand an installer who is standing
 * in the venue, which is the same posture the CMS takes on its plan gates.
 */
export async function claimCapExceeded(tenantUserId: string): Promise<boolean> {
  const ref = db.collection(CLAIM_COUNTER_COLLECTION).doc(`${tenantUserId}_${utcDay()}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = Number(snap.data()?.claims || 0);
      if (used >= DAILY_CLAIM_CAP) return true;
      tx.set(
        ref,
        { tenantUserId, claims: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return false;
    });
  } catch (error) {
    console.error('[ADOPTION LIMIT] Daily cap check failed; allowing claim:', error);
    return false;
  }
}

/** Test seam — mirrors __resetOtpRateLimits(). */
export function __resetAdoptionRateLimits(): void {
  hits.clear();
}
