/**
 * A venue's booking calendar — the service PR D's owner routes mount (plan §5:
 * `GET/PUT/DELETE /tenants/:t/venues/:v/stay-feed`, `POST …/check`, `POST …/sync`).
 * PR C uses it from the sandbox dev routes and the tests.
 *
 *  - One feed per venue: doc `CaptivePortal_StayFeeds/venue_{venueId}`, read and written in
 *    one transaction (D-C34), so two saves at once give one feed.
 *  - Airbnb venues only (D-C7). The link is stored unencrypted, in its standard form, and only ever shown masked;
 *    no error carries it (`new URL()` would put it on `err.input`, and the routers print
 *    unexpected errors whole).
 *  - Nothing is scheduled while the account's launch mode is off (stage 0 writes nothing
 *    but the owner's own setting); the worker's watchdog starts the chain later.
 *  - "Check link" fetches and parses at once and stores nothing (D-C3: the one fetch
 *    outside the worker; in PR C only the sandbox calendar is read this way).
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import type { StayDoc, StayFeedDoc } from '../store/engineTypes';
import type { Actor } from '../core/schemas';
import { SCHEMA_VERSION } from '../core/constants';
import { sha256Hex } from '../core/checksum';
import { localDateKey } from '../core/runtime/time';
import { getVenues } from '../store/tenantData';
import { readEngineSettings, modeFor } from '../store/engineSettings';
import { tsMs } from '../store/time';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { now, refreshClock, sandboxEnabled } from '../engine/clock';
import { loadVenueContext } from '../engine/context';
import { ensureRollup } from '../rollups/rollup';
import { ApiError, notFound } from '../api/errors';
import { IcalParseError, isUnsupported, looksLikeIcal, parseIcal } from '../stays/ical';
import { FeedFetchError, checkFeedUrl } from '../stays/fetch';
import { fetchStayCalendar, isSandboxLink, sandboxCalendarName } from '../stays/source';
import { feedWords, maskFeedUrl, statusCode } from '../stays/words';
import { syncNowKey } from '../stays/times';
import { armNextPoll, chainIsStale } from '../stays/sync';
import { contactStaysQuery, loadFeedStays, stayEventExists, stayRef, toStay, venueFeedRef, writeStayEventInTx } from '../stays/store';
import { z } from 'zod';
import { COL as COLS, contactVenueId } from '../store/collections';
import { eventIdFor } from '../core/runtime/ids';
import { eventDoc, eventRef } from '../engine/events';
import { completeLink, writeRelinkedEventInTx } from '../stays/link';
import { readEngineSettings as readSettings, venueModeFor } from '../store/engineSettings';
import { maskedGuest } from '../core/owner/mask';
import { conflict } from '../api/errors';
import type { ContactDoc } from '../store/engineTypes';

const INVALID = "That calendar link isn't valid";

/** The owner's venue, of type Airbnb — else a 403 / 404 / 400 (never naming anything from another account). */
async function ownedVenue(tenantUserId: string, venueId: string, opts: { airbnb: boolean }): Promise<{ venueId: string; tz: string }> {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
  const ctx = await loadVenueContext(venueId);
  if (opts.airbnb) {
    const type = venue.venueType ?? ((await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get()).get('businessType') as string | undefined) ?? null;
    if (type !== 'airbnb') throw new ApiError('bad_request', 'Calendar links are for holiday-rental (Airbnb) venues');
  }
  return { venueId, tz: ctx?.tz ?? venue.timezone ?? 'Europe/Zurich' };
}

/**
 * The link to store: trimmed, `webcal://` and `http://` read as `https://`, passing the
 * fetcher's rules (https, port 443, no credentials, no IP literal), in its standard form. A `sandbox:calendar/…`
 * link only in the local sandbox. A bad link → 400 with no part of it in the error.
 */
