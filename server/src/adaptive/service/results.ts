/**
 * The owner's running-card numbers (plan §5: `GET /tenants/:t/results?venueId&from&to`; PR D),
 * read from the daily `CaptivePortal_JourneyStats` docs by id (no index). Also behind the MCP
 * tool `get_adaptive_results`.
 *
 *  - One venue, or every Adaptive venue of the account in one call (the running cards).
 *  - Venue-local dates, at most 92 days, default the last 30 (engine clock).
 *  - Test runs apart (`testRun`), never in the live numbers.
 *  - Revenue at read time: came back × the venue's average spend (D-D2).
 *  - "Waiting for credits": the wallet can't pay one message while a marketing playbook runs,
 *    and how many sends started waiting for credits in the last 72 h.
 */

import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, adaptiveVenueId, stayFeedId } from '../store/collections';
import type { AdaptiveVenueDoc, VenuePlaybookDoc } from '../store/types';
import { ApiError } from '../api/errors';
import { getVenues } from '../store/tenantData';
import { listAdaptiveVenues } from '../store/venueSetups';
import { loadCatalogue, templateVersion } from './catalogue';
import { pickLang } from '../core/schemas';
import { localDateKey, HOUR_MS } from '../core/runtime/time';
import { isValidTimeZone } from '../core/runtime/time';
import { statsDocId } from '../rollups/journeyStats';
import { now, refreshClock } from '../engine/clock';
import { modeFor, readEngineSettings } from '../store/engineSettings';
import { getCreditConfig, getWalletSnapshot } from '../../services/credits';
import { spendableForChannel } from '../../services/creditBuckets';
import { accountCreditWaitQuery, venueEventsOfTypesQuery, venueSetupsQuery } from './../store/ownerQueries';
import { cardNumbers, dayKeyOf, resultsRange, RETURN_VISIT_GOALS, sumStats, waitingByVenue, type CreditBudget, type NumMap } from '../core/owner/results';
import { SHARED_KEY } from '../../services/creditBuckets';

const VENUE_KEY = '_venue';
const MAX_VENUES = 50;
const CREDIT_WAIT_WINDOW_MS = 72 * HOUR_MS;
/** Deferrals read per venue for the 72 h count (pages of 200); past it the count says "at least". */
const CREDIT_WAIT_PAGE = 200;
const CREDIT_WAIT_PAGES = 5;

async function getAllChunked(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => db.collection(COL.journeyStats).doc(id));
    if (!refs.length) continue;
    for (const s of await db.getAll(...refs)) if (s.exists) out.set(s.id, s.data() as Record<string, unknown>);
  }
  return out;
}

interface JourneyInfo {
  journeyKey: string;
  name: string;
  returnVisit: boolean;
}

/** The journeys this venue has set up (any playbook, any state), with whether their goal is a return visit. */
async function venueJourneys(venueId: string): Promise<JourneyInfo[]> {
  const [snap, cat] = await Promise.all([venueSetupsQuery(venueId).get(), loadCatalogue()]);
  const out = new Map<string, JourneyInfo>();
  for (const d of snap.docs) {
    const setup = d.data() as VenuePlaybookDoc;
    for (const [journeyKey, jc] of Object.entries(setup.journeys ?? {})) {
      if (out.has(journeyKey)) continue;
      const found = templateVersion(cat, journeyKey, jc.templateVersion);
      const goal = found?.definition.goal?.event ?? null;
      out.set(journeyKey, {
        journeyKey,
        name: pickLang(found?.record.header.name ?? { en: journeyKey }, 'en'),
        returnVisit: goal !== null && RETURN_VISIT_GOALS.includes(goal),
      });
    }
  }
  return [...out.values()];
}

/**
 * "Waiting for credits": messages waiting for credits right now (the journeys' own wait state),
 * or a wallet that can't pay one message while a marketing playbook runs; and how many sends
 * started waiting for credits in the last 72 h (every deferral read, up to a cap — past it the
 * count is marked `startedWaitingLast72hTruncated`).
 */
interface Wallet {
  /** Can't pay one message on either channel (only said while the account is live). */
  low: boolean;
  /** Its credits as the engine spends them (core/owner/results.ts `waitingByVenue`). */
  budget: CreditBudget;
}

const WAITING_READ = 1000;

/**
 * The account's messages that couldn't be paid at their last look, measured again against the
 * wallet now (a top-up shows at once, not only at each message's next look): one budget for the
 * whole account, per venue. Truncated: more were flagged than read (those count as waiting).
 */
