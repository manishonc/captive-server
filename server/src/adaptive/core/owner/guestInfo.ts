/**
 * Guest info content (plan §6, Appendix A; PR D): the owner's form, checked before it is
 * saved. Pure — the route and the tests share it.
 *
 * All plain text this round (Wi-Fi password and door code included; they only ever appear
 * in the message itself and on the guest's own info page). Rules:
 *  - check-in/out: `HH:MM` between 06:00 and 22:00 — the engine's own rule, so "10 Uhr" is
 *    refused with a reason instead of silently skipping the checkout messages;
 *  - links: `directBookingUrl` and `menuUrl` http(s); `hostContactUrl` also `tel:` / `mailto:`
 *    (owners often give a phone number); `javascript:` / `data:` never;
 *  - lengths small enough that four languages stay well under the 100 KB request limit.
 */

import { z } from 'zod';
import { LANGS, type Lang } from '../constants';
import { resolveStayTimes, validStayTime } from '../../stays/times';

export const GUEST_INFO_TEXT_FIELDS = {
  wifiName: 100,
  wifiPassword: 100,
  doorCode: 100,
  keyInstructions: 1000,
  // Room for what owners type ("10 Uhr", "ab 15.00 Uhr"): the time rule below refuses it with
  // its own reason (GI02, 422) — a cap of 5 would answer a bare 400 "too long" first.
  checkInTime: 20,
  checkOutTime: 20,
  houseRules: 1500,
  trashRules: 1000,
  parking: 1000,
  hostContactUrl: 500,
  emergencyNumbers: 500,
  menuUrl: 500,
  openingHours: 500,
  localTips: 1500,
  directBookingUrl: 500,
  extraNotes: 1000,
} as const;

export type GuestInfoField = keyof typeof GUEST_INFO_TEXT_FIELDS;
export const GUEST_INFO_FIELD_NAMES = Object.keys(GUEST_INFO_TEXT_FIELDS) as GuestInfoField[];
/** Shown only on the guest's own info page, inside its time window (D-D7). */
export const GUEST_INFO_SECRET_FIELDS: GuestInfoField[] = ['wifiPassword', 'doorCode', 'keyInstructions'];

export type GuestInfoLocale = Partial<Record<GuestInfoField, string>>;

const localeShape: Record<string, z.ZodTypeAny> = {};
for (const f of GUEST_INFO_FIELD_NAMES) localeShape[f] = z.string().max(GUEST_INFO_TEXT_FIELDS[f]).nullable().optional();
/** One language of the form; an unknown field is refused, so a typo is never stored silently. */
const localeSchema = z.object(localeShape).strict();

export const guestInfoInputSchema = z.object({
  locales: z.record(z.string(), localeSchema.nullable()),
  /** The `version` the form loaded (0 when there was none): 409 if it moved. */
  baseVersion: z.number().int().min(0),
});

export interface GuestInfoIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path: string;
}

function safeLink(value: string, allowContact: boolean): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') return Boolean(u.hostname);
  return allowContact && (u.protocol === 'tel:' || u.protocol === 'mailto:');
}

const LINK_FIELDS: Array<{ field: GuestInfoField; contact: boolean }> = [
  { field: 'directBookingUrl', contact: false },
  { field: 'menuUrl', contact: false },
  { field: 'hostContactUrl', contact: true },
];

/** Trimmed, control characters removed (new lines kept). */
function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

/**
 * Checks the form and merges it into what is saved: a language sent is replaced (empty values
 * dropped), `null` removes that language, a language left out is kept. Errors block the save;
 * warnings don't (e.g. languages with different check-in times — the engine uses English first).
 */
