/**
 * `POST /admin/decisions/replay {sendKey | eventId, lang?}` (plan §5): load a stored
 * decision and its replay snapshot; the re-run, the compare and the answer are pure
 * (core/runtime/replay.ts). Read only.
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import { ApiError, notFound } from '../api/errors';
import type { DecisionRecord } from '../core/runtime/decision';
import { readReplaySnapshot, replayAnswer, type ReplayAnswer } from '../core/runtime/replay';
import { isValidTimeZone } from '../core/runtime/time';

export type { ReplayAnswer };

export interface ReplayRequest {
  sendKey?: string;
  eventId?: string;
  lang?: 'en' | 'de';
}

const FALLBACK_TZ = 'Europe/Zurich';

/** A Firestore doc id we'll look up (no `/`, not `.` / `..`). */
function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) && id !== '.' && id !== '..';
}

function asDecision(raw: unknown): DecisionRecord | null {
  const d = raw as Partial<DecisionRecord> | null | undefined;
  if (!d || typeof d !== 'object' || typeof d.result !== 'string' || !Array.isArray(d.checks) || !d.channel || !d.slot) return null;
  return d as DecisionRecord;
}

interface Loaded {
  decision: DecisionRecord;
  replay: unknown;
  sendKey: string | null;
  venueId: string | null;
}

async function loadSend(sendKey: string): Promise<Loaded> {
  const snap = await db.collection(COL.journeySends).doc(sendKey).get();
  if (!snap.exists) throw notFound('No send with that key.');
  const decision = asDecision(snap.get('decision'));
  if (!decision) throw notFound('That send has no decision record.');
  return { decision, replay: snap.get('replay') ?? null, sendKey, venueId: (snap.get('venueId') as string | undefined) ?? null };
}

async function load(req: { sendKey?: string; eventId?: string }): Promise<Loaded> {
  if (req.sendKey !== undefined) {
    if (!validId(req.sendKey)) throw notFound('No send with that key.');
    return loadSend(req.sendKey);
  }
  if (!validId(req.eventId)) throw notFound('No event with that id.');
  const snap = await db.collection(COL.journeyEvents).doc(req.eventId).get();
  if (!snap.exists) throw notFound('No event with that id.');
  const data = (snap.get('data') ?? {}) as Record<string, unknown>;
  const sendKey = (snap.get('sendKey') as string | null | undefined) ?? null;
  const decision = asDecision(data.decision);
  if (decision) return { decision, replay: data.replay ?? null, sendKey, venueId: (snap.get('venueId') as string | null | undefined) ?? null };
  // A live send's decision is on the send, not on its `message.sent` event.
  if (sendKey && validId(sendKey)) return loadSend(sendKey);
  throw notFound('That event has no decision record.');
}

/** The zone the decision was made in (the gate's quiet-hours zone), else the venue's. */
async function zoneFor(replay: unknown, venueId: string | null): Promise<string> {
  const fromGate = readReplaySnapshot(replay)?.gate?.quiet?.venueTz;
  if (isValidTimeZone(fromGate)) return fromGate;
  if (!venueId || !validId(venueId)) return FALLBACK_TZ;
  const [av, venue] = await Promise.all([
    db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get(),
    db.collection(COL.venues).doc(venueId).get(),
  ]);
  const tz = [av.get('timezone'), venue.get('timezone')].find((z) => isValidTimeZone(z));
  return (tz as string | undefined) ?? FALLBACK_TZ;
}

/** Throws `bad_request` (neither or both ids) or `not_found` (unknown id, or no decision on it). */
export async function replayDecision(req: ReplayRequest): Promise<ReplayAnswer> {
  const hasSend = typeof req.sendKey === 'string' && req.sendKey !== '';
  const hasEvent = typeof req.eventId === 'string' && req.eventId !== '';
  if (hasSend === hasEvent) throw new ApiError('bad_request', 'Give either a sendKey or an eventId.');
  const loaded = await load(hasSend ? { sendKey: req.sendKey } : { eventId: req.eventId });
  const tz = await zoneFor(loaded.replay, loaded.venueId);
  return replayAnswer({ stored: loaded.decision, replay: loaded.replay, sendKey: loaded.sendKey, lang: req.lang === 'de' ? 'de' : 'en', tz });
}
