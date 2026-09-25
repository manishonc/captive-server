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
import { loadFeedStays, stayEventExists, stayRef, toStay, venueFeedRef, writeStayEventInTx } from '../stays/store';

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
  const stays = (await loadFeedStays(snap.id))
    .filter((s) => s.checkOut >= today)
    .sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0))
    .map((s) => ({ checkIn: s.checkIn, checkOut: s.checkOut, nights: s.nights, status: s.status, linked: Boolean(s.contactId) }));
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
export async function syncStayFeedNow(tenantUserId: string, venueId: string) {
  await ownedVenue(tenantUserId, venueId, { airbnb: false });
  const snap = await venueFeedRef(venueId).get();
  if (!snap.exists) throw notFound('No calendar link is saved for this venue');
  const queued = await queueSync({ feedId: snap.id, tenantUserId, venueId, nextPollAt: snap.get('nextPollAt') });
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
