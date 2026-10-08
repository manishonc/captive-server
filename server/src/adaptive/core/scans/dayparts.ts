/**
 * Slow times (PR S, decision S-D4 — the "Slow-time filler", formerly "Quiet-hours filler").
 *
 * Every Monday the scan looks at the venue's last 8 weeks of visits (when each started, venue
 * time) by weekday × daypart:
 *
 *   morning 06–11 · lunch 11–14 · afternoon 14–17 · evening 17–21 · late 21–24
 *
 * (visits between midnight and 06:00 aren't counted). A weekday × daypart is "open" when it had
 * visits in at least half of the observed weeks (4 of 8) — a time with nobody most weeks is
 * taken to be closed, not quiet (opening hours aren't known). With at least 4 weeks of data and
 * 40 visits, the 2 open times with the fewest visits are this week's targets. Guests who came in
 * that daypart before (any weekday) — and not in the last 3 days — get one invite for the coming
 * occurrence; a guest is invited for at most one target a week.
 *
 * Pure: the caller passes the visits and `now`.
 */

import type { Lang } from '../constants';
import { DAY_MS, localParts, zonedTime } from '../runtime/time';
import { addDays, daysBetween } from './holidays';

export const DAYPARTS = ['morning', 'lunch', 'afternoon', 'evening', 'late'] as const;
export type Daypart = (typeof DAYPARTS)[number];

/** [from, to) local hours. */
export const DAYPART_HOURS: Record<Daypart, [number, number]> = {
  morning: [6, 11],
  lunch: [11, 14],
  afternoon: [14, 17],
  evening: [17, 21],
  late: [21, 24],
};

export function daypartOfHour(hour: number): Daypart | null {
  for (const d of DAYPARTS) {
    const [from, to] = DAYPART_HOURS[d];
    if (hour >= from && hour < to) return d;
  }
  return null;
}

export interface SlowTimeRules {
  lookbackWeeks: number;
  /** Targets a week. */
  dayparts: number;
  minWeeks: number;
  minVisits: number;
  /** Guests seen this recently aren't invited (they were just here). */
  recentDays: number;
}

export const SLOW_TIME_DEFAULTS: SlowTimeRules = { lookbackWeeks: 8, dayparts: 2, minWeeks: 4, minVisits: 40, recentDays: 3 };

export interface VisitRow {
  contactId: string;
  startedAt: number;
}

export interface SlowTarget {
  /** 0 = Sunday … 6 = Saturday (like Date#getDay). */
  weekday: number;
  daypart: Daypart;
  /** The coming occurrence, venue-local YYYY-MM-DD. */
  date: string;
  /** Visits in this time over the observed weeks. */
  visits: number;
}

export type SlowTimeResult =
  | { kind: 'not_enough_data'; weeks: number; visits: number }
  | { kind: 'targets'; weeks: number; visits: number; targets: SlowTarget[]; invites: Array<{ contactId: string; target: SlowTarget }> };

const ymd = (p: { year: number; month: number; day: number }) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

/** Monday 1 … Sunday 7 order, so a week's dates run Monday → Sunday. */
function isoDow(weekday: number): number {
  return weekday === 0 ? 7 : weekday;
}

/**
 * Finds this week's slow times and who to invite. `now` is the scan time (a Monday); dates
 * of the coming occurrences are today … Sunday. A morning target today can't be announced the
 * evening before, so morning targets on the scan day are passed over.
 */
