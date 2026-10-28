/**
 * "Cancel journeys" for one CMS guest (2026-10-27): the owner stops every journey this person
 * is running, so the guest can then be removed from the guest list without Adaptive messaging
 * them on. Nothing about the person is deleted here — the Contact, its contact points, sends and
 * events stay (anonymisation is a later task: research/…/adaptive-engine-task-guest-anonymisation.md).
 *
 *  - The CMS guest (`CaptivePortal_Users` id) is matched to this owner's contact through
 *    `Contacts.guestIds`, else the hashed email / phone (like `findGuest`).
 *  - Each active instance ends like `engine/advance.ts` ends one: `cancelled` with the reason
 *    `guest_cancelled`, a `journey.exited` event, the ContactVenues slot freed — in one
 *    transaction that checks the instance `rev`, so a worker moving it meanwhile is never
 *    overwritten (we re-read and try again). Starts queued behind it (`reentry.queue`) are dropped.
 *  - The instance's queued timer task is marked `cancelled` too (a stale one would do nothing:
 *    `runTimer` skips an instance that isn't active).
 *  - The contact is held (`journeysCancelled`): no new journey starts — a pending visit end, a
 *    scan, a stay moment — until the guest's next Wi-Fi login lifts it (engine/route.ts).
 *  - Calling it twice is safe: the second call finds nothing active and cancels nothing.
 *
 * The Adaptive guest drawer (2026-10-28) cancels by contact instead (`cancelContactJourneys`):
 * the same cancel, for a guest the owner already has open. Either way it covers every venue of
 * the account, since the contact and the hold are the account's.
 */

import { FieldPath } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import { taskIdFor } from '../core/runtime/ids';
import { pickLang, type Actor } from '../core/schemas';
import { notFound } from '../api/errors';
import { getVenues } from '../store/tenantData';
import { retentionFrom, tsMs } from '../store/time';
import { now, refreshClock } from '../engine/clock';
import { DAY_MS } from '../core/runtime/time';
import { appendEventInTx } from '../engine/events';
import { instanceRef, loadInstance, stateUpdate } from '../engine/instanceStore';
import { contactPointId } from '../identity/key';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { loadCatalogue } from './catalogue';
import { assertLookupKeyMatches } from './identityGuard';

export const GUEST_CANCELLED = 'guest_cancelled';
const MAX_CONFLICT_RETRIES = 5;
/** Like a cancelled task in queue/firestoreQueue.ts: kept a week, then the TTL removes it. */
const TASK_DONE_TTL_MS = 7 * DAY_MS;

const guestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * This owner's Adaptive contact for a CMS guest, or null when Adaptive never saw them. Throws
 * not-found when the guest doc is missing or belongs to another owner's access point.
 */
export async function contactIdOfGuest(tenantUserId: string, guestId: string): Promise<string | null> {
  const g = (await db.collection(COL.guests).doc(guestId).get()).data() as Record<string, any> | undefined;
  if (!g) throw notFound('No such guest in this account');
  const apId = typeof g.captivePortalAccessPointId === 'string' ? g.captivePortalAccessPointId : null;
  const ap = apId ? (await db.collection(COL.accessPoints).doc(apId).get()).data() : undefined;
  const venue = typeof ap?.venueId === 'string' ? (await getVenues([ap.venueId])).get(ap.venueId) : undefined;
  if (!venue || venue.tenantUserId !== tenantUserId) throw notFound('No such guest in this account');

  const byGuest = await db.collection(COL.contacts).where('guestIds', 'array-contains', guestId).get();
  const own = byGuest.docs.find((d) => d.get('tenantUserId') === tenantUserId);
  if (own) return own.id;

  const email = normalizeEmail(String(g.email ?? ''));
  const phone = typeof g.phoneE164 === 'string' ? g.phoneE164 : normalizeE164(String(g.phoneCountryCode ?? ''), String(g.phone ?? ''));
  if (!email && !phone) return null;
  await assertLookupKeyMatches();
  for (const [kind, value] of [['email', email], ['phone', phone]] as const) {
    if (!value) continue;
    const cp = await db.collection(COL.contactPoints).doc(contactPointId(kind, value)).get();
    const id = (cp.get('tenantContacts') ?? {})[tenantUserId];
    if (typeof id !== 'string') continue;
    const contact = await db.collection(COL.contacts).doc(id).get();
    if (contact.exists && contact.get('tenantUserId') === tenantUserId) return id;
  }
  return null;
}

