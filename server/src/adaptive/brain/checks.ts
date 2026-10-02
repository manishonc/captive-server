/**
 * The checks every model answer passes before anything uses it (PR F2a; PRD 04 §9.3 step 5). Pure.
 *
 *  - Only a normal end is read. A refusal, an answer cut off at the token limit (its JSON can
 *    still parse, into something wrong) or no text at all is rejected, never repaired.
 *  - The text must be JSON that matches the job's schema. The structured-output format fixes the
 *    shape, but not enums, ranges or lengths (the SDK moves those into descriptions), so the
 *    job's Zod schema is checked again here.
 *  - Every number the reasoning quotes must be in what the model was given — the package (values
 *    and keys), the prompt or the answer's schema — within one unit of the precision it is quoted
 *    at ("12.46" as "12.5", 37.5 as "37"), and percentages of fractions (0.125 as "12.5 %",
 *    "12,5 %", "12.5 percent", "12,5 Prozent", "12,5 pour cent" alike). Times and dates in the input
 *    are read in parts ("11.30" or "11:30" gives 11, 30 and 11.30, "18:30:45" also 45; "2026-10-17" or
 *    "17.10.2026" gives 2026, 10, 17 and "17.10"): these readings explain a number quoted without "%"
 *    and exactly as read — never a percentage (a date's day or a price's cents is no rate), never a
 *    number next to one ("17.10.2026" explains no "18", "18:30" no "19"; a bare "17.10" is also the
 *    decimal 17.1, which explains "18" like any decimal); a price ("CHF 18.50") is not read
 *    as a time, a pair is a time only up to 24:59 or a date only up to 31.12, and a list of rates
 *    ("5/10/20 %") is no date. "1 234" in the reasoning is one number: when the input doesn't have
 *    it, it is reported as written ("5 000"), never read as 1 and 234; the input's "1 200" and
 *    "1.200" give 1200 too (and 1, 200 or 1.2). A number with a unit after it ("45min", "3.5k", "12pp")
 *    or a currency before it ("CHF1200") is a claim like any other; a number glued to a letter
 *    before it ("GSM-7", "s1", "v2") is a label. Whole numbers up to 10 without "%" are plain
 *    counts ("two wordings", "a 4-digit number"); a job that needs stricter words adds its own
 *    check.
 */

import type { ZodType } from 'zod';

export type AnswerProblem = 'refusal' | 'cut_off' | 'no_text' | 'bad_json' | 'bad_shape' | 'unexpected_stop';

export type Evaluated<T> = { ok: true; value: T } | { ok: false; problem: AnswerProblem; detail: string };

export interface CheckResult {
  code: string;
  ok: boolean;
  /** Plain words for the run log (never a guest's data: the package has none). */
  detail: string;
}

/** A normal end → JSON → the job's schema. */
export function evaluateAnswer<T>(reply: { stopReason: string | null; text: string }, schema: ZodType<T>): Evaluated<T> {
  if (reply.stopReason === 'refusal') return { ok: false, problem: 'refusal', detail: 'The model declined to answer' };
  if (reply.stopReason === 'max_tokens' || reply.stopReason === 'model_context_window_exceeded') {
    return { ok: false, problem: 'cut_off', detail: `The answer was cut off (${reply.stopReason})` };
  }
  if (reply.stopReason !== 'end_turn') return { ok: false, problem: 'unexpected_stop', detail: `The answer stopped with ${String(reply.stopReason)}` };
  const text = reply.text.trim();
  if (!text) return { ok: false, problem: 'no_text', detail: 'The answer had no text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'bad_json', detail: 'The answer is not JSON' };
  }
  const res = schema.safeParse(parsed);
  if (!res.success) {
    const issues = res.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, problem: 'bad_shape', detail: `The answer doesn't match the schema — ${issues.join('; ')}` };
  }
  return { ok: true, value: res.data };
}

