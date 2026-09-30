/**
 * The bandit's learner (PR F1, 04-engine-runtime §9.2; the brief's DF1 and DF13). The only
 * writer of `CaptivePortal_BanditArms`. Never on the send path, never imports `send/`.
 *
 * Per venue (`learn_arms`, bandit/tasks.ts):
 *  1. Events — the venue's log from the learner's own watermark (`BanditArms/learn_{venueId}`),
 *     in commit order, 2 minutes behind real time (the rollup's query and index). Pulls and the
 *     reactions the admin numbers show (core/runtime/banditLearn.ts); a click, a rating, a return
 *     visit and an unsubscribe are also remembered per send in the state doc's `facts`.
 *  2. Closing — once the log is caught up, the venue's live sends older than 7 days + 12 hours
 *     (engine clock), from its own mark (`JourneySends(venueId, mode, createdAt)`, an existing
 *     index): one more finished send each and its whole reward (α for its click, rating and
 *     visit; β+1 without a click, β+10 for an unsubscribe or an SMS STOP it caused). The draw
 *     sees finished sends only.
 *  One transaction per page re-reads the mark (and, closing, the facts), adds the deltas and
 *  moves the mark: a page is counted exactly once, so re-running changes nothing and two workers
 *  can't double count. A venue's first run starts 15 days back (nothing older can train: the
 *  bandit wasn't on yet). `facts.visitCredits` (journeys credited with a return visit) is kept 30
 *  days, the per-send facts 15; each map keeps at most 3,000 entries (the oldest go first), so the
 *  state doc stays far under Firestore's 1 MiB even at the venue send cap.
 *  3. Once a week per step: the data part drifts (× 0.95) and hopeless wordings retire (only
 *     today's texts compete).
 *
 * `learn_pool`, daily (the worker arms it while the bandit is on anywhere): every pooled doc
 * rebuilt from scratch from all venues' docs, and pooled docs no venue has any more deleted (no
 * tenant on them, so a deleted account's share drops out within a day).
 */

import { FieldPath, FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import { tsMs } from '../store/time';
import { SCHEMA_VERSION } from '../core/constants';
import { banditArmsIdFor, banditLearnIdFor, banditPoolIdFor } from '../core/runtime/ids';
import { readBanditBlock, type ArmBlock, type Segment } from '../core/runtime/bandit';
import { DAY_MS } from '../core/runtime/time';
import {
  CLOSE_MARGIN_MS,
  LEARN_WINDOW_MS,
  deltasForClose,
  deltasForEvent,
  deltasForVisit,
  applyRetire,
  drifted,
  groupDeltas,
  isPenalty,
  poolFrom,
  toRetire,
  type ArmDelta,
  type Delta,
  type LearnSend,
} from '../core/runtime/banditLearn';
import { ROLLUP_LAG_MS, venueEventsQuery } from '../rollups/rollup';
import { __clearBanditArmsCache, clearBanditArmsFor, poolFresh } from '../engine/banditArms';
import { loadCatalogue, type Catalogue } from '../service/catalogue';
import { currentArmKeys } from './steps';

const PAGE = 200;
const MAX_PAGES = 10;
const CREDIT_KEEP_MS = 30 * DAY_MS;
/** A send's facts wait for its close (7 days + 12 hours), with room for a late run. */
const FACT_KEEP_MS = 15 * DAY_MS;
/** Entries per `facts` map (~44 bytes each): 5 maps stay under ~700 KB of the state doc. */
const MAX_FACT_ENTRIES = 3_000;
const DRIFT_EVERY_MS = 7 * DAY_MS;
/** A venue's first run looks this far back (events by commit time, sends by engine time). */
const FIRST_LOOK_BACK_MS = 15 * DAY_MS;
/** Parallel reads of guests' sends (return visits). */
const VISIT_READS = 8;
const arms = () => db.collection(COL.banditArms);

interface Mark {
  at: Timestamp;
  id: string;
}

function readMark(v: unknown): Mark | null {
  const m = v as { at?: unknown; id?: unknown } | undefined;
  return m && m.at instanceof Timestamp && typeof m.id === 'string' ? { at: m.at, id: m.id } : null;
}

const sameMark = (a: Mark | null, b: Mark | null) => (!a || !b ? a === b : a.id === b.id && a.at.isEqual(b.at));

export function toLearnSend(id: string, d: Record<string, any>): LearnSend {
  return {
    sendKey: id,
    mode: d.mode === 'live' ? 'live' : 'test',
    purpose: d.purpose === 'service' ? 'service' : 'marketing',
    status: String(d.status ?? ''),
    channel: String(d.channel ?? ''),
    journeyKey: String(d.journeyKey ?? ''),
    nodeId: String(d.nodeId ?? ''),
    instanceId: String(d.instanceId ?? ''),
    sentAt: tsMs(d.sentAt),
    firstClickAt: tsMs(d.engagement?.firstClickAt),
    bandit: readBanditBlock(d.bandit),
  };
}

const FIELD: Record<keyof ArmDelta, string[]> = {
  a: ['a'],
  b: ['b'],
  pulls: ['pulls'],
  closed: ['closed'],
  click: ['rewards', 'click'],
  visit: ['rewards', 'visit'],
  rating: ['rewards', 'rating'],
  unsub: ['penalties', 'unsub'],
};

/** Deltas as nested `increment`s for `set(…, {merge: true})` (arm keys like `v:3f9a…` are map keys, not paths). */
function incrementTree(blocks: Record<string, Record<string, Record<string, ArmDelta>>>): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [seg, kinds] of Object.entries(blocks)) {
    for (const [kind, armsOf] of Object.entries(kinds)) {
      for (const [arm, d] of Object.entries(armsOf)) {
        const node = (((out[seg] ??= {})[kind] ??= {})[arm] ??= {});
        for (const [k, v] of Object.entries(d) as Array<[keyof ArmDelta, number]>) {
          if (!v) continue;
          const path = FIELD[k];
          if (path.length === 1) node[path[0]] = FieldValue.increment(v);
          else (node[path[0]] ??= {})[path[1]] = FieldValue.increment(v);
        }
      }
    }
  }
  return out;
}

