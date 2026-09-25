/**
 * One calendar sync (plan §3.3 items 2–3, brief §2): read the feed, keep one `Stay` per
 * booking, count bookings that went missing, flag overlaps — then re-arm the feed's
 * 4-hourly chain.
 *
 *  - **One poll at a time per feed**: a lease on the feed doc (real time) plus
 *    `successSeq`, so a retried or concurrent poll can't count a miss twice or write
 *    over a newer poll.
 *  - **Never throws on a fetch or parse error**: it is recorded on the feed as a code
 *    (`consecutiveErrors`, `failing` after 3) and the chain goes on — a throw would
 *    retry 8 times and then end the chain for good. Only a Firestore error throws.
 *  - **Launch mode off stops the chain** (no fetch, no write, no re-arm: stage 0 writes
 *    nothing) — unless a guest is linked to a stay of this feed that isn't over, whose
 *    running stay guide must still hear about date changes and cancellations.
 *  - Each Stay change is written in ONE transaction with its event and, for a change or a
 *    cancellation, the `event_route` task that takes it to the guest's journeys — linked
 *    or not: a guest may link between this sync's read and its write, and the task reads
 *    the Stay fresh. The transaction re-reads the Stay and `update()`s only the sync's
 *    own fields, so a concurrent link keeps its `contactId`.
 *  - Two clocks: due times, "today", the 30-minute miss spacing and the 24 h suspect
 *    window use the engine clock (`env.now`); the lease and the fetch deadline real time.
 */

