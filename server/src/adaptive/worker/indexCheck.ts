/**
 * Startup index check. The Firebase project is shared, so the engine's composite
 * indexes are created by hand (docs/adaptive-engine.md) — and the emulator doesn't
 * enforce them, so a missing one would only show up in production as a failed
 * query. The worker runs every engine query once with limit(1) at startup and
 * stays idle (saying which index is missing) until they all work.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { venueEventsQuery } from '../rollups/rollup';
import { activeInstancesQuery } from '../engine/applyInFlight';
import { contactStaysQuery, failingFeedsQuery, linkCandidatesQuery, stayContactInstancesQuery, stayInstancesQuery, staysOfFeedQuery, watchedFeedsQuery } from '../stays/store';
import { FieldPath } from 'firebase-admin/firestore';
import {
  contactAllStaysQuery,
  contactConsentQuery,
  contactEventsQuery,
  contactInstancesQuery,
  contactSendsQuery,
  contactVenuesQuery,
  deadTasksQuery,
  venueEventsOfTypesQuery,
  accountCreditWaitQuery,
  venueGuestsQuery,
  venueSetupsQuery,
} from '../store/ownerQueries';

interface Probe {
  name: string;
  run: () => Promise<unknown>;
}

const past = () => new Date(Date.now() - 1000);

const PROBES: Probe[] = [
  { name: 'JourneyTasks(status, dueAt)', run: () => db.collection(COL.journeyTasks).where('status', '==', 'queued').where('dueAt', '<=', past()).orderBy('dueAt').limit(1).get() },
  { name: 'JourneyTasks(status, leaseUntil)', run: () => db.collection(COL.journeyTasks).where('status', '==', 'leased').where('leaseUntil', '<=', past()).limit(1).get() },
  { name: 'JourneyInstances(contactId, status)', run: () => db.collection(COL.journeyInstances).where('contactId', '==', '_probe').where('status', '==', 'active').limit(1).get() },
  {
    name: 'JourneySends(venueId, mode, createdAt)',
    run: () => db.collection(COL.journeySends).where('venueId', '==', '_probe').where('mode', '==', 'live').where('createdAt', '>=', past()).count().get(),
  },
  { name: 'JourneySends(mode, createdAt)', run: () => db.collection(COL.journeySends).where('mode', '==', 'live').where('createdAt', '>=', past()).count().get() },
  {
    name: 'JourneySends(venueId, mode, purpose, createdAt)',
    run: () =>
      db.collection(COL.journeySends).where('venueId', '==', '_probe').where('mode', '==', 'live').where('purpose', '==', 'service').where('createdAt', '>=', past()).count().get(),
  },
  // The old opt-out lookups (engine/route.ts): equality only, which Firestore serves by
  // merging single-field indexes — probed so a field exempted from indexing shows up here.
  ...(['smsOptOut', 'whatsappOptOut'] as const).flatMap((flag) => [
    { name: `Users(phoneE164, ${flag})`, run: () => db.collection(COL.guests).where('phoneE164', '==', '_probe').where(flag, '==', true).limit(1).get() },
    { name: `Users(${flag})`, run: () => db.collection(COL.guests).where(flag, '==', true).select('phone').limit(1).get() },
  ]),
  // The sign-up breaker finds the place a retried connect holds (single-field index; must not be exempted).
  { name: 'AdaptiveBreakers/*/signups(contactId)', run: () => db.collection(COL.breakers).doc('_probe').collection('signups').where('contactId', '==', '_probe').limit(1).get() },
  // Twilio status callbacks find their send by the provider id (single-field index; must not be exempted).
  { name: 'JourneySends(providerMessageId)', run: () => db.collection(COL.journeySends).where('providerMessageId', '==', '_probe').limit(1).get() },
  { name: 'Users(email in, unsubscribed)', run: () => db.collection(COL.guests).where('email', 'in', ['_probe', '_probe2']).where('unsubscribed', '==', true).limit(1).get() },
  // The daily numbers read a venue's log in commit order (recordedAt is exempt from single-field indexing).
  { name: 'JourneyEvents(venueId, recordedAt)', run: () => venueEventsQuery('_probe', past(), null, 1).get() },
  // "Apply to guests already in these journeys" pages through a journey's running guests.
  { name: 'JourneyInstances(venueId, journeyKey, status)', run: () => activeInstancesQuery('_probe', '_probe').limit(1).get() },
  // Airbnb stays (PR C). The link candidates need the composite; the rest are equality-only,
  // served by merged single-field indexes — probed so an exempted field shows up here.
  { name: 'Stays(venueId, status, checkOutAt)', run: () => linkCandidatesQuery('_probe', past()).limit(1).get() },
  { name: 'Stays(feedId)', run: () => staysOfFeedQuery('_probe').limit(1).get() },
  { name: 'Stays(venueId, contactId)', run: () => contactStaysQuery('_probe', '_probe').limit(1).get() },
  { name: 'JourneyInstances(context.stayId, status)', run: () => stayInstancesQuery('_probe').limit(1).get() },
  { name: 'StayFeeds(status in)', run: () => watchedFeedsQuery().limit(1).get() },
  { name: 'StayFeeds(status) count', run: () => failingFeedsQuery().count().get() },
  // The owner / admin / MCP routes (PR D). The API runs these, not the worker — probed here so a
  // missing index shows on the admin card before an owner screen fails (create them before the deploy).
  { name: 'ContactVenues(venueId, lastVisitAt desc)', run: () => venueGuestsQuery('_probe').limit(1).get() },
  { name: 'JourneyEvents(contactId, occurredAt desc)', run: () => contactEventsQuery('_probe').limit(1).get() },
  { name: 'ConsentEvents(contactId, occurredAt desc)', run: () => contactConsentQuery('_probe').limit(1).get() },
  {
    name: 'JourneyEvents(venueId, type, occurredAt desc)',
    run: () => venueEventsOfTypesQuery('_probe', ['send.deferred', 'send.skipped'], past()).orderBy(FieldPath.documentId(), 'desc').limit(1).get(),
  },
  { name: 'JourneyTasks(status, doneAt desc)', run: () => deadTasksQuery().limit(1).get() },
  // …and their equality-only lookups (merged single-field indexes; must not be exempted).
  { name: 'JourneyInstances(contactId)', run: () => contactInstancesQuery('_probe').limit(1).get() },
  { name: 'JourneySends(contactId)', run: () => contactSendsQuery('_probe').limit(1).get() },
  { name: 'Stays(contactId)', run: () => contactAllStaysQuery('_probe').limit(1).get() },
  { name: 'ContactVenues(contactId)', run: () => contactVenuesQuery('_probe').limit(1).get() },
  { name: 'VenuePlaybooks(venueId)', run: () => venueSetupsQuery('_probe').limit(1).get() },
  { name: 'JourneyInstances(tenantUserId, status, waiting.creditsShort)', run: () => accountCreditWaitQuery('_probe').limit(1).get() },
  // An owner's link by hand gives back that guest's journeys of the stay (PR D).
  { name: 'JourneyInstances(context.stayId, contactId)', run: () => stayContactInstancesQuery('_probe', '_probe').limit(1).get() },
];

export interface IndexCheckResult {
  ok: boolean;
  missing: Array<{ name: string; message: string }>;
}

export async function checkIndexes(): Promise<IndexCheckResult> {
  const missing: IndexCheckResult['missing'] = [];
  for (const p of PROBES) {
    try {
      await p.run();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      const msg = String(e?.message ?? err);
      if (e?.code === 9 || /index/i.test(msg)) missing.push({ name: p.name, message: msg.slice(0, 400) });
      else throw err;
    }
  }
  return { ok: missing.length === 0, missing };
}