function writeDeltas(tx: Transaction, venueId: string, tenantUserId: string, deltas: Delta[]): void {
  for (const doc of groupDeltas(deltas).values()) {
    tx.set(
      arms().doc(banditArmsIdFor(venueId, doc.journeyKey, doc.nodeId)),
      { scope: 'venue', tenantUserId, venueId, journeyKey: doc.journeyKey, nodeId: doc.nodeId, segments: incrementTree(doc.blocks), updatedAt: new Date(), schemaVersion: SCHEMA_VERSION },
      { merge: true },
    );
  }
}

async function sendsByKey(keys: string[]): Promise<Map<string, LearnSend>> {
  const out = new Map<string, LearnSend>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 100) {
    const snaps = await db.getAll(...unique.slice(i, i + 100).map((k) => db.collection(COL.journeySends).doc(k)));
    for (const s of snaps) if (s.exists) out.set(s.id, toLearnSend(s.id, s.data() as Record<string, any>));
  }
  return out;
}

/** The guest's sends at this venue (equality on contactId: an index the worker already probes). */
async function contactSendsAt(contactId: string, venueId: string): Promise<LearnSend[]> {
  const snap = await db.collection(COL.journeySends).where('contactId', '==', contactId).get();
  return snap.docs.filter((d) => d.get('venueId') === venueId).map((d) => toLearnSend(d.id, d.data() as Record<string, any>));
}

/** Every contact's sends at the venue, a few reads at a time (one read per guest per run). */
async function sendsOfContacts(contactIds: string[], venueId: string, cache: Map<string, LearnSend[]>): Promise<void> {
  const todo = [...new Set(contactIds)].filter((c) => !cache.has(c));
  for (let i = 0; i < todo.length; i += VISIT_READS) {
    const chunk = todo.slice(i, i + VISIT_READS);
    const got = await Promise.all(chunk.map((c) => contactSendsAt(c, venueId)));
    chunk.forEach((c, j) => cache.set(c, got[j]));
  }
}

