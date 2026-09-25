/**
 * What one calendar sync decides for each booking — pure, so the rules are tested
 * without Firestore (brief §2 "Sync algorithm", D-C8, D-C9, D-C31, D-C35). The sync
 * (stays/sync.ts) runs each decision again inside the transaction that writes it, on
 * the Stay as it is then.
 *
 *  - Only successful parses count. Unchanged content (a 304, or the same normalized
 *    stays) is that content again: no upserts, but the miss pass still runs.
 *  - A booking absent from a parse counts one miss, at most once per 30 minutes on the
 *    engine clock; two misses → cancelled. Never once checkout day has come (frozen).
 *  - Two or more countable bookings absent at once is suspect (a link to another listing,
 *    a cut or reformatted file): no miss for up to 24 h (bookings still in it are seen and
 *    their misses reset — that can't cancel anything). A single one always
 *    follows the plain rule, so a host's only booking can still be cancelled.
 */

import type { ContactVenueDoc } from '../store/engineTypes';
import { tsMs } from '../store/time';
import { HOUR_MS, MINUTE_MS } from '../core/runtime/time';
import { addDays } from './ical';
import { MISSES_TO_CANCEL, MISS_SPACING_MS, SUSPECT_GUARD_MS, type StayInstants } from './times';

export type StayStatus = 'confirmed' | 'cancelled' | 'overlap_flagged';

/** A Stay as the sync and the rules see it (times in epoch ms). */
export interface StaySnap {
  id: string;
  status: StayStatus;
  checkIn: string;
  checkOut: string;
  checkInAt: number;
  checkOutAt: number;
  nights: number;
  datesVersion: number;
  missingCount: number;
  lastMissAt: number | null;
  contactId: string | null;
  linkedAt: number | null;
  linkMode: 'test' | 'live' | null;
  overlapWith: string[];
  lastSeenInFeedAt: number | null;
}

/** Known, not cancelled and before checkout day: the stays a parse can count as missing. */
export function isCountable(s: Pick<StaySnap, 'status' | 'checkOut'>, today: string): boolean {
  return s.status !== 'cancelled' && today < s.checkOut;
}

/**
 * The feed keeps syncing while the account is off only for a stay a guest is linked to
 * and that isn't over (checkout + 3 days covers "book direct"), so a running stay guide
 * still hears about date changes and cancellations.
 */
export function isCurrentLinked(s: Pick<StaySnap, 'status' | 'checkOut' | 'contactId'>, today: string): boolean {
  return s.status !== 'cancelled' && Boolean(s.contactId) && addDays(s.checkOut, 3) >= today;
}

export type UpsertDecision =
  | { kind: 'create' }
  | { kind: 'reinstate' }
  | { kind: 'change' }
  | { kind: 'reset' }
  | { kind: 'seen' }
  | { kind: 'none' };

const SEEN_REFRESH_MS = 24 * 60 * 60_000;

/**
 * A booking in the parsed content against its Stay (null: new).
 *  - new → create, unless it is already over;
 *  - cancelled and back → confirmed again (D-C9), a new dates version even with the same dates;
 *  - other dates or times → changed;
 *  - the same → reset its misses (unless `resetMisses` is off; the sync always passes it on).
 */
export function decideUpsert(
  existing: StaySnap | null,
  parsed: { checkIn: string; checkOut: string },
  instants: StayInstants,
  ctx: { today: string; now: number; resetMisses: boolean },
): UpsertDecision {
  if (!existing) return parsed.checkOut >= ctx.today ? { kind: 'create' } : { kind: 'none' };
  if (existing.status === 'cancelled') return parsed.checkOut >= ctx.today ? { kind: 'reinstate' } : { kind: 'none' };
  if (datesDiffer(existing, parsed, instants)) return { kind: 'change' };
  if (ctx.resetMisses && (existing.missingCount > 0 || existing.lastMissAt !== null)) return { kind: 'reset' };
  if (existing.lastSeenInFeedAt === null || ctx.now - existing.lastSeenInFeedAt >= SEEN_REFRESH_MS) return { kind: 'seen' };
  return { kind: 'none' };
}

export function datesDiffer(s: Pick<StaySnap, 'checkIn' | 'checkOut' | 'checkInAt' | 'checkOutAt'>, parsed: { checkIn: string; checkOut: string }, instants: StayInstants): boolean {
  return s.checkIn !== parsed.checkIn || s.checkOut !== parsed.checkOut || s.checkInAt !== instants.checkInAt || s.checkOutAt !== instants.checkOutAt;
}

