/**
 * Abuse limits for the public verification endpoints.
 *
 * `/verify/send` is unauthenticated and spends real money on every call
 * (Twilio SMS, Meta authentication-category conversations), so it is the single
 * most attractive endpoint in this codebase. SMS pumping — driving traffic to
 * premium-rate ranges the attacker collects revenue share on — is the specific
 * threat these limits exist to bound.
 *
 * Two tiers, on purpose:
 *
 *   in-memory  — per-destination / per-IP / per-AP sliding windows. Fast, and
 *                correct while captive-server runs as a single container (it
 *                does; docker-compose declares no replicas). The existing
 *                connectedFormRateLimited uses the same pattern.
 *   Firestore  — the per-venue daily cap. Authoritative, survives a restart,
 *                and stays correct if the server is ever replicated.
 *
 * IF THIS SERVER IS EVER HORIZONTALLY SCALED, the in-memory tier degrades to
 * per-replica and `dest_send` must move to Firestore. The daily cap does not.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';

export type LimitKind = 'dest_send' | 'ip_send' | 'ap_send' | 'dest_check' | 'ip_check';

interface Window {
  max: number;
  windowMs: number;
}

const LIMITS: Record<LimitKind, Window> = {
  // Tight: one person legitimately needs 1-3 codes, and this is the layer that
  // survives the OTP doc being deleted by a burnt attempt counter.
  dest_send: { max: 5, windowMs: 30 * 60_000 },
  // Loose: a whole venue can sit behind one NAT address.
  ip_send: { max: 15, windowMs: 10 * 60_000 },
  ap_send: { max: 60, windowMs: 10 * 60_000 },
  dest_check: { max: 20, windowMs: 10 * 60_000 },
  ip_check: { max: 60, windowMs: 10 * 60_000 },
};

const hits = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 5000;

export interface LimitVerdict {
  limited: boolean;
  retryAfterSeconds: number;
}

export function otpRateLimited(kind: LimitKind, key: string): LimitVerdict {
  const { max, windowMs } = LIMITS[kind];
  const mapKey = `${kind}:${key}`;
  const now = Date.now();
  const recent = (hits.get(mapKey) || []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    const oldest = recent[0];
    hits.set(mapKey, recent);
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
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

/** Test seam — the sliding windows are process-global otherwise. */
export function __resetOtpRateLimits(): void {
  hits.clear();
}

const QUOTA_COLLECTION = 'CaptivePortal_GuestVerificationQuota';

function dailyCap(): number {
  const raw = Number(process.env.GUEST_OTP_DAILY_CAP_PER_VENUE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Records one send against the venue's daily budget and reports whether the cap
 * is now spent. Called AFTER a successful send — counting attempts rather than
 * deliveries would let a provider outage exhaust a venue's budget.
 *
 * Fails open (returns false) on a Firestore error: losing count is strictly
 * better than blocking verification because the counter was unreachable.
 */
export async function recordVenueOtpSend(scopeKey: string): Promise<void> {
  const docId = `${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}_${todayKey()}`;
  await db
    .collection(QUOTA_COLLECTION)
    .doc(docId)
    .set(
      { scopeKey, day: todayKey(), count: FieldValue.increment(1), updatedAt: Date.now() },
      { merge: true },
    )
    .catch((err) => console.error('[OTP QUOTA WRITE ERROR]', err));
}

export async function venueOtpCapExceeded(scopeKey: string): Promise<boolean> {
  const docId = `${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}_${todayKey()}`;
  try {
    const snap = await db.collection(QUOTA_COLLECTION).doc(docId).get();
    if (!snap.exists) return false;
    return (snap.data()?.count || 0) >= dailyCap();
  } catch (err) {
    console.error('[OTP QUOTA READ ERROR]', err);
    return false;
  }
}
