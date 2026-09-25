/**
 * A small iCal (RFC 5545) reader for booking calendars — pure: no Firestore, no
 * network, no clock (plan §3.3, brief §1).
 *
 * What it keeps of a feed: per booking `{ uid, checkIn, checkOut, nights }` (local
 * `YYYY-MM-DD` dates, checkout exclusive) and the kind of feed. Never the SUMMARY or
 * DESCRIPTION text, guest names or the phone's last 4 digits (D-C28, D-C32).
 *
 * Which events are stays (D-C4):
 *  - Airbnb: a reservation (`SUMMARY:Reserved`, or a "Reservation URL" in DESCRIPTION);
 *    "Airbnb (Not available)" blocks are ignored.
 *  - Booking.com: none — it marks bookings and closures alike `CLOSED - Not available`,
 *    so it can't be split into stays (the sync calls such a feed unsupported).
 *  - Anything else (VRBO, PMS): only events whose SUMMARY starts with "Reserved"
 *    (VRBO sends `Reserved - <name>`); every other event is ignored.
 *
 * Skipped: `STATUS:CANCELLED`, recurring events, events without a UID (never given a
 * made-up one: it would change with the dates and cancel the linked stay), events that
 * end on or before their start, and events longer than 90 nights.
 *
 * Parsing rules that break naive readers: lines are unfolded on BYTES (a fold may split
 * a UTF-8 character), names are case-insensitive, parameter values may be quoted (a
 * colon inside quotes is not the separator), only a VEVENT's own properties count (not
 * its VALARM's), and DATE values stay strings (`new Date('YYYY-MM-DD')` is UTC midnight).
 */

import { contentChecksum } from '../core/checksum';
import { MINUTE_MS, isValidTimeZone, localDateKey, zonedTime } from '../core/runtime/time';

export type FeedSource = 'airbnb' | 'booking' | 'generic';

export interface ParsedStay {
  uid: string;
  /** Venue-local dates; checkout is exclusive (the day the guest leaves). */
  checkIn: string;
  checkOut: string;
  nights: number;
}

export interface IcalCounts {
  /** VEVENTs read. */
  events: number;
  stays: number;
  /** Events that are not stays (blocks, closures, anything that isn't a reservation). */
  ignored: number;
  skippedRecurring: number;
  /** No UID, unreadable dates, or an end on/before the start. */
  skippedInvalid: number;
  /** Longer than MAX_NIGHTS. */
  skippedLong: number;
  /** `STATUS:CANCELLED`. */
  cancelled: number;
  duplicateUid: number;
  /** Past the event cap. */
  overCap: number;
}

export interface IcalParse {
  source: FeedSource;
  /** Sorted by check-in, then uid. */
  stays: ParsedStay[];
  counts: IcalCounts;
  /** Any event's SUMMARY starts with "Reserved" (whatever became of the event). */
  hasReservedEvent: boolean;
}

export class IcalParseError extends Error {
  constructor(public readonly code: 'NOT_ICAL' | 'TRUNCATED') {
    super(code);
    this.name = 'IcalParseError';
  }
}

export const MAX_NIGHTS = 90;
export const MAX_EVENTS = 5000;

const RESERVED = /^reserved\b/i;
const AIRBNB_RESERVATION = /reservation url|\/hosting\/reservations\/details\//i;
const NOT_AVAILABLE = /not available/i;
const BOOKING_CLOSED = /^closed\s*-\s*not available$/i;

/** The body starts like a calendar (after a BOM and whitespace). */
export function looksLikeIcal(body: Buffer | string): boolean {
  const text = (typeof body === 'string' ? body : body.subarray(0, 64).toString('latin1')).replace(/^﻿|^\xEF\xBB\xBF/, '');
  return /^\s*BEGIN:VCALENDAR/i.test(text);
}

/** Unfold on bytes, then decode: a fold between the two bytes of "ü" must give back "ü". */
function unfold(input: Buffer | string): string {
  let buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  const joined = buf.toString('latin1').replace(/(\r\n|\n|\r)[ \t]/g, '');
  return Buffer.from(joined, 'latin1').toString('utf8');
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** `NAME;P=V;P="a:b":VALUE` — split at the first colon outside quotes. */
function parseLine(line: string): ContentLine | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ';' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { name, params, value };
}

