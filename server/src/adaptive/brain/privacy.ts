/**
 * The last check before a request package leaves for the model (PR F2a; brain.md §3.6). Pure.
 *
 * The input builders copy allowed fields by name and never read guests or Guest info; this scan
 * of the finished package — as it is serialized, so what is checked is what is sent — is the
 * second line. A finding stops the run: nothing is sent and nothing of the package is stored —
 * and the finding itself never carries a value: its path names plain field keys (starting with a
 * lower-case letter or "_") as they are and replaces any other key with `<key #n>`.
 *
 * Every text is first put in one form: URL escapes of punctuation and "@" decoded (twice: "%252B"),
 * HTML character references read as a reader reads them (every numeric one, and the named ones for
 * spacing, dashes, the punctuation of addresses and numbers, and Latin letters: "&nbsp;", "&uuml;"),
 * and URL escapes once more after them ("&#37;40"), Unicode compatibility forms (fullwidth digits,
 * no-break and thin spaces), every dash as "-", every bullet ("•", "∙", "⋅", "・") as "·", control
 * characters as spaces, invisible characters (zero-width, soft hyphen) removed.
 *
 *  - email: anything shaped like an address — also "(at)" / "[at]" and "(dot)" / "(point)" spelled
 *    out, a quoted name, a non-Latin top-level domain — in a string value or a key (a "/…/@name"
 *    profile link, an image name like "logo@2x.png" and "Infos @ www.sonne.ch" are not one);
 *  - phone: in a string or a key, a number written as a phone number would be — a "+" and 8+
 *    digits, "00" and a country code and 10+ digits, or 9+ digits, with any separators (spaces,
 *    dashes, dots, slashes, brackets, "·"), not glued to letters ("ar_1234567890abc" is an id)
 *    — a "+" or "00" number may be glued to the next word ("+49 7531 123456Wir", "+4915112345678Wir",
 *    "0049-7531-123456Wir"; the start of a UUID, "00123456-7890-4abc…", is an id) — and any Swiss
 *    number ("0xx", "+41", "0041") whatever its separators, also glued to a word when it has one
 *    ("Telefon079 123 45 67", "Tel_079 123 45 67"), but not glued to an id by "_" ("va_0258177156…";
 *    one in _italics_ is still found). UUIDs are ids ("12345678-9012-4abc-…"). Lists of years
 *    ("2024 2025 2026"), map coordinates ("47.3668903"; not "333.1234567") and long ids inside web links
 *    (".../events/1234567890123456", also a bare "site.ch/…" link) are not phone numbers — a link
 *    with "tel:"/"tel=", "wa.me/", "phone=", a "+" number or a "41…" mobile number still is. Dates and times (ISO,
 *    "30.09.2026", "30-09-2026", "09/30/2026", "01.10.26", "03.10.", with a time and zone), Swiss
 *    company numbers ("CHE-123.456.789") and two-decimal amounts ("12.50") are taken out first,
 *    so they are never digits of a phone number, nor hide one next to them. Any whole number of 9
 *    to 15 digits stored as a number is one too (packages carry times as ISO strings, never as
 *    epoch numbers, and no large amounts);
 *  - iban: an account number with a valid IBAN check (spaced or not);
 *  - secret: a value the caller passes (a venue's Wi-Fi password, door code, staff name,
 *    address…), with at least 4 letters or digits, matched without case, accents, "ß"/"ss",
 *    invisible characters, or the punctuation and spacing between its parts ("Gast24!" in
 *    "Gast24", "D’Angelo" for "D'Angelo", "Sunshine 2024" for "Sunshine2024", "Tinas" for "Tina").
 *    Letters with strokes read as typed without them ("Søren" = "Soren", "Łukasz" = "Lukasz").
 *    An umlaut in the secret reads as its "ae/oe/ue" spelling ("Müller": "Müller", "Mueller" —
 *    never "Muller", which is also a word: "Schön" is not "schon", "Bürger" not "Burger"); an umlaut
 *    in the text reads both ways ("Muller" and "Mueller" are found in "Müller"). A secret of digits
 *    only is a whole number (not inside a date, an amount or a longer number): four digits also as
 *    "12 34" or "4 8 2 1", five or more also in any groups ("1234 5678", "1234-5678"), and one with
 *    its own punctuation also exactly as written ("12-34", "01.10.2026", "12:34" — not "12.34"); any
 *    other matches as whole words. A name part of 3 letters (letters only, as typed: "Tim", "Mia")
 *    is a whole word with no genitive ("Dan" is not "dans") and the text's accents count ("Gia" is not
 *    "già", "Ole" is not "Öle"; "Léa" is found as "Lea"); codes and anything else need 4 letters or
 *    digits — or, with fewer, 6 characters or more, exactly as written ("Bar!!!!!", never "bar";
 *    "Tim." or "Bar!!" is not checked: the builder passes a name's letters, "Tim"). A secret
 *    too long for a pattern (over 128 letters and digits, or 64 parts) is compared with the spacing
 *    and punctuation removed. The scan never splits a free-text secret ("Haustür 4821"): the input
 *    builder passes its parts (F2b). Numbers are never compared with secrets: a
 *    count may equal a door code. A name is passed as its parts too (first name, last name) by
 *    the input builder: the scan never splits a secret itself.
 */