/**
 * A `{id: date}` map's change: ids older than `keepMs` deleted, new ids dated — only the fields
 * that change, or null (never `{}`: an empty map in a merge would wipe the stored one).
 */
function mapUpdate(stored: Record<string, unknown> | undefined, added: string[], engineNow: number, keepMs: number): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const kept: Array<[string, number]> = [];
  for (const [id, at] of Object.entries(stored ?? {})) {
    const ms = tsMs(at) ?? 0;
    if (engineNow - ms > keepMs) out[id] = FieldValue.delete();
    else if (!added.includes(id)) kept.push([id, ms]);
  }
  // Past the cap the oldest go first (a guard: realistic venues stay far below it).
  const over = kept.length + new Set(added).size - MAX_FACT_ENTRIES;
  if (over > 0) {
    console.warn(`[ADAPTIVE] bandit learner facts at the cap (${MAX_FACT_ENTRIES}): the ${over} oldest dropped`);
    for (const [id] of kept.sort((x, y) => x[1] - y[1]).slice(0, over)) out[id] = FieldValue.delete();
  }
  for (const id of added) out[id] = new Date(engineNow);
  return Object.keys(out).length ? out : null;
}

/** The learner's memory in the state doc (`facts`): journeys credited with a visit, sends clicked, rated, visited, penalized. */
interface Facts {
  visitCredits?: Record<string, unknown>;
  clicked?: Record<string, unknown>;
  rated?: Record<string, unknown>;
  visited?: Record<string, unknown>;
  penalized?: Record<string, unknown>;
}

const has = (m: Record<string, unknown> | undefined, key: string) => Boolean(m && Object.prototype.hasOwnProperty.call(m, key));

export interface LearnResult {
  events: number;
  closed: number;
  drifted: number;
  retired: number;
  more: boolean;
}

/**
 * One learner run for a venue. `cutoffMs` (real time) defaults to now − 2 min, like the rollup.
 * `onProgress` runs after every page (the worker extends its lease). `closeUntil` (engine time,
 * the task's due time) caps what closes: after an outage, the overdue run doesn't close sends
 * whose signals from the outage are still queued behind it.
 */
