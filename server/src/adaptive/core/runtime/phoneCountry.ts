/**
 * Phone number → country (and its time zone when the country has only one).
 *
 * Used for two gate rules: the SMS allowed-countries list, and the stricter
 * quiet-hours check in the phone's home zone. Countries with several zones (US,
 * CA, ES with the Canaries, PT with the Azores, …) return no zone, so they never
 * move quiet hours. Pure and small on purpose — not a full numbering plan.
 */

interface CountryInfo {
  country: string;
  /** Only for single-zone countries. */
  tz?: string;
}

// Longest prefix wins, so 3-digit codes are listed before their 2-digit parents.
const PREFIXES: Array<[string, CountryInfo]> = [
  ['423', { country: 'LI', tz: 'Europe/Vaduz' }],
  ['352', { country: 'LU', tz: 'Europe/Luxembourg' }],
  ['353', { country: 'IE', tz: 'Europe/Dublin' }],
  ['354', { country: 'IS', tz: 'Atlantic/Reykjavik' }],
  ['356', { country: 'MT', tz: 'Europe/Malta' }],
  ['357', { country: 'CY', tz: 'Asia/Nicosia' }],
  ['358', { country: 'FI', tz: 'Europe/Helsinki' }],
  ['359', { country: 'BG', tz: 'Europe/Sofia' }],
  ['370', { country: 'LT', tz: 'Europe/Vilnius' }],
  ['371', { country: 'LV', tz: 'Europe/Riga' }],
  ['372', { country: 'EE', tz: 'Europe/Tallinn' }],
  ['377', { country: 'MC', tz: 'Europe/Monaco' }],
  ['385', { country: 'HR', tz: 'Europe/Zagreb' }],
  ['386', { country: 'SI', tz: 'Europe/Ljubljana' }],
  ['420', { country: 'CZ', tz: 'Europe/Prague' }],
  ['421', { country: 'SK', tz: 'Europe/Bratislava' }],
  ['351', { country: 'PT' }],
  ['30', { country: 'GR', tz: 'Europe/Athens' }],
  ['31', { country: 'NL', tz: 'Europe/Amsterdam' }],
  ['32', { country: 'BE', tz: 'Europe/Brussels' }],
  ['33', { country: 'FR', tz: 'Europe/Paris' }],
  ['34', { country: 'ES' }],
  ['36', { country: 'HU', tz: 'Europe/Budapest' }],
  ['39', { country: 'IT', tz: 'Europe/Rome' }],
  ['40', { country: 'RO', tz: 'Europe/Bucharest' }],
  ['41', { country: 'CH', tz: 'Europe/Zurich' }],
  ['43', { country: 'AT', tz: 'Europe/Vienna' }],
  ['44', { country: 'GB', tz: 'Europe/London' }],
  ['45', { country: 'DK', tz: 'Europe/Copenhagen' }],
  ['46', { country: 'SE', tz: 'Europe/Stockholm' }],
  ['47', { country: 'NO', tz: 'Europe/Oslo' }],
  ['48', { country: 'PL', tz: 'Europe/Warsaw' }],
  ['49', { country: 'DE', tz: 'Europe/Berlin' }],
  ['61', { country: 'AU' }],
  ['81', { country: 'JP', tz: 'Asia/Tokyo' }],
  ['86', { country: 'CN', tz: 'Asia/Shanghai' }],
  ['91', { country: 'IN', tz: 'Asia/Kolkata' }],
  ['1', { country: 'US' }],
  ['7', { country: 'RU' }],
];

/** `+41791234567` → { country: 'CH', tz: 'Europe/Zurich' }; unknown → null. */
export function phoneCountry(e164: string | null | undefined): CountryInfo | null {
  if (!e164 || !e164.startsWith('+')) return null;
  const digits = e164.slice(1);
  let best: CountryInfo | null = null;
  let bestLen = 0;
  for (const [prefix, info] of PREFIXES) {
    if (prefix.length > bestLen && digits.startsWith(prefix)) {
      best = info;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Default SMS allow-list (PRD rule 4); the platform can change it in AdaptiveConfig. */
export const DEFAULT_SMS_COUNTRIES = ['CH', 'LI', 'DE', 'AT', 'FR', 'IT'];