export function normalizeFeedUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError('bad_request', INVALID);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) throw new ApiError('bad_request', INVALID);
  if (isSandboxLink(trimmed)) {
    const name = sandboxCalendarName(trimmed);
    if (!sandboxEnabled() || !name) throw new ApiError('bad_request', INVALID);
    return `sandbox:calendar/${name}`;
  }
  const url = trimmed.replace(/^webcal:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  try {
    // The standard form, so `HTTPS://`, an upper-case host or `:443` is the same link, not a new one.
    return checkFeedUrl(url).href;
  } catch (err) {
    const code = err instanceof FeedFetchError ? err.code : 'BAD_URL';
    throw new ApiError('bad_request', code === 'BAD_URL' ? INVALID : feedWords(code) ?? INVALID);
  }
}

const iso = (v: unknown) => {
  const ms = tsMs(v);
  return ms === null ? null : new Date(ms).toISOString();
};

export interface StayFeedView {
  feedId: string;
  url: string;
  kind: 'ical';
  status: StayFeedDoc['status'];
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorWords: string | null;
  consecutiveErrors: number;
  upcomingCount: number;
  overlapCount: number;
  feedWarning: StayFeedDoc['feedWarning'];
  feedWarningWords: string | null;
  nextPollAt: string | null;
}

function feedView(id: string, d: StayFeedDoc): StayFeedView {
  return {
    feedId: id,
    url: maskFeedUrl(String(d.url ?? '')),
    kind: 'ical',
    status: d.status,
    lastPolledAt: iso(d.lastPolledAt),
    lastSuccessAt: iso(d.lastSuccessAt),
    lastError: d.lastError ?? null,
    lastErrorWords: feedWords(d.lastError),
    consecutiveErrors: Number(d.consecutiveErrors) || 0,
    upcomingCount: Number(d.upcomingCount) || 0,
    overlapCount: Number(d.overlapCount) || 0,
    feedWarning: d.feedWarning ?? null,
    feedWarningWords: feedWords(d.feedWarning),
    nextPollAt: iso(d.nextPollAt),
  };
}

/** Status, masked link and the stays not over yet — no calendar text, no guest details. */
export async function getStayFeed(tenantUserId: string, venueId: string) {
  const v = await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const snap = await venueFeedRef(venueId).get();
  if (!snap.exists) return { feed: null, stays: [] };
  await refreshClock();
  const today = localDateKey(new Date(now()), v.tz);
  const current = (await loadFeedStays(snap.id))
    .filter((s) => s.checkOut >= today)
    .sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));
  // Who is linked, masked (PR D), so the owner can see a wrong link and unlink it.
  const contactIds = [...new Set(current.map((s) => s.contactId).filter((c): c is string => Boolean(c)))];
  const contacts = new Map<string, ContactDoc>();
  if (contactIds.length) {
    const snaps = await db.getAll(...contactIds.map((id) => db.collection(COLS.contacts).doc(id)));
    for (const c of snaps) if (c.exists && c.get('tenantUserId') === tenantUserId) contacts.set(c.id, c.data() as ContactDoc);
  }
  const stays = current.map((s) => ({
    stayId: s.id,
    checkIn: s.checkIn,
    checkOut: s.checkOut,
    nights: s.nights,
    status: s.status,
    linked: Boolean(s.contactId),
    linkedContactId: s.contactId,
    linkedGuest: s.contactId ? maskedGuest(contacts.get(s.contactId)) : null,
    linkedBy: s.contactId ? s.linkedBy ?? 'guest' : null,
    linkMode: s.contactId ? s.linkMode : null,
  }));
  return { feed: feedView(snap.id, snap.data() as StayFeedDoc), stays };
}

/**
 * Starts a poll now (and the 4-hourly chain if it isn't running) — never while the account
 * is off. Clicks in the same minute share one task; a save adds the link's hash, so a
 * different link saved in the same minute is still read at once.
 */