async function accountWaits(tenantUserId: string, wallet: Wallet | null): Promise<{ byVenue: Map<string, number>; truncated: boolean; failed: boolean }> {
  try {
    // One more than we use: exactly WAITING_READ flagged isn't "cut off".
    const snap = await accountCreditWaitQuery(tenantUserId).select('venueId', 'waiting.creditsShortFor').limit(WAITING_READ + 1).get();
    const flagged = snap.docs.slice(0, WAITING_READ).map((d) => {
      const f = d.get('waiting.creditsShortFor') as { channel?: unknown; price?: unknown } | undefined;
      return { venueId: String(d.get('venueId') ?? ''), channel: typeof f?.channel === 'string' ? f.channel : null, price: typeof f?.price === 'number' ? f.price : null };
    });
    return { byVenue: waitingByVenue(flagged, wallet?.budget ?? null), truncated: snap.size > WAITING_READ, failed: false };
  } catch (err) {
    console.error('[ADAPTIVE] credit-wait lookup failed:', (err as Error)?.name ?? 'Error');
    return { byVenue: new Map(), truncated: false, failed: true };
  }
}

async function creditWait(tenantUserId: string, venueId: string, marketingOn: boolean, t: number, wallet: Wallet | null, waits: { byVenue: Map<string, number>; truncated: boolean; failed: boolean }) {
  const waitingNow = waits.byVenue.get(venueId) ?? 0;
  const waitingTruncated = waits.truncated;
  // The flagged messages couldn't be read: say so, never "nothing is waiting".
  const waitingUnknown = waits.failed;
  // One message waiting across nights writes a credits deferral each morning: count messages, not events.
  const waited = new Set<string>();
  let truncated = false;
  try {
    const base = venueEventsOfTypesQuery(venueId, ['send.deferred'], new Date(t - CREDIT_WAIT_WINDOW_MS))
      .orderBy(FieldPath.documentId(), 'desc')
      .select('tenantUserId', 'sendKey', 'data.decision.reason', 'data.reason', 'occurredAt');
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (let page = 0; page < CREDIT_WAIT_PAGES; page += 1) {
      const snap: FirebaseFirestore.QuerySnapshot = await (last ? base.startAfter(last) : base).limit(CREDIT_WAIT_PAGE).get();
      for (const d of snap.docs) {
        if (d.get('tenantUserId') === tenantUserId && (d.get('data.decision.reason') === 'credits' || d.get('data.reason') === 'credits')) waited.add(String(d.get('sendKey') ?? d.id));
      }
      if (snap.size < CREDIT_WAIT_PAGE) break;
      last = snap.docs[snap.docs.length - 1];
      if (page === CREDIT_WAIT_PAGES - 1) truncated = true;
    }
  } catch (err) {
    console.error('[ADAPTIVE] credit-wait count failed:', (err as Error)?.name ?? 'Error');
  }
  const lowBalance = marketingOn && Boolean(wallet?.low);
  return {
    // Cut off or unread: those messages may not be payable either.
    waiting: waitingNow > 0 || waitingTruncated || waitingUnknown || lowBalance,
    lowBalance,
    messagesWaiting: waitingNow,
    ...(waitingTruncated ? { messagesWaitingTruncated: true } : {}),
    ...(waitingUnknown ? { messagesWaitingUnknown: true } : {}),
    startedWaitingLast72h: waited.size,
    ...(truncated ? { startedWaitingLast72hTruncated: true } : {}),
  };
}