export type PrivacyFindingKind = 'email' | 'phone' | 'iban' | 'secret';

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  path: string;
}

// Bounded parts (RFC lengths), so a long run of address characters can't make the scan slow.
const EMAIL = /[^\s@()<>,;:"'[\]{}/]{1,64}@[^\s@()<>,;:"'[\]{}]{1,253}\.(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})(?![\p{L}\p{N}])/iu;
// `(?<!\s)`: a match starts where a run of spaces starts (else a long run is scanned from each space).
const AT_SPELLED = /(?<!\s)\s*[([{]\s*(?:at|ät|@)\s*[)\]}]\s*/giu;
const DOT_SPELLED = /(?<!\s)\s*[([{]\s*(?:dot|punkt|point|punto|\.)\s*[)\]}]\s*/giu;
// An image name ("logo@2x.png") is not an address.
const IMAGE_NAME = /@\d(?:\.\d)?x\.(?:png|jpe?g|gif|webp|svg|avif)\b/giu;
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}_])(?:(?:\+|\(\+|\(?(?=00[1-9]))\d[\d\s().\-/·]*\d\)?(?![\p{N}_])|(?:\+|\(\+?)?\d[\d\s().\-/·]*\d\)?(?![\p{L}\p{N}_]))/gu;
const LETTER_SWISS = /(?<=\p{L}_?)0\d{2}[\s./·-]{0,3}\d{3}[\s./·-]{0,3}\d{2}[\s.,/·-]{0,3}\d{2}(?!\p{N})/gu;
// A Swiss number with any separators ("079 123 45.67", "+41 79 123 45,67", "+41 (0)44 …"),
// checked before amounts are taken out.
const SWISS_NUMBER =
  /(?:(?<![\p{L}\p{N}]|[\p{L}\p{N}]_)0|(?<![\p{L}\p{N}+]|[\p{L}\p{N}]_)(?:\+|00)41[\s./·-]{0,3}(?:\(0\)[\s./·-]{0,3})?)\d{2}[\s./·-]{0,3}\d{3}[\s./·-]{0,3}\d{2}[\s.,/·-]{0,3}\d{2}(?!\p{N})/u;
// A Swiss number glued to a phone label ("Tel079 123 45 67", "Natel079…").
const LABELED_SWISS = /(?:^|[^\p{L}])(?:tel|natel|mobile?|mob|handy|fon|phone|[tmp])\.?:?\s?0\d{2}[\s./·-]{0,3}\d{3}[\s./·-]{0,3}\d{2}[\s.,/·-]{0,3}\d{2}(?!\p{N})/iu;
// Not phone numbers: a list of years, a map coordinate.
const YEAR_LIST = /^\(?(?:19|20)\d{2}\)?(?:[\s./\u00B7-]*\(?(?:19|20)\d{2}\)?)+$/;
// (Degrees go up to 180: "333.1234567" is an Italian mobile number.)
const COORDINATE = /^(?:1[0-7]\d|180|[1-9]\d?)\.\d{4,}$/;
// A UUID is an id, never a phone number ("12345678-9012-4abc-8def-0123456789ab").
const UUID = /(?<![\p{L}\p{N}])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}])/giu;
// The start of one, cut off or glued to a word: its first three groups, the third ending there
// ("00123456-7890-4abc…"; not "00491511-2345-678Bitte", a phone number glued to a word).
const UUID_START = /^\(?00\d{6}-[0-9a-f]{4}-[0-9a-f]{4}(?![\p{L}\p{N}])/iu;
// Bullets and the dots that look like one, as "·".
const BULLETS = /[\u2022\u2023\u2043\u2219\u22C5\u2027\u30FB\u2E31\u2E33\u25E6\u25CF\u2981]/gu;
// A web link (also a bare "site.ch/…" with a path): its long numbers are ids, unless it points at a phone.
const WEB_LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+|(?<![\w-]|[\w-]\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s<>"']*/gi;
const LINK_PHONE_SIGNAL = /tel[:=]|wa\.me\/|phone=|(?<![\p{L}\p{N}])\+\d|(?<!\p{N})00[1-9]\d|(?<!\p{N})41[1-9]\d{8}(?!\p{N})/iu;
// yyyy-mm-dd, dd.mm.yyyy / dd-mm-yyyy, mm/dd/yyyy (and yyyy.mm.dd), with an optional time and zone.
const DATE_TIME = new RegExp(
  '(?<!\\d)(?:' +
    '(?:19|20)\\d{2}[-./](?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\\d|3[01])' +
    '|(?:0?[1-9]|[12]\\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\\d{2}' +
    '|(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\\d|3[01])/(?:19|20)\\d{2}' +
    ')(?:[ T](?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?(?!\\d)',
  'g',
);
// "01.10.26", "1.10.26", "03.10." — never a part of "06.12.34.56.78" or "079.123.45.67".
const SHORT_DATE = /(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:\d{2}(?!\d|[./]\d)|(?!\d))/g;
const TIME = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)/g;
// A Swiss company number (UID).
const COMPANY_ID = /\bCHE-?\d{3}\.?\d{3}\.?\d{3}\b/gi;
// An amount with two decimals on its own ("12.50", "1'234.50"), never a part of "079.123.45.67".
const AMOUNT = /(?<![\d.,])\d{1,6}[.,]\d{2}(?![\d.,])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}]/gu;
const FIELD_KEY = /^[a-z_][A-Za-z0-9_]{0,63}$/;
const MIN_SECRET_CHARS = 4;
/** A name part ("Tim", "Mia") is a whole word of 3 letters; codes and anything with a digit need 4. */
const MIN_NAME_CHARS = 3;
const MAX_DEPTH = 40;

