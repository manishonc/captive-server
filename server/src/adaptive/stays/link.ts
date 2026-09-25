/**
 * Who is the stay's guest? (plan §3.3 item 4, brief §3) The calendar has no email or
 * phone, so the first guest who connects to the venue's Wi-Fi in the stay's window is
 * linked to it — the others in the group get the Wi-Fi card, not the stay messages.
 *
 * Runs in the worker's connect handling (engine/route.ts) on every fresh connect, after
 * the existing gates: an install, a mode that isn't off, an address, the sign-up breaker
 * not tripped, a connect not handled late.
 *
 *  - Window: 12 h before check-in until checkout. On a turnover day (the previous stay
 *    checks out the day this one checks in) it opens at the previous stay's checkout, and
 *    nobody seen at the venue during the previous stay is linked: that party's companions
 *    were never linked and their phones reconnect, and its guest may stay late (D-C11).
 *  - Never a second stay for a guest already linked to one here that isn't over; an
 *    in-progress stay is preferred. Known limit: a guest with two back-to-back bookings
 *    is linked only to the first.
 *  - Only `confirmed` stays link (not overlapping or cancelled ones), and never one missing
 *    from the calendar's last content (the feed's `lastMissingStayIds`: the old half of a
 *    cancel-and-rebook is on its way out) or missed by a poll and not seen since
 *    (`missingCount > 0`: on checkout day it has left the missing list). First guest wins —
 *    one transaction on the Stay (and the feed's missing list); `linkMode` is frozen there (D-C13).
 *  - The outgoing stay of a turnover isn't linked on its checkout day: an early next guest
 *    (or a cleaner) would otherwise be taken for its guest.
 *  - Follow-up: the stay's moments, then `stay.linked` as the "done" mark. A link whose
 *    follow-up crashed is finished by the retried task or the guest's next connect.
 */

import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactVenueDoc, StayDoc } from '../store/engineTypes';
import { eventIdFor } from '../core/runtime/ids';
import { DAY_MS, localDateKey } from '../core/runtime/time';
import type { EngineEvent, RunMode } from '../core/runtime/types';
import type { EngineSettings } from '../store/engineSettings';
import { appendEvent, eventRef } from '../engine/events';
import { loadVenueContext, type VenueContext } from '../engine/context';
import { deliverEvent } from '../engine/advance';
import { contactStaysQuery, linkCandidatesQuery, loadStay, stayInstancesQuery, stayRef, toStay, venueFeedRef } from './store';
import { linkable, outgoingOnTurnoverDay, seenDuringAny, windowCandidates, windowOpensAt } from './plan';
import { scheduleStayMoments } from './moments';

export interface LinkArgs {
  ctx: VenueContext;
  contactId: string;
  guestId: string | null;
  /** When the guest connected (engine clock). */
  at: number;
  mode: RunMode;
  now: number;
}

