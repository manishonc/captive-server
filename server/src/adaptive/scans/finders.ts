/**
 * Who a scan journey applies to today (PR S). Each finder reads the venue's guests and returns
 * one candidate per guest and occasion; the trigger task (scans/trigger.ts) checks everything
 * again when it runs and starts the journey. No new Firestore index:
 *
 *  - Win-back, Holidays: ContactVenues(venueId ↑, lastVisitAt ↓) — the composite the owner's
 *    guest list already uses;
 *  - Birthday: Contacts(tenantUserId, profile.birthdayMonth) — equality only (merged
 *    single-field indexes), then the guest's ContactVenues doc by id;
 *  - Slow times: the venue's `visit.started` events, JourneyEvents(venueId ↑, type ↑,
 *    occurredAt ↓) — the composite the owner's messages list uses.
 *
 * "Past guests aren't messaged" (S-D1): a guest only counts when their last visit came after
 * the venue's marketing playbook went live (`floorMs`); the trigger also judges it against the
 * launch and Start sending.
 */

import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactVenueDoc } from '../store/engineTypes';
import type { SlotValue } from '../core/schemas';
import { tsMs } from '../store/time';
import { DAY_MS, localParts, zonedTime } from '../core/runtime/time';
import { unitFromKey } from '../core/runtime/time';
import { addDays, holidaysDue, parseHolidayKeys } from '../core/scans/holidays';
import { SLOW_TIME_DEFAULTS, findSlowTimes, inviteTriggerAt, isoWeekKey, type SlowTimeRules } from '../core/scans/dayparts';
import { occasionKey, winbackWindow, type Occasion } from '../core/scans/occasions';
import { venueEventsOfTypesQuery } from '../store/ownerQueries';

export interface ScanCandidate {
  contactId: string;
  occasion: Occasion;
  /** The visit the occasion rests on (S-D1): after the venue started, and it decides test or live. */
  qualifiedAt: number;
  /** When the trigger task runs. */
  dueAt: number;
}

export interface FinderContext {
  venueId: string;
  tenantUserId: string;
  tz: string;
  /** Today, venue-local (YYYY-MM-DD). */
  today: string;
  now: number;
  /** Guests whose last visit is older don't count (the marketing playbook went live then). */
  floorMs: number;
  slots: Record<string, SlotValue>;
  onProgress?: () => Promise<void> | void;
}

const PAGE = 500;
const YEAR_MS = 365 * DAY_MS;
/** Win-back: a scan missed for up to this many days is caught up. */
export const WINBACK_CATCH_UP_DAYS = 2;
/** Holidays: likewise; and the reminders spread over this many mornings. */
export const HOLIDAY_CATCH_UP_DAYS = 2;
export const HOLIDAY_SPREAD_DAYS = 3;
/** Birthday: a guest who tells us their month later in that month gets the gift until this day. */
export const BIRTHDAY_LATE_UNTIL_DAY = 25;

/** A venue's guests whose last visit lies in [fromMs, toMs), newest first (the guest list's composite). */
export function lastVisitRangeQuery(venueId: string, fromMs: number, toMs: number): Query {
  return db
    .collection(COL.contactVenues)
    .where('venueId', '==', venueId)
    .where('lastVisitAt', '>=', new Date(fromMs))
    .where('lastVisitAt', '<', new Date(toMs))
    .orderBy('lastVisitAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');
}

/** An account's guests who told us this birthday month (equality only). */
export function birthdayMonthQuery(tenantUserId: string, month: number): Query {
  return db.collection(COL.contacts).where('tenantUserId', '==', tenantUserId).where('profile.birthdayMonth', '==', month).orderBy(FieldPath.documentId());
}

async function* pages(q: Query, onProgress?: () => Promise<void> | void): AsyncGenerator<QueryDocumentSnapshot[]> {
  let last: QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap = await (last ? q.startAfter(last) : q).limit(PAGE).get();
    if (snap.empty) return;
    yield snap.docs;
    if (onProgress) await onProgress();
    if (snap.size < PAGE) return;
    last = snap.docs[snap.docs.length - 1];
  }
}

