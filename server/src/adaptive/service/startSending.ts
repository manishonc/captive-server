/**
 * Start sending (plan §2.4 stage 4, §4.2 `sendingConfirmedAt`; PR D decision D-D1), and the
 * launch-aware status the owner's screens show.
 *
 *  - `POST /tenants/:t/venues/:v/start-sending`: the owner's one click for a venue turned on
 *    before their account went live (the engine holds it until then: core/runtime/hold.ts).
 *    Only while the account is live; idempotent; writes only `sendingConfirmedAt/By` (never
 *    `updatedAt`, which older docs use as "switched off since").
 *  - The overview's `sendingLive` now means "this account is live" (the "Early access" note
 *    stays until then), with `sendingPaused` beside it and, per venue, `needsStartSending`.
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import type { AdaptiveVenueDoc } from '../store/types';
import type { Actor } from '../core/schemas';
import { getVenues } from '../store/tenantData';
import { ApiError, conflict } from '../api/errors';
import { modeFor, readEngineSettings, venueHeld, venueNeedsStartSending, type LaunchMode } from '../store/engineSettings';
import { venueHasSomethingOn } from '../core/runtime/hold';
import { now, refreshClock, sandboxEnabled } from '../engine/clock';
import { tsMs } from '../store/time';
import { forgetConnectVenue } from '../ingest/connect';

function iso(v: unknown): string | null {
  const ms = tsMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

interface OverviewVenueLike {
  venueId: string;
  adaptive: Record<string, unknown> | null;
}

/**
 * The launch-aware part of the owner overview (spread into service/tenant.ts `getOverview`'s
 * answer, so every key is optional). Any failure reads as "not live yet" — the "Early access"
 * note then stays up, which is the safe side.
 */
export async function launchAwareOverview<V extends OverviewVenueLike>(
  tenantUserId: string,
  adaptiveDocs: AdaptiveVenueDoc[],
  venues: V[],
): Promise<{ sendingLive?: boolean; sendingPaused?: boolean; launchMode?: LaunchMode; venues?: V[] }> {
  try {
    const settings = await readEngineSettings();
    await refreshClock();
    const t = now();
    const mode = modeFor(settings, tenantUserId);
    const byVenue = new Map(adaptiveDocs.map((a) => [a.venueId, a]));
    return {
      sendingLive: mode === 'live',
      sendingPaused: settings.paused,
      launchMode: mode,
      venues: venues.map((v) => {
        const av = byVenue.get(v.venueId);
        if (!v.adaptive || !av) return v;
        return { ...v, adaptive: { ...v.adaptive, needsStartSending: venueHeld(settings, av, t), sendingConfirmedAt: iso(av.sendingConfirmedAt) } };
      }),
    };
  } catch (err) {
    console.error('[ADAPTIVE] launch status for the overview failed:', (err as Error)?.name ?? 'Error');
    return { sendingLive: false, sendingPaused: true, launchMode: 'off' };
  }
}

export async function startSending(tenantUserId: string, venueId: string, actor: Actor) {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
  const settings = await readEngineSettings();
  // Before launch the click would mean nothing (and would skip the moment the owner learns
  // real messages and credits start).
  if (modeFor(settings, tenantUserId) !== 'live') throw conflict("Sending hasn't launched for your account yet");
  await refreshClock();
  const t = now();
  const ref = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const av = snap.exists ? (snap.data() as AdaptiveVenueDoc) : null;
    if (!av || av.tenantUserId !== tenantUserId) throw conflict('Nothing is switched on at this venue');
    if (!venueHasSomethingOn({ status: av.status, utility: { enabled: av.utility?.enabled === true } })) throw conflict('Nothing is switched on at this venue');
    const confirmed = tsMs(av.sendingConfirmedAt);
    if (confirmed !== null) {
      // Local sandbox only: a click stamped on a fake clock that was reset since would lie in
      // the future and hold every guest until real time catches up.
      if (sandboxEnabled() && confirmed > t) {
        tx.update(ref, { sendingConfirmedAt: new Date(t) });
        return { alreadyConfirmed: true, at: t, by: av.sendingConfirmedBy ?? null };
      }
      return { alreadyConfirmed: true, at: confirmed, by: av.sendingConfirmedBy ?? null };
    }
    // Turned on after the account went live: nothing waits, and a stray click stores nothing.
    if (!venueNeedsStartSending(settings, av)) return { alreadyConfirmed: false, at: null, by: null, notNeeded: true };
    tx.update(ref, { sendingConfirmedAt: new Date(t), sendingConfirmedBy: actor.uid });
    return { alreadyConfirmed: false, at: t, by: actor.uid };
  });
  // This API process's login hook forgets its cached copy, so the next guest counts at once.
  forgetConnectVenue(venueId);
  return {
    venueId,
    sendingConfirmedAt: out.at === null ? null : new Date(out.at).toISOString(),
    sendingConfirmedBy: out.by,
    alreadyConfirmed: out.alreadyConfirmed,
    needsStartSending: false,
  };
}
