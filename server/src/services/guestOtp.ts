/**
 * One-time codes for captive-portal guest verification.
 *
 * Modelled on the CMS's `lib/email-otp.js` (sha256 + pepper at rest, timing-safe
 * compare, TTL, attempt cap) with three deliberate differences, each driven by
 * this being a public unauthenticated endpoint on the path to internet access:
 *
 *  1. `issueOtp` runs in a transaction. A bare `.set()` cannot enforce a resend
 *     cooldown against two concurrent taps, and every tap costs real money on
 *     SMS/WhatsApp.
 *
 *  2. A resend mints a NEW code but keeps the PREVIOUS one valid until the doc
 *     expires. Codes are stored hashed, so literally re-sending the old digits
 *     is impossible — but the UX problem that would solve (two messages, two
 *     different numbers, guest types the first and is told it's wrong) is real,
 *     so both hashes are accepted instead.
 *
 *  3. A successful consume marks `consumed` with a short grace window instead of
 *     deleting. Captive-portal mini-browsers drop responses constantly; a hard
 *     delete turns one dropped response into a dead end for the guest.
 *
 * Scope: codes are keyed by channel + destination + venue, so the same phone
 * verifying at two venues holds two independent codes.
 */

import * as crypto from 'crypto';
import { db } from '../firebase';
import { Timestamp } from 'firebase-admin/firestore';

export type VerifyChannel = 'email' | 'sms' | 'whatsapp';

export interface OtpScope {
  venueId: string | null;
  accessPointId: string | null;
}

const COLLECTION = 'CaptivePortal_GuestVerifications';

/**
 * Must equal the `code_expiration_minutes` baked into the WhatsApp
 * authentication template, which renders "This code expires in 10 minutes" as
 * a footer. If they diverge, the message lies to the guest.
 */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** Sends per live code doc. Caps spend on one destination inside one TTL. */
export const MAX_SENDS_PER_DOC = 3;
/** How long a correct code keeps working after it is first accepted. */
export const CONSUME_GRACE_MS = 2 * 60 * 1000;
/** How long the doc lingers for the Firestore TTL sweeper to collect. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

function pepper(): string {
  return process.env.GUEST_OTP_PEPPER || '';
}

/**
 * Verification is scoped to a venue. APs are allowed to exist with a null
 * venueId (see the apmac lookup in routes/captive.ts), so fall back to the AP
 * itself — without this, every venue-less AP in the estate would share one
 * scope and a code issued at one would verify at another.
 */
export function scopeKeyFor(scope: OtpScope): string | null {
  if (scope.venueId) return `venue:${scope.venueId}`;
  if (scope.accessPointId) return `ap:${scope.accessPointId}`;
  return null;
}

export function otpDocId(channel: VerifyChannel, destination: string, scopeKey: string): string {
  return crypto.createHash('sha256').update(`${channel}:${destination}:${scopeKey}`).digest('hex');
}

/** 6 digits, zero-padded. Leading zeros are real — never render this as a number. */
export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(code: string, channel: VerifyChannel, destination: string, scopeKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`${code}:${channel}:${destination}:${scopeKey}:${pepper()}`)
    .digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  return bufA.length > 0 && bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export type IssueResult =
  | { ok: true; code: string; expiresAt: number; resendAvailableAt: number; resent: boolean }
  | { ok: false; reason: 'cooldown' | 'send_cap'; retryAfterSeconds: number };

/**
 * Reserves and returns a code to send. The caller MUST send it and, on provider
 * failure, call `revokeOtp` — persisting before sending means a crash between
 * the two leaves an unusable code rather than a sent-but-unverifiable one.
 */