import type { Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { StayDoc, StayFeedDoc } from '../store/engineTypes';
import { SCHEMA_VERSION } from '../core/constants';
import { contentChecksum } from '../core/checksum';
import { stayIdFor } from '../core/runtime/ids';
import { HOUR_MS, localDateKey } from '../core/runtime/time';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { modeFor, type EngineSettings } from '../store/engineSettings';
import { retentionFrom, tsMs } from '../store/time';
import { dayKey, raiseAlert } from '../engine/alerts';
import { loadGuestInfo, loadVenueContext } from '../engine/context';
import { IcalParseError, isUnsupported, looksLikeIcal, parseIcal, staysHash, type IcalParse } from './ical';
import { FeedFetchError, type FetchFeedResult } from './fetch';
import { fetchStayCalendar } from './source';
import { decideMiss, decideUpsert, isCountable, isCurrentLinked, overlapMap, suspectState, type UpsertDecision } from './plan';
import { FAILING_AFTER_ERRORS, nextPollSlot, resolveStayTimes, stayInstants, type StayTimes } from './times';
import { feedRef, loadFeedStays, stayEventExists, stayRef, toStay, watchedFeedsQuery, writeStayEventInTx, type LoadedStay } from './store';
import { statusCode } from './words';

/** One poll holds the feed this long (real time), renewed while it works. */
export const POLL_LEASE_MS = 3 * 60_000;
/** A chain whose next poll is this far overdue (or unknown) is restarted by the watchdog, a save or Sync now. */
export const STALE_CHAIN_MS = HOUR_MS;
/** The owner hears about a failing link once a day after it has failed this long (D-C25). */
const FAILING_EMAIL_AFTER_MS = 24 * HOUR_MS;

export interface PollOptions {
  /** `chain` = the feed's own grid task (always re-arms); `manual` = Sync now / a save / the dev route (arms a stopped chain only). */
  kind: 'chain' | 'manual';
  /** The lease owner: the task id (a retry of the same task takes its own lease back) or a dev call's id. */
  owner: string;
  /** Called now and then in a long sync (the worker extends its task lease). */
  onProgress?: () => Promise<void>;
  /** Tests only: runs after the sync has read the feed's stays, before it writes anything. */
  onRead?: () => Promise<void>;
}

export interface PollResult {
  /** `superseded`: the feed was deleted, re-leased or saved with another link mid-sync — the rest was left undone. */
  outcome: 'no_feed' | 'off' | 'busy' | 'error' | 'unsupported' | 'synced' | 'superseded';
  errorCode?: string;
  /** The final HTTP status (200, 304, …) when the calendar was fetched. */
  fetchStatus?: number;
  /** A 304, or the same stays as the last successful parse. */
  unchanged?: boolean;
  created: number;
  changed: number;
  reinstated: number;
  missed: number;
  cancelled: number;
  overlapsFlagged: number;
  /** Stays in the parsed content. */
  parsed: number;
  /** Confirmed stays not checked out yet. */
  upcoming: number;
  feedWarning?: string | null;
  /** The chain's next poll, when this run armed it. */
  nextPollAt?: number;
}

const empty = (outcome: PollResult['outcome']): PollResult => ({ outcome, created: 0, changed: 0, reinstated: 0, missed: 0, cancelled: 0, overlapsFlagged: 0, parsed: 0, upcoming: 0 });

export function chainIsStale(nextPollAt: unknown, now: number): boolean {
  const next = tsMs(nextPollAt);
  return next === null || next < now - STALE_CHAIN_MS;
}

/** Schedules the feed's next grid-slot poll (create-only: a live chain already has it, so this can never fork a second chain). */
export async function armNextPoll(feed: { feedId: string; tenantUserId: string; venueId: string }, now: number): Promise<number> {
  const next = nextPollSlot(feed.feedId, now);
  await firestoreScheduler.schedule({
    dedupeKey: next.key,
    kind: 'stay_poll',
    dueAt: next.dueAt,
    payload: { feedId: feed.feedId, venueId: feed.venueId },
    tenantUserId: feed.tenantUserId,
    venueId: feed.venueId,
  });
  return next.dueAt;
}

async function venueTz(venueId: string): Promise<string> {
  const ctx = await loadVenueContext(venueId);
  if (ctx) return ctx.tz;
  const tz = (await db.collection(COL.venues).doc(venueId).get()).get('timezone');
  return typeof tz === 'string' && tz ? tz : 'Europe/Zurich';
}

async function claimLease(feedId: string, owner: string): Promise<{ feed: StayFeedDoc; successSeq: number } | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(feedRef(feedId));
    if (!snap.exists) return null;
    const feed = snap.data() as StayFeedDoc;
    const lease = feed.pollLease;
    if (lease && lease.owner !== owner && (tsMs(lease.until) ?? 0) > Date.now()) return null;
    tx.update(feedRef(feedId), { pollLease: { owner, until: new Date(Date.now() + POLL_LEASE_MS) } });
    return { feed, successSeq: Number(feed.successSeq) || 0 };
  });
}

async function renewLease(feedId: string, owner: string): Promise<void> {
  await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(feedRef(feedId));
      if (snap.get('pollLease.owner') !== owner) return;
      tx.update(feedRef(feedId), { 'pollLease.until': new Date(Date.now() + POLL_LEASE_MS) });
    })
    .catch(() => undefined);
}

/** Writes the feed's outcome — only while this poll still holds it and nobody finished a newer one. */
async function finishFeed(feedId: string, owner: string, successSeq: number, url: string, update: Record<string, unknown>): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(feedRef(feedId));
    if (!snap.exists) return false; // deleted meanwhile
    if (snap.get('pollLease.owner') !== owner || (Number(snap.get('successSeq')) || 0) !== successSeq) return false;
    // Another link was saved while this poll read the old one: its results belong to nobody.
    // Only the lease is let go; the save's own sync reads the new link.
    if (snap.get('url') !== url) {
      tx.update(feedRef(feedId), { pollLease: null });
      return false;
    }
    tx.update(feedRef(feedId), { ...update, pollLease: null, updatedAt: new Date() });
    return true;
  });
}