interface RunningJourney {
  instanceId: string;
  journeyKey: string;
  name: string;
  venueId: string;
  venueName: string | null;
  mode: 'live' | 'test';
}

async function runningOf(tenantUserId: string, contactId: string, lang: 'en' | 'de'): Promise<RunningJourney[]> {
  const snap = await db.collection(COL.journeyInstances).where('contactId', '==', contactId).where('status', '==', 'active').get();
  const docs = snap.docs.filter((d) => d.get('tenantUserId') === tenantUserId);
  if (!docs.length) return [];
  const cat = await loadCatalogue();
  const venues = await getVenues([...new Set(docs.map((d) => String(d.get('venueId'))))]);
  return docs
    .map((d) => {
      const journeyKey = String(d.get('journeyKey'));
      const venueId = String(d.get('venueId'));
      const header = cat.templates.get(journeyKey)?.header;
      return {
        instanceId: d.id,
        journeyKey,
        name: header ? pickLang(header.name, lang) : journeyKey,
        venueId,
        venueName: venues.get(venueId)?.name ?? null,
        mode: d.get('mode') === 'live' ? ('live' as const) : ('test' as const),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const langOf = (v: unknown): 'en' | 'de' => (v === 'de' ? 'de' : 'en');

/** GET …/guests/by-guest/:guestId/journeys — what "Cancel journeys" would stop (a read). */
export async function getGuestJourneys(tenantUserId: string, guestIdRaw: string, query: { lang?: unknown }) {
  const guestId = guestIdSchema.parse(guestIdRaw);
  const contactId = await contactIdOfGuest(tenantUserId, guestId);
  const running = contactId ? await runningOf(tenantUserId, contactId, langOf(query.lang)) : [];
  const held = contactId ? tsMs((await db.collection(COL.contacts).doc(contactId).get()).get('journeysCancelled.at')) : null;
  return {
    guestId,
    contactId,
    running: running.map(({ instanceId: _id, ...j }) => j),
    // Set after a Cancel journeys until the guest's next Wi-Fi login.
    cancelledAt: held === null ? null : new Date(held).toISOString(),
  };
}

/** Ends one instance as cancelled, rev-checked. `false` when it had already ended. */
async function cancelInstance(instanceId: string, tenantUserId: string, actor: Actor): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const inst = await loadInstance(instanceId);
    if (!inst || inst.meta.tenantUserId !== tenantUserId || inst.state.status !== 'active') return false;
    await refreshClock();
    const at = now();
    const expectedRev = inst.state.rev;
    const cvRef = db.collection(COL.contactVenues).doc(contactVenueId(inst.meta.contactId, inst.meta.venueId));
    const taskRefs = [...new Set(['start', inst.state.waiting?.token].filter((t): t is string => Boolean(t)))].map((token) =>
      db.collection(COL.journeyTasks).doc(taskIdFor(`node:${instanceId}:${token}`)),
    );
    const ok = await db.runTransaction(async (tx) => {
      const snap = await tx.get(instanceRef(instanceId));
      if (!snap.exists || Number(snap.get('rev')) !== expectedRev) return false;
      const [cvSnap, ...taskSnaps] = await Promise.all([tx.get(cvRef), ...taskRefs.map((r) => tx.get(r))]);
      const next = { ...inst.state, status: 'cancelled' as const, exitReason: GUEST_CANCELLED, waiting: null, rev: expectedRev + 1 };
      tx.update(instanceRef(instanceId), stateUpdate(next, at, retentionFrom(at)));
      appendEventInTx(tx, {
        type: 'journey.exited',
        occurredAt: at,
        tenantUserId,
        venueId: inst.meta.venueId,
        contactId: inst.meta.contactId,
        instanceId,
        journeyKey: inst.meta.journeyKey,
        mode: inst.meta.mode,
        data: { status: 'cancelled', reason: GUEST_CANCELLED, by: actor.uid },
      });
      for (const t of taskSnaps) {
        if (t.exists && t.get('status') === 'queued') tx.update(t.ref, { status: 'cancelled', doneAt: new Date(), expireAt: new Date(Date.now() + TASK_DONE_TTL_MS) });
      }
      // The venue slot is freed like advance.ts frees it; starts queued behind this run don't begin.
      if (cvSnap.exists && cvSnap.get(new FieldPath('journeys', inst.meta.journeyKey, 'activeInstanceId')) === instanceId) {
        tx.update(
          cvRef,
          new FieldPath('journeys', inst.meta.journeyKey, 'activeInstanceId'),
          null,
          new FieldPath('journeys', inst.meta.journeyKey, 'lastExitAt'),
          new Date(at),
          new FieldPath('journeys', inst.meta.journeyKey, 'lastExitReason'),
          GUEST_CANCELLED,
          new FieldPath('journeys', inst.meta.journeyKey, 'queued'),
          [],
        );
      }
      return true;
    });
    if (ok) return true;
  }
  throw new Error(`instance ${instanceId} kept changing; try again`);
}

/** Holds the contact and ends each of their running journeys; what stopped and what still runs. */
async function cancelAllOf(tenantUserId: string, contactId: string, lang: 'en' | 'de', actor: Actor) {
  // First the hold, so nothing new starts while we end the running ones (a pending visit end,
  // a scan, a queued start): it stays until the guest's next Wi-Fi login (engine/enrol.ts).
  await refreshClock();
  await db.collection(COL.contacts).doc(contactId).update({ journeysCancelled: { at: new Date(now()), by: actor.uid } });
  const running = await runningOf(tenantUserId, contactId, lang);
  const stopped: RunningJourney[] = [];
  for (const j of running) {
    if (await cancelInstance(j.instanceId, tenantUserId, actor)) stopped.push(j);
  }
  // Re-read: a journey that started while we worked is reported, so the CMS doesn't offer Remove.
  const still = await runningOf(tenantUserId, contactId, lang);
  const strip = ({ instanceId: _id, ...j }: RunningJourney) => j;
  return { cancelled: stopped.length, journeys: stopped.map(strip), running: still.map(strip) };
}

/** POST …/guests/by-guest/:guestId/journeys/cancel — stop every running journey of this guest. */
export async function cancelGuestJourneys(tenantUserId: string, guestIdRaw: string, body: unknown, actor: Actor) {
  const guestId = guestIdSchema.parse(guestIdRaw);
  const lang = langOf((body as { lang?: unknown } | null)?.lang);
  const contactId = await contactIdOfGuest(tenantUserId, guestId);
  if (!contactId) return { guestId, contactId: null, cancelled: 0, journeys: [], running: [] };
  return { guestId, contactId, ...(await cancelAllOf(tenantUserId, contactId, lang, actor)) };
}

/** POST …/guests/:contactId/journeys/cancel — the same, for the guest open in the Adaptive drawer. */
export async function cancelContactJourneys(tenantUserId: string, contactId: string, body: unknown, actor: Actor) {
  const lang = langOf((body as { lang?: unknown } | null)?.lang);
  const contact = await db.collection(COL.contacts).doc(contactId).get();
  if (!contact.exists || contact.get('tenantUserId') !== tenantUserId) throw notFound('No such guest in this account');
  return { contactId, ...(await cancelAllOf(tenantUserId, contactId, lang, actor)) };
}
