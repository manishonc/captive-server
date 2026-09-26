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
import { contactStaysQuery, linkCandidatesQuery, loadStay, stayContactInstancesQuery, stayInstancesQuery, stayRef, toStay, venueFeedRef } from './store';
import { FieldPath } from 'firebase-admin/firestore';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { instanceRef } from '../engine/instanceStore';
import { eventDoc } from '../engine/events';
import { linkable, outgoingOnTurnoverDay, seenDuringAny, windowCandidates, windowOpensAt } from './plan';
import { scheduleStayMoments } from './moments';
import { linkSeqSuffix } from './times';

/** The "follow-up done" mark of a stay's link, per link generation (PR D unlink/relink). */
export function linkMarkId(stayId: string, linkSeq: number): string {
  return eventIdFor('engine', `stay:${stayId}:linked${linkSeqSuffix(linkSeq)}`);
}

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
      const [snap, feedSnap, theirs] = await Promise.all([tx.get(stayRef(c.stay.id)), tx.get(venueFeedRef(ctx.venueId)), tx.get(contactStaysQuery(ctx.venueId, a.contactId))]);
      if (!snap.exists) return false;
      // Never a second current stay here (read in the transaction: an owner's link at the same time can't slip in).
      if (theirs.docs.some((d) => d.id !== c.stay.id && d.get('status') !== 'cancelled' && String(d.get('checkOut') ?? '') >= today)) return false;
      const s = toStay(snap.id, snap.data() as StayDoc);
      // First guest wins; the dates may have moved, or a poll found it missing, since the query.
      if (!linkable(s, missingOf(feedSnap.get('lastMissingStayIds'))) || outgoingOnTurnoverDay(stays, s, today)) return false;
      // Someone the owner unlinked from this stay is never linked to it again automatically (PR D).
      if ((s.unlinkedContactIds ?? []).includes(a.contactId)) return false;
      const opensAt = windowOpensAt(s, c.previous);
      if (!(opensAt <= a.at && a.at < s.checkOutAt)) return false;
      tx.update(stayRef(s.id), { contactId: a.contactId, linkedAt: new Date(a.at), linkedGuestId: a.guestId, linkMode: a.mode, linkedBy: 'guest', updatedAt: new Date() });
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
export async function completeLink(stayId: string, ctx: VenueContext, now: number, opts: { relinkSeq?: number } = {}): Promise<void> {
  // The Stay first: the mark's id depends on its link generation (an unlink and a new link
  // must not find the first guest's mark and stop here).
  const stay = await loadStay(stayId);
  if (!stay?.contactId || stay.status === 'cancelled') return;
  const markId = linkMarkId(stayId, stay.linkSeq);
  if ((await eventRef(markId).get()).exists) return;
  // An owner's re-link (PR D): its handler resumes the journeys first, then does this — no other
  // path may schedule the moments before (a reminder beside a Stay guide about to resume).
  if (stay.relinkPending && opts.relinkSeq !== stay.linkSeq) return;
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
      data: {
        stayId,
        linkMode: stay.linkMode,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        ...(stay.linkSeq ? { linkSeq: stay.linkSeq } : {}),
        ...(stay.linkedBy === 'owner' ? { linkedBy: 'owner' } : {}),
      },
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
  // Not while an owner's re-link is still being resumed: its handler schedules the moments first.
  const waitForRelink = event.type === 'stay.changed' && stay.status !== 'cancelled' && stay.relinkPending;
  if (event.type === 'stay.changed' && stay.status !== 'cancelled' && !waitForRelink) {
    const ctx = await loadVenueContext(stay.venueId);
    if (ctx) await scheduleStayMoments(stay, ctx, env.now);
  }
  const running = await stayInstancesQuery(stayId).get();
  for (const doc of running.docs) mustDeliver(await deliverEvent(doc.id, event, env));
  // …then this change runs again (the running journeys have it already: they skip it), and
  // schedules the moments with the dates as they are then.
  if (waitForRelink) mustDeliver({ status: 'retry' });
}

/**
 * `stay.unlinked` (PR D: the owner took a wrongly linked person off a stay). That person's
 * running stay journeys end as `cancelled` / `stay_unlinked`: `advance` sees the Stay is no
 * longer theirs, whatever the event (engine/advance.ts); the gate and the live claim check
 * it too, so a send already on its way is skipped.
 */