/** One form for every text (see the file header). */
/**
 * HTML character references, as a reader (or the model) reads them: every numeric one ("&#160;",
 * "&#xA0;"), and the named ones for spacing, dashes, the punctuation of addresses and numbers,
 * and Latin letters ("&uuml;", "&eacute;", "&szlig;"). Any other name stays as it is.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', numsp: ' ', puncsp: ' ', hairsp: ' ',
  NonBreakingSpace: ' ', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', lrm: '\u200e', rlm: '\u200f', Tab: '\t', NewLine: '\n',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', sbquo: '‚',
  ndash: '–', mdash: '—', minus: '−', hyphen: '‐', dash: '‐',
  commat: '@', period: '.', plus: '+', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']',
  sol: '/', middot: '·', centerdot: '·', colon: ':', comma: ',', num: '#', ast: '*', excl: '!',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø',
  eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
};
const ENTITY_MARKS: Record<string, string> = {
  uml: '\u0308', acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', ring: '\u030a', cedil: '\u0327', caron: '\u030c',
};
const ENTITY = /&(?:#0*(\d{1,7});?|#x0*([0-9a-f]{1,6});?|([A-Za-z])(uml|acute|grave|circ|tilde|ring|cedil|caron);|([A-Za-z]{2,16});)/gi;
const entitiesDecoded = (t: string) =>
  t.replace(ENTITY, (m, dec?: string, hex?: string, letter?: string, mark?: string, name?: string) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex!, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    if (letter && mark) return `${letter}${ENTITY_MARKS[mark.toLowerCase()]}`.normalize('NFC');
    // Own names only: "&constructor;" is no character.
    return name && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
  });

const PERCENT = /%(2[0-9A-F]|3[0-9A-F]|40)/gi;
const percentDecoded = (t: string) => t.replace(PERCENT, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

function unify(text: string): string {
  // URL escapes, character references, and URL escapes once more ("&#37;40" is "%40", then "@").
  return percentDecoded(percentDecoded(entitiesDecoded(entitiesDecoded(percentDecoded(percentDecoded(text))))))
    .normalize('NFKC')
    // Dashes, and the minus signs that look like them.
    .replace(/[\p{Pd}\u2212\u2796\u02D7]/gu, '-')
    .replace(BULLETS, '·')
    .replace(/[。｡]/g, '.')
    .replace(/\p{Cc}/gu, ' ')
    // Invisible characters between a word and a number keep them apart ("Tel\u200b079…").
    .replace(/(?<=\p{L})(?<![\p{Default_Ignorable_Code_Point}])[\p{Default_Ignorable_Code_Point}]+(?=[\d+(])/gu, ' ')
    .replace(INVISIBLE, '');
}

/** Dates, times, company numbers and amounts taken out (a " | " each, so nothing joins across them). */
function withoutDatesAndAmounts(text: string): string {
  return text.replace(DATE_TIME, ' | ').replace(SHORT_DATE, ' | ').replace(TIME, ' | ').replace(COMPANY_ID, ' | ').replace(AMOUNT, ' | ');
}

