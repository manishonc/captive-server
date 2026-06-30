/**
 * Per-recipient unsubscribe links for marketing email.
 *
 * The CMS guarantees every marketing body carries a `{{unsubscribeUrl}}` token;
 * this module mints the value the dispatcher interpolates into it (and into the
 * RFC 8058 `List-Unsubscribe` header). A link is an HMAC-signed, tamper-proof
 * token so the public `/u/:token` endpoint can trust it without a session:
 *
 *     <SERVER_PUBLIC_URL>/u/<base64url(payload)>.<base64url(hmacSha256)>
 *
 * The payload carries only the guest id (+ venue/campaign for analytics) — never
 * the email — so the link leaks nothing; the endpoint resolves the email from
 * Firestore when it needs to blocklist the Brevo contact.
 */

import * as crypto from 'crypto';

const SECRET = process.env.UNSUBSCRIBE_SIGNING_SECRET || '';
const BASE = (process.env.SERVER_PUBLIC_URL || '').replace(/\/$/, '');

export interface UnsubscribePayload {
  /** guestId — the CaptivePortal_Users doc id. */
  g: string;
  /** venueId (optional, for analytics). */
  v?: string;
  /** campaignId (optional, for analytics). */
  c?: string;
}

function sign(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

/** Build a signed token: `base64url(JSON(payload)).base64url(hmac)`. */
export function makeUnsubscribeToken(payload: UnsubscribePayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

/** Verify + decode a token. Returns the payload, or null if missing/tampered. */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  if (!SECRET || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.g === 'string' && parsed.g) return parsed as UnsubscribePayload;
    return null;
  } catch {
    return null;
  }
}

/**
 * The full guest-facing unsubscribe URL for a recipient. Returns '' when the
 * feature is not configured (no secret or public URL) — the dispatcher then
 * resolves `{{unsubscribeUrl}}` to empty, same as any other unknown token.
 */
export function buildUnsubscribeUrl(payload: UnsubscribePayload): string {
  if (!SECRET || !BASE) return '';
  return `${BASE}/u/${makeUnsubscribeToken(payload)}`;
}
