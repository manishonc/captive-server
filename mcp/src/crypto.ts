import * as crypto from 'crypto';

/** Cryptographically-strong opaque token / id (default 256 bits, hex). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** A public OAuth client id (128 bits, base64url — URL-safe, shorter than hex). */
export function randomClientId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** SHA-256 hex digest — used as the Firestore doc id for opaque tokens / codes. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** base64url without padding (RFC 7636 / RFC 9125 style). */
export function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

/**
 * Verify a PKCE code_verifier against the stored S256 code_challenge
 * (RFC 7636 §4.6): BASE64URL(SHA256(verifier)) must equal the challenge.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = base64url(crypto.createHash('sha256').update(verifier).digest());
  return timingSafeEqual(computed, challenge);
}

/** Constant-time string compare. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