const midnight = (date: string, tz: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return zonedTime(y, m, d, 0, 0, tz).getTime();
};

/** A guest who may be messaged at all (no ≤ 2★ rating here; last visit after the start). */
function eligible(cv: ContactVenueDoc, floorMs: number): number | null {
  if (tsMs(cv.lowRatingAt) !== null) return null;
  const last = tsMs(cv.lastVisitAt);
  return last !== null && last >= floorMs ? last : null;
}

// ── Win-back ─────────────────────────────────────────────────────────────────

export async function winbackCandidates(f: FinderContext, journeyKey: string, cfg: { days: number[]; catchUpDays?: number }): Promise<ScanCandidate[]> {
  const out: ScanCandidate[] = [];
  const catchUp = cfg.catchUpDays ?? WINBACK_CATCH_UP_DAYS;
  for (const days of [...cfg.days].sort((a, b) => a - b)) {
    const { fromDate, toDate } = winbackWindow(f.today, days, catchUp);
    const fromMs = Math.max(midnight(fromDate, f.tz), f.floorMs);
    const toMs = midnight(addDays(toDate, 1), f.tz);
    if (fromMs >= toMs) continue;
    for await (const docs of pages(lastVisitRangeQuery(f.venueId, fromMs, toMs), f.onProgress)) {
      for (const doc of docs) {
        const cv = doc.data() as ContactVenueDoc;
        const last = eligible(cv, f.floorMs);
        if (last === null || cv.journeys?.[journeyKey]?.activeInstanceId) continue;
        out.push({ contactId: cv.contactId, occasion: { kind: 'winback', days, lastVisitAt: last }, qualifiedAt: last, dueAt: f.now });
      }
    }
  }
  return out;
}

// ── Birthday ─────────────────────────────────────────────────────────────────

export async function birthdayCandidates(f: FinderContext, cfg: { day?: number; lateUntilDay?: number }): Promise<ScanCandidate[]> {
  const p = localParts(new Date(f.now), f.tz);
  const first = cfg.day ?? 1;
  if (p.day < first || p.day > (cfg.lateUntilDay ?? BIRTHDAY_LATE_UNTIL_DAY)) return [];
  const out: ScanCandidate[] = [];
  const since = Math.max(f.now - YEAR_MS, f.floorMs);
  for await (const docs of pages(birthdayMonthQuery(f.tenantUserId, p.month), f.onProgress)) {
    const cvs = await db.getAll(...docs.map((d) => db.collection(COL.contactVenues).doc(contactVenueId(d.id, f.venueId))));
    for (const snap of cvs) {
      if (!snap.exists) continue; // never visited this venue
      const cv = snap.data() as ContactVenueDoc;
      const last = eligible(cv, since);
      if (last === null) continue;
      out.push({ contactId: cv.contactId, occasion: { kind: 'birthday', year: p.year, month: p.month }, qualifiedAt: last, dueAt: f.now });
    }
  }
  return out;
}

// ── Holidays ─────────────────────────────────────────────────────────────────

export async function holidayCandidates(
  f: FinderContext,
  cfg: { leadDays: number; slot?: string; spreadDays?: number; catchUpDays?: number },
): Promise<ScanCandidate[]> {
  const picks = parseHolidayKeys(f.slots[cfg.slot ?? 'holidays']);
  const due = holidaysDue(f.today, picks, cfg.leadDays, cfg.catchUpDays ?? HOLIDAY_CATCH_UP_DAYS);
  if (!due.length) return [];
  const spread = Math.max(1, cfg.spreadDays ?? HOLIDAY_SPREAD_DAYS);
  const out: ScanCandidate[] = [];
  const since = Math.max(f.now - YEAR_MS, f.floorMs);
  for await (const docs of pages(lastVisitRangeQuery(f.venueId, since, f.now + DAY_MS), f.onProgress)) {
    for (const doc of docs) {
      const cv = doc.data() as ContactVenueDoc;
      const last = eligible(cv, since);
      if (last === null) continue;
      for (const h of due) {
        // Spread over `spread` mornings from lead day on — the same group for every holiday of a
        // guest, so close days (Christmas Eve, Christmas Day) reach them a day apart, in order; a
        // group whose morning has passed (a caught-up scan) goes now.
        const group = Math.floor(unitFromKey(`holidays:${cv.contactId}`) * spread);
        const day = addDays(h.date, -cfg.leadDays + group);
        const [y, m, d] = day.split('-').map(Number);
        const at = zonedTime(y, m, d, 6, 0, f.tz).getTime();
        out.push({ contactId: cv.contactId, occasion: { kind: 'holiday', holidayKey: h.key, date: h.date }, qualifiedAt: last, dueAt: Math.max(at, f.now) });
      }
    }
  }
  return out;
}