export function findSlowTimes(visits: VisitRow[], now: number, tz: string, rules: SlowTimeRules = SLOW_TIME_DEFAULTS, lastVisitAt: Map<string, number> = new Map()): SlowTimeResult {
  const today = localParts(new Date(now), tz);
  const todayKey = ymd(today);
  const since = now - rules.lookbackWeeks * 7 * DAY_MS;
  const inWindow = visits.filter((v) => v.startedAt >= since && v.startedAt < now);
  const total = inWindow.length;
  const first = inWindow.reduce((m, v) => Math.min(m, v.startedAt), Number.POSITIVE_INFINITY);
  // Whole weeks of data (3½ weeks is 3, not 4).
  const weeks = Number.isFinite(first) ? Math.min(rules.lookbackWeeks, Math.floor((now - first) / (7 * DAY_MS))) : 0;
  if (weeks < rules.minWeeks || total < rules.minVisits) return { kind: 'not_enough_data', weeks, visits: total };

  // Per weekday × daypart: visit count and the set of weeks it had visits in.
  const counts = new Map<string, { visits: number; weeks: Set<number> }>();
  const byDaypart = new Map<Daypart, Set<string>>();
  for (const v of inWindow) {
    const p = localParts(new Date(v.startedAt), tz);
    const dp = daypartOfHour(p.hour);
    if (!dp) continue;
    const key = `${p.weekday}:${dp}`;
    const week = Math.floor(daysBetween(ymd(p), todayKey) / 7);
    const c = counts.get(key) ?? { visits: 0, weeks: new Set<number>() };
    c.visits += 1;
    c.weeks.add(week);
    counts.set(key, c);
    const set = byDaypart.get(dp) ?? new Set<string>();
    set.add(v.contactId);
    byDaypart.set(dp, set);
  }
  const openWeeks = Math.ceil(weeks / 2);
  const candidates: SlowTarget[] = [];
  for (const [key, c] of counts) {
    if (c.weeks.size < openWeeks) continue; // closed (or an exception), not slow
    const [weekdayStr, dp] = key.split(':') as [string, Daypart];
    const weekday = Number(weekdayStr);
    const ahead = (isoDow(weekday) - isoDow(today.weekday) + 7) % 7;
    if (ahead === 0 && dp === 'morning') continue; // can't be announced the evening before any more
    candidates.push({ weekday, daypart: dp, date: addDays(todayKey, ahead), visits: c.visits });
  }
  // Fewest visits first; ties: earlier in the week, then earlier in the day.
  candidates.sort((a, b) => a.visits - b.visits || a.date.localeCompare(b.date) || DAYPARTS.indexOf(a.daypart) - DAYPARTS.indexOf(b.daypart));
  const targets = candidates.slice(0, rules.dayparts);

  const lastSeen = new Map<string, number>();
  for (const v of inWindow) lastSeen.set(v.contactId, Math.max(lastSeen.get(v.contactId) ?? 0, v.startedAt));
  const invites: Array<{ contactId: string; target: SlowTarget }> = [];
  const invited = new Set<string>();
  const recentFrom = now - rules.recentDays * DAY_MS;
  for (const target of targets) {
    const guests = [...(byDaypart.get(target.daypart) ?? [])].sort();
    for (const contactId of guests) {
      if (invited.has(contactId)) continue;
      const last = Math.max(lastVisitAt.get(contactId) ?? 0, lastSeen.get(contactId) ?? 0);
      if (last >= recentFrom) continue;
      invited.add(contactId);
      invites.push({ contactId, target });
    }
  }
  return { kind: 'targets', weeks, visits: total, targets, invites };
}

/** When the invite's trigger runs: the target day 07:00, or the evening before (16:00) for a morning target. */
export function inviteTriggerAt(target: SlowTarget, tz: string): number {
  const [y, m, d] = target.date.split('-').map(Number);
  if (target.daypart === 'morning') {
    const prev = addDays(target.date, -1).split('-').map(Number);
    return zonedTime(prev[0], prev[1], prev[2], 16, 0, tz).getTime();
  }
  return zonedTime(y, m, d, 7, 0, tz).getTime();
}

/** ISO week key of a local date, e.g. 2026-W42 (the slow-time entry key: one invite a week). */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAYPART_EN: Record<Daypart, (day: string) => string> = {
  morning: (d) => `this ${d} morning`,
  lunch: (d) => `this ${d} at lunchtime`,
  afternoon: (d) => `this ${d} afternoon`,
  evening: (d) => `this ${d} evening`,
  late: (d) => `late this ${d} evening`,
};
const DAYPART_DE: Record<Daypart, (day: string) => string> = {
  morning: (d) => `diesen ${d}morgen`,
  lunch: (d) => `diesen ${d}mittag`,
  afternoon: (d) => `diesen ${d}nachmittag`,
  evening: (d) => `diesen ${d}abend`,
  late: (d) => `diesen ${d} spätabends`,
};

/** "this Tuesday afternoon" / "diesen Dienstagnachmittag" (other languages read the English). */
export function slowWhenText(weekday: number, daypart: Daypart, lang: Lang): string {
  if (lang === 'de') return DAYPART_DE[daypart](WEEKDAY_DE[weekday] ?? WEEKDAY_DE[0]);
  return DAYPART_EN[daypart](WEEKDAY_EN[weekday] ?? WEEKDAY_EN[0]);
}

export function isDaypart(value: unknown): value is Daypart {
  return typeof value === 'string' && (DAYPARTS as readonly string[]).includes(value);
}