export interface QuotedNumber {
  raw: string;
  value: number;
  decimals: number;
  percent: boolean;
}

// A number that isn't glued to a letter, digit, "_" or "." before it, or to "letter-" ("GSM-7"),
// nor to a digit or "_" after it; a unit after it ("45min") is fine, and so is a sentence's "."
// Never starting right after "digit," (inside a number it would read again — and on a long run of
// "1,1,1…" that would take quadratic time).
const NUMBER = /(?<![\p{L}\p{N}_.])(?<!\p{L}-)(?<!\p{N}[,’'])\d+(?:[.,’']\d+)*(?:\s?(?:%|percent\b|per\s?cent\b|pct\b|prozent\b|pour\s?cent\b|per\s?cento\b))?(?![\p{N}_]|[.,’']\p{N})/giu;
const THOUSANDS = /^[1-9]\d{0,2}(?:[,’']\d{3})+(?:\.\d+)?$/;
// German thousands with a decimal comma ("1.000,5").
const THOUSANDS_DE = /^[1-9]\d{0,2}(?:\.\d{3})+,\d+$/;
const DECIMAL_COMMA = /^(?:0,\d+|\d+,\d{1,2})$/;
const PERCENT_TAIL = /\s?(?:%|percent|per\s?cent|pct|prozent|pour\s?cent|per\s?cento)$/i;
// "CHF1200", "Fr.30": a currency before a number is not a label.
const CURRENCY_BEFORE = /\b(CHF|EUR|USD|GBP|Fr\.?|SFr\.?)(?=\d)/g;

/** The numbers a text quotes ("1,234", "12.5 %", "0.4", "45min"; an ISO time's hour too). */
export function quotedNumbers(text: string): QuotedNumber[] {
  const out: QuotedNumber[] = [];
  const plain = String(text).replace(CURRENCY_BEFORE, '$1 ').replace(/(\d)T(\d)/g, '$1 $2');
  for (const m of plain.match(NUMBER) ?? []) {
    const percent = PERCENT_TAIL.test(m);
    const body = m.replace(PERCENT_TAIL, '');
    const parts = THOUSANDS.test(body)
      ? [body.replace(/[,’']/g, '')]
      : THOUSANDS_DE.test(body)
        ? [body.replace(/\./g, '').replace(',', '.')]
        : DECIMAL_COMMA.test(body)
          ? [body.replace(',', '.')]
          : body.split(/[,’']/);
    for (const part of parts) {
      if (!/^\d+(?:\.\d+)?$/.test(part)) {
        // "1.2.3" and the like: each piece on its own.
        for (const piece of part.split('.').filter(Boolean)) out.push({ raw: piece, value: Number(piece), decimals: 0, percent });
        continue;
      }
      const decimals = part.includes('.') ? part.split('.')[1].length : 0;
      out.push({ raw: `${part}${percent ? '%' : ''}`, value: Number(part), decimals, percent });
    }
  }
  return out;
}

// Dates and times in the input: taken out before its numbers are read, and read in parts instead.
// A year first ("2026-10-17", "2026-10-17T18:30:00Z"), a day first ("17.10.2026", "17.10.26",
// "17-10-2026", "17/10/2026"; not a list of rates, "5/10/20 %": a "%" after a 2-digit last part, not
// a URL escape other than "%25" — "17.10.2026 %" and "…17.10.26%2018:00" are dates), a month first
// ("10/17/2026"), a time ("18:30", "18:30:45": the seconds too).
const DATE_YMD = /(?<![\d.])((?:19|20)\d{2})([-./])(0?[1-9]|1[0-2])\2(0?[1-9]|[12]\d|3[01])(?:[T ]([01]?\d|2[0-4]):([0-5]\d)(?::([0-5]\d(?:\.\d{1,9})?))?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d]|[.,]\d)/g;
const DATE_DMY = /(?<![\d.])(0?[1-9]|[12]\d|3[01])([./-])(0?[1-9]|1[0-2])\2((?:19|20)\d{2}|\d{2})(?![\d]|[.,/-]\d|(?<=[./-]\d{2})\s?(?:%(?!(?!25)\d[\dA-F])|percent\b|per\s?cent\b|pct\b|prozent\b|pour\s?cent\b|per\s?cento\b))/gi;
const DATE_MDY = /(?<![\d./])(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})(?![\d]|[.,/]\d)/g;
const CLOCK = /(?<![\d.:])([01]?\d|2[0-4]):([0-5]\d)(?::([0-5]\d))?(?![\d]|[.:]\d)/g;
// "11.30", "31.10.": a time (up to 24:59) or a day and month (up to 31.12) — never a price ("CHF 18.50";
// not "Fr.", which is also Friday: "Mo–Fr. 11.30").
const PAIR = /(?<![\d.:])(?<!(?:CHF|EUR|USD|GBP|SFr\.?|€|\$|£)\s?)(\d{1,2})\.(\d{2})(?!\d|[.,]\d|\s?(?:CHF|EUR|€))/gi;
const SPACED = /(?<![\d.,’'])\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?!\d|[.,]\d)/g;
// "1.200" in the input: also 1200 (German and Italian thousands); not glued to a letter ("v2.100" is
// a label), but after a currency ("CHF1.200", "Fr.1.200").
const DOTTED = /(?<![\p{L}\d.,’'])[1-9]\d{0,2}(?:\.\d{3})+(?!\d|[.,]\d)/gu;

/** A day and month as they are quoted: "17.10", "1.5" and "1.05". */
const dayMonth = (d: string, m: string) => [Number(`${Number(d)}.${Number(m)}`), Number(`${Number(d)}.${m.padStart(2, '0')}`)];

/** A text's numbers (`values`) and its dates and times read in parts (`readings`). */
function readText(text: string, values: Set<number>, readings: Set<number>): void {
  const add = (...xs: number[]) => { for (const x of xs) if (Number.isFinite(x)) readings.add(x); };
  const time = (h?: string, mm?: string, ss?: string) => {
    if (h !== undefined && mm !== undefined) add(Number(h), Number(mm), Number(`${Number(h)}.${mm}`));
    if (ss !== undefined) add(Number(ss), Math.trunc(Number(ss)));
  };
  const rest = String(text)
    .replace(DATE_YMD, (_, y: string, _s: string, m: string, d: string, h?: string, mm?: string, ss?: string) => { add(Number(y), Number(m), Number(d), ...dayMonth(d, m)); time(h, mm, ss); return ' '; })
    .replace(DATE_DMY, (_, d: string, _s: string, m: string, y: string) => { add(Number(d), Number(m), Number(y), ...dayMonth(d, m)); return ' '; })
    .replace(DATE_MDY, (_, m: string, d: string, y: string) => { add(Number(d), Number(m), Number(y), ...dayMonth(d, m), ...dayMonth(m, d)); return ' '; })
    .replace(CLOCK, (_, h: string, mm: string, ss?: string) => { time(h, mm, ss); return ' '; });
  for (const q of quotedNumbers(rest)) values.add(q.value);
  // Grouped thousands ("1 200", "1.200") also as the one number the reasoning reads them as.
  for (const m of rest.matchAll(SPACED)) values.add(Number(m[0].replace(/\D/g, '')));
  for (const m of rest.replace(CURRENCY_BEFORE, '$1 ').matchAll(DOTTED)) values.add(Number(m[0].replace(/\./g, '')));
  for (const m of rest.matchAll(PAIR)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a <= 24 && b <= 59) time(m[1], m[2]);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) add(a, b, ...dayMonth(m[1], m[2]));
  }
}

/** Every number the model was given: `values` explain any quote; `readings` (dates and times in parts) only the same number without "%". */
export interface GivenNumbers {
  values: number[];
  readings: number[];
}

/** Every number the model was given: numeric leaves, and the numbers inside strings, keys and the prompt. */
export function givenNumbers(pkg: unknown, promptTexts: string[] = []): GivenNumbers {
  const values = new Set<number>();
  const readings = new Set<number>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 40) return;
    if (typeof v === 'number' && Number.isFinite(v)) values.add(v);
    else if (typeof v === 'string') readText(v, values, readings);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        readText(k, values, readings);
        walk(x, depth + 1);
      }
    }
  };
  walk(pkg, 0);
  for (const t of promptTexts) readText(t, values, readings);
  return { values: [...values], readings: [...readings] };
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Sorted absolute values, searched around a number (the nearest decide: "close" only shrinks with distance). */
function sortedAbs(xs: ReadonlyArray<number>): Float64Array {
  return Float64Array.from(xs, Math.abs).sort();
}
function anyNear(sorted: Float64Array, target: number, ok: (x: number) => boolean): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i < Math.min(sorted.length, lo + 2); i++) if (ok(sorted[i])) return true;
  return false;
}

/** The quoted numbers the input explains (see the file header), each checked once. */
function explainer(given: GivenNumbers | ReadonlyArray<number>): (q: QuotedNumber) => boolean {
  const values = sortedAbs(Array.isArray(given) ? given : (given as GivenNumbers).values);
  const fractions = values.filter((x) => x <= 1);
  const readings = sortedAbs(Array.isArray(given) ? [] : (given as GivenNumbers).readings);
  const memo = new Map<string, boolean>();
  return (q) => {
    if (!q.percent && q.decimals === 0 && q.value <= 10) return true;
    const key = `${q.percent ? '%' : ''}${q.value}/${q.decimals}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const d = Math.min(q.decimals, 4);
    // Rounded up, down or cut: anything closer than one unit of the quoted precision.
    const close = (x: number) => roundTo(x, d) === q.value || Math.abs(x - q.value) < 10 ** -d - 1e-9;
    const ok =
      anyNear(values, q.value, close) ||
      // "12.5 %" for a fraction 0.125 (only fractions: 12.5 % of a count means nothing).
      (q.percent && anyNear(fractions, q.value / 100, (x) => close(x * 100))) ||
      // A date's or a time's parts explain "on the 17th" or "at 11:30" as they are: never "17 %",
      // never "18" (a count one above the day, or the hour after "18:30").
      (!q.percent && anyNear(readings, q.value, (x) => x === q.value));
    memo.set(key, ok);
    return ok;
  };
}

/** The numbers the reasoning quotes that the model wasn't given (at most 10, as written). */
export function unexplainedNumbers(reasoning: string, given: GivenNumbers | ReadonlyArray<number>): string[] {
  const explained = explainer(given);
  const out: string[] = [];
  const seen = new Set<string>();
  const report = (raw: string) => {
    if (!seen.has(raw) && out.length < 10) out.push(raw);
    seen.add(raw);
  };
  // "1 234" is one number: explained, or reported as written ("5 000" is never 5 and 0).
  const joined = reasoning.replace(SPACED, (m) => {
    if (!explained({ raw: m, value: Number(m.replace(/\D/g, '')), decimals: 0, percent: false })) report(m);
    return ' ';
  });
  for (const q of quotedNumbers(joined)) {
    if (out.length >= 10) break;
    if (seen.has(q.raw)) continue;
    if (!explained(q)) report(q.raw);
    seen.add(q.raw);
  }
  return out;
}

/** The generic "numbers in the reasoning" check as a run-log line. */
export function numbersCheck(reasoning: string, pkg: unknown, promptTexts: string[]): CheckResult {
  const extra = unexplainedNumbers(reasoning, givenNumbers(pkg, promptTexts));
  return extra.length
    ? { code: 'numbers_in_input', ok: false, detail: `The reasoning quotes numbers it wasn't given: ${extra.join(', ')}` }
    : { code: 'numbers_in_input', ok: true, detail: 'Every number in the reasoning is in the input' };
}
