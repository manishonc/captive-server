/**
 * Strict E.164 normalization for the guest-verification path.
 *
 * This is deliberately NOT the `toE164` in twilio.ts / whatsapp.ts. Those strip
 * non-digits and concatenate, which mangles the two things guests type most:
 *
 *   "07911 123456"   + "+44"  ->  +4407911123456   (trunk 0 never stripped)
 *   "+447911123456"  + "+44"  ->  +44447911123456  (country code doubled)
 *
 * Marketing tolerates that because a bad number just fails silently in the
 * background. OTP does not: the guest sits on the verify step waiting for a
 * message that can never arrive, and cannot get online. So this module is
 * stricter, and returns null rather than guessing.
 *
 * The legacy `toE164`s are intentionally left alone — changing them alters
 * delivery for existing marketing sends and belongs in its own commit.
 */

/** E.164 permits at most 15 digits including the country code. */
const MAX_E164_DIGITS = 15;
/** Shortest plausible full international number (e.g. Niue, +683 XXXX). */
const MIN_E164_DIGITS = 7;

function digitsOf(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function finalize(digits: string): string | null {
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  return `+${digits}`;
}

/**
 * Builds an E.164 number from the portal's country selector + the typed number.
 * Returns null when the input cannot be normalized with confidence.
 *
 * Precedence, highest first:
 *   1. the guest typed a leading "+"  -> they gave the full number; the country
 *      selector is ignored entirely (pasting "+41 79…" while the selector still
 *      says +44 must not produce "+4441 79…")
 *   2. the guest typed a leading "00" -> international access prefix, same thing
 *   3. otherwise                      -> strip one national trunk "0", prepend cc
 *
 * A number that duplicates its own country code without a "+" (cc "+41", typed
 * "41791234567") is NOT special-cased: "41…" is a legitimate national number in
 * several plans, so unpicking it would break valid input to fix invalid input.
 */
export function normalizeE164(phoneCountryCode: string, phone: string): string | null {
  const raw = String(phone || '').trim();
  if (!raw) return null;

  if (raw.startsWith('+')) return finalize(digitsOf(raw));

  const typed = digitsOf(raw);
  if (!typed) return null;
  if (typed.startsWith('00')) return finalize(typed.slice(2));

  const cc = digitsOf(phoneCountryCode);
  // No country code and no international prefix means we cannot know the
  // country. Guessing here is how an OTP silently goes to the wrong number.
  if (!cc) return null;

  const national = typed.startsWith('0') ? typed.slice(1) : typed;
  if (!national) return null;

  return finalize(cc + national);
}

/**
 * Normalizes an email for use as a verification destination and doc-id input.
 * Returns null when it cannot plausibly receive mail.
 */
export function normalizeEmail(email: string): string | null {
  const value = String(email || '').trim().toLowerCase();
  if (!value || value.length > 254) return null;
  // Deliberately permissive — the whole point of emailing a code is that we
  // cannot tell a deliverable address from an undeliverable one by inspection.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/** Masks a destination for display, so the portal never echoes it in full. */
export function maskDestination(channel: string, destination: string): string {
  if (channel === 'email') {
    const at = destination.indexOf('@');
    if (at < 1) return '•••';
    const name = destination.slice(0, at);
    const domain = destination.slice(at);
    const head = name.slice(0, 1);
    return `${head}${'•'.repeat(Math.max(2, Math.min(6, name.length - 1)))}${domain}`;
  }
  const tail = destination.slice(-3);
  return `${destination.slice(0, 3)} ••• ••• ${tail}`;
}
