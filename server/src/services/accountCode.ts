/**
 * Account codes — the credential a venue installer types into the AP Adoption Helper.
 *
 * Pure: no Firestore, no controller, no env beyond the hash pepper. Firestore lives in
 * services/adoptionCodes.ts, so this half stays unit-testable without credentials (same
 * split as subscriptionState.ts / publicPricing.ts).
 *
 * SHAPE. 8 characters from a 31-character alphabet with every visually confusable glyph
 * removed — no I, L, O, and no 0 or 1. ~8.5 x 10^11 combinations, which matters because
 * these endpoints are public and unauthenticated: the code IS the authentication. The same
 * alphabet reasoning as services/shortlinks.ts, but generated with crypto.randomInt rather
 * than Math.random, because unlike a short link this is auth-bearing.
 *
 * NO LOOKALIKE FOLDING. `normalizeAccountCode` strips separators and uppercases, and that is
 * all. It deliberately does NOT map O->0 or I->1: the alphabet already excludes both sides of
 * every such pair, so folding would only widen the accepted input space — weakening the code
 * for zero usability gain. A mistyped O is rejected, and the UI says why.
 *
 * STORAGE. The code is never a Firestore document id. The lookup key is a peppered SHA-256
 * so a database leak yields no usable codes and no reversible lookup table; the displayable
 * copy is encrypted separately (services/secretBox.ts). ADOPTION_CODE_PEPPER must be set —
 * an unpeppered hash of an 8-character code from a known alphabet is brute-forceable offline
 * in seconds, so `accountCodeDocId` throws rather than silently degrading.
 */

import crypto from 'node:crypto';

/** No I, L, O, 0 or 1 — the pairs people transcribe wrongly when reading off a screen. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Characters a human plausibly types in place of an allowed one. Rejected, never folded. */
const CONFUSABLE = new Set(['I', 'L', 'O', '0', '1']);
const ALLOWED = new Set(CODE_ALPHABET.split(''));

export type CodeProblem = 'empty' | 'too_short' | 'too_long' | 'confusable' | 'bad_char';

export interface CodeCheck {
  /** Canonical form: uppercase, no separators. What goes on the wire and into the hash. */
  value: string;
  ok: boolean;
  problem?: CodeProblem;
}

/** Cryptographically random code. Rejection-free: 31 divides evenly enough via randomInt. */
export function generateAccountCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Strip separators and uppercase. Never drops unknown characters — dropping would shift the
 * remaining ones left and turn a typo into a different, possibly valid, code.
 */
export function normalizeAccountCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/** Display form, `H7K2-M9QX`. Formats partial input progressively for as-you-type UIs. */
export function formatAccountCode(input: unknown): string {
  const v = normalizeAccountCode(input).slice(0, CODE_LENGTH);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

/**
 * Validate, reporting WHY. `confusable` is checked before length so that someone who typed
 * `H7K2-M9Q0` is told about the 0 rather than being told the code is too short — that is the
 * single most common failure when reading a code off a screen.
 */
export function checkAccountCode(input: unknown): CodeCheck {
  const value = normalizeAccountCode(input);
  if (!value) return { value, ok: false, problem: 'empty' };
  const chars = value.split('');
  if (chars.some((c) => CONFUSABLE.has(c))) return { value, ok: false, problem: 'confusable' };
  if (chars.some((c) => !ALLOWED.has(c))) return { value, ok: false, problem: 'bad_char' };
  if (value.length > CODE_LENGTH) return { value, ok: false, problem: 'too_long' };
  if (value.length < CODE_LENGTH) return { value, ok: false, problem: 'too_short' };
  return { value, ok: true };
}

/** True when the hash pepper is configured. `/adoption` refuses to mount without it. */
export function accountCodeSubsystemReady(): boolean {
  return Boolean(process.env.ADOPTION_CODE_PEPPER);
}

/**
 * Firestore document id for a code: peppered SHA-256, hex. Throws when the pepper is unset
 * rather than falling back to an unpeppered hash, which would be trivially reversible for an
 * 8-character code drawn from a published alphabet.
 */
export function accountCodeDocId(code: string): string {
  const pepper = process.env.ADOPTION_CODE_PEPPER;
  if (!pepper) throw new Error('ADOPTION_CODE_PEPPER is not configured.');
  const canonical = normalizeAccountCode(code);
  return crypto.createHash('sha256').update(`${pepper}:${canonical}`).digest('hex');
}

/** For logs and errors. A whole code must never reach the log ring buffer or a support email. */
export function maskAccountCode(input: unknown): string {
  const v = normalizeAccountCode(input);
  return v.length >= 4 ? `${v.slice(0, 4)}-••••` : '••••';
}