/** TEXT unescaping (RFC 5545 §3.3.11); unknown escapes are kept. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

interface RawEvent {
  props: Map<string, ContentLine>;
  recurring: boolean;
}

// ── Dates ────────────────────────────────────────────────────────────────────

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function dateKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` + n calendar days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from `a` to `b` (`YYYY-MM-DD`). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

type ParsedTime = { kind: 'date'; date: string } | { kind: 'instant'; ms: number } | null;

/**
 * DATE → the date as it is (a listing's local date). DATE-TIME: UTC (`Z`) or with a
 * TZID (a valid IANA name; anything else, e.g. a Windows zone name, is read as the
 * venue's zone) → an instant; floating → the venue's wall-clock time.
 */
function parseTime(line: ContentLine | undefined, venueTz: string): ParsedTime {
  if (!line) return null;
  const v = line.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? { kind: 'date', date: dateKey(y, mo, d) } : null;
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || s > 60) return null;
  if (m[7]) return { kind: 'instant', ms: Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59)) };
  const tzid = line.params.TZID;
  const tz = tzid && isValidTimeZone(tzid) ? tzid : venueTz;
  return { kind: 'instant', ms: zonedTime(y, mo, d, h, mi, tz).getTime() };
}

/** `P3D`, `P1W`, `PT36H`, `P1DT2H` → ms; null for anything else or a negative duration. */
export function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m || m[1] === '-') return null;
  if (!m.slice(2).some((x) => x !== undefined)) return null;
  const [w, d, h, mi, s] = m.slice(2).map((x) => Number(x ?? 0));
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

function toDate(t: { kind: 'date'; date: string } | { kind: 'instant'; ms: number }, venueTz: string): string {
  return t.kind === 'date' ? t.date : localDateKey(new Date(t.ms), venueTz);
}

/** The event's local check-in and checkout dates, or null when they can't be read. */
function eventDates(ev: RawEvent, venueTz: string): { checkIn: string; checkOut: string } | null {
  const start = parseTime(ev.props.get('DTSTART'), venueTz);
  if (!start) return null;
  const endLine = ev.props.get('DTEND');
  let end: ParsedTime = null;
  if (endLine) {
    end = parseTime(endLine, venueTz);
    if (!end) return null;
  } else {
    const durLine = ev.props.get('DURATION');
    const dur = durLine ? parseDuration(durLine.value) : null;
    if (durLine && dur === null) return null;
    if (dur !== null) {
      end = start.kind === 'date' ? { kind: 'date', date: addDays(start.date, Math.floor(dur / (24 * 60 * MINUTE_MS))) } : { kind: 'instant', ms: start.ms + dur };
    } else if (start.kind === 'date') {
      end = { kind: 'date', date: addDays(start.date, 1) }; // an all-day event with no end is one day
    } else {
      end = start; // a DATE-TIME with no end has no length
    }
  }
  return { checkIn: toDate(start, venueTz), checkOut: toDate(end, venueTz) };
}

// ── The reader ───────────────────────────────────────────────────────────────

function readEvents(input: Buffer | string): { prodid: string; events: RawEvent[]; overCap: number } {
  const text = unfold(input);
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new IcalParseError('NOT_ICAL');
  const stack: string[] = [];
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  let prodid = '';
  let closed = false;
  let overCap = 0;

  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      const comp = line.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') {
        if (events.length >= MAX_EVENTS) {
          overCap += 1;
          current = null;
        } else {
          current = { props: new Map(), recurring: false };
          events.push(current);
        }
      }
      continue;
    }
    if (line.name === 'END') {
      const comp = line.value.trim().toUpperCase();
      const at = stack.lastIndexOf(comp);
      if (at >= 0) stack.length = at; // tolerant of a missing END in between
      if (comp === 'VEVENT') current = null;
      if (comp === 'VCALENDAR' && at === 0) closed = true;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR' && stack.length === 1 && line.name === 'PRODID' && !prodid) prodid = line.value;
    if (top === 'VEVENT' && current) {
      // Only the event's own properties (a VALARM inside has its own DESCRIPTION).
      if (line.name === 'RRULE' || line.name === 'RDATE' || line.name === 'RECURRENCE-ID') current.recurring = true;
      if (!current.props.has(line.name)) current.props.set(line.name, line);
    }
  }
  // A cut-off download must not read as "these bookings are gone".
  if (!closed) throw new IcalParseError('TRUNCATED');
  return { prodid, events, overCap };
}

function textOf(ev: RawEvent, name: string): string {
  const line = ev.props.get(name);
  return line ? unescapeText(line.value).trim() : '';
}