async function queueSync(feed: { feedId: string; tenantUserId: string; venueId: string; nextPollAt: unknown }, keySuffix = ''): Promise<boolean> {
  const settings = await readEngineSettings();
  if (modeFor(settings, feed.tenantUserId) === 'off') return false;
  await refreshClock();
  const t = now();
  await firestoreScheduler.schedule({
    dedupeKey: syncNowKey(feed.feedId, t) + keySuffix,
    kind: 'stay_poll',
    dueAt: t,
    payload: { feedId: feed.feedId, venueId: feed.venueId, manual: true },
    tenantUserId: feed.tenantUserId,
    venueId: feed.venueId,
  });
  if (chainIsStale(feed.nextPollAt, t)) {
    const at = await armNextPoll(feed, t);
    await venueFeedRef(feed.venueId).update({ nextPollAt: new Date(at) });
  }
  return true;
}

/**
 * Saves the venue's calendar link. A different link resets the feed's sync state (and lifts
 * a "bookings vanished" hold at once, D-C35); stays missing from the new link then cancel
 * after two polls. Returns the feed as the owner sees it.
 */
export async function saveStayFeed(tenantUserId: string, venueId: string, url: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId, { airbnb: true });
  const link = normalizeFeedUrl(url);
  const ref = venueFeedRef(venueId);
  await refreshClock();
  const savedAt = now(); // engine time, like the sync's clock
  const saved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const at = new Date();
    if (!snap.exists) {
      const doc: StayFeedDoc & { updatedBy: string } = {
        tenantUserId,
        venueId,
        kind: 'ical',
        url: link,
        status: 'active',
        lastPolledAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveErrors: 0,
        failingSince: null,
        etag: null,
        upcomingCount: 0,
        overlapCount: 0,
        successSeq: 0,
        pollLease: null,
        lastContentHash: null,
        lastMissingStayIds: [],
        reservedSeen: false,
        feedWarning: null,
        suspectSince: null,
        createdAt: at,
        updatedAt: at,
        updatedBy: actor.uid,
        schemaVersion: SCHEMA_VERSION,
      };
      tx.create(ref, doc);
      return { nextPollAt: null as unknown };
    }
    const d = snap.data() as StayFeedDoc;
    // Every save is a "try again": errors and the ETag reset (the next poll reads everything).
    const update: Record<string, unknown> = { status: 'active', etag: null, consecutiveErrors: 0, lastError: null, failingSince: null, updatedAt: at, updatedBy: actor.uid };
    if (d.url !== link) {
      // A different link: its content is judged afresh, and bookings missing from it are the
      // owner's doing — they cancel after two polls, with no 24 h hold (D-C35).
      Object.assign(update, { url: link, lastContentHash: null, lastMissingStayIds: [], reservedSeen: false, feedWarning: null, suspectSince: null, guardLiftedAt: new Date(savedAt) });
    }
    tx.update(ref, update);
    return { nextPollAt: d.nextPollAt };
  });
  const queued = await queueSync({ feedId: ref.id, tenantUserId, venueId, nextPollAt: saved.nextPollAt }, `:save:${sha256Hex(link).slice(0, 12)}`);
  const view = await getStayFeed(tenantUserId, venueId);
  return { ...view, syncQueued: queued };
}

/** "Sync now": a poll in the next seconds (no new task kind: a manual `stay_poll`). */
export async function syncStayFeedNow(tenantUserId: string, venueId: string, opts: { keySuffix?: string } = {}) {
  await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const snap = await venueFeedRef(venueId).get();
  if (!snap.exists) throw notFound('No calendar link is saved for this venue');
  const queued = await queueSync({ feedId: snap.id, tenantUserId, venueId, nextPollAt: snap.get('nextPollAt') }, opts.keySuffix ?? '');
  return { queued, ...(queued ? {} : { reason: 'Adaptive is off for this account' }) };
}

export type CheckResult = {
  ok: boolean;
  /** Bookings that aren't over yet. */
  upcoming?: number;
  nextCheckIn?: string;
  source?: string;
  errorCode?: string;
  error?: string;
};