export function mergeGuestInfo(
  existing: Partial<Record<string, GuestInfoLocale | undefined>> | null | undefined,
  input: z.infer<typeof guestInfoInputSchema>,
): { locales: Partial<Record<Lang, GuestInfoLocale>>; issues: GuestInfoIssue[] } {
  const issues: GuestInfoIssue[] = [];
  const locales: Partial<Record<Lang, GuestInfoLocale>> = {};
  for (const [lang, l] of Object.entries(existing ?? {})) {
    if ((LANGS as readonly string[]).includes(lang) && l) locales[lang as Lang] = l;
  }
  for (const [lang, raw] of Object.entries(input.locales)) {
    if (!(LANGS as readonly string[]).includes(lang)) {
      issues.push({ code: 'GI01', severity: 'error', message: `“${lang}” isn't a language we support (en, de, it, fr)`, path: `locales.${lang}` });
      continue;
    }
    if (!raw) {
      delete locales[lang as Lang];
      continue;
    }
    const out: GuestInfoLocale = {};
    for (const f of GUEST_INFO_FIELD_NAMES) {
      const v = raw[f];
      if (typeof v !== 'string') continue;
      const clean = cleanText(v);
      if (clean) out[f] = clean;
    }
    for (const f of ['checkInTime', 'checkOutTime'] as const) {
      if (out[f] !== undefined && !validStayTime(out[f])) {
        issues.push({
          code: 'GI02',
          severity: 'error',
          message: `${f === 'checkInTime' ? 'Check-in' : 'Check-out'} time must look like 15:00 and be between 06:00 and 22:00`,
          path: `locales.${lang}.${f}`,
        });
      }
    }
    for (const { field, contact } of LINK_FIELDS) {
      const v = out[field];
      if (v !== undefined && !safeLink(v, contact)) {
        issues.push({
          code: 'GI03',
          severity: 'error',
          message: contact ? 'The contact link must start with https://, tel: or mailto:' : 'The link must start with https:// (or http://)',
          path: `locales.${lang}.${field}`,
        });
      }
    }
    if (Object.keys(out).length) locales[lang as Lang] = out;
    else delete locales[lang as Lang];
  }
  issues.push(...guestInfoWarnings(locales));
  return { locales, issues };
}

/** What the saved content means for the messages (never blocks a save). */
export function guestInfoWarnings(locales: Partial<Record<string, GuestInfoLocale | undefined>>): GuestInfoIssue[] {
  const issues: GuestInfoIssue[] = [];
  const resolved = resolveStayTimes({ locales: locales as Record<string, Record<string, unknown> | undefined> });
  // Different check-in/out times per language: the engine schedules with the first valid one
  // (English first), and prints that same time in every language (D-C20).
  for (const f of ['checkInTime', 'checkOutTime'] as const) {
    const want = f === 'checkInTime' ? resolved.checkIn : resolved.checkOut;
    const differ = Object.entries(locales).filter(([, l]) => l?.[f] && validStayTime(l[f]) !== want);
    if (want && differ.length) {
      issues.push({
        code: 'GI04',
        severity: 'warning',
        message: `Languages give different ${f === 'checkInTime' ? 'check-in' : 'check-out'} times; guests are told ${want} in every language`,
        path: `locales.${differ[0][0]}.${f}`,
      });
    }
  }
  const any = (f: GuestInfoField) => Object.values(locales).some((l) => Boolean(l?.[f]));
  if (!any('wifiName')) issues.push({ code: 'GI10', severity: 'warning', message: 'No Wi-Fi name: the Wi-Fi card is not sent', path: 'locales.en.wifiName' });
  if (!resolved.checkOut) issues.push({ code: 'GI11', severity: 'warning', message: 'No check-out time: checkout messages are not sent', path: 'locales.en.checkOutTime' });
  if (!any('localTips')) issues.push({ code: 'GI12', severity: 'warning', message: 'No local tips: the Local tips message is not sent', path: 'locales.en.localTips' });
  if (!any('directBookingUrl')) issues.push({ code: 'GI13', severity: 'warning', message: 'No booking link: the Book direct message is not sent', path: 'locales.en.directBookingUrl' });
  return issues;
}