/** Links the connecting guest to a stay, or finishes a link that is theirs. Returns the stay id linked now, if any. */
export async function linkStayOnConnect(a: LinkArgs): Promise<string | null> {
  const { ctx } = a;
  if (ctx.venueType !== 'airbnb') return null; // feeds exist only for Airbnb venues (D-C7)
  const today = localDateKey(new Date(a.at), ctx.tz);

  // Already linked here to a stay that isn't over: never a second one — but make sure its follow-up was done.
  const mine = (await contactStaysQuery(ctx.venueId, a.contactId).get()).docs.map((d) => toStay(d.id, d.data() as StayDoc));
  const current = mine.filter((s) => s.status !== 'cancelled' && s.checkOut >= today);
  if (current.length) {
    for (const s of current) await completeLink(s.id, ctx, a.now);
    return null;
  }

  const stays = (await linkCandidatesQuery(ctx.venueId, new Date(a.at - DAY_MS)).get()).docs.map((d) => toStay(d.id, d.data() as StayDoc));
  if (!stays.length) return null;
  const missingOf = (ids: unknown) => new Set(Array.isArray(ids) ? (ids as string[]) : []);
  const candidates = windowCandidates(stays, a.at, missingOf((await venueFeedRef(ctx.venueId).get()).get('lastMissingStayIds')), today);
  if (!candidates.length) return null;
  let cv: Partial<ContactVenueDoc> | null | undefined;
  for (const c of candidates) {
    if (c.previous.length) {
      if (cv === undefined) cv = ((await db.collection(COL.contactVenues).doc(contactVenueId(a.contactId, ctx.venueId)).get()).data() ?? null) as Partial<ContactVenueDoc> | null;
      if (seenDuringAny(cv, c.previous)) continue;
    }
    const linked = await db.runTransaction(async (tx) => {
      const [snap, feedSnap] = await Promise.all([tx.get(stayRef(c.stay.id)), tx.get(venueFeedRef(ctx.venueId))]);
      if (!snap.exists) return false;
      const s = toStay(snap.id, snap.data() as StayDoc);
      // First guest wins; the dates may have moved, or a poll found it missing, since the query.
      if (!linkable(s, missingOf(feedSnap.get('lastMissingStayIds'))) || outgoingOnTurnoverDay(stays, s, today)) return false;
      const opensAt = windowOpensAt(s, c.previous);
      if (!(opensAt <= a.at && a.at < s.checkOutAt)) return false;
      tx.update(stayRef(s.id), { contactId: a.contactId, linkedAt: new Date(a.at), linkedGuestId: a.guestId, linkMode: a.mode, updatedAt: new Date() });
      return true;
    });
    if (linked) {
      await completeLink(c.stay.id, ctx, a.now);
      return c.stay.id;
    }
  }
  return null;
}

/**
 * The link's follow-up: the stay's moments, then `stay.linked` — the mark that it's done,
 * so a link whose follow-up crashed (e.g. a failed schedule) is finished next time.
 */
export async function completeLink(stayId: string, ctx: VenueContext, now: number): Promise<void> {
  const markId = eventIdFor('engine', `stay:${stayId}:linked`);
  if ((await eventRef(markId).get()).exists) return;
  const stay = await loadStay(stayId);
  if (!stay?.contactId || stay.status === 'cancelled') return;
  await scheduleStayMoments(stay, ctx, now);
  await appendEvent(
    {
      type: 'stay.linked',
      occurredAt: stay.linkedAt ?? now,
      tenantUserId: stay.tenantUserId,
      venueId: stay.venueId,
      contactId: stay.contactId,
      guestId: stay.linkedGuestId,
      source: 'engine',
      data: { stayId, linkMode: stay.linkMode, checkIn: stay.checkIn, checkOut: stay.checkOut },
    },
    markId,
  );
}

/**
 * `stay.changed` / `stay.cancelled` from a sync (an `event_route` task written with the
 * Stay change). Reads the Stay fresh: if a guest is linked, a change reschedules the
 * moments of journeys that haven't started (the only place that does), and the event
 * goes to this stay's running journeys — a change moves their anchored waits, a
 * cancellation ends them.
 */
export async function handleStayEvent(event: EngineEvent, env: { now: number; settings: EngineSettings; workerId: string }, mustDeliver: (r: { status: string }) => void): Promise<void> {
  const stayId = typeof event.data.stayId === 'string' ? event.data.stayId : null;
  if (!stayId) return;
  const stay = await loadStay(stayId);
  if (!stay?.contactId) return; // nobody linked: nothing to move
  if (event.type === 'stay.changed' && stay.status !== 'cancelled') {
    const ctx = await loadVenueContext(stay.venueId);
    if (ctx) await scheduleStayMoments(stay, ctx, env.now);
  }
  const running = await stayInstancesQuery(stayId).get();
  for (const doc of running.docs) mustDeliver(await deliverEvent(doc.id, event, env));
}