interface SyncCtx {
  feedId: string;
  feed: StayFeedDoc;
  /** The lease owner: every write checks this poll still holds the feed. */
  owner: string;
  tz: string;
  today: string;
  now: number;
  times: StayTimes;
  /** Set once a write found the feed deleted, re-leased or saved with another link: the rest of the sync stops. */
  lost: boolean;
}

/**
 * Read first in every Stay transaction: the feed still exists, this poll still holds it,
 * and its link is the one this poll read. Otherwise nothing more is written — a delete
 * (whose stays must stay cancelled) or a save of another link happened meanwhile.
 */
async function stillMine(tx: Transaction, c: SyncCtx): Promise<boolean> {
  const f = await tx.get(feedRef(c.feedId));
  const mine = f.exists && f.get('pollLease.owner') === c.owner && f.get('url') === c.feed.url;
  if (!mine) c.lost = true;
  return mine;
}

function stayFields(p: { checkIn: string; checkOut: string }, c: SyncCtx) {
  const i = stayInstants(p.checkIn, p.checkOut, c.tz, c.times);
  return {
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    checkInAt: new Date(i.checkInAt),
    checkOutAt: new Date(i.checkOutAt),
    nights: i.nights,
    expireAt: retentionFrom(i.checkOutAt),
  };
}

/** A booking in the content: create, change, reinstate or refresh its Stay (one transaction). */
async function applyUpsert(c: SyncCtx, id: string, p: { uid: string; checkIn: string; checkOut: string }, resetMisses: boolean): Promise<UpsertDecision['kind']> {
  const instants = stayInstants(p.checkIn, p.checkOut, c.tz, c.times);
  return db.runTransaction(async (tx) => {
    if (!(await stillMine(tx, c))) return 'none';
    const snap = await tx.get(stayRef(id));
    const existing = snap.exists ? toStay(id, snap.data() as StayDoc) : null;
    const d = decideUpsert(existing, p, instants, { today: c.today, now: c.now, resetMisses });
    const seenAt = new Date(c.now);
    if (d.kind === 'create') {
      const stub = { id, tenantUserId: c.feed.tenantUserId, venueId: c.feed.venueId, contactId: null };
      const known = await stayEventExists(tx, `${id}:created`);
      const doc: StayDoc = {
        tenantUserId: c.feed.tenantUserId,
        venueId: c.feed.venueId,
        feedId: c.feedId,
        externalUid: p.uid,
        status: 'confirmed',
        ...stayFields(p, c),
        datesVersion: 1,
        contactId: null,
        linkedAt: null,
        linkedGuestId: null,
        linkMode: null,
        lastSeenInFeedAt: seenAt,
        missingCount: 0,
        lastMissAt: null,
        overlapWith: [],
        cancelledAt: null,
        cancelReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      };
      tx.create(stayRef(id), doc);
      if (!known) writeStayEventInTx(tx, { type: 'stay.created', key: `${id}:created`, stay: stub, occurredAt: c.now, data: { checkIn: p.checkIn, checkOut: p.checkOut, nights: instants.nights } });
      return d.kind;
    }
    if (!existing) return 'none';
    if (d.kind === 'change' || d.kind === 'reinstate') {
      const version = existing.datesVersion + 1;
      const key = `${id}:changed:${version}`;
      const known = await stayEventExists(tx, key);
      const update: Record<string, unknown> = { ...stayFields(p, c), datesVersion: version, lastSeenInFeedAt: seenAt, updatedAt: new Date() };
      if (d.kind === 'reinstate') Object.assign(update, { status: 'confirmed', cancelledAt: null, cancelReason: null, missingCount: 0, lastMissAt: null, overlapWith: [] });
      else if (resetMisses) Object.assign(update, { missingCount: 0, lastMissAt: null });
      tx.update(stayRef(id), update);
      if (!known) {
        writeStayEventInTx(tx, {
          type: 'stay.changed',
          key,
          stay: existing,
          occurredAt: c.now,
          data: { datesVersion: version, from: { checkIn: existing.checkIn, checkOut: existing.checkOut }, to: { checkIn: p.checkIn, checkOut: p.checkOut }, ...(d.kind === 'reinstate' ? { reinstated: true } : {}) },
        });
      }
      return d.kind;
    }
    if (d.kind === 'reset') tx.update(stayRef(id), { missingCount: 0, lastMissAt: null, lastSeenInFeedAt: seenAt, updatedAt: new Date() });
    else if (d.kind === 'seen') tx.update(stayRef(id), { lastSeenInFeedAt: seenAt });
    return d.kind;
  });
}

