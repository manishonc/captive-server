/**
 * Local-time maths for the engine: quiet hours, send slots, stay moments.
 *
 * Every time zone is an IANA name (`Europe/Zurich`), never an offset, so a DST
 * change can't shift a send (PRD JB-10). Pure: no Firestore, no clock — callers
 * pass `now`.
 */

import { durationToMinutes } from '../issues';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `date` in `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/** Minutes the zone is ahead of UTC at that instant (CET = 60, CEST = 120). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / MINUTE_MS);
}

/**
 * The instant a wall-clock time in `tz` happens. A time skipped by a DST jump
 * (02:30 on the spring-forward night) lands just after the jump; a repeated one
 * (the autumn night) takes the later occurrence. Engine times are 08:00–21:00,
 * so neither case shows up in practice.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - firstOffset * MINUTE_MS;
  const secondOffset = tzOffsetMinutes(new Date(t), tz);
  if (secondOffset !== firstOffset) t = guess - secondOffset * MINUTE_MS;
  return new Date(t);
}

export function parseHhmm(value: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Bad time "${value}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function minutesOfDay(p: { hour: number; minute: number }): number {
  return p.hour * 60 + p.minute;
}

/** Calendar date `days` after the local date of `date` in `tz` (days may be negative). */
export function addLocalDays(date: Date, tz: string, days: number): { year: number; month: number; day: number } {
  const p = localParts(date, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `HH:MM` on the local day `days` after `date` (0 = the same local day). */
export function atLocalTime(date: Date, tz: string, hhmm: string, days = 0): Date {
  const { year, month, day } = addLocalDays(date, tz, days);
  const { hour, minute } = parseHhmm(hhmm);
  return zonedTime(year, month, day, hour, minute, tz);
}

/** Next `HH:MM` strictly after `date` (today if still ahead, else tomorrow). */
export function nextLocalTime(date: Date, tz: string, hhmm: string): Date {
  const today = atLocalTime(date, tz, hhmm, 0);
  return today.getTime() > date.getTime() ? today : atLocalTime(date, tz, hhmm, 1);
}

/** Is `date` inside a window like 21:00–09:00 (wraps midnight) or 09:00–11:00 in `tz`? */
export function isInWindow(date: Date, tz: string, window: { start: string; end: string }): boolean {
  const now = minutesOfDay(localParts(date, tz));
  const start = minutesOfDay(parseHhmm(window.start));
  const end = minutesOfDay(parseHhmm(window.end));
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * When a quiet window that contains `date` ends ("wait until 09:00"). Only
 * meaningful when `isInWindow(date, tz, window)` is true.
 */
export function windowEnd(date: Date, tz: string, window: { start: string; end: string }): Date {
  return nextLocalTime(date, tz, window.end);
}

/**
 * The next moment inside a daily slot window (e.g. 14:00–17:00):
 *  - before today's window → its start;
 *  - inside it → now;
 *  - after it → tomorrow's start.
 * Returns the window's own bounds too, so a caller can spread sends inside it.
 */
export function nextSlotWindow(date: Date, tz: string, slot: [string, string]): { from: Date; to: Date } {
  const start = atLocalTime(date, tz, slot[0], 0);
  const end = atLocalTime(date, tz, slot[1], 0);
  if (date.getTime() < start.getTime()) return { from: start, to: end };
  if (date.getTime() < end.getTime()) return { from: date, to: end };
  return { from: atLocalTime(date, tz, slot[0], 1), to: atLocalTime(date, tz, slot[1], 1) };
}

export function durationMs(value: string): number {
  const minutes = durationToMinutes(value);
  if (minutes === null) throw new Error(`Bad duration "${value}"`);
  return minutes * MINUTE_MS;
}

/** "+1d" / "-2h" / "+30m" → signed ms. */
export function offsetMs(value: string | undefined): number {
  if (!value) return 0;
  const m = /^([+-])(\d{1,3})(m|h|d)$/.exec(value);
  if (!m) throw new Error(`Bad offset "${value}"`);
  const n = Number(m[2]) * (m[3] === 'm' ? MINUTE_MS : m[3] === 'h' ? HOUR_MS : DAY_MS);
  return m[1] === '-' ? -n : n;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * An ISO string that prints as the right *local* day through `render.ts`'s UTC
 * date filter: noon UTC of the local date (render.ts is shared with the preview
 * and stays unchanged).
 */
export function localDateForRender(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0)).toISOString();
}

/** Deterministic 0…1 from a key, so Replay reproduces the same jitter. */
export function unitFromKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}
