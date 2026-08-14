// Setup-code parsing and validation, done locally so a typo costs no round trip and the
// person gets told what is actually wrong.
//
// KEEP IN SYNC with two other copies:
//   captive-server/server/src/services/accountCode.ts  — the authority
//   ../../renderer/account-code.ts                     — the renderer's classic-script twin
// test/account-code.test.ts asserts the alphabet literal matches the renderer copy.

/** No I, L, O, 0 or 1 — the pairs people transcribe wrongly when reading off a screen. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

const ALLOWED = new Set(CODE_ALPHABET.split(''));
/** Characters a human plausibly types in place of an allowed one. Rejected, never folded. */
const CONFUSABLE = new Set(['I', 'L', 'O', '0', '1']);

export type CodeProblem = 'empty' | 'too_short' | 'too_long' | 'confusable' | 'bad_char';

export interface CodeCheck {
  /** Canonical: uppercase, no separators. What goes on the wire. */
  value: string;
  ok: boolean;
  problem?: CodeProblem;
}

/**
 * Strip separators and uppercase. Never drops unknown characters — dropping shifts the rest
 * left, silently turning a typo into a different code that might even be valid.
 */
export function normalizeAccountCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/** Display form `H7K2-M9QX`; formats partial input so the dash appears as you type. */
export function formatAccountCode(input: unknown): string {
  const v = normalizeAccountCode(input).slice(0, CODE_LENGTH);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

/**
 * Validate, reporting why. `confusable` is checked BEFORE length: someone who typed
 * `H7K2-M9Q0` should be told about the 0, not sent hunting for a missing character.
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

/**
 * For the log ring buffer, which the "Copy log" button mails to support. A live code must
 * never end up in an email thread.
 */
export function maskAccountCode(input: unknown): string {
  const v = normalizeAccountCode(input);
  return v.length >= 4 ? `${v.slice(0, 4)}-••••` : '••••';
}
