/**
 * How many parts (segments) an SMS takes, as the carrier counts them (PR F0). Pure.
 *
 * Adaptive's pricing, its owner estimate and (PR F2) the wording lint use this. The
 * shared `services/smsBilling.ts` counter counts code points, so an emoji — two UTF-16
 * units, which is what UCS-2 bills — reads as one there; it is left as it is because the
 * legacy campaigns bill with it (additive-only rule).
 *
 *   GSM-7: 160 septets in one part, 153 per part when split; an extension character
 *          (€ [ ] { } | \ ~ ^, form feed) takes two septets and is never split across parts.
 *   UCS-2: any other character (– ’ “ ” … emoji, ć š …): 70 UTF-16 units in one part, 67 per
 *          part when split; a character outside the BMP (emoji) takes two units and is never
 *          split across parts.
 *
 * German umlauts, ß and é è à ù ì ò are GSM-7 and cost nothing extra.
 */

// GSM 03.38 basic set (the same list as services/smsBilling.ts) and its extension table.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '\f^{}\\[~]|€';

export interface SmsParts {
  encoding: 'gsm7' | 'ucs2';
  /** Septets (GSM-7) or UTF-16 units (UCS-2). */
  units: number;
  segments: number;
  /** The characters that forced UCS-2, each once, in the order they appear. */
  nonGsm: string[];
}

export function isGsm7Char(ch: string): boolean {
  return GSM7_BASIC.includes(ch) || GSM7_EXTENDED.includes(ch);
}

/** Parts needed for these character sizes: `single` fits in one, else `multi` per part, a character never split. */
function pack(sizes: number[], single: number, multi: number): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= single) return 1;
  let parts = 1;
  let used = 0;
  for (const n of sizes) {
    if (used + n > multi) {
      parts += 1;
      used = 0;
    }
    used += n;
  }
  return parts;
}

export function smsParts(text: string): SmsParts {
  const s = String(text ?? '');
  const chars = [...s];
  const nonGsm: string[] = [];
  for (const ch of chars) if (!isGsm7Char(ch) && !nonGsm.includes(ch)) nonGsm.push(ch);
  if (!nonGsm.length) {
    const sizes = chars.map((ch) => (GSM7_EXTENDED.includes(ch) ? 2 : 1));
    return { encoding: 'gsm7', units: sizes.reduce((a, b) => a + b, 0), segments: pack(sizes, 160, 153), nonGsm };
  }
  const sizes = chars.map((ch) => ch.length);
  return { encoding: 'ucs2', units: s.length, segments: pack(sizes, 70, 67), nonGsm };
}

/**
 * Typographic punctuation → its GSM-7 twin, for merge VALUES in an SMS (a guest or venue name
 * typed on a phone — "Luigi’s", "Café – Bar" — would otherwise make the whole SMS Unicode: 70
 * characters a part instead of 160). Letters are never changed (ë, ç, ô stay; a name is a name).
 */
const SMS_PUNCTUATION: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060\u2039\u203A]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u00A0\u2002-\u200A\u202F\u205F]/g, ' '],
  [/[\u200B\u200C\u200D\u2060\uFEFF]/g, ''],
];

export function smsSafeText(value: string): string {
  let out = String(value ?? '');
  for (const [pattern, replacement] of SMS_PUNCTUATION) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Which of two renderings of one SMS to send: the one with cleaned values only when it is GSM-7
 * and takes no more parts than the text as typed. A name like "Zoë" keeps the SMS Unicode either
 * way; cleaning it would only change the guest's own punctuation (and "…" → "..." adds units).
 */
export function smsCheaperText(asTyped: string, cleaned: string): string {
  if (cleaned === asTyped) return asTyped;
  const c = smsParts(cleaned);
  return c.encoding === 'gsm7' && c.segments <= smsParts(asTyped).segments ? cleaned : asTyped;
}

/** Just the number of parts. */
export function smsSegmentCount(text: string): number {
  return smsParts(text).segments;
}