/** Does a (unified) text hold a phone number? */
function phoneIn(text: string): boolean {
  const unified = text.replace(UUID, ' | ');
  const dateless = unified.replace(DATE_TIME, ' | ').replace(SHORT_DATE, ' | ').replace(TIME, ' | ');
  if (SWISS_NUMBER.test(dateless) || LABELED_SWISS.test(dateless)) return true;
  for (const m of dateless.match(LETTER_SWISS) ?? []) if (/\D/.test(m)) return true;
  const links = unified.replace(WEB_LINK, (link) => (LINK_PHONE_SIGNAL.test(link) ? link : ' | '));
  const candidates = withoutDatesAndAmounts(links);
  for (const match of candidates.matchAll(PHONE_CANDIDATE)) {
    const m = match[0];
    // A "+" or "00" number may be glued to the next word ("0049-7531-123456Wir"); the start of a
    // UUID is an id when its letters show it, in one case ("00123456-7890-4abc…", not "…-67Ab 18 Uhr";
    // whole UUIDs are out already).
    const head = UUID_START.exec(candidates.slice(match.index, match.index + m.length + 12))?.[0];
    if (head && /[a-f]/.test(head) !== /[A-F]/.test(head)) continue;
    if (YEAR_LIST.test(m) || COORDINATE.test(m)) continue;
    const digits = m.replace(/\D/g, '');
    const plus = /^\(?\+/.test(m);
    const zeroZero = /^\(?00[1-9]/.test(m);
    if (plus && digits.length >= 8) return true;
    if (zeroZero ? digits.length >= 10 : digits.length >= 9) return true;
  }
  return false;
}

export function looksLikePhone(text: string): boolean {
  return phoneIn(unify(text));
}

function emailIn(unified: string): boolean {
  return EMAIL.test(
    unified
      .replace(IMAGE_NAME, ' ')
      .replace(AT_SPELLED, '@')
      .replace(DOT_SPELLED, '.')
      .replace(/["']/g, ''),
  );
}

/** The IBAN check: the country and check digits moved to the end, letters as numbers, mod 97 = 1. */
function validIban(candidate: string): boolean {
  const s = candidate.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  let mod = 0;
  for (const ch of `${s.slice(4)}${s.slice(0, 4)}`) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
}

function ibanIn(unified: string): boolean {
  for (const m of unified.toUpperCase().match(IBAN) ?? []) {
    if (validIban(m) || validIban(m.replace(/ ?[A-Z0-9]{1,4}$/, ''))) return true;
  }
  return false;
}

/** A whole number stored as a number that is as long as a phone number (9–15 digits). */
function phoneLikeNumber(v: number): boolean {
  return Number.isInteger(v) && Math.abs(v) >= 1e8 && Math.abs(v) < 1e15;
}

/** The umlaut mark once decomposed (NFKD): "ü" is "u" + this. */
const UMLAUT = /([aou])\u0308/g;

/** Lower case, the umlaut as its "ae/oe/ue" spelling (or the plain vowel: `umlaut` ''), other accents gone, "ß" as "ss". */
/** Letters Unicode doesn't decompose, as they are typed without them. */
const STROKES: Record<string, string> = { ł: 'l', ı: 'i', ø: 'o', đ: 'd', ð: 'd', æ: 'ae', œ: 'oe', þ: 'th' };

function plainForm(unified: string, umlaut = 'e'): string {
  return unified
    .normalize('NFKD')
    .toLowerCase()
    .replace(UMLAUT, `$1${umlaut}`)
    .replace(/\p{M}/gu, '')
    .replace(/[łıøđðæœþ]/g, (ch) => STROKES[ch] ?? ch)
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Needle {
  test: (text: string) => boolean;
  /**
   * Where it is searched: `digits` in the text with its dates and amounts taken out, `words` in the
   * text without accents (umlauts both ways), `accented` in the text with its accents (a 3-letter name).
   */
  form: 'digits' | 'words' | 'accented';
  /** Digits only: the secret exactly as written (its own punctuation), searched in the whole text. */
  asWritten?: (text: string) => boolean;
}

/** Past these, a secret is compared as one squashed string (a pattern that long could overflow). */
const MAX_NEEDLE_RUNS = 64;
const MAX_NEEDLE_CHARS = 128;

const squash = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '');

/** The secret's own characters, exactly as written: at a word's edge, a whole word. */
function literal(plain: string): RegExp {
  const before = /^[\p{L}\p{N}]/u.test(plain) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = /[\p{L}\p{N}]$/u.test(plain) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${before}${escapeRe(plain)}${after}`, 'u');
}

function needleFor(secret: string): Needle | null {
  const typed = unify(secret).trim();
  const plain = plainForm(typed);
  const chars = squash(plain);
  // A 3-letter name part only when it is letters as typed ("Tim"; "Bar!!!!!" is no name).
  const name = /^[\p{L}\p{M}]+$/u.test(typed);
  if (chars.length < (name ? MIN_NAME_CHARS : MIN_SECRET_CHARS)) {
    // Too few letters and digits to search for their parts: only the secret exactly as written.
    if (chars.length === 0 || plain.replace(/\s/g, '').length < 6) return null;
    try {
      const re = literal(plain);
      return { test: (t) => re.test(t), form: 'words' };
    } catch {
      return null;
    }
  }
  const digits = /^\p{N}+$/u.test(chars);
  const runs = plain.match(/\p{L}+|\p{N}+/gu) ?? [];
  if (chars.length > MAX_NEEDLE_CHARS || runs.length > MAX_NEEDLE_RUNS) {
    return { test: (t) => squash(t).includes(chars), form: digits ? 'digits' : 'words' };
  }
  try {
    if (digits) {
      // A whole number: four digits also as "12 34" or digit by digit ("4 8 2 1", "4-8-2-1"), never
      // "1 234" or "17-22"; more also in any groups.
      const d = chars.split('');
      const body =
        chars.length <= 4 ? `(?:${chars.slice(0, 2)} ?${chars.slice(2)}|${d[0]}(?<sep>[ -])${d.slice(1).join('\\k<sep>')})` : d.join('[ -]?');
      const re = new RegExp(`(?<!\\p{N})${body}(?!\\p{N})`, 'u');
      // With its own punctuation between digits ("12-34", "01.10.2026", "12:34"): also exactly that
      // punctuation (spaces around it aside), never a longer number ("1.12-34") or another one ("12.34").
      const core = plain.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const seps = core.match(/[^\p{L}\p{N}]+/gu) ?? [];
      let written: RegExp | null = null;
      if (seps.some((sep) => /\S/.test(sep))) {
        const parts = core.split(/[^\p{L}\p{N}]+/u);
        const pattern = parts.map((part, i) => (i === 0 ? part : `${/\S/.test(seps[i - 1]) ? ` ?${escapeRe(seps[i - 1].replace(/\s/g, ''))} ?` : ' ?'}${part}`)).join('');
        written = new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[.,:/-])${pattern}(?![\\p{L}\\p{N}]|[.,:/-]\\p{N})`, 'u');
      }
      return { test: (t) => re.test(t), form: 'digits', asWritten: written ? (t) => written.test(t) : undefined };
    }
    if (name && chars.length < MIN_SECRET_CHARS) {
      // A 3-letter name: a whole word, as typed or without its accents, and no genitive ("Dan" is
      // not "dans", "Mai" not "mais"); the text keeps its accents ("Gia" is not "già", "Ole" not "Öle").
      const forms = [...new Set([typed.normalize('NFC').toLowerCase(), chars])].map(escapeRe).join('|');
      const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${forms})(?![\\p{L}\\p{M}\\p{N}])`, 'u');
      return { test: (t) => re.test(t), form: 'accented' };
    }
    // Its letter runs and digit runs, with any (or no) punctuation and spacing between them.
    const body = runs.map(escapeRe).join('[^\\p{L}\\p{N}]{0,3}');
    const genitive = /\p{L}$/u.test(runs[runs.length - 1] ?? '') ? 's?' : '';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${genitive}(?![\\p{L}\\p{N}])`, 'u');
    return { test: (t) => re.test(t), form: 'words' };
  } catch {
    // Never an error that could carry the secret: the squashed comparison instead.
    return { test: (t) => squash(t).includes(chars), form: digits ? 'digits' : 'words' };
  }
}

