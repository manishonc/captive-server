/**
 * "Who gets messages" (plan §5/§6, PR D): the owner's choice per venue — SMS only to
 * verified numbers (default) or to everyone who said yes, and the same for email (default
 * everyone) — the last-30-day counts behind it, and what it does to the estimate. Pure.
 *
 * Counts come from the guests' own docs: opted-in guests first captured in the last 30 days
 * at the venue's access points, split by the `phoneVerified` / `emailVerified` flags the
 * verification gate stores. So they work before the venue is ever turned on.
 *
 * `classes` keys are four flags: has a phone, phone verified, has an email, email verified —
 * e.g. "1010" = a phone (not verified) and an email (not verified) — then, for a guest with a
 * phone, `:` and the number's country ("1110:CH"; "1110:" when unknown). The engine texts only
 * the countries in its SMS list, so a number elsewhere counts as no phone here (email, or nobody).
 */

export type AudienceChoice = 'verified' | 'all';
export interface Audience {
  sms: AudienceChoice;
  email: AudienceChoice;
}

export const DEFAULT_AUDIENCE: Audience = { sms: 'verified', email: 'all' };

/** The engine's own reading (engine/context.ts): SMS verified unless 'all', email all unless 'verified'. */
export function effectiveAudience(saved: { sms?: unknown; email?: unknown } | null | undefined): Audience {
  return { sms: saved?.sms === 'all' ? 'all' : 'verified', email: saved?.email === 'verified' ? 'verified' : 'all' };
}

export function classKey(g: { hasPhone: boolean; phoneVerified: boolean; hasEmail: boolean; emailVerified: boolean }): string {
  return `${g.hasPhone ? 1 : 0}${g.hasPhone && g.phoneVerified ? 1 : 0}${g.hasEmail ? 1 : 0}${g.hasEmail && g.emailVerified ? 1 : 0}`;
}

/** The class key with the phone's country (see the file header). */
export function classKeyWithCountry(g: { hasPhone: boolean; phoneVerified: boolean; hasEmail: boolean; emailVerified: boolean }, country: string | null): string {
  return g.hasPhone ? `${classKey(g)}:${country ?? ''}` : classKey(g);
}

/** A key's flags; a phone in a country SMS doesn't go to (or unknown) counts as none. No suffix: counted as reachable. */
function flags(key: string, smsCountries: readonly string[]) {
  const [bits, country] = key.split(':');
  const phoneReachable = bits[0] === '1' && (country === undefined || smsCountries.includes(country));
  return {
    hasPhone: phoneReachable,
    phoneVerified: phoneReachable && bits[1] === '1',
    hasEmail: bits[2] === '1',
    emailVerified: bits[3] === '1',
    otherCountry: bits[0] === '1' && !phoneReachable,
  };
}

export interface AudienceCounts {
  /** Opted-in guests of the last 30 days with a phone number: verified by code, or not. */
  sms: { verified: number; unverified: number };
  /** The same for email addresses. */
  email: { verified: number; unverified: number };
  /** Guests whose number is in a country SMS doesn't go to (they are counted by email only). */
  smsOtherCountries: number;
}

export function audienceCounts(classes: Record<string, number> | undefined, smsCountries: readonly string[]): AudienceCounts {
  const out: AudienceCounts = { sms: { verified: 0, unverified: 0 }, email: { verified: 0, unverified: 0 }, smsOtherCountries: 0 };
  for (const [key, n] of Object.entries(classes ?? {})) {
    const f = flags(key, smsCountries);
    if (f.otherCountry) out.smsOtherCountries += n;
    if (f.hasPhone) out.sms[f.phoneVerified ? 'verified' : 'unverified'] += n;
    if (f.hasEmail) out.email[f.emailVerified ? 'verified' : 'unverified'] += n;
  }
  return out;
}

/**
 * The estimate's inputs under a choice: a guest the owner's choice lets us SMS counts as
 * "with phone" (the journey's ladder then picks SMS or email), one we may only email as
 * "email only", and one we may reach on neither isn't counted (no cost, no return).
 */
export function reachableUnder(
  classes: Record<string, number> | undefined,
  audience: Audience,
  smsCountries: readonly string[],
): { withPhone: number; emailOnly: number; optedIn: number } {
  let withPhone = 0;
  let emailOnly = 0;
  for (const [key, n] of Object.entries(classes ?? {})) {
    const f = flags(key, smsCountries);
    const smsOk = f.hasPhone && (audience.sms === 'all' || f.phoneVerified);
    const emailOk = f.hasEmail && (audience.email === 'all' || f.emailVerified);
    if (smsOk) withPhone += n;
    else if (emailOk) emailOnly += n;
  }
  return { withPhone, emailOnly, optedIn: withPhone + emailOnly };
}