// ── Slow times (Mondays) ─────────────────────────────────────────────────────

export async function slowTimeCandidates(
  f: FinderContext,
  cfg: { dayparts: number; lookbackWeeks: number; minWeeks?: number; minVisits?: number; recentDays?: number },
): Promise<{ candidates: ScanCandidate[]; summary: string }> {
  if (localParts(new Date(f.now), f.tz).weekday !== 1) return { candidates: [], summary: 'not Monday' };
  const rules: SlowTimeRules = {
    lookbackWeeks: cfg.lookbackWeeks,
    dayparts: cfg.dayparts,
    minWeeks: cfg.minWeeks ?? SLOW_TIME_DEFAULTS.minWeeks,
    minVisits: cfg.minVisits ?? SLOW_TIME_DEFAULTS.minVisits,
    recentDays: cfg.recentDays ?? SLOW_TIME_DEFAULTS.recentDays,
  };
  const since = new Date(f.now - rules.lookbackWeeks * 7 * DAY_MS);
  const visits: Array<{ contactId: string; startedAt: number }> = [];
  const q = venueEventsOfTypesQuery(f.venueId, ['visit.started'], since).orderBy(FieldPath.documentId(), 'desc');
  for await (const docs of pages(q, f.onProgress)) {
    for (const d of docs) {
      const at = tsMs(d.get('occurredAt'));
      const contactId = d.get('contactId');
      if (at !== null && typeof contactId === 'string') visits.push({ contactId, startedAt: at });
    }
  }
  const result = findSlowTimes(visits, f.now, f.tz, rules);
  if (result.kind === 'not_enough_data') return { candidates: [], summary: `not enough data (${result.weeks} weeks, ${result.visits} visits)` };
  const week = isoWeekKey(f.today);
  const out: ScanCandidate[] = [];
  const ids = [...new Set(result.invites.map((i) => i.contactId))];
  const cvs = new Map<string, ContactVenueDoc>();
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await db.getAll(...ids.slice(i, i + 100).map((id) => db.collection(COL.contactVenues).doc(contactVenueId(id, f.venueId))));
    for (const s of snaps) if (s.exists) cvs.set((s.data() as ContactVenueDoc).contactId, s.data() as ContactVenueDoc);
  }
  for (const invite of result.invites) {
    const cv = cvs.get(invite.contactId);
    if (!cv) continue;
    const last = eligible(cv, f.floorMs);
    if (last === null || f.now - last < rules.recentDays * DAY_MS) continue;
    const at = inviteTriggerAt(invite.target, f.tz);
    if (at < f.now - 60 * 60_000) continue; // its announcement time has passed
    const t = invite.target;
    out.push({ contactId: cv.contactId, occasion: { kind: 'slow', week, weekday: t.weekday, daypart: t.daypart, date: t.date }, qualifiedAt: last, dueAt: Math.max(at, f.now) });
  }
  const targets = result.targets.map((t) => `${t.date} ${t.daypart} (${t.visits})`).join(', ');
  return { candidates: out, summary: `targets ${targets}; ${out.length} invites` };
}

/** The trigger task's dedupe key: one per venue, journey, occasion and guest. */
export function scanTriggerKey(venueId: string, journeyKey: string, c: ScanCandidate): string {
  return `scan_trigger:${venueId}:${journeyKey}:${occasionKey(c.occasion)}:${c.contactId}`;
}