function sourceOf(prodid: string, events: RawEvent[]): FeedSource {
  const p = prodid.toLowerCase();
  if (p.includes('airbnb')) return 'airbnb';
  if (p.includes('booking.com')) return 'booking';
  const uids = events.map((e) => textOf(e, 'UID').toLowerCase());
  if (uids.some((u) => u.endsWith('@airbnb.com')) || events.some((e) => AIRBNB_RESERVATION.test(textOf(e, 'DESCRIPTION')) && /airbnb\./i.test(textOf(e, 'DESCRIPTION')))) {
    return 'airbnb';
  }
  if (uids.some((u) => u.endsWith('@booking.com'))) return 'booking';
  // Booking.com's own marker — unless the feed also has reservations (a PMS feed mixing in
  // Booking.com closures): then its "Reserved" events are still stays.
  const summaries = events.map((e) => textOf(e, 'SUMMARY'));
  if (summaries.some((s) => BOOKING_CLOSED.test(s)) && !summaries.some((s) => RESERVED.test(s))) return 'booking';
  return 'generic';
}

function isStay(source: FeedSource, ev: RawEvent): boolean {
  const summary = textOf(ev, 'SUMMARY');
  if (source === 'booking') return false;
  if (source === 'airbnb') {
    if (NOT_AVAILABLE.test(summary)) return false;
    return RESERVED.test(summary) || AIRBNB_RESERVATION.test(textOf(ev, 'DESCRIPTION'));
  }
  return RESERVED.test(summary);
}

/**
 * Reads a calendar. Throws `IcalParseError` when the body isn't a calendar or was cut
 * off; everything else (odd events) is skipped and counted, never fatal.
 */
export function parseIcal(input: Buffer | string, venueTz: string): IcalParse {
  const { prodid, events, overCap } = readEvents(input);
  const source = sourceOf(prodid, events);
  const counts: IcalCounts = { events: events.length, stays: 0, ignored: 0, skippedRecurring: 0, skippedInvalid: 0, skippedLong: 0, cancelled: 0, duplicateUid: 0, overCap };
  const byUid = new Map<string, ParsedStay>();
  let hasReservedEvent = false;

  for (const ev of events) {
    if (RESERVED.test(textOf(ev, 'SUMMARY'))) hasReservedEvent = true;
    if (textOf(ev, 'STATUS').toUpperCase() === 'CANCELLED') {
      counts.cancelled += 1;
      continue;
    }
    if (ev.recurring) {
      counts.skippedRecurring += 1;
      continue;
    }
    const uid = textOf(ev, 'UID');
    const dates = eventDates(ev, venueTz);
    if (!uid || !dates) {
      counts.skippedInvalid += 1;
      continue;
    }
    const nights = daysBetween(dates.checkIn, dates.checkOut);
    if (nights <= 0) {
      counts.skippedInvalid += 1;
      continue;
    }
    if (nights > MAX_NIGHTS) {
      counts.skippedLong += 1;
      continue;
    }
    if (!isStay(source, ev)) {
      counts.ignored += 1;
      continue;
    }
    const prev = byUid.get(uid);
    if (prev) {
      counts.duplicateUid += 1;
      // Never seen in a real Airbnb export: keep the first. Other feeds: one booking
      // split in pieces becomes one stay (earliest start, latest end).
      if (source !== 'airbnb') {
        const checkIn = dates.checkIn < prev.checkIn ? dates.checkIn : prev.checkIn;
        const checkOut = dates.checkOut > prev.checkOut ? dates.checkOut : prev.checkOut;
        const merged = daysBetween(checkIn, checkOut);
        if (merged <= MAX_NIGHTS) byUid.set(uid, { uid, checkIn, checkOut, nights: merged });
      }
      continue;
    }
    byUid.set(uid, { uid, checkIn: dates.checkIn, checkOut: dates.checkOut, nights });
  }

  const stays = [...byUid.values()].sort((a, b) => (a.checkIn === b.checkIn ? (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0) : a.checkIn < b.checkIn ? -1 : 1));
  counts.stays = stays.length;
  return { source, stays, counts, hasReservedEvent };
}

/**
 * A feed PR C can't read stays from (D-C4): Booking.com, or a feed of another kind that
 * has events but no "Reserved" one and has never given a stay (`reservedSeen`). An empty
 * feed, or an Airbnb feed with only blocks, is a normal feed with no stays.
 */
export function isUnsupported(parse: Pick<IcalParse, 'source' | 'counts' | 'hasReservedEvent'>, reservedSeen: boolean): boolean {
  if (parse.source === 'booking') return true;
  return parse.source === 'generic' && parse.counts.events > 0 && !parse.hasReservedEvent && !reservedSeen;
}

/** Hash of the normalized stays — the raw body changes on every fetch (DTSTAMP). */
export function staysHash(stays: ParsedStay[]): string {
  return contentChecksum(stays.map((s) => [s.uid, s.checkIn, s.checkOut]));
}