export async function learnVenue(
  venueId: string,
  opts: { engineNow: number; tenantUserId?: string | null; cutoffMs?: number; pageSize?: number; onProgress?: () => Promise<unknown>; closeUntil?: number },
): Promise<LearnResult> {
  const pageSize = opts.pageSize ?? PAGE;
  const stateRef = arms().doc(banditLearnIdFor(venueId));
  const cutoff = new Date(opts.cutoffMs ?? Date.now() - ROLLUP_LAG_MS);
  const progress = () => (opts.onProgress ? opts.onProgress().catch(() => undefined) : Promise.resolve());
  const guestSends = new Map<string, LearnSend[]>();
  let tenantUserId = opts.tenantUserId ?? null;
  let events = 0;
  let closed = 0;
  let more = false;
  let caughtUp = false;

  // ── 1. Events ──
  for (let round = 0, pages = 0; round < MAX_PAGES * 3 && pages < MAX_PAGES; round += 1) {
    const state = await stateRef.get();
    const from = readMark(state.get('events'));
    const facts = (state.get('facts') ?? {}) as Facts;
    let q = venueEventsQuery(venueId, cutoff, from ? { at: from.at, eventId: from.id } : null, pageSize);
    if (!from) q = q.where('recordedAt', '>=', new Date(cutoff.getTime() - FIRST_LOOK_BACK_MS));
    const page = await q.get();
    if (page.empty) {
      caughtUp = true;
      break;
    }
    const evs = page.docs.map((d) => ({
      id: d.id,
      type: String(d.get('type') ?? ''),
      sendKey: (d.get('sendKey') as string | null) ?? null,
      contactId: (d.get('contactId') as string | null) ?? null,
      occurredAt: tsMs(d.get('occurredAt')) ?? 0,
      data: (d.get('data') ?? {}) as Record<string, unknown>,
      tenantUserId: (d.get('tenantUserId') as string | null) ?? null,
    }));
    tenantUserId ??= evs.map((e) => e.tenantUserId).find((t): t is string => typeof t === 'string') ?? null;
    const sends = await sendsByKey(evs.map((e) => e.sendKey).filter((k): k is string => typeof k === 'string' && k.startsWith('js_')));
    // A first visit follows no send at this venue: only return visits need the guest's sends.
    const visits = evs.filter((e) => e.type === 'visit.started' && e.contactId && e.data.isFirstVisit !== true);
    await sendsOfContacts(visits.map((e) => e.contactId!), venueId, guestSends);
    const credited = new Set(Object.keys(facts.visitCredits ?? {}));
    const penalized = new Set(Object.keys(facts.penalized ?? {}));
    const rated = new Set(Object.keys(facts.rated ?? {}));
    const clickedSet = new Set(Object.keys(facts.clicked ?? {}));
    const add = { visitCredits: [] as string[], clicked: [] as string[], penalized: [] as string[], rated: [] as string[], visited: [] as string[] };
    const deltas: Delta[] = [];
    for (const e of evs) {
      if (e.type === 'visit.started') {
        if (!e.contactId || e.data.isFirstVisit === true) continue;
        const r = deltasForVisit(e.occurredAt, guestSends.get(e.contactId) ?? [], credited);
        deltas.push(...r.deltas);
        for (const i of r.instances) {
          credited.add(i);
          add.visitCredits.push(i);
        }
        add.visited.push(...r.sends);
      } else if (e.sendKey) {
        const ds = deltasForEvent(e, sends.get(e.sendKey) ?? null);
        if (!ds.length) continue;
        // An unsubscribe and a spam report for one email are one penalty; two rating links one rating.
        const once = isPenalty(e)
          ? { seen: penalized, into: add.penalized }
          : e.type === 'rating.submitted'
            ? { seen: rated, into: add.rated }
            : e.type === 'message.clicked'
              ? { seen: clickedSet, into: add.clicked }
              : null;
        if (once) {
          if (once.seen.has(e.sendKey)) continue;
          once.seen.add(e.sendKey);
          once.into.push(e.sendKey);
        }
        deltas.push(...ds);
      }
    }
    const last = page.docs[page.docs.length - 1];
    const to: Mark = { at: last.get('recordedAt') as Timestamp, id: last.id };
    const owner = tenantUserId;
    const counted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!sameMark(readMark(snap.get('events')), from)) return false;
      if (owner) writeDeltas(tx, venueId, owner, deltas);
      const stored = (snap.get('facts') ?? {}) as Facts;
      const change: Record<string, unknown> = {};
      for (const [k, keep] of [['visitCredits', CREDIT_KEEP_MS], ['clicked', FACT_KEEP_MS], ['penalized', FACT_KEEP_MS], ['rated', FACT_KEEP_MS], ['visited', FACT_KEEP_MS]] as const) {
        const m = mapUpdate(stored[k], add[k], opts.engineNow, keep);
        if (m) change[k] = m;
      }
      tx.set(
        stateRef,
        { scope: 'learn', tenantUserId: owner, venueId, events: to, ...(Object.keys(change).length ? { facts: change } : {}), updatedAt: new Date(), schemaVersion: SCHEMA_VERSION },
        { merge: true },
      );
      return true;
    });
    if (!counted) continue;
    pages += 1;
    events += page.size;
    await progress();
    if (page.size < pageSize) {
      caughtUp = true;
      break;
    }
    if (pages >= MAX_PAGES) more = true;
  }

  // ── 2. Closing ── (only once the log is caught up: a send's facts must be in before its reward lands)
  const closeBefore = new Date(Math.min(opts.engineNow, opts.closeUntil ?? opts.engineNow) - LEARN_WINDOW_MS - CLOSE_MARGIN_MS);
  for (let round = 0, pages = 0; caughtUp && round < MAX_PAGES * 3 && pages < MAX_PAGES; round += 1) {
    const state = await stateRef.get();
    const from = readMark(state.get('closed'));
    let q = db
      .collection(COL.journeySends)
      .where('venueId', '==', venueId)
      .where('mode', '==', 'live')
      .where('createdAt', '<', closeBefore)
      .orderBy('createdAt')
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (from) q = q.startAfter(from.at, from.id);
    else q = q.where('createdAt', '>=', new Date(opts.engineNow - FIRST_LOOK_BACK_MS));
    const page = await q.get();
    if (page.empty) break;
    const docs = page.docs.map((d) => ({ d, s: toLearnSend(d.id, d.data() as Record<string, any>) }));
    tenantUserId ??= docs.map(({ d }) => d.get('tenantUserId') as string | null).find((t): t is string => typeof t === 'string') ?? null;
    // The phone numbers of the SMS that train, read together (an SMS STOP counts at close).
    const pointIds = [...new Set(docs.filter(({ s, d }) => s.bandit && s.channel === 'sms' && typeof d.get('toPointId') === 'string').map(({ d }) => d.get('toPointId') as string))];
    const points = new Map<string, DocumentSnapshot>();
    for (let i = 0; i < pointIds.length; i += 100) {
      for (const cp of await db.getAll(...pointIds.slice(i, i + 100).map((id) => db.collection(COL.contactPoints).doc(id)))) points.set(cp.id, cp);
    }
    const phones = new Map<string, { stopAt: number | null; lastLiveSmsKey: string | null }>();
    for (const { d, s } of docs) {
      const cp = s.bandit && s.channel === 'sms' ? points.get(d.get('toPointId') as string) : undefined;
      if (!cp?.exists) continue;
      const sms = cp.get('suppression.sms') as { reason?: string; at?: unknown } | undefined;
      phones.set(s.sendKey, { stopAt: sms?.reason === 'stop' ? tsMs(sms.at) : null, lastLiveSmsKey: (cp.get('lastLiveSms.sendKey') as string | undefined) ?? null });
    }
    const last = page.docs[page.docs.length - 1];
    const to: Mark = { at: last.get('createdAt') as Timestamp, id: last.id };
    const owner = tenantUserId;
    const counted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!sameMark(readMark(snap.get('closed')), from)) return false;
      // The facts as this transaction reads them: a rating counted by a concurrent run retries this one.
      const f = (snap.get('facts') ?? {}) as Facts;
      const deltas: Delta[] = [];
      for (const { s } of docs) {
        if (!s.bandit) continue;
        deltas.push(
          ...deltasForClose(s, phones.get(s.sendKey) ?? null, {
            clicked: has(f.clicked, s.sendKey),
            rated: has(f.rated, s.sendKey),
            visited: has(f.visited, s.sendKey),
            penalized: has(f.penalized, s.sendKey),
          }),
        );
      }
      if (owner) writeDeltas(tx, venueId, owner, deltas);
      tx.set(stateRef, { scope: 'learn', tenantUserId: owner, venueId, closed: to, updatedAt: new Date(), schemaVersion: SCHEMA_VERSION }, { merge: true });
      return true;
    });
    if (!counted) continue;
    pages += 1;
    closed += page.size;
    await progress();
    if (page.size < pageSize) break;
    if (pages >= MAX_PAGES) more = true;
  }

  // ── 3. Weekly drift and retire ──
  const weekly = await driftAndRetire(venueId, opts.engineNow);
  clearBanditArmsFor(venueId);
  return { events, closed, drifted: weekly.drifted, retired: weekly.retired, more };
}