/** A booking absent from the content: one more miss (30 min apart), cancelled at two (one transaction). */
async function applyMiss(c: SyncCtx, id: string): Promise<'none' | 'miss' | 'cancel'> {
  return db.runTransaction(async (tx) => {
    if (!(await stillMine(tx, c))) return 'none';
    const snap = await tx.get(stayRef(id));
    if (!snap.exists) return 'none';
    const s = toStay(id, snap.data() as StayDoc);
    const d = decideMiss(s, { today: c.today, now: c.now });
    if (d.kind === 'none') return 'none';
    if (d.kind === 'miss') {
      tx.update(stayRef(id), { missingCount: d.count, lastMissAt: new Date(c.now), updatedAt: new Date() });
      return 'miss';
    }
    const key = `${id}:cancelled:${s.datesVersion}`;
    const known = await stayEventExists(tx, key);
    tx.update(stayRef(id), { status: 'cancelled', missingCount: d.count, lastMissAt: new Date(c.now), cancelledAt: new Date(c.now), cancelReason: 'missing', updatedAt: new Date() });
    if (!known) writeStayEventInTx(tx, { type: 'stay.cancelled', key, stay: s, occurredAt: c.now, data: { datesVersion: s.datesVersion, reason: 'missing', checkIn: s.checkIn, checkOut: s.checkOut } });
    return 'cancel';
  });
}

/** Flags (or clears) an overlap on one stay. A linked stay keeps running (D-C10); flagging only stops new links. */
async function applyOverlap(c: SyncCtx, id: string, withIds: string[]): Promise<'flagged' | 'cleared' | 'none'> {
  return db.runTransaction(async (tx) => {
    if (!(await stillMine(tx, c))) return 'none';
    const snap = await tx.get(stayRef(id));
    if (!snap.exists) return 'none';
    const s = toStay(id, snap.data() as StayDoc);
    if (s.status === 'cancelled') return 'none';
    if (!withIds.length) {
      if (s.status !== 'overlap_flagged') return 'none';
      tx.update(stayRef(id), { status: 'confirmed', overlapWith: [], updatedAt: new Date() });
      return 'cleared';
    }
    if (s.status === 'overlap_flagged') {
      if (JSON.stringify(s.overlapWith) !== JSON.stringify(withIds)) tx.update(stayRef(id), { overlapWith: withIds, updatedAt: new Date() });
      return 'none';
    }
    const key = `${id}:overlap:${s.datesVersion}:${contentChecksum(withIds).slice(0, 16)}`;
    const known = await stayEventExists(tx, key);
    tx.update(stayRef(id), { status: 'overlap_flagged', overlapWith: withIds, updatedAt: new Date() });
    if (!known) writeStayEventInTx(tx, { type: 'stay.overlap_flagged', key, stay: s, occurredAt: c.now, data: { overlapWith: withIds, checkIn: s.checkIn, checkOut: s.checkOut } });
    return 'flagged';
  });
}

