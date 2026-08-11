/**
 * What an SMS actually costs, in segments.
 *
 * Pure — no Firestore, no providers — so the billing text can be tested
 * directly. That matters because SMS is the only channel whose price depends on
 * its content, and getting the content wrong silently under-charges every send.
 *
 * THE TEXT WE PRICE must be the text we send. `dispatchOne` builds the outbound
 * body as:
 *
 *   base message
 *     → resolveVariant(guest language)      ← priced here
 *     → interpolate({{firstName}} etc.)     ← NOT priced (see below)
 *     → swapVenueRatingUrl / swapTrackedLinks  ← NOT priced (see below)
 *     → ensureSmsOptOutSuffix                ← priced here
 *
 * The language variant is the step that matters and the one we can price
 * exactly: it is deterministic and known at estimate time from the audience.
 * Two ways a translation costs more than the English it replaces:
 *
 *   - **Length.** Translations of English run longer (German especially), and
 *     160 characters is a cliff, not a slope. This is the common case.
 *   - **Charset.** Note that German umlauts and Italian/French accents
 *     (ä ö ü ß é à ò …) ARE in GSM-7 and cost nothing extra. What drops a
 *     message to UCS-2 — and the per-segment limit from 160 to 70 — is
 *     typographic punctuation (’ “ ” —, i.e. anything autocorrect produces),
 *     emoji, and Slavic diacritics (ć š ř). A single curly apostrophe pasted in
 *     from a word processor more than doubles the price of a long SMS.
 *
 * Pricing the base body therefore under-charged every multi-language SMS
 * campaign, sometimes by half.
 *
 * Interpolation and link-swapping are deliberately NOT priced:
 *   - interpolation varies per guest and cuts both ways ("{{firstName}}" is 13
 *     characters, most names are shorter), so it is noise rather than bias;
 *   - short links are minted during dispatch and cannot be known while
 *     estimating — and they shorten the body, so ignoring them is conservative.
 * Both are reported honestly in the COGS snapshot instead, so any margin drift
 * shows up on the admin dashboard rather than hiding in the estimate.
 */

import { resolveVariant } from './guestLanguage';

// GSM 03.38 basic character set + extension characters (which count double).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

/**
 * Segments a message body will consume (spec §3 SMS note): GSM-7 texts fit 160
 * chars in one segment (153/segment when concatenated); any non-GSM character
 * forces UCS-2 at 70 / 67. Mirrors the CMS composer's preview math.
 */
export function smsSegments(content: string): number {
  const text = String(content ?? '');
  if (text.length === 0) return 1;

  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  const chars = [...text].length;
  return chars <= 70 ? 1 : Math.ceil(chars / 67);
}

// CTIA compliance: every marketing SMS must carry opt-out instructions. The
// suffix is appended unless the author already wrote their own (keep this
// regex in sync with the CMS MessageBuilder preview).
//
// KNOWN WART: the pattern is English-only. A German variant ending "Antworten
// Sie STOP zum Abbestellen." is not recognised, so it receives the English
// suffix on top of its own instruction — two opt-outs, one in the wrong
// language, and 26 wasted characters that can tip a message into a second
// segment. Pre-existing; pricing is correct either way because we price the
// final text. Fixing it means translating both the suffix and the pattern per
// language, which is a compliance change, not a billing one.
// Pinned by tests/smsBilling.test.ts ("KNOWN WART").
const SMS_OPT_OUT_SUFFIX = '\nReply STOP to unsubscribe';
const SMS_OPT_OUT_PATTERN = /\breply\s+stop\b|\bstop\b.{0,20}(unsubscribe|opt.?out|cancel)/i;

export function ensureSmsOptOutSuffix(content: string): string {
  const safe = String(content ?? '');
  if (SMS_OPT_OUT_PATTERN.test(safe)) return safe;
  return `${safe}${SMS_OPT_OUT_SUFFIX}`;
}

/** Minimal shape needed to price a message — a subset of CampaignMessage. */
export interface BillableMessage {
  content?: string;
  translations?: Record<string, Record<string, unknown>> | null;
}

/**
 * The exact text an SMS is billed on for one guest: their language variant
 * plus the CTIA suffix.
 *
 * Every pricing path — estimate, reservation, in-run budget check, settle
 * breakdown and COGS snapshot — must go through this one function, or the
 * reservation and the debit will disagree about what a message cost.
 */
export function smsBillingText(msg: BillableMessage, language: unknown): string {
  const resolved = resolveVariant(msg, language);
  return ensureSmsOptOutSuffix(String(resolved.content ?? ''));
}

/** Segments one guest's copy of an SMS will consume. */
export function smsSegmentsFor(msg: BillableMessage, language: unknown): number {
  return smsSegments(smsBillingText(msg, language));
}
