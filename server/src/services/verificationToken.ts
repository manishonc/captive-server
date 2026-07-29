/**
 * Proof-of-verification tokens.
 *
 * `/verify/check` mints one; every path that actually grants network access
 * refuses without it when the venue requires verification. Without this a guest
 * could simply POST /create-user (or /unifi/authorize) directly and skip the
 * verify step entirely — the portal UI is not a security boundary.
 *
 * Shape mirrors services/unsubscribe.ts, plus a version prefix that is INSIDE
 * the signed data so a downgrade to a future weaker format cannot be forged:
 *
 *     hv1.<base64url(JSON(payload))>.<base64url(hmacSha256)>
 *
 * Deliberately NOT single-use: one guest flow presents the same token to
 * /create-user and then to /unifi/authorize. Single-use would break UniFi
 * outright. It is bounded instead by a 15-minute expiry and by binding to the
 * scope, the channel, the exact destination and the client MAC.
 */

import * as crypto from 'crypto';
import type { VerifyChannel } from './guestOtp';

const VERSION = 'hv1';
const TOKEN_TTL_SECONDS = 15 * 60;
/** Tolerance for a token that looks minted slightly in the future. */
const IAT_SKEW_SECONDS = 60;

/**
 * Its own secret — deliberately NOT chaining a fallback to any other signing
 * secret. A fallback chain reaches an empty string when nothing in it is set,
 * and an empty-key HMAC is forgeable by anyone who can read this file. Failing
 * closed on a missing secret is the only safe behaviour, so the chain would buy
 * nothing and cost everything.
 */
function secret(): string {
  return process.env.GUEST_VERIFICATION_SIGNING_SECRET || '';
}

export function verificationSubsystemReady(): boolean {
  return !!secret() && !!process.env.GUEST_OTP_PEPPER;
}

export interface VerificationTokenPayload {
  /** channel */
  c: VerifyChannel;
  /** destination, normalized (E.164 or lowercased email) */
  d: string;
  /** scope key — `venue:<id>` or `ap:<id>` */
  s: string;
  /** client MAC, normalized; null when the vendor did not supply one */
  m: string | null;
  /** issued at (epoch seconds) */
  iat: number;
  /** expires at (epoch seconds) */
  exp: number;
  /** nonce, for log correlation */
  n: string;
  /**
   * Set when the server WAIVED verification rather than performing it (the
   * venue's daily OTP budget is spent). It still authorizes the connect — that
   * is the fail-open rule — but the guest doc must not be marked verified.
   */
  b?: 1;
}

function sign(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function normalizeMac(mac: unknown): string | null {
  const value = String(mac || '').trim().toLowerCase();
  return value || null;
}

/** Returns null when the signing secret is unset — never an unsigned token. */
export function mintVerificationToken(args: {
  channel: VerifyChannel;
  destination: string;
  scopeKey: string;
  mac: string | null;
  bypass?: boolean;
}): string | null {
  if (!secret()) return null;
  const iat = Math.floor(Date.now() / 1000);
  const payload: VerificationTokenPayload = {
    c: args.channel,
    d: args.destination,
    s: args.scopeKey,
    m: normalizeMac(args.mac),
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    n: crypto.randomBytes(8).toString('hex'),
    ...(args.bypass ? { b: 1 as const } : {}),
  };
  const data = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${data}.${sign(data)}`;
}

export type TokenRejection =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'scope_mismatch'
  | 'destination_mismatch'
  | 'mac_mismatch'
  | 'channel_disabled';

export type TokenVerdict =
  | { ok: true; payload: VerificationTokenPayload }
  | { ok: false; reason: TokenRejection };

/**
 * `expectedDestination` is the destination derived from THIS request's body, not
 * from the token. That comparison is the whole point of the token: it stops a
 * guest verifying their own address and then submitting someone else's.
 */
export function verifyVerificationToken(
  token: unknown,
  expect: {
    scopeKey: string;
    expectedDestination: string | null;
    mac: string | null;
    allowedChannels: VerifyChannel[];
  },
): TokenVerdict {
  if (!secret()) return { ok: false, reason: 'missing' };
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return { ok: false, reason: 'missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };

  const data = `${parts[0]}.${parts[1]}`;
  const provided = Buffer.from(parts[2]);
  const expected = Buffer.from(sign(data));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: VerificationTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.d !== 'string' || typeof payload.s !== 'string') {
    return { ok: false, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' };
  if (typeof payload.iat !== 'number' || payload.iat > now + IAT_SKEW_SECONDS) {
    return { ok: false, reason: 'malformed' };
  }

  // A token minted at venue A must be worthless at venue B.
  if (payload.s !== expect.scopeKey) return { ok: false, reason: 'scope_mismatch' };

  // Revoking a channel in the CMS invalidates tokens already in flight for it.
  if (!expect.allowedChannels.includes(payload.c)) return { ok: false, reason: 'channel_disabled' };

  if (!expect.expectedDestination || payload.d !== expect.expectedDestination) {
    return { ok: false, reason: 'destination_mismatch' };
  }

  // Skipped when either side is absent — some Aruba firmware omits the client
  // MAC, and failing closed there would lock out an entire vendor.
  const mac = normalizeMac(expect.mac);
  if (payload.m && mac && payload.m !== mac) return { ok: false, reason: 'mac_mismatch' };

  return { ok: true, payload };
}
