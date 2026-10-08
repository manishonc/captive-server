/**
 * The holiday calendar for the Holidays journey (PR S, decision S-D3): the 8 days a
 * restaurant in Switzerland books tables for. Dates are computed per year, so the list
 * never runs out (Easter and the Sundays move every year).
 *
 *  - Valentine's Day 14 Feb, Swiss National Day 1 Aug, Christmas Eve / Day 24–25 Dec,
 *    New Year's Eve 31 Dec;
 *  - Easter Sunday (Gregorian computus), Mother's Day (2nd Sunday of May in Switzerland),
 *    Father's Day (1st Sunday of June in Switzerland).
 *
 * The owner ticks which ones (a `holidays` blank — a comma-separated list of keys). One
 * region for now (`ch`): every venue is Swiss. Pure: no clock, no Firestore.
 */

import type { I18n } from '../schemas';

export interface HolidayDef {
  key: string;
  name: I18n;
  /** The date in `year` as YYYY-MM-DD. */
  dateIn(year: number): string;
}

export interface Holiday {
  key: string;
  name: I18n;
  date: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** Easter Sunday (Anonymous Gregorian algorithm). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The `n`th Sunday (1-based) of a month. */
function nthSunday(year: number, month: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday
  const firstSunday = 1 + ((7 - firstWeekday) % 7);
  return firstSunday + (n - 1) * 7;
}

const fixed = (month: number, day: number) => (year: number) => ymd(year, month, day);

export const HOLIDAYS_CH: HolidayDef[] = [
  { key: 'valentines', name: { en: "Valentine's Day", de: 'Valentinstag', fr: 'la Saint-Valentin', it: 'San Valentino' }, dateIn: fixed(2, 14) },
  {
    key: 'easter',
    name: { en: 'Easter', de: 'Ostern', fr: 'Pâques', it: 'Pasqua' },
    dateIn: (year) => {
      const e = easterSunday(year);
      return ymd(year, e.month, e.day);
    },
  },
  { key: 'mothers_day', name: { en: "Mother's Day", de: 'Muttertag', fr: 'la fête des mères', it: 'la Festa della mamma' }, dateIn: (year) => ymd(year, 5, nthSunday(year, 5, 2)) },
  { key: 'fathers_day', name: { en: "Father's Day", de: 'Vatertag', fr: 'la fête des pères', it: 'la Festa del papà' }, dateIn: (year) => ymd(year, 6, nthSunday(year, 6, 1)) },
  { key: 'national_day', name: { en: 'Swiss National Day', de: 'Nationalfeiertag', fr: 'la fête nationale', it: 'la Festa nazionale' }, dateIn: fixed(8, 1) },
  { key: 'christmas_eve', name: { en: 'Christmas Eve', de: 'Heiligabend', fr: 'le réveillon de Noël', it: 'la Vigilia di Natale' }, dateIn: fixed(12, 24) },
  { key: 'christmas', name: { en: 'Christmas Day', de: 'Weihnachten', fr: 'Noël', it: 'Natale' }, dateIn: fixed(12, 25) },
  { key: 'new_years_eve', name: { en: "New Year's Eve", de: 'Silvester', fr: 'la Saint-Sylvestre', it: 'San Silvestro' }, dateIn: fixed(12, 31) },
];

export const HOLIDAY_KEYS: readonly string[] = HOLIDAYS_CH.map((h) => h.key);

/** Ticked by default (S-D3). */
export const DEFAULT_HOLIDAY_KEYS = ['valentines', 'mothers_day', 'christmas_eve', 'new_years_eve'] as const;
export const DEFAULT_HOLIDAYS_VALUE = DEFAULT_HOLIDAY_KEYS.join(',');

export function holidayDef(key: string): HolidayDef | undefined {
  return HOLIDAYS_CH.find((h) => h.key === key);
}

/**
 * The keys in a `holidays` blank value, in calendar-list order, unknown ones dropped.
 * The value is a comma-separated list ("valentines,christmas_eve"); anything else is empty.
 */
export function parseHolidayKeys(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const picked = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  return HOLIDAY_KEYS.filter((k) => picked.has(k));
}

/** Keys in a value that aren't on the calendar (for the blank's check). */
export function unknownHolidayKeys(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !HOLIDAY_KEYS.includes(s));
}

/** Days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** YYYY-MM-DD `days` after a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * The picked holidays whose reminder is due on `today` (venue-local YYYY-MM-DD): the holiday
 * is between `leadDays − catchUpDays` and `leadDays` days away. A scan missed for a day or two
 * still finds it; the trigger keys (holiday + year) keep it to one reminder per guest.
 */
export function holidaysDue(today: string, picked: string[], leadDays: number, catchUpDays: number): Holiday[] {
  const year = Number(today.slice(0, 4));
  const out: Holiday[] = [];
  for (const key of picked) {
    const def = holidayDef(key);
    if (!def) continue;
    for (const y of [year, year + 1]) {
      const date = def.dateIn(y);
      const away = daysBetween(today, date);
      if (away <= leadDays && away >= leadDays - catchUpDays) out.push({ key, name: def.name, date });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Every calendar holiday of `year`, in date order (for the owner's picker and docs). */
export function holidaysOf(year: number): Holiday[] {
  return HOLIDAYS_CH.map((h) => ({ key: h.key, name: h.name, date: h.dateIn(year) })).sort((a, b) => a.date.localeCompare(b.date));
}