/** "Check link": fetch + parse now, store nothing. */
export async function checkStayFeed(tenantUserId: string, venueId: string, url: unknown): Promise<CheckResult> {
  const v = await ownedVenue(tenantUserId, venueId, { airbnb: true });
  const link = normalizeFeedUrl(url);
  const saved = await venueFeedRef(venueId).get();
  // A feed that has given stays before stays supported (D-C4) — only for the link it is saved with.
  const reservedSeen = saved.exists && saved.get('url') === link ? Boolean(saved.get('reservedSeen')) : false;
  const fail = (code: string): CheckResult => ({ ok: false, errorCode: code, error: feedWords(code) ?? 'The calendar could not be read.' });
  let body: Buffer;
  try {
    const r = await fetchStayCalendar(link, null);
    if (r.status !== 200) return fail(statusCode(r.status));
    body = r.body ?? Buffer.alloc(0);
  } catch (err) {
    return fail(err instanceof FeedFetchError ? err.code : 'NETWORK');
  }
  try {
    if (!looksLikeIcal(body)) return fail('NOT_ICAL');
    const parse = parseIcal(body, v.tz);
    if (isUnsupported(parse, reservedSeen)) return { ...fail('unsupported_source'), source: parse.source };
    await refreshClock();
    const today = localDateKey(new Date(now()), v.tz);
    const upcoming = parse.stays.filter((s) => s.checkOut > today);
    const next = upcoming.find((s) => s.checkIn >= today);
    return { ok: true, upcoming: upcoming.length, ...(next ? { nextCheckIn: next.checkIn } : {}), source: parse.source };
  } catch (err) {
    return fail(err instanceof IcalParseError ? err.code : 'PARSE_FAILED');
  }
}

/**
 * Removes the calendar link: polling stops (the chain's next task finds no feed), and
 * stays nobody is linked to that aren't over are cancelled. Stays a guest is linked to keep
 * running. Saving a link again later reuses the same feed id, so those stays are found again.
 */
export async function deleteStayFeed(tenantUserId: string, venueId: string, actor: Actor) {
  const v = await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const ref = venueFeedRef(venueId);
  if (!(await ref.get()).exists) return { deleted: false, cancelled: 0 };
  await ref.delete();
  await refreshClock();
  const t = now();
  const today = localDateKey(new Date(t), v.tz);
  let cancelled = 0;
  for (const s of await loadFeedStays(ref.id)) {
    if (s.status === 'cancelled' || s.contactId || !(today < s.checkOut)) continue;
    const done = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stayRef(s.id));
      if (!snap.exists) return false;
      const fresh = toStay(s.id, snap.data() as StayDoc);
      if (fresh.status === 'cancelled' || fresh.contactId) return false; // linked meanwhile: keeps running
      const key = `${s.id}:cancelled:${fresh.datesVersion}`;
      const known = await stayEventExists(tx, key);
      tx.update(stayRef(s.id), { status: 'cancelled', cancelledAt: new Date(t), cancelReason: 'feed_deleted', updatedAt: new Date() });
      if (!known) writeStayEventInTx(tx, { type: 'stay.cancelled', key, stay: fresh, occurredAt: t, data: { datesVersion: fresh.datesVersion, reason: 'feed_deleted', checkIn: fresh.checkIn, checkOut: fresh.checkOut, by: actor.uid } });
      return true;
    });
    if (done) cancelled += 1;
  }
  // Written outside a worker task: arm the venue's daily numbers here.
  if (cancelled) await ensureRollup(venueId, tenantUserId);
  return { deleted: true, cancelled };
}

// ── Unlink and link by hand (PR D, D-C11 / D-D8) ─────────────────────────────

const unlinkInputSchema = z.object({ expectContactId: z.string().min(1).max(128) });
// Contact ids are read as doc ids: our id characters only (a `/` would answer a 500).
const linkInputSchema = z.object({ contactId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), expectContactId: z.string().min(1).max(128).optional() });

/** The venue's stay, or a 404 that names nothing of another account. */
function ownStay(snap: FirebaseFirestore.DocumentSnapshot, tenantUserId: string, venueId: string) {
  if (!snap.exists) throw notFound('This booking was not found');
  const s = toStay(snap.id, snap.data() as StayDoc);
  if (s.tenantUserId !== tenantUserId || s.venueId !== venueId) throw notFound('This booking was not found');
  return s;
}