/** Scans a package (the object that will be serialized) for personal data and the given secrets. */
export function scanPackage(pkg: unknown, secrets: ReadonlyArray<string | null | undefined> = []): PrivacyFinding[] {
  const needles = [...new Set(secrets.filter((s): s is string => typeof s === 'string'))]
    .map(needleFor)
    .filter((n): n is Needle => n !== null);
  const findings: PrivacyFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: PrivacyFindingKind, path: string) => {
    const key = `${kind}:${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ kind, path });
    }
  };
  /** The kinds of personal data a text holds. */
  const kindsIn = (text: string): PrivacyFindingKind[] => {
    const u = unify(text);
    const kinds: PrivacyFindingKind[] = [];
    if (emailIn(u)) kinds.push('email');
    if (phoneIn(u)) kinds.push('phone');
    if (ibanIn(u)) kinds.push('iban');
    if (needles.length) {
      // The text's umlauts both ways: "Muller" and "Mueller" are found in "Müller".
      const words = plainForm(u);
      const plainVowels = plainForm(u, '');
      const numbers = withoutDatesAndAmounts(words);
      let accented: string | undefined;
      const found = (n: Needle) =>
        n.form === 'digits'
          ? n.test(numbers) || (n.asWritten?.(words) ?? false)
          : n.form === 'accented'
            ? n.test((accented ??= u.normalize('NFC').toLowerCase()))
            : n.test(words) || n.test(plainVowels);
      if (needles.some(found)) kinds.push('secret');
    }
    return kinds;
  };
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      add('secret', `${path || '(root)'} (too deep to check)`);
      return;
    }
    if (typeof value === 'string') {
      for (const kind of kindsIn(value)) add(kind, path || '(root)');
      return;
    }
    if (typeof value === 'number') {
      if (phoneLikeNumber(value)) add('phone', path || '(root)');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([k, v], i) => {
        const keyKinds = kindsIn(k);
        // A key that holds anything, or isn't a plain field name (a name could be one), is never
        // written into a path.
        const segment = keyKinds.length === 0 && FIELD_KEY.test(k) ? k : `<key #${i}>`;
        const p = path ? `${path}.${segment}` : segment;
        for (const kind of keyKinds) add(kind, `${p} (key)`);
        walk(v, p, depth + 1);
      });
    }
  };
  walk(pkg, '', 0);
  return findings;
}