export async function getResults(tenantUserId: string, query: { venueId?: unknown; from?: unknown; to?: unknown; journeys?: unknown }) {
  let venueDocs: AdaptiveVenueDoc[];
  if (typeof query.venueId === 'string' && query.venueId) {
    // Our id characters only: a `/` would reach Firestore as a path (a 500, not an answer).
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(query.venueId)) throw new ApiError('bad_request', 'venueId is not valid');
    const v = (await getVenues([query.venueId])).get(query.venueId);
    if (!v || v.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${query.venueId} was not found in this account`);
    const av = await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(query.venueId)).get();
    // A venue moved here from another account keeps that account's setup doc: not set up here yet.
    venueDocs = av.exists && av.get('tenantUserId') === tenantUserId ? [av.data() as AdaptiveVenueDoc] : [];
    if (!venueDocs.length) return { venues: [], range: null };
  } else {
    venueDocs = (await listAdaptiveVenues(tenantUserId)).slice(0, MAX_VENUES);
  }
  const withJourneys = query.journeys === '1' || query.journeys === 'true' || query.journeys === true;
  await refreshClock();
  const t = now();
  const venues = await getVenues(venueDocs.map((a) => a.venueId));
  // A venue moved to another account keeps its old AdaptiveVenues doc: only venues this account owns now.
  venueDocs = venueDocs.filter((a) => a.tenantUserId === tenantUserId && venues.get(a.venueId)?.tenantUserId === tenantUserId);

  // The wallet once for the account: can it pay one message on either channel?
  const settings = await readEngineSettings();
  // Read whatever the launch mode: live journeys keep waiting after an account is moved to off or
  // test. "Low balance" is only said while the account is live (a test run charges nothing).
  let wallet: Wallet | null = null;
  const accountLive = modeFor(settings, tenantUserId) === 'live';
  try {
    const [w, rate] = await Promise.all([getWalletSnapshot(tenantUserId), getCreditConfig()]);
    const spendable = (ch: 'sms' | 'email') => (w.suspended ? 0 : spendableForChannel(w.channelBalances, ch));
    const own: Record<string, number> = {};
    for (const [k, v] of Object.entries(w.channelSpendable ?? {})) if (k !== SHARED_KEY) own[k] = w.suspended ? 0 : Number(v) || 0;
    wallet = {
      low: accountLive && spendable('sms') < rate.channelRates.sms.creditsPerSegment && spendable('email') < rate.channelRates.email.creditsPerMessage,
      budget: { own, shared: w.suspended ? 0 : Number(w.channelSpendable?.[SHARED_KEY]) || 0 },
    };
  } catch {
    wallet = null;
  }
  const waits = await accountWaits(tenantUserId, wallet);

  const ranges: Array<{ from: string; to: string }> = [];
  const out = [];
  for (const av of venueDocs) {
    const venue = venues.get(av.venueId);
    const tz = [av.timezone, venue?.timezone].find((z) => isValidTimeZone(z)) ?? 'Europe/Zurich';
    const r = resultsRange(query.from, query.to, localDateKey(new Date(t), tz));
    if ('error' in r) throw new ApiError('bad_request', r.error);
    ranges.push({ from: r.from, to: r.to });
    const journeys = await venueJourneys(av.venueId);
    const keys = [VENUE_KEY, ...journeys.filter((j) => j.returnVisit || withJourneys).map((j) => j.journeyKey)];
    const ids = keys.flatMap((k) => r.days.map((d) => statsDocId(av.venueId, k, dayKeyOf(d))));
    const docs = await getAllChunked(ids);
    // A venue that moved to another account keeps its old numbers under the old account: skip them.
    const mine = (k: string) => r.days.map((d) => docs.get(statsDocId(av.venueId, k, dayKeyOf(d)))).filter((d) => d && d.tenantUserId === tenantUserId);
    const venueSum = sumStats(mine(VENUE_KEY));
    const perJourney = new Map(journeys.map((j) => [j.journeyKey, sumStats(mine(j.journeyKey))]));
    const conv = (which: 'live' | 'testRun') =>
      journeys.filter((j) => j.returnVisit).reduce((s, j) => s + (Number(perJourney.get(j.journeyKey)?.[which].converted) || 0), 0);
    const feed = av.venueId ? await db.collection(COL.stayFeeds).doc(stayFeedId(av.venueId)).get() : null;
    const upcoming = feed?.exists ? Number(feed.get('upcomingCount')) || 0 : null;
    out.push({
      venueId: av.venueId,
      name: venue?.name ?? null,
      timezone: tz,
      // Each venue's own window: its local dates (venues in other time zones can differ by a day).
      range: { from: r.from, to: r.to },
      card: cardNumbers({ venue: venueSum.live, returnConversions: conv('live'), averageSpend: av.avgSpendPerVisit ?? null, upcomingStays: upcoming }),
      testRun: cardNumbers({ venue: venueSum.testRun, returnConversions: conv('testRun'), averageSpend: av.avgSpendPerVisit ?? null, upcomingStays: null }),
      waitingForCredits: await creditWait(tenantUserId, av.venueId, av.status === 'on' && Boolean(av.activePlaybookKey), t, wallet, waits),
      ...(withJourneys
        ? {
            journeys: journeys.map((j) => {
              const s = perJourney.get(j.journeyKey)!;
              return { journeyKey: j.journeyKey, name: j.name, returnVisit: j.returnVisit, live: s.live as NumMap, testRun: s.testRun as NumMap };
            }),
          }
        : {}),
    });
  }
  // One shared window when every venue has the same one (always with from/to given, or one venue).
  const same = ranges.length > 0 && ranges.every((x) => x.from === ranges[0].from && x.to === ranges[0].to);
  return { range: same ? ranges[0] : null, ...(ranges.length && !same ? { rangesDiffer: true } : {}), venues: out };
}