export async function issueOtp(args: {
  channel: VerifyChannel;
  destination: string;
  scope: OtpScope;
  scopeKey: string;
  ip?: string | null;
  mac?: string | null;
}): Promise<IssueResult> {
  const { channel, destination, scopeKey } = args;
  const ref = db.collection(COLLECTION).doc(otpDocId(channel, destination, scopeKey));
  const code = generateOtp();
  const codeHash = hashOtp(code, channel, destination, scopeKey);

  return db.runTransaction<IssueResult>(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const expiresAt = now + OTP_TTL_MS;
    const existing = snap.exists ? (snap.data() as Record<string, any>) : null;
    const live = !!existing && typeof existing.expiresAt === 'number' && existing.expiresAt > now;

    if (live) {
      const sinceLastSend = now - (existing!.lastSentAt || 0);
      if (sinceLastSend < RESEND_COOLDOWN_MS) {
        return {
          ok: false,
          reason: 'cooldown',
          retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceLastSend) / 1000),
        };
      }
      if ((existing!.sendCount || 0) >= MAX_SENDS_PER_DOC) {
        return {
          ok: false,
          reason: 'send_cap',
          retryAfterSeconds: Math.max(1, Math.ceil((existing!.expiresAt - now) / 1000)),
        };
      }

      tx.update(ref, {
        codeHash,
        // The code the guest may already be holding stays valid, so a resend
        // never invalidates a message that is still in flight.
        prevCodeHash: existing!.codeHash || null,
        expiresAt,
        ttlAt: Timestamp.fromMillis(expiresAt + RETENTION_MS),
        sendCount: (existing!.sendCount || 0) + 1,
        lastSentAt: now,
        consumed: false,
        consumedAt: null,
      });
      return { ok: true, code, expiresAt, resendAvailableAt: now + RESEND_COOLDOWN_MS, resent: true };
    }

    tx.set(ref, {
      channel,
      destination,
      scopeKey,
      venueId: args.scope.venueId ?? null,
      accessPointId: args.scope.accessPointId ?? null,
      codeHash,
      prevCodeHash: null,
      expiresAt,
      ttlAt: Timestamp.fromMillis(expiresAt + RETENTION_MS),
      attempts: 0,
      sendCount: 1,
      firstSentAt: now,
      lastSentAt: now,
      createdAt: now,
      consumed: false,
      consumedAt: null,
      ip: args.ip ?? null,
      mac: args.mac ?? null,
    });
    return { ok: true, code, expiresAt, resendAvailableAt: now + RESEND_COOLDOWN_MS, resent: false };
  });
}

/**
 * Drops a reserved code after the provider refused it. Without this a failed
 * send would burn the 60s cooldown, leaving the guest staring at a countdown
 * for a message that was never sent.
 */
export async function revokeOtp(
  channel: VerifyChannel,
  destination: string,
  scopeKey: string,
): Promise<void> {
  await db
    .collection(COLLECTION)
    .doc(otpDocId(channel, destination, scopeKey))
    .delete()
    .catch(() => {});
}

export type ConsumeFailure = 'invalid' | 'expired' | 'too_many';
export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: ConsumeFailure; attemptsLeft: number };

export async function consumeOtp(args: {
  channel: VerifyChannel;
  destination: string;
  scopeKey: string;
  code: string;
}): Promise<ConsumeResult> {
  const { channel, destination, scopeKey } = args;
  const code = String(args.code || '').trim();
  const ref = db.collection(COLLECTION).doc(otpDocId(channel, destination, scopeKey));
  const snap = await ref.get();

  // No doc and a wrong code are reported identically, so the endpoint is not an
  // oracle for which destinations currently have a code in flight.
  if (!snap.exists) return { ok: false, reason: 'invalid', attemptsLeft: 0 };

  const data = snap.data() as Record<string, any>;
  const now = Date.now();
  const candidate = hashOtp(code, channel, destination, scopeKey);

  // Checked before expiry: a guest who verified at 9:59 and whose response was
  // dropped must still succeed on retry at 10:01.
  if (data.consumed === true) {
    const withinGrace = now - (data.consumedAt || 0) <= CONSUME_GRACE_MS;
    if (withinGrace && hashesMatch(data.codeHash, candidate)) return { ok: true };
    return { ok: false, reason: 'invalid', attemptsLeft: 0 };
  }

  if (typeof data.expiresAt !== 'number' || now > data.expiresAt) {
    await ref.delete().catch(() => {});
    return { ok: false, reason: 'expired', attemptsLeft: 0 };
  }

  const attempts = data.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) {
    await ref.delete().catch(() => {});
    return { ok: false, reason: 'too_many', attemptsLeft: 0 };
  }

  const matched =
    hashesMatch(data.codeHash, candidate) ||
    (data.prevCodeHash ? hashesMatch(data.prevCodeHash, candidate) : false);

  if (!matched) {
    const next = attempts + 1;
    await ref.update({ attempts: next }).catch(() => {});
    if (next >= MAX_ATTEMPTS) {
      await ref.delete().catch(() => {});
      return { ok: false, reason: 'too_many', attemptsLeft: 0 };
    }
    return { ok: false, reason: 'invalid', attemptsLeft: MAX_ATTEMPTS - next };
  }

  await ref
    .update({ consumed: true, consumedAt: now, codeHash: candidate, prevCodeHash: null })
    .catch(() => {});
  return { ok: true };
}