export async function handleStayUnlinked(event: EngineEvent, env: { now: number; settings: EngineSettings; workerId: string }, mustDeliver: (r: { status: string }) => void): Promise<void> {
  const stayId = typeof event.data.stayId === 'string' ? event.data.stayId : null;
  if (!stayId || !event.contactId) return;
  const running = await stayInstancesQuery(stayId).get();
  for (const doc of running.docs) {
    if (doc.get('contactId') !== event.contactId) continue;
    mustDeliver(await deliverEvent(doc.id, event, env));
  }
}

/** The event that carries an owner's re-link to the worker (one per link generation). */
export const relinkedEventId = (stayId: string, linkSeq: number) => eventIdFor('cms', `stay:${stayId}:relinked:${linkSeq}`);

/**
 * Written in the owner's link transaction when the person linked had been unlinked from this
 * stay before (PR D, D-D8): the worker then runs `handleStayRelinked`. Nothing is resumed in the
 * API, so the resume can't race the unlink's own cancel or a newer link.
 */
export function writeRelinkedEventInTx(
  tx: FirebaseFirestore.Transaction,
  s: { id: string; tenantUserId: string; venueId: string },
  contactId: string,
  linkSeq: number,
  t: number,
  by: string,
): string {
  const id = relinkedEventId(s.id, linkSeq);
  tx.set(eventRef(id), eventDoc({ type: 'stay.relinked', occurredAt: t, tenantUserId: s.tenantUserId, venueId: s.venueId, contactId, source: 'cms', data: { stayId: s.id, linkSeq, by } }));
  firestoreScheduler.scheduleInTx(tx, { dedupeKey: `event:${id}`, kind: 'event_route', dueAt: t, payload: { eventId: id }, tenantUserId: s.tenantUserId, venueId: s.venueId });
  return id;
}

const resumeToken = (token: string, linkSeq: number) => `${token}:relink${linkSeq}`;

/** The re-link's follow-up is over (done, or nothing to do): other paths may schedule moments again. */
async function clearRelinkPending(stayId: string, linkSeq: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const s = await tx.get(stayRef(stayId));
    if (s.exists && (Number(s.get('linkSeq')) || 0) === linkSeq && s.get('relinkPendingSeq') === linkSeq) tx.update(stayRef(stayId), { relinkPendingSeq: null });
  });
}

function msOf(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof (v as { toMillis?: () => number })?.toMillis === 'function') return (v as { toMillis: () => number }).toMillis();
  return typeof v === 'number' ? v : null;
}

/**
 * `stay.relinked` (PR D, D-D8): the owner linked someone back to a stay they had been unlinked
 * from. In this order, all in the worker:
 *  1. Their stay journeys the unlink ended (`cancelled` / `stay_unlinked`, wait kept) are active
 *     again — only while the Stay is still theirs at this link generation (a newer unlink or link
 *     wins), and not when another run of the journey took the slot meanwhile.
 *  2. Each of their running journeys of this stay hears the re-link: a wait anchored on the stay
 *     is entered again with the current dates (they may have changed while unlinked).
 *  3. A kept wait the re-link didn't move gets its task back at its own time — so a step that
 *     was due long ago runs at once and the stale rule sees how late it is; a journey that was
 *     unlinked before its first step starts.
 *  4. The moments of stay journeys that never started (the same as any link), after the resume,
 *     so the overlap rules see the resumed Stay guide.
 * Safe to run again: each step re-checks what it needs.
 */