/**
 * Writes `stay.unlinked` for the person taken off the stay, with its `event_route` task (their
 * running stay journeys end, engine/advance.ts). The id carries the new link generation, so
 * it is new in this transaction.
 */
function writeUnlinkedEventInTx(tx: FirebaseFirestore.Transaction, s: { id: string; tenantUserId: string; venueId: string }, oldContactId: string, linkSeq: number, t: number, by: string) {
  const id = eventIdFor('cms', `stay:${s.id}:unlinked:${linkSeq}`);
  tx.set(eventRef(id), eventDoc({ type: 'stay.unlinked', occurredAt: t, tenantUserId: s.tenantUserId, venueId: s.venueId, contactId: oldContactId, source: 'cms', data: { stayId: s.id, linkSeq, by } }));
  firestoreScheduler.scheduleInTx(tx, { dedupeKey: `event:${id}`, kind: 'event_route', dueAt: t, payload: { eventId: id }, tenantUserId: s.tenantUserId, venueId: s.venueId });
}

/**
 * Takes the linked person off a stay (e.g. a cleaner who connected first). Their stay messages
 * stop, and they are never linked to this stay again automatically; the next guest who connects
 * in the window is linked and gets the stay's remaining messages. `expectContactId` must name the
 * person being removed (409 if the stay was re-linked meanwhile), so a repeated click can never
 * unlink the right guest.
 */
export async function unlinkStay(tenantUserId: string, venueId: string, stayId: string, body: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const { expectContactId } = unlinkInputSchema.parse(body ?? {});
  await refreshClock();
  const t = now();
  const out = await db.runTransaction(async (tx) => {
    const s = ownStay(await tx.get(stayRef(stayId)), tenantUserId, venueId);
    if (!s.contactId) return { unlinked: false as const };
    if (s.contactId !== expectContactId) throw conflict('Someone else is linked to this booking now — reload and check');
    const linkSeq = s.linkSeq + 1;
    const unlinkedContactIds = [...s.unlinkedContactIds.filter((c) => c !== s.contactId), s.contactId].slice(-10);
    tx.update(stayRef(stayId), {
      contactId: null,
      linkedAt: null,
      linkedGuestId: null,
      linkMode: null,
      linkedBy: null,
      linkSeq,
      unlinkedContactIds,
      unlinkedAt: new Date(t),
      unlinkedBy: actor.uid,
      updatedAt: new Date(),
    });
    writeUnlinkedEventInTx(tx, s, s.contactId, linkSeq, t, actor.uid);
    return { unlinked: true as const };
  });
  // Written outside a worker task: arm the venue's daily numbers here.
  if (out.unlinked) await ensureRollup(venueId, tenantUserId);
  return { unlinked: out.unlinked, ...(await getStayFeed(tenantUserId, venueId)) };
}

/**
 * The owner links the right guest to a stay by hand, picked from the guests seen at this venue.
 * Replacing someone already linked needs `expectContactId` naming them (they are unlinked in the
 * same transaction). The guest gets the stay's remaining moments (more than 12 h past are
 * skipped). Refused while the venue doesn't start journeys for new guests (launch off, or
 * waiting for Start sending), for a cancelled or finished stay, and for a guest already linked
 * to another current stay here.
 */