async function alertOverlaps(c: SyncCtx, stays: LoadedStay[], flagged: Set<string>, map: Map<string, string[]>): Promise<void> {
  const byId = new Map(stays.map((s) => [s.id, s]));
  const done = new Set<string>();
  const ctx = await loadVenueContext(c.feed.venueId);
  const venue = ctx?.venueName || c.feed.venueId;
  for (const id of flagged) {
    for (const other of map.get(id) ?? []) {
      const [a, b] = [byId.get(id), byId.get(other)].sort((x, y) => String(x?.id).localeCompare(String(y?.id)));
      if (!a || !b) continue;
      const pair = `${a.id}@${a.datesVersion}:${b.id}@${b.datesVersion}`;
      if (done.has(pair)) continue;
      done.add(pair);
      await raiseAlert({
        kind: 'stay_overlap',
        dedupeKey: `stay_overlap:${pair}`,
        audience: 'owner',
        tenantUserId: c.feed.tenantUserId,
        venueId: c.feed.venueId,
        subject: `Two bookings overlap at ${venue}`,
        text: `Your booking calendar for ${venue} has two bookings that overlap: ${a.checkIn} to ${a.checkOut} and ${b.checkIn} to ${b.checkOut}. Until the calendar is fixed, no guest is linked to them, so they get no stay messages. Guests already linked keep theirs.`,
      });
    }
  }
}

/** Records a failed poll on the feed; false when the write was refused (the feed was deleted, re-leased or saved with another link). */
async function recordError(feedId: string, owner: string, successSeq: number, feed: StayFeedDoc, code: string, c: { now: number; tz: string }, armedAt: number | null): Promise<boolean> {
  const errors = (Number(feed.consecutiveErrors) || 0) + 1;
  const failingSince = tsMs(feed.failingSince) ?? c.now;
  const failing = errors >= FAILING_AFTER_ERRORS;
  const recorded = await finishFeed(feedId, owner, successSeq, feed.url, {
    lastPolledAt: new Date(c.now),
    lastError: code,
    consecutiveErrors: errors,
    status: failing ? 'failing' : feed.status === 'failing' ? 'failing' : 'active',
    failingSince: new Date(failingSince),
    ...(armedAt !== null ? { nextPollAt: new Date(armedAt) } : {}),
  });
  // One owner email a day once the link has failed for more than 24 h (D-C25).
  if (recorded && failing && c.now - failingSince >= FAILING_EMAIL_AFTER_MS) {
    const ctx = await loadVenueContext(feed.venueId);
    const venue = ctx?.venueName || feed.venueId;
    await raiseAlert({
      kind: 'stay_feed_failing',
      dedupeKey: `stay_feed_failing:${feedId}:${dayKey(c.now, c.tz)}`,
      audience: 'owner',
      tenantUserId: feed.tenantUserId,
      venueId: feed.venueId,
      subject: `Your calendar link for ${venue} stopped working`,
      text: `We could not read the booking calendar for ${venue} since ${new Date(failingSince).toISOString().slice(0, 10)}. Stay messages use it to know when guests arrive and leave. Please copy the calendar link again from your booking site and save it in HeidiFi.`,
    });
  }
  return recorded;
}

/**
 * Runs one sync of a feed. The worker's `stay_poll` task, Sync now and the sandbox's
 * `/dev/stay-sync` all come here.
 */