export async function handleStayRelinked(event: EngineEvent, env: { now: number; settings: EngineSettings; workerId: string }, mustDeliver: (r: { status: string }) => void): Promise<void> {
  const stayId = typeof event.data.stayId === 'string' ? event.data.stayId : null;
  const contactId = event.contactId ?? null;
  const linkSeq = Number(event.data.linkSeq);
  if (!stayId || !contactId || !Number.isInteger(linkSeq)) return;
  const stay = await loadStay(stayId);
  if (!stay || stay.contactId !== contactId || stay.linkSeq !== linkSeq) return; // unlinked or re-linked again since (a newer generation)
  // The booking was cancelled meanwhile: nothing to resume or schedule (a reinstated booking gets its
  // moments from its own stay.changed, which no longer waits for this).
  if (stay.status === 'cancelled') return clearRelinkPending(stayId, linkSeq);

  // 1. Active again.
  const ended = await stayContactInstancesQuery(stayId, contactId).get();
  for (const doc of ended.docs) {
    if (doc.get('status') !== 'cancelled' || doc.get('exitReason') !== 'stay_unlinked') continue;
    await db.runTransaction(async (tx) => {
      const [instSnap, cvSnap, staySnap] = await Promise.all([
        tx.get(instanceRef(doc.id)),
        tx.get(db.collection(COL.contactVenues).doc(contactVenueId(contactId, String(doc.get('venueId'))))),
        tx.get(stayRef(stayId)),
      ]);
      const d = instSnap.data() as Record<string, any> | undefined;
      if (!d || d.status !== 'cancelled' || d.exitReason !== 'stay_unlinked') return;
      if (staySnap.get('contactId') !== contactId || (Number(staySnap.get('linkSeq')) || 0) !== linkSeq || staySnap.get('status') === 'cancelled') return;
      const w = d.waiting as { nodeId?: string; token?: string } | null;
      if (!w?.nodeId || !w.token) return;
      const journeyKey = String(d.journeyKey);
      if (cvSnap.get(new FieldPath('journeys', journeyKey, 'activeInstanceId'))) return; // another run of it started meanwhile
      tx.update(instanceRef(doc.id), {
        status: 'active',
        exitReason: null,
        endedAt: null,
        expireAt: null,
        'waiting.token': resumeToken(w.token, linkSeq),
        rev: (Number(d.rev) || 0) + 1,
        updatedAt: new Date(env.now),
      });
      tx.update(cvSnap.ref, new FieldPath('journeys', journeyKey, 'activeInstanceId'), doc.id);
      tx.set(
        eventRef(eventIdFor('cms', `resume:${doc.id}:${linkSeq}`)),
        eventDoc({
          type: 'journey.resumed',
          occurredAt: env.now,
          tenantUserId: d.tenantUserId,
          venueId: d.venueId,
          contactId,
          instanceId: doc.id,
          journeyKey,
          mode: d.mode === 'live' ? 'live' : 'test',
          source: 'engine',
          data: { reason: 'stay_relinked', stayId, linkSeq },
        }),
      );
    });
  }

  // 2 + 3. Every running journey of this stay for this person.
  const running = await stayContactInstancesQuery(stayId, contactId).get();
  for (const doc of running.docs) {
    if (doc.get('status') !== 'active') continue;
    mustDeliver(await deliverEvent(doc.id, event, env));
    const after = await instanceRef(doc.id).get();
    const w = after.get('waiting') as { kind?: string; nodeId?: string; token?: string; untilAt?: unknown } | null;
    // Only a wait a re-link resumed and didn't move (its token is still a resume token) — also one an
    // earlier re-link resumed and never re-armed (the task key is create-only: an existing one stays).
    if (after.get('status') !== 'active' || !w?.nodeId || !/:relink\d+$/.test(w.token ?? '')) continue;
    const until = msOf(w.untilAt);
    if (w.kind === 'events' && until === null) continue; // waits for events only: nothing to arm
    // A send stopped at its live claim keeps a wait with no time of its own: the step's own time
    // then, so the stale rule still sees how late it is.
    const dueAt = until ?? msOf(after.get('cursor.enteredAt')) ?? env.now;
    const start = w.nodeId === '__start';
    // Create-only: a second run of this handler finds it and leaves it.
    await firestoreScheduler.schedule({
      dedupeKey: `node:${doc.id}:${w.token}`,
      kind: 'node_run',
      dueAt,
      payload: start
        ? { instanceId: doc.id, input: 'start', token: w.token }
        : { instanceId: doc.id, input: w.kind === 'send_due' ? 'send_due' : 'wake', nodeId: w.nodeId, token: w.token },
      tenantUserId: String(after.get('tenantUserId')),
      venueId: String(after.get('venueId')),
    });
  }

  // 4. Journeys of this stay that never started for this person.
  const ctx = await loadVenueContext(stay.venueId);
  if (ctx) await completeLink(stayId, ctx, env.now, { relinkSeq: linkSeq });
  await clearRelinkPending(stayId, linkSeq);
}