export async function linkStayByOwner(tenantUserId: string, venueId: string, stayId: string, body: unknown, actor: Actor) {
  const v = await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const input = linkInputSchema.parse(body ?? {});
  const ctx = await loadVenueContext(venueId);
  if (!ctx || (!ctx.marketing && !ctx.utility)) throw conflict('Adaptive Campaigns is not switched on at this venue');
  await refreshClock();
  const t = now();
  const settings = await readSettings();
  const mode = venueModeFor(settings, ctx.adaptive, t);
  if (mode === 'off') throw conflict('Stays can be linked once sending is on for this venue');
  const today = localDateKey(new Date(t), v.tz);

  // Already linked to another stay here that isn't over: never two (the automatic rule too).
  const theirs = (await contactStaysQuery(venueId, input.contactId).get()).docs.map((d) => toStay(d.id, d.data() as StayDoc));
  if (theirs.some((s) => s.id !== stayId && s.status !== 'cancelled' && s.checkOut >= today)) {
    throw conflict('This guest is already linked to another booking here');
  }

  const out = await db.runTransaction(async (tx) => {
    const [staySnap, contactSnap, cvSnap, theirsTx] = await Promise.all([
      tx.get(stayRef(stayId)),
      tx.get(db.collection(COLS.contacts).doc(input.contactId)),
      tx.get(db.collection(COLS.contactVenues).doc(contactVenueId(input.contactId, venueId))),
      // Read in the transaction too: a link of this guest to another stay at the same time can't slip in.
      tx.get(contactStaysQuery(venueId, input.contactId)),
    ]);
    const s = ownStay(staySnap, tenantUserId, venueId);
    if (!contactSnap.exists || contactSnap.get('tenantUserId') !== tenantUserId) throw notFound('This guest was not found');
    if (!cvSnap.exists) throw new ApiError('bad_request', 'Only a guest who has connected at this venue can be linked');
    if (s.status === 'cancelled') throw conflict('This booking was cancelled');
    // The same "not over" as the stay list: checkout day still counts (the review ask comes that afternoon).
    if (s.checkOut < today) throw conflict('This booking is over');
    if (theirsTx.docs.some((d) => d.id !== stayId && d.get('status') !== 'cancelled' && String(d.get('checkOut') ?? '') >= today)) {
      throw conflict('This guest is already linked to another booking here');
    }
    // Already theirs (e.g. a retry after the follow-up failed): no new link, but the follow-up runs again below.
    // (A re-link whose worker follow-up hasn't finished: that follow-up does the rest.)
    if (s.contactId === input.contactId) return { linked: false as const, same: true as const, linkSeq: s.linkSeq, relink: s.relinkPending };
    let linkSeq = s.linkSeq;
    if (s.contactId) {
      if (input.expectContactId !== s.contactId) throw conflict('Someone else is linked to this booking — reload and check');
      linkSeq += 1;
      writeUnlinkedEventInTx(tx, s, s.contactId, linkSeq, t, actor.uid);
    }
    const unlinkedContactIds = [...s.unlinkedContactIds.filter((c) => c !== input.contactId), ...(s.contactId ? [s.contactId] : [])].slice(-10);
    const guestIds = contactSnap.get('guestIds');
    tx.update(stayRef(stayId), {
      contactId: input.contactId,
      linkedAt: new Date(t),
      linkedGuestId: Array.isArray(guestIds) && guestIds.length ? String(guestIds[guestIds.length - 1]) : null,
      linkMode: mode,
      linkedBy: 'owner',
      linkSeq,
      unlinkedContactIds,
      ...(s.contactId ? { unlinkedAt: new Date(t), unlinkedBy: actor.uid } : {}),
      // Someone linked back after an unlink: the worker resumes the stay journeys the unlink ended,
      // then schedules the rest (stays/link.ts handleStayRelinked); nothing else schedules meanwhile.
      relinkPendingSeq: s.unlinkedContactIds.includes(input.contactId) ? linkSeq : null,
      updatedAt: new Date(),
    });
    const relink = s.unlinkedContactIds.includes(input.contactId);
    if (relink) writeRelinkedEventInTx(tx, s, input.contactId, linkSeq, t, actor.uid);
    return { linked: true as const, same: false as const, linkSeq, relink };
  });
  const resuming = out.relink;
  if (out.linked || out.same) {
    // Not a re-link still being resumed: the same follow-up as an automatic link (the moments, then
    // `stay.linked`) — safe to repeat.
    if (!resuming) await completeLink(stayId, ctx, t);
    await ensureRollup(venueId, tenantUserId);
  }
  return { linked: out.linked, resuming, ...(await getStayFeed(tenantUserId, venueId)) };
}
