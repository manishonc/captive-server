/**
 * Stay times, moments and the poll grid — pure (no Firestore, no clock).
 *
 * Check-in / checkout times are venue-level (D-C20): the first valid `HH:MM` between
 * 06:00 and 22:00 in Guest info, `locales.en` first, then the other languages in
 * alphabetical order. A time near midnight is not valid: the stay guide's fixed-day
 * `wait_until` offsets (+2d, −1d) would land on the wrong local day across a DST change.
 * Scheduling falls back to 15:00 / 10:00; the wording never prints that fallback.
 *
 * Moments come from local dates (`atLocalTime`), never "timestamp + n × 24 h".
 */

import { HOUR_MS, atLocalTime, unitFromKey, zonedTime } from '../core/runtime/time';
import { daysBetween } from './ical';

export const DEFAULT_CHECK_IN = '15:00';
export const DEFAULT_CHECK_OUT = '10:00';

/** A stay journey's moment runs up to this late (D-C14); later it is skipped. */
export const MOMENT_GRACE_MS = 12 * HOUR_MS;
/** A booking missing from the feed counts one miss at most this often (engine clock). */
export const MISS_SPACING_MS = 30 * 60_000;
/** Missing this many times in a row → cancelled. */
export const MISSES_TO_CANCEL = 2;
/** The suspect-parse guard lifts after this long (D-C35). */
export const SUSPECT_GUARD_MS = 24 * HOUR_MS;
/** Errors in a row before a feed shows as failing (D-C25). */
export const FAILING_AFTER_ERRORS = 3;
/** How often each feed is read. */
export const POLL_EVERY_MS = 4 * HOUR_MS;

/** `HH:MM`, 06:00–22:00. */
export function validStayTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 6 * 60 && minutes <= 22 * 60 ? `${m[1]}:${m[2]}` : null;
}

export interface StayTimes {
  /** The resolved venue-level times, or null when no language has a valid one. */
  checkIn: string | null;
  checkOut: string | null;
}

/** D-C20: `locales.en` first, then the other languages alphabetically; each field on its own. */
export function resolveStayTimes(guestInfo: { locales?: Record<string, Record<string, unknown> | undefined> } | null | undefined): StayTimes {
  const locales = guestInfo?.locales ?? {};
  const order = [...(locales.en ? ['en'] : []), ...Object.keys(locales).filter((l) => l !== 'en').sort()];
  const first = (field: 'checkInTime' | 'checkOutTime') => {
    for (const lang of order) {
      const v = validStayTime(locales[lang]?.[field]);
      if (v) return v;
    }
    return null;
  };
  return { checkIn: first('checkInTime'), checkOut: first('checkOutTime') };
}

export interface StayInstants {
  checkInAt: number;
  checkOutAt: number;
  nights: number;
}

function at(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return zonedTime(y, m, d, h, mi, tz).getTime();
}

/** The stay's check-in / checkout instants in the venue's zone (DST-safe). */
export function stayInstants(checkIn: string, checkOut: string, tz: string, times: StayTimes): StayInstants {
  return {
    checkInAt: at(checkIn, times.checkIn ?? DEFAULT_CHECK_IN, tz),
    checkOutAt: at(checkOut, times.checkOut ?? DEFAULT_CHECK_OUT, tz),
    nights: daysBetween(checkIn, checkOut),
  };
}

/** A `stay.window` moment: `at` on the local day `offsetDays` after the anchor's local day. */
export function momentFor(anchorMs: number, tz: string, hhmm: string, offsetDays: number): number {
  return atLocalTime(new Date(anchorMs), tz, hhmm, offsetDays).getTime();
}

export type MomentPlan = { kind: 'later'; at: number } | { kind: 'now' } | { kind: 'too_late' };

/** In the future → a task then; up to 12 h past → now; more → skipped (D-C14). */
export function planMoment(momentAt: number, now: number): MomentPlan {
  if (momentAt > now) return { kind: 'later', at: momentAt };
  if (now - momentAt <= MOMENT_GRACE_MS) return { kind: 'now' };
  return { kind: 'too_late' };
}

export function stayTriggerKey(stayId: string, journeyKey: string, datesVersion: number, momentAt: number): string {
  return `stay_trigger:${stayId}:${journeyKey}:${datesVersion}:${momentAt}`;
}

// ── The poll grid ────────────────────────────────────────────────────────────

/** Each feed's fixed offset inside the 4 h cycle, so feeds don't all poll at once. */
export function pollOffsetMs(feedId: string): number {
  return Math.floor(unitFromKey(`stay_poll:${feedId}`) * (POLL_EVERY_MS / 60_000)) * 60_000;
}

/**
 * The next grid slot strictly after `t`: every restart (a save, Sync now, the watchdog,
 * the chain's own re-arm) lands on the same slot, so one chain absorbs them all.
 */
export function nextPollSlot(feedId: string, t: number): { slot: number; dueAt: number; key: string } {
  const off = pollOffsetMs(feedId);
  const slot = Math.floor((t - off) / POLL_EVERY_MS) + 1;
  return { slot, dueAt: off + slot * POLL_EVERY_MS, key: `stay_poll:${feedId}:${slot}` };
}

/** Sync now: its own key per minute, so clicks in the same minute share one task. */
export function syncNowKey(feedId: string, t: number): string {
  return `stay_sync:${feedId}:${Math.floor(t / 60_000)}`;
}