export type MissDecision = { kind: 'none'; why: 'frozen' | 'cancelled' | 'too_soon' } | { kind: 'miss'; count: number } | { kind: 'cancel'; count: number };

/** One more miss for a booking absent from this parse (never within 30 min of the last, never once checkout day has come). */
export function decideMiss(s: StaySnap, ctx: { today: string; now: number }): MissDecision {
  if (s.status === 'cancelled') return { kind: 'none', why: 'cancelled' };
  if (ctx.today >= s.checkOut) return { kind: 'none', why: 'frozen' };
  if (s.lastMissAt !== null && ctx.now - s.lastMissAt < MISS_SPACING_MS) return { kind: 'none', why: 'too_soon' };
  const count = s.missingCount + 1;
  return count >= MISSES_TO_CANCEL ? { kind: 'cancel', count } : { kind: 'miss', count };
}

export interface SuspectState {
  /** This parse counts no miss (the bookings in it are still seen: their misses reset). */
  suspect: boolean;
  warning: 'mass_missing' | null;
  suspectSince: number | null;
  /** A new warning (one HeidiFi alert per feed and `suspectSince`). */
  raise: boolean;
}

/** D-C35: 2+ countable bookings absent at once → hold misses for up to 24 h of such parses. */
export function suspectState(absentCount: number, previousSince: number | null, now: number): SuspectState {
  if (absentCount < 2) return { suspect: false, warning: null, suspectSince: null, raise: false };
  const since = previousSince ?? now;
  return { suspect: now - since < SUSPECT_GUARD_MS, warning: 'mass_missing', suspectSince: since, raise: previousSince === null };
}

/** Half-open date ranges [checkIn, checkOut): back-to-back is not an overlap. */
export function rangesOverlap(a: { checkIn: string; checkOut: string }, b: { checkIn: string; checkOut: string }): boolean {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut;
}

/**
 * Which stays overlap another (among the not-cancelled ones not over before today).
 * Returns, per stay id, the ids it overlaps (empty = not overlapping).
 */
export function overlapMap(stays: StaySnap[], today: string): Map<string, string[]> {
  const live = stays.filter((s) => s.status !== 'cancelled' && s.checkOut >= today);
  const out = new Map<string, string[]>();
  for (const s of live) out.set(s.id, []);
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      if (rangesOverlap(live[i], live[j])) {
        out.get(live[i].id)!.push(live[j].id);
        out.get(live[j].id)!.push(live[i].id);
      }
    }
  }
  for (const v of out.values()) v.sort();
  return out;
}

/** Facts for `branch` / `entry.when`: `stay.nights`, `stay.checkIn`, … (numbers stay numbers). */
export function stayFacts(stay: Pick<StaySnap, 'nights' | 'checkIn' | 'checkOut' | 'status' | 'checkInAt' | 'checkOutAt'>) {
  return { stay: { nights: stay.nights, checkIn: stay.checkIn, checkOut: stay.checkOut, checkInAt: stay.checkInAt, checkOutAt: stay.checkOutAt, status: stay.status } };
}

// ── Past guests (stays/moments.ts) ───────────────────────────────────────────

/**
 * "Past guests aren't messaged": a guest who checked out before an install went live
 * (a stay playbook turned on for the first time after they left, say) gets none of its
 * moments — whatever the moment's own time. `liveSince` null means "no filter", as in
 * enrolment: a hold that must stop everyone can't be expressed as null.
 */
export function checkedOutBeforeLive(stay: Pick<StaySnap, 'checkOutAt'>, liveSince: number | null): boolean {
  return liveSince !== null && stay.checkOutAt <= liveSince;
}

// ── The checkout overlap rule (stays/moments.ts) ─────────────────────────────

/** How late after its moment the worker may reach Stay guide's checkout step (its wake's lag). */
export const COVER_MARGIN_MS = 15 * MINUTE_MS;

/**
 * Does a Stay guide switched off (or paused) at `offSinceAt` still send its checkout message
 * for a moment at `momentAt`? The gate lets it through while its send time — the moment plus
 * the worker's lag — is inside the freeze window. Leans towards "no" near the edge, so the
 * Checkout reminder then goes (both messages at worst). Not airtight: a Stay guide checkout
 * message held past the freeze — a worker more than 15 min late, or quiet hours in the
 * guest's phone zone deferring it — can still leave neither (docs, "Known limits").
 */
export function guideStillSends(momentAt: number, offSinceAt: number | null, freezeMs: number): boolean {
  return offSinceAt !== null && momentAt + COVER_MARGIN_MS <= offSinceAt + freezeMs;
}

// ── Linking a guest to a stay (stays/link.ts) ─────────────────────────────────