export async function pollFeed(feedId: string, env: { now: number; settings: EngineSettings }, opts: PollOptions): Promise<PollResult> {
  const now = env.now;
  const first = await feedRef(feedId).get();
  if (!first.exists) return empty('no_feed'); // deleted: the chain ends here
  const initial = first.data() as StayFeedDoc;
  const tz = await venueTz(initial.venueId);
  const today = localDateKey(new Date(now), tz);

  if (modeFor(env.settings, initial.tenantUserId) === 'off') {
    // Stage 0 writes nothing. After on → off, only a feed with a linked stay that isn't over keeps going.
    const known = await loadFeedStays(feedId);
    if (!known.some((s) => isCurrentLinked(s, today))) return empty('off');
  }

  const who = { feedId, tenantUserId: initial.tenantUserId, venueId: initial.venueId };
  const arm = opts.kind === 'chain' || chainIsStale(initial.nextPollAt, now);
  const lease = await claimLease(feedId, opts.owner);
  if (!lease) {
    // Another poll is running. The chain must not end here, so it still re-arms.
    if (arm) {
      const at = await armNextPoll(who, now);
      await feedRef(feedId).update({ nextPollAt: new Date(at) }).catch(() => undefined);
      return { ...empty('busy'), nextPollAt: at };
    }
    return empty('busy');
  }
  const { feed, successSeq } = lease;
  // Arm first: whatever happens below, the chain goes on.
  const armedAt = arm ? await armNextPoll(who, now) : null;
  const armed = armedAt !== null ? { nextPollAt: armedAt } : {};
  // A refused write means a delete or another link's save overtook this poll: its result belongs to nobody.
  const failed = (recorded: boolean, code: string): PollResult => (recorded ? { ...empty('error'), errorCode: code, ...armed } : { ...empty('superseded'), ...armed });

  // ── Fetch + parse ──
  let fetched: FetchFeedResult;
  try {
    fetched = await fetchStayCalendar(feed.url, feed.etag ?? null);
  } catch (err) {
    const code = err instanceof FeedFetchError ? err.code : 'NETWORK';
    return failed(await recordError(feedId, opts.owner, successSeq, feed, code, { now, tz }, armedAt), code);
  }
  let parse: IcalParse | null = null;
  if (fetched.status === 200) {
    const body = fetched.body ?? Buffer.alloc(0);
    try {
      if (!looksLikeIcal(body)) throw new IcalParseError('NOT_ICAL');
      parse = parseIcal(body, tz);
    } catch (err) {
      const code = err instanceof IcalParseError ? err.code : 'PARSE_FAILED';
      return failed(await recordError(feedId, opts.owner, successSeq, feed, code, { now, tz }, armedAt), code);
    }
  } else if (fetched.status !== 304) {
    const code = statusCode(fetched.status);
    return failed(await recordError(feedId, opts.owner, successSeq, feed, code, { now, tz }, armedAt), code);
  }

  // Not an error: the fetch worked, the feed just can't give stays (D-C4). No misses.
  if (parse && isUnsupported(parse, Boolean(feed.reservedSeen))) {
    const recorded = await finishFeed(feedId, opts.owner, successSeq, feed.url, {
      lastPolledAt: new Date(now),
      lastSuccessAt: new Date(now),
      status: 'active',
      consecutiveErrors: 0,
      lastError: null,
      failingSince: null,
      feedWarning: 'unsupported_source',
      suspectSince: null,
      etag: null, // re-read in full next time, so it is judged again
      ...(armedAt !== null ? { nextPollAt: new Date(armedAt) } : {}),
    });
    if (!recorded) return { ...empty('superseded'), ...armed };
    return { ...empty('unsupported'), feedWarning: 'unsupported_source', ...armed };
  }

  // ── The sync ──
  const hash = parse ? staysHash(parse.stays, parse.skippedLongUids) : null;
  const unchanged = !parse || (Boolean(feed.lastContentHash) && hash === feed.lastContentHash);
  const known = await loadFeedStays(feedId);
  await opts.onRead?.();
  const c: SyncCtx = { feedId, feed, owner: opts.owner, tz, today, now, times: resolveStayTimes(await loadGuestInfo(feed.venueId)), lost: false };
  const countable = known.filter((s) => isCountable(s, today));
  const countableIds = new Set(countable.map((s) => s.id));
  let absent: string[];
  if (unchanged) {
    // A 304 has no body: the absent set is the last successful parse's, still countable.
    absent = (Array.isArray(feed.lastMissingStayIds) ? feed.lastMissingStayIds : []).filter((id) => countableIds.has(id));
  } else {
    // A reservation skipped only for being over 90 nights is still in the calendar: seen, not missing.
    const inContent = new Set([...parse!.stays.map((p) => p.uid), ...parse!.skippedLongUids].map((uid) => stayIdFor(feedId, uid)));
    absent = countable.filter((s) => !inContent.has(s.id)).map((s) => s.id);
  }
  // The owner saved a different link: bookings missing from it are expected, so no hold (D-C35).
  const lifted = tsMs(feed.guardLiftedAt) !== null;
  const sus = lifted ? { suspect: false, warning: null, suspectSince: null, raise: false } : suspectState(absent.length, tsMs(feed.suspectSince), now);
  const absentSet = new Set(absent);
  const result: PollResult = { ...empty('synced'), fetchStatus: fetched.status, unchanged, parsed: parse ? parse.stays.length : 0, feedWarning: sus.warning, ...armed };

  let work = 0;
  const tick = async () => {
    work += 1;
    if (work % 25 === 0) {
      await renewLease(feedId, opts.owner);
      await opts.onProgress?.().catch(() => undefined);
    }
  };
  const count = (k: UpsertDecision['kind']) => {
    if (k === 'create') result.created += 1;
    else if (k === 'change') result.changed += 1;
    else if (k === 'reinstate') result.reinstated += 1;
  };

  const byId = new Map(known.map((s) => [s.id, s]));
  // Most polls change nothing: a stay whose snapshot needs no write gets no transaction.
  // (The only other writer, a link, touches none of the fields this decides on.)
  // A stay that is in the content is seen, so its misses reset — also on a suspect parse:
  // that can't cancel anything; the guard only holds back the miss pass below.
  const upsert = async (id: string, p: { uid: string; checkIn: string; checkOut: string }) => {
    const before = byId.get(id) ?? null;
    const instants = stayInstants(p.checkIn, p.checkOut, tz, c.times);
    if (c.lost || (before && decideUpsert(before, p, instants, { today, now, resetMisses: true }).kind === 'none')) return;
    count(await applyUpsert(c, id, p, true));
    await tick();
  };
  if (!unchanged) {
    // New stays and date changes apply even on a suspect parse.
    for (const p of parse!.stays) await upsert(stayIdFor(feedId, p.uid), p);
    // A known stay extended past 90 nights: seen, kept at the dates it had.
    for (const uid of parse!.skippedLongUids) {
      const s = byId.get(stayIdFor(feedId, uid));
      if (s && s.status !== 'cancelled') await upsert(s.id, { uid, checkIn: s.checkIn, checkOut: s.checkOut });
    }
  } else {
    // The same content: the stays in it are seen again (misses reset), and a Guest info
    // check-in/out time change still moves them (D-C20).
    for (const s of known) {
      if (s.status === 'cancelled' || s.checkOut < today || absentSet.has(s.id)) continue;
      await upsert(s.id, { uid: s.externalUid, checkIn: s.checkIn, checkOut: s.checkOut });
    }
  }

  if (!sus.suspect) {
    for (const id of absent) {
      if (c.lost) break;
      const r = await applyMiss(c, id);
      if (r === 'miss') result.missed += 1;
      if (r === 'cancel') result.cancelled += 1;
      await tick();
    }
  }

  // ── Overlaps, on the stays as they are now — among the bookings in this content: one that
  // left the calendar (a cancel-and-rebook of the same dates, say) is on its way out, not an
  // overlap; it keeps the status it had until it is cancelled or comes back.
  const after = c.lost ? [] : await loadFeedStays(feedId);
  const present = after.filter((s) => !absentSet.has(s.id));
  const map = overlapMap(present, today);
  const flagged = new Set<string>();
  for (const s of present) {
    if (c.lost) break;
    if (s.status === 'cancelled' || s.checkOut < today) continue;
    const want = map.get(s.id) ?? [];
    if (s.status === 'confirmed' ? !want.length : JSON.stringify(s.overlapWith) === JSON.stringify(want)) continue; // nothing to change
    const r = await applyOverlap(c, s.id, want);
    if (r === 'flagged') flagged.add(s.id);
    await tick();
  }
  result.overlapsFlagged = flagged.size;
  if (c.lost) {
    // A delete or another link's save won: leave the feed to it (its lease, if still ours, is let go).
    await finishFeed(feedId, opts.owner, successSeq, feed.url, {}).catch(() => false);
    return { ...result, outcome: 'superseded' };
  }
  if (flagged.size) await alertOverlaps(c, after, flagged, map);

  const final = flagged.size ? await loadFeedStays(feedId) : after;
  // A booking missing from this (trusted) content is on its way out: not upcoming.
  result.upcoming = final.filter((s) => s.status === 'confirmed' && s.checkOutAt > now && (sus.suspect || !absentSet.has(s.id))).length;
  const committed = await finishFeed(feedId, opts.owner, successSeq, feed.url, {
    lastPolledAt: new Date(now),
    lastSuccessAt: new Date(now),
    status: 'active',
    consecutiveErrors: 0,
    lastError: null,
    failingSince: null,
    etag: fetched.etag ?? feed.etag ?? null,
    lastContentHash: unchanged ? feed.lastContentHash ?? hash : hash,
    lastMissingStayIds: absent,
    reservedSeen: Boolean(feed.reservedSeen) || (parse ? parse.stays.length > 0 : false),
    feedWarning: sus.warning,
    suspectSince: sus.suspectSince !== null ? new Date(sus.suspectSince) : null,
    // Back to normal (fewer than two missing): the next mass disappearance is held again.
    ...(lifted && absent.length < 2 ? { guardLiftedAt: null } : {}),
    upcomingCount: result.upcoming,
    overlapCount: final.filter((s) => s.status === 'overlap_flagged' && s.checkOut >= today).length,
    successSeq: successSeq + 1,
    ...(armedAt !== null ? { nextPollAt: new Date(armedAt) } : {}),
  });
  // Deleted, re-leased or saved with another link after the last stay write: nothing was recorded.
  if (!committed) return { ...result, outcome: 'superseded' };

  if (sus.raise) {
    const ctx = await loadVenueContext(feed.venueId);
    await raiseAlert({
      kind: 'stay_feed_suspect',
      dedupeKey: `stay_feed_suspect:${feedId}:${sus.suspectSince}`,
      audience: 'heidifi',
      tenantUserId: feed.tenantUserId,
      venueId: feed.venueId,
      subject: `Adaptive: ${absent.length} bookings vanished at once from ${ctx?.venueName || feed.venueId}'s calendar`,
      text: `${absent.length} upcoming bookings disappeared from the calendar feed of ${ctx?.venueName || feed.venueId} in one sync. They are not treated as cancelled for 24 hours (or until the owner saves another calendar link): a wrong link, a changed format or a cut-off file looks the same. Check the feed.`,
    });
  }
  return result;
}

/**
 * The watchdog (worker start, then hourly): restarts a feed chain that stopped — its
 * `nextPollAt` missing (a feed saved while the account was off, the demo feed) or over an
 * hour overdue — for accounts that aren't off. It only reads while they are off. With the
 * grid, restarting a live chain lands on its existing task and does nothing.
 */
export async function stayFeedWatchdog(env: { now: number; settings: EngineSettings }): Promise<number> {
  const snap = await watchedFeedsQuery().get();
  let armed = 0;
  for (const d of snap.docs) {
    const feed = d.data() as StayFeedDoc;
    if (modeFor(env.settings, feed.tenantUserId) === 'off') continue;
    if (!chainIsStale(feed.nextPollAt, env.now)) continue;
    try {
      const at = await armNextPoll({ feedId: d.id, tenantUserId: feed.tenantUserId, venueId: feed.venueId }, env.now);
      await d.ref.update({ nextPollAt: new Date(at) });
      armed += 1;
    } catch (err) {
      // e.g. the feed was deleted meanwhile (its orphan task finds no feed and stops): the others still get their turn.
      console.warn('[ADAPTIVE] stay feed watchdog: one feed skipped:', (err as { code?: unknown })?.code ?? 'error');
    }
  }
  return armed;
}

