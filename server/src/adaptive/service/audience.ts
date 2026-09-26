/**
 * "Who gets messages" (plan §5: `GET/PUT /tenants/:t/venues/:v/audience`; PR D). The engine
 * already obeys `AdaptiveVenues.audience` at every send (gate rule "audience"); this is where
 * the owner reads and changes it, with the last-30-day verified / not verified counts per
 * channel, and where the estimate learns to price by it.
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import { getVenues, recentCaptureStats, type CaptureStats } from '../store/tenantData';
import { ApiError, conflict } from '../api/errors';
import type { Actor } from '../core/schemas';
import { z } from 'zod';
import { toJson } from '../store/serialize';
import { cachedEngineSettings } from '../store/engineSettings';
import { audienceCounts, effectiveAudience, reachableUnder, type Audience, type AudienceCounts } from '../core/owner/audience';

const choice = z.enum(['verified', 'all']);
export const audienceInputSchema = z.object({ sms: choice, email: choice });

const BASIS = 'Guests who said yes to messages in the last 30 days';
const COUNTS_TTL_MS = 60_000;
const countsCache = new Map<string, { at: number; stats: CaptureStats | undefined }>();

async function ownedVenue(tenantUserId: string, venueId: string): Promise<void> {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
}

/** The countries the engine sends SMS to (its settings; the defaults when they can't be read). */
async function smsCountries(): Promise<string[]> {
  return (await cachedEngineSettings()).sms.allowedCountries;
}

/** The venue's capture stats, read at most once a minute (the scan reads every guest doc of its access points). */
async function statsFor(tenantUserId: string, venueId: string): Promise<CaptureStats | undefined> {
  const hit = countsCache.get(venueId);
  if (hit && Date.now() - hit.at < COUNTS_TTL_MS) return hit.stats;
  const stats = (await recentCaptureStats(tenantUserId, [venueId])).get(venueId);
  countsCache.set(venueId, { at: Date.now(), stats });
  if (countsCache.size > 500) countsCache.clear();
  return stats;
}

export async function getAudience(tenantUserId: string, venueId: string) {
  await ownedVenue(tenantUserId, venueId);
  const [av, stats] = await Promise.all([db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get(), statsFor(tenantUserId, venueId)]);
  const saved = av.get('audience') as Partial<Audience> | undefined;
  return {
    audience: effectiveAudience(saved),
    isDefault: !saved,
    updatedAt: toJson(av.get('audienceUpdatedAt') ?? null),
    counts: { basis: BASIS, ...audienceCounts(stats?.classes, await smsCountries()) },
  };
}

/**
 * Saves the choice. It applies from the next send, also to guests already in a journey (the
 * gate reads it at every send). The venue must have been set up once (the wizard saves the
 * choice with the setup itself, `PUT /setups` `audience`).
 */
export async function putAudience(tenantUserId: string, venueId: string, body: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId);
  const b = (body ?? {}) as Record<string, unknown>;
  const audience = audienceInputSchema.parse({ sms: b.sms, email: b.email });
  const ref = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw conflict('Set this venue up first (the choice is saved with its setup)');
    if (snap.get('tenantUserId') !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
    // Named fields only (the setup write keeps the whole doc it reads), and never `updatedAt`:
    // older docs use it as "switched off since".
    tx.update(ref, { audience, audienceUpdatedAt: new Date(), audienceUpdatedBy: actor.uid });
  });
  return getAudience(tenantUserId, venueId);
}

export interface VenueAudienceView {
  audience: Audience;
  isDefault: boolean;
  counts: AudienceCounts & { basis: string };
}

/**
 * For the estimate (service/tenant.ts): with each venue's choice — the one being picked in the
 * wizard, else the saved one, else the defaults — only the guests it lets us reach are priced
 * and expected to come back. Adjusts the stats in place; returns the counts per venue.
 */
export async function applyAudienceToStats(
  venueIds: string[],
  stats: Map<string, CaptureStats>,
  picked: Record<string, Partial<Audience>> | undefined,
): Promise<Record<string, VenueAudienceView>> {
  const out: Record<string, VenueAudienceView> = {};
  if (!venueIds.length) return out;
  const [snaps, countries] = await Promise.all([db.getAll(...venueIds.map((id) => db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(id)))), smsCountries()]);
  venueIds.forEach((id, i) => {
    const saved = snaps[i]?.get('audience') as Partial<Audience> | undefined;
    const audience = effectiveAudience(picked?.[id] ?? saved);
    const s = stats.get(id);
    const reach = reachableUnder(s?.classes, audience, countries);
    if (s) {
      s.withPhone = reach.withPhone;
      s.emailOnly = reach.emailOnly;
      s.optedIn30d = reach.optedIn;
    }
    out[id] = { audience, isDefault: !picked?.[id] && !saved, counts: { basis: BASIS, ...audienceCounts(s?.classes, countries) } };
  });
  return out;
}