/** The link window opens this long before check-in (plan §3.3 item 4). */
export const LINK_BEFORE_CHECK_IN_MS = 12 * HOUR_MS;

export interface Candidate {
  stay: StaySnap;
  /** When its window opens (the previous stays' latest checkout on a turnover day). */
  opensAt: number;
  /**
   * The back-to-back stays before it: every stay not cancelled that checks out the day it
   * checks in — two when a double booking ends that day (overlap_flagged ones included).
   */
  previous: StaySnap[];
}

/** The stays not cancelled that check out on the day `s` checks in. */
function previousStays(stays: StaySnap[], s: StaySnap): StaySnap[] {
  return stays.filter((p) => p.id !== s.id && p.status !== 'cancelled' && p.checkOut === s.checkIn);
}

/**
 * On its checkout day, `s` is the outgoing stay of a turnover (another stay not cancelled
 * checks in that day): not linked any more that day. Otherwise the next guest — or a
 * cleaner — who connects before the checkout time would be taken for this stay's guest and
 * get its review ask and book-direct offer. `today` is the venue-local date of the connect.
 */
export function outgoingOnTurnoverDay(stays: StaySnap[], s: Pick<StaySnap, 'id' | 'checkOut'>, today: string): boolean {
  return today >= s.checkOut && stays.some((n) => n.id !== s.id && n.status !== 'cancelled' && n.checkIn === s.checkOut);
}

/**
 * Never linked: not `confirmed`, already linked, missing from the calendar's last content,
 * or missed by an earlier poll and not seen since (`missingCount > 0`) — from checkout day on
 * a stay leaves the missing list (absence is no signal then, D-C31), but a booking that
 * vanished the evening before is still on its way out.
 */
export function linkable(s: Pick<StaySnap, 'id' | 'status' | 'contactId' | 'missingCount'>, missing: ReadonlySet<string>): boolean {
  return s.status === 'confirmed' && !s.contactId && !missing.has(s.id) && !(s.missingCount > 0);
}

/** When `s`'s link window opens: at the previous stays' latest checkout on a turnover day, else 12 h before check-in. */
export function windowOpensAt(s: Pick<StaySnap, 'checkInAt'>, previous: Array<Pick<StaySnap, 'checkOutAt'>>): number {
  return previous.length ? Math.max(...previous.map((p) => p.checkOutAt)) : s.checkInAt - LINK_BEFORE_CHECK_IN_MS;
}

/**
 * The stays whose window contains `at` (pure; the candidates come from `linkCandidatesQuery`).
 * `missing` is the feed's `lastMissingStayIds`: a booking absent from the calendar's last
 * content (the old half of a cancel-and-rebook, one held by the suspect-parse guard) is on
 * its way out and is never linked — it still counts as a previous stay on a turnover day.
 * `today` (the venue-local date of `at`) applies the turnover-day rule for the outgoing stay
 * (`outgoingOnTurnoverDay`); the link always passes it.
 */
export function windowCandidates(stays: StaySnap[], at: number, missing: ReadonlySet<string> = new Set(), today?: string): Candidate[] {
  const out: Candidate[] = [];
  for (const s of stays) {
    if (!linkable(s, missing)) continue;
    if (today !== undefined && outgoingOnTurnoverDay(stays, s, today)) continue;
    const previous = previousStays(stays, s);
    const opensAt = windowOpensAt(s, previous);
    if (opensAt <= at && at < s.checkOutAt) out.push({ stay: s, opensAt, previous });
  }
  // An in-progress stay first, then the earliest.
  return out.sort((a, b) => {
    const ai = a.stay.checkInAt <= at ? 0 : 1;
    const bi = b.stay.checkInAt <= at ? 0 : 1;
    return ai - bi || a.stay.checkInAt - b.stay.checkInAt;
  });
}

/** Seen at the venue during any of the previous stays. */
export function seenDuringAny(cv: Partial<ContactVenueDoc> | null, previous: StaySnap[]): boolean {
  return previous.some((p) => seenDuring(cv, p));
}

/** Seen at the venue during the previous stay (first visit, or a visit start or end inside it). */
export function seenDuring(cv: Partial<ContactVenueDoc> | null, previous: StaySnap): boolean {
  if (!cv) return false;
  const from = previous.checkInAt - LINK_BEFORE_CHECK_IN_MS;
  return [cv.firstVisitAt, cv.lastVisitAt, cv.lastVisitEndedAt].some((t) => {
    const ms = tsMs(t);
    return ms !== null && ms >= from && ms < previous.checkOutAt;
  });
}