async function driftAndRetire(venueId: string, engineNow: number): Promise<{ drifted: number; retired: number }> {
  const docs = await arms().where('venueId', '==', venueId).get();
  let driftedDocs = 0;
  let retired = 0;
  let cat: Catalogue | null = null;
  for (const doc of docs.docs) {
    if (doc.get('scope') !== 'venue') continue;
    const due = tsMs(doc.get('lastDriftAt'));
    if (due !== null && engineNow - due < DRIFT_EVERY_MS) continue;
    // Today's texts of the step (read once per run, only when a drift is due); unknown → nothing retires.
    if (due !== null) cat ??= await loadCatalogue().catch(() => null);
    const current = cat ? currentArmKeys(cat, String(doc.get('journeyKey')), String(doc.get('nodeId'))) : null;
    // Counted from the committed attempt only (a retried transaction runs this body again).
    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      // Deleted since the query (an account delete): never write it back.
      if (!snap.exists) return { drifted: 0, retired: 0 };
      const last = tsMs(snap.get('lastDriftAt'));
      if (last === null) {
        tx.set(doc.ref, { lastDriftAt: new Date(engineNow) }, { merge: true });
        return { drifted: 0, retired: 0 };
      }
      if (engineNow - last < DRIFT_EVERY_MS) return { drifted: 0, retired: 0 };
      const segments = (snap.get('segments') ?? {}) as Partial<Record<Segment | 'all', ArmBlock>>;
      const next: Partial<Record<Segment | 'all', ArmBlock>> = {};
      for (const [seg, block] of Object.entries(segments) as Array<[Segment | 'all', ArmBlock]>) next[seg] = drifted(block);
      const pool = await tx.get(arms().doc(banditPoolIdFor(String(snap.get('journeyKey')), String(snap.get('nodeId')))));
      // The priors the pick would use: a pool not rebuilt for 48 hours is left out there too.
      const pooled = (pool.exists && poolFresh(pool.get('rebuiltAt')) ? pool.get('segments.all.variant') : undefined) as Record<string, any> | undefined;
      let n = 0;
      if (current && next.all?.variant) {
        const check = toRetire(next.all.variant, pooled, `retire:${doc.id}:${Math.floor(engineNow / DRIFT_EVERY_MS)}`, current);
        next.all.variant = applyRetire(next.all.variant, check);
        n = check.retire.length;
      } else if (next.all?.variant) {
        // No check this week (step unknown): a `low` from last week mustn't count as consecutive.
        next.all.variant = applyRetire(next.all.variant, { retire: [], low: [] });
      }
      tx.update(doc.ref, { segments: next, lastDriftAt: new Date(engineNow), updatedAt: new Date() });
      return { drifted: 1, retired: n };
    });
    driftedDocs += r.drifted;
    retired += r.retired;
  }
  return { drifted: driftedDocs, retired };
}

