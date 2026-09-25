/**
 * The connect hook (04-engine-runtime §2.2, plan H1): after today's login code
 * has saved the guest doc, hand "guest X connected at venue Y" to the engine.
 *
 * Cheap and quiet by design:
 *  - every account off (the default) → returns after one cached read a minute;
 *  - the venue has no playbook or Guest info on → returns (venue cached 60 s);
 *  - otherwise one batch: the `wifi.connected` event + its `event_route` task.
 *
 * The event id is `portal:{guest}:{AP}:{minute}`, so the UniFi double call
 * (/create-user then /unifi/authorize) can't create two. `/create-user` also skips
 * UniFi APs outright — `/unifi/authorize` is the moment that guest is online.
 * Raw contact details travel only in the task payload, never in the 25-month event
 * log. The queue removes them once the task is done or dead, and a task nobody
 * handles expires after 30 days. The payload also carries this API's identity-key
 * fingerprint, so the worker can hold or flag connects made with a different key.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import type { AdaptiveVenueDoc } from '../store/types';
import { anyAccountOn, cachedEngineSettings, modeFor } from '../store/engineSettings';
import { eventIdFor, minuteBucket, taskIdFor, shardOf } from '../core/runtime/ids';
import { now, refreshClock } from '../engine/clock';
import { retentionFrom } from '../store/time';
import { SCHEMA_VERSION } from '../core/constants';
import { TASK_SCHEMA_VERSION } from '../queue/firestoreQueue';
import { keyFingerprint } from '../identity/key';
import { DAY_MS } from '../core/runtime/time';

export interface ConnectHookInput {
  route: 'create-user' | 'unifi-authorize';
  wifiGuestId: string;
  accessPointId: string | null;
  venueId: string | null;
  apVendor: string | null;
  /** The guest ticked the marketing box in this request. */
  consentGiven: boolean;
  language: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phoneCountryCode: string | null;
  /** From the verification gate of this request, when it ran. */
  phoneE164?: string | null;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}

const VENUE_TTL_MS = 60_000;
const venueCache = new Map<string, { doc: AdaptiveVenueDoc | null; at: number }>();

async function liveVenue(venueId: string): Promise<AdaptiveVenueDoc | null> {
  const hit = venueCache.get(venueId);
  if (hit && Date.now() - hit.at < VENUE_TTL_MS) return hit.doc;
  const snap = await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get();
  const doc = snap.exists ? (snap.data() as AdaptiveVenueDoc) : null;
  venueCache.set(venueId, { doc, at: Date.now() });
  if (venueCache.size > 2000) venueCache.clear();
  return doc;
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message));
}

export async function adaptiveOnConnect(input: ConnectHookInput): Promise<void> {
  if (input.route === 'create-user' && input.apVendor === 'unifi') return;
  if (!input.venueId || !input.wifiGuestId) return;

  const settings = await cachedEngineSettings();
  if (!anyAccountOn(settings)) return;

  const venue = await liveVenue(input.venueId);
  if (!venue || (venue.status !== 'on' && !venue.utility?.enabled)) return;
  if (modeFor(settings, venue.tenantUserId) === 'off') return;

  await refreshClock();
  const occurredAt = now();
  const eventId = eventIdFor('portal', `${input.wifiGuestId}:${input.accessPointId ?? '-'}:${minuteBucket(occurredAt)}`);
  const taskId = taskIdFor(`event:${eventId}`);

  const batch = db.batch();
  batch.create(db.collection(COL.journeyEvents).doc(eventId), {
    type: 'wifi.connected',
    tenantUserId: venue.tenantUserId,
    venueId: input.venueId,
    contactId: null,
    guestId: input.wifiGuestId,
    instanceId: null,
    journeyKey: null,
    nodeId: null,
    sendKey: null,
    variantId: null,
    channel: null,
    slot: null,
    source: 'portal',
    occurredAt: new Date(occurredAt),
    recordedAt: FieldValue.serverTimestamp(), // commit time (the rollups read the log in this order)
    data: { apId: input.accessPointId, route: input.route, consentGiven: input.consentGiven, lang: input.language },
    expireAt: retentionFrom(occurredAt),
    schemaVersion: SCHEMA_VERSION,
  });
  batch.create(db.collection(COL.journeyTasks).doc(taskId), {
    kind: 'event_route',
    shard: shardOf(taskId),
    status: 'queued',
    dueAt: new Date(occurredAt),
    leaseOwner: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts: 8,
    lastError: null,
    payload: {
      eventId,
      schemaVersion: TASK_SCHEMA_VERSION,
      keyFingerprint: keyFingerprint(),
      guest: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        phoneCountryCode: input.phoneCountryCode,
        phoneE164: input.phoneE164 ?? null,
        emailVerified: Boolean(input.emailVerified),
        phoneVerified: Boolean(input.phoneVerified),
      },
    },
    tenantUserId: venue.tenantUserId,
    venueId: input.venueId,
    createdAt: new Date(),
    doneAt: null,
    // Backstop only (e.g. the worker was stopped for good): done/dead set their own.
    expireAt: new Date(Date.now() + 30 * DAY_MS),
  });
  try {
    await batch.commit();
  } catch (err) {
    if (!isAlreadyExists(err)) throw err; // the UniFi double call: already queued
  }
}

/** For tests. */
export function __clearConnectCaches(): void {
  venueCache.clear();
}
