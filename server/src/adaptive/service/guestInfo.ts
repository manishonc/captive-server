/**
 * Guest info content (plan §5: `GET/PUT /tenants/:t/venues/:v/guest-info`; PR D). The
 * on/off switch stays PR 1's `POST …/guest-info`. This is the form behind it: Wi-Fi name
 * and password, door code, check-in/out times, house rules, parking, contact, menu,
 * opening hours, local tips, the direct-booking link — per language, plain text.
 *
 *  - Only this route writes `CaptivePortal_VenueGuestInfo/venue_{venueId}`, one transaction,
 *    with an optimistic `baseVersion` (409 when someone saved meanwhile).
 *  - The owner sees what they typed (Wi-Fi password and door code included). No MCP tool
 *    reads this route: those values are never handed to an AI.
 *  - A save that changes the check-in/out time queues a calendar Sync now, so the stay times
 *    move within seconds instead of at the next 4-hourly poll (the wording already reads the
 *    new time live).
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId, guestInfoId } from '../store/collections';
import { getVenues } from '../store/tenantData';
import { SCHEMA_VERSION } from '../core/constants';
import type { Actor } from '../core/schemas';
import type { Issue } from '../core/issues';
import { ApiError, conflict, validationFailed } from '../api/errors';
import { toJson } from '../store/serialize';
import { resolveStayTimes } from '../stays/times';
import { guestInfoInputSchema, guestInfoWarnings, mergeGuestInfo, type GuestInfoLocale } from '../core/owner/guestInfo';
import { syncStayFeedNow } from './stays';

async function ownedVenue(tenantUserId: string, venueId: string): Promise<void> {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
}

const ref = (venueId: string) => db.collection(COL.venueGuestInfo).doc(guestInfoId(venueId));

function view(d: Record<string, unknown> | undefined, enabled: boolean) {
  const locales = (d?.locales ?? {}) as Record<string, GuestInfoLocale | undefined>;
  const times = resolveStayTimes({ locales: locales as Record<string, Record<string, unknown> | undefined> });
  return {
    guestInfo: d
      ? { locales, version: Number(d.version) || 0, updatedAt: toJson(d.updatedAt ?? null), updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : null }
      : null,
    enabled,
    resolvedTimes: times,
    warnings: guestInfoWarnings(locales),
  };
}

export async function getGuestInfoContent(tenantUserId: string, venueId: string) {
  await ownedVenue(tenantUserId, venueId);
  const [snap, av] = await Promise.all([ref(venueId).get(), db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get()]);
  return view(snap.exists ? (snap.data() as Record<string, unknown>) : undefined, av.get('utility.enabled') === true);
}

export async function saveGuestInfoContent(tenantUserId: string, venueId: string, body: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId);
  const b = (body ?? {}) as Record<string, unknown>;
  const input = guestInfoInputSchema.parse({ locales: b.locales, baseVersion: b.baseVersion });

  const saved = await db.runTransaction(async (tx) => {
    const [snap, av] = await Promise.all([tx.get(ref(venueId)), tx.get(db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)))]);
    const existing = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
    const version = Number(existing?.version) || 0;
    if (version !== input.baseVersion) throw conflict('Someone else changed Guest info meanwhile — reload and try again');
    const before = (existing?.locales ?? {}) as Record<string, GuestInfoLocale | undefined>;
    const { locales, issues } = mergeGuestInfo(before, input);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw validationFailed('Some Guest info needs fixing before saving', errors as Issue[]);
    const doc = {
      tenantUserId,
      venueId,
      locales,
      version: version + 1,
      updatedAt: new Date(),
      updatedBy: actor.uid,
      schemaVersion: SCHEMA_VERSION,
    };
    tx.set(ref(venueId), doc);
    const was = resolveStayTimes({ locales: before as Record<string, Record<string, unknown> | undefined> });
    const now = resolveStayTimes({ locales: locales as Record<string, Record<string, unknown> | undefined> });
    return { timesChanged: was.checkIn !== now.checkIn || was.checkOut !== now.checkOut, doc, enabled: av.get('utility.enabled') === true };
  });

  // New check-in/out times move the venue's stays at once (a calendar Sync now), if it has a calendar.
  // Best effort: the save has committed, so nothing here turns it into an error (a retry would 409).
  // Its own task per saved version: a second change in the same minute still gets a sync.
  let resynced = false;
  if (saved.timesChanged) {
    try {
      resynced = (await syncStayFeedNow(tenantUserId, venueId, { keySuffix: `:gi${saved.doc.version}` })).queued === true;
    } catch (err) {
      // An ApiError: no calendar link here, nothing to move. Anything else: the 4-hourly poll moves them.
      if (!(err instanceof ApiError)) console.error('[ADAPTIVE] Guest info resync failed:', (err as { name?: string })?.name ?? 'Error', (err as { code?: unknown })?.code ?? '');
    }
  }
  return { ...view(saved.doc as unknown as Record<string, unknown>, saved.enabled), resynced };
}