/**
 * `learn_pool`: every pooled doc rebuilt from scratch from all venues' arms; a pooled doc no venue
 * has any more is deleted — only one written before this run started, so a slow run overlapping
 * a newer one never deletes that one's pools. `onProgress` runs after every page (the lease).
 */
export async function rebuildPools(opts: { onProgress?: () => Promise<unknown> } = {}): Promise<{ pools: number; venueDocs: number; removed: number }> {
  const started = Date.now();
  const progress = () => (opts.onProgress ? opts.onProgress().catch(() => undefined) : Promise.resolve());
  const docs: Array<{ journeyKey: string; nodeId: string; segments?: Partial<Record<Segment | 'all', ArmBlock>> }> = [];
  let after: DocumentSnapshot | null = null;
  for (;;) {
    let q = arms().where('scope', '==', 'venue').orderBy(FieldPath.documentId()).limit(300);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    for (const d of page.docs) docs.push({ journeyKey: String(d.get('journeyKey')), nodeId: String(d.get('nodeId')), segments: d.get('segments') ?? {} });
    await progress();
    if (page.size < 300) break;
    after = page.docs[page.docs.length - 1];
  }
  const pools = poolFrom(docs);
  const writes: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
  const kept = new Set<string>();
  for (const p of pools.values()) {
    const id = banditPoolIdFor(p.journeyKey, p.nodeId);
    kept.add(id);
    writes.push((b) =>
      b.set(arms().doc(id), {
        scope: 'pool',
        tenantUserId: null,
        journeyKey: p.journeyKey,
        nodeId: p.nodeId,
        segments: p.segments,
        venues: p.venues,
        rebuiltAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      }),
    );
  }
  // A step whose last venue docs went (a deleted account): its pooled numbers go too.
  const stale = (await arms().where('scope', '==', 'pool').get()).docs.filter((d) => !kept.has(d.id) && (tsMs(d.get('rebuiltAt')) ?? 0) < started);
  for (const d of stale) writes.push((b) => b.delete(d.ref));
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 400)) w(batch);
    await batch.commit();
    await progress();
  }
  __clearBanditArmsCache();
  return { pools: pools.size, venueDocs: docs.length, removed: stale.length };
}
