/**
 * Scan journeys (PR S): Win-back, Birthday, Holidays and the Slow-time filler start from a daily
 * scan of each venue, not from a Wi-Fi event. The scan finds the guests one occasion applies to
 * ("last visit 30 days ago", "birthday month", "Christmas Eve in 7 days", "slow Tuesday
 * afternoon"); each becomes a `scan.due` event that starts the journey.
 *
 *  - The occasion key is the journey's entry key, so a guest gets each occasion once
 *    (win-back stages 30 / 60 / 90 never collide; one birthday gift a year; one invite a week).
 *  - The occasion's values go onto the instance as vars at entry (`winbackDays`, `holidayKey`,
 *    `slowDaypart`, …): branches read `instance.vars.*`, wording reads the merge fields
 *    `holiday.name`, `holiday.day`, `slow.when`.
 *  - v1 of the four seeded templates were placeholders ("coming soon"): they never run, only
 *    the versions from `SCAN_MIN_TEMPLATE_VERSION` on do.
 *
 * Pure.
 */

import type { Lang } from '../constants';
import { pickLang } from '../schemas';
import { addDays } from './holidays';
import { holidayDef } from './holidays';
import { slowWhenText, type Daypart } from './dayparts';

export const SCAN_EVENT = 'scan.due';

export const SCAN_TRIGGER_TYPES = ['days_since_visit', 'date_field', 'calendar.holiday', 'computed.slow_daypart'] as const;
export type ScanTriggerType = (typeof SCAN_TRIGGER_TYPES)[number];

export function isScanTrigger(type: string): type is ScanTriggerType {
  return (SCAN_TRIGGER_TYPES as readonly string[]).includes(type);
}

/** The seeded scan journeys whose v1 was a placeholder: only these versions and later run. */
export const SCAN_MIN_TEMPLATE_VERSION: Readonly<Record<string, number>> = {
  win_back: 2,
  birthday: 2,
  quiet_hours_filler: 2,
  holidays: 2,
};

/** Can this pinned version of a scan journey run? (Journeys authored later have no floor.) */
export function scanJourneyRunnable(journeyKey: string, templateVersion: number): boolean {
  return templateVersion >= (SCAN_MIN_TEMPLATE_VERSION[journeyKey] ?? 1);
}

export type Occasion =
  | { kind: 'winback'; days: number; lastVisitAt: number }
  | { kind: 'birthday'; year: number; month: number }
  | { kind: 'holiday'; holidayKey: string; date: string }
  | { kind: 'slow'; week: string; weekday: number; daypart: Daypart; date: string };

/** The trigger type each occasion kind belongs to. */
export const OCCASION_TRIGGER: Record<Occasion['kind'], ScanTriggerType> = {
  winback: 'days_since_visit',
  birthday: 'date_field',
  holiday: 'calendar.holiday',
  slow: 'computed.slow_daypart',
};

/** The entry key (and task / event id part): one start per guest and occasion. */
export function occasionKey(o: Occasion): string {
  switch (o.kind) {
    case 'winback':
      return `winback:${o.days}:${o.lastVisitAt}`;
    case 'birthday':
      return `birthday:${o.year}`;
    case 'holiday':
      return `holiday:${o.holidayKey}:${o.date.slice(0, 4)}`;
    case 'slow':
      return `slow:${o.week}`;
  }
}

/** What the journey knows about its occasion (instance vars at entry). */
export function occasionVars(o: Occasion): Record<string, unknown> {
  switch (o.kind) {
    case 'winback':
      return { occasionKind: 'winback', winbackDays: o.days, lastVisitAt: o.lastVisitAt };
    case 'birthday':
      return { occasionKind: 'birthday', birthdayMonth: o.month, birthdayYear: o.year };
    case 'holiday':
      return { occasionKind: 'holiday', holidayKey: o.holidayKey, holidayDate: o.date };
    case 'slow':
      return { occasionKind: 'slow', slowWeekday: o.weekday, slowDaypart: o.daypart, slowDate: o.date };
  }
}

/**
 * Win-back stage window: guests whose last visit's venue-local date lies `days` days before
 * today — or up to `catchUpDays` more (a scan missed while the worker was down).
 */
export function winbackWindow(today: string, days: number, catchUpDays: number): { fromDate: string; toDate: string } {
  return { fromDate: addDays(today, -days - catchUpDays), toDate: addDays(today, -days) };
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** "Saturday 14 February" / "Samstag, 14. Februar" for a YYYY-MM-DD date. */
export function dayText(date: string, lang: Lang): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (lang === 'de') return `${WEEKDAYS_DE[weekday]}, ${d}. ${MONTHS_DE[m - 1]}`;
  return `${WEEKDAYS_EN[weekday]} ${d} ${MONTHS_EN[m - 1]}`;
}

/** The occasion merge fields a wording can use, from the instance vars (missing → not set). */
export function occasionMergeValues(vars: Record<string, unknown>, lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof vars.holidayKey === 'string') {
    const def = holidayDef(vars.holidayKey);
    if (def) out['holiday.name'] = pickLang(def.name, lang);
    if (typeof vars.holidayDate === 'string') out['holiday.day'] = dayText(vars.holidayDate, lang);
  }
  if (typeof vars.slowWeekday === 'number' && typeof vars.slowDaypart === 'string') {
    out['slow.when'] = slowWhenText(vars.slowWeekday, vars.slowDaypart as Daypart, lang);
  }
  return out;
}

/** Sample values for previews ("See what guests get"). */
export function sampleOccasionValues(lang: Lang): Record<string, string> {
  return occasionMergeValues({ holidayKey: 'christmas_eve', holidayDate: '2026-12-24', slowWeekday: 2, slowDaypart: 'afternoon' }, lang);
}
