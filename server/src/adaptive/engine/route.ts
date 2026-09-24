/**
 * Routing events (04-engine-runtime §2.3) and the visit-end fallback.
 *
 * `wifi.connected` → who is this (contact + consent) → which visit → a new visit
 * wakes the guest's running journeys (a revisit can redeem the A1 offer) and
 * starts the journeys it triggers → the 3 h "visit ended" fallback is (re)armed.
 * Every step is safe to repeat: re-running a task after a crash can't double
 * anything (deterministic ids, remembered connect ids, idempotent enrolment).
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { VisitDoc } from '../store/engineTypes';
import type { EngineEvent, RunMode } from '../core/runtime/types';
import { eventIdFor } from '../core/runtime/ids';
import { HOUR_MS, durationMs } from '../core/runtime/time';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { LANGS, type Lang } from '../core/constants';
import { resolveContact } from '../identity/resolve';
import { recordConnect, revisitGapHours } from '../identity/visits';
import { identityReady } from '../identity/key';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { modeFor, type EngineSettings } from '../store/engineSettings';
import { tsMs } from '../store/time';
import { appendEvent, loadEvent } from './events';
import { enabledJourneys, loadContact, loadVenueContext, type VenueContext } from './context';
import { enrolForEvent, type VisitFacts } from './enrol';
import { deliverEvent } from './advance';
import { fromDoc } from './instanceStore';

export interface RouteEnv {
  now: number;
  settings: EngineSettings;
  workerId: string;
}

interface GuestPayload {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneCountryCode?: string | null;
  phoneE164?: string | null;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}

export async function routeEvent(payload: { eventId: string; guest?: GuestPayload }, env: RouteEnv): Promise<void> {
  const event = await loadEvent(payload.eventId);
  if (!event) return;
  if (event.type === 'wifi.connected') return handleConnect(event, payload.guest ?? {}, env);
  // Events tied to one journey (message.*, ratings) arrive with PR B.
  if (event.instanceId) await deliverEvent(event.instanceId, event, env);
}

function asLang(value: unknown): Lang | null {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value) ? (value as Lang) : null;
}

/** Old STOP flags live on every guest doc with that number (services/optOut.ts writes them all). */
async function legacyPhoneStops(phoneE164: string): Promise<{ sms: boolean; whatsapp: boolean }> {
  const snap = await db.collection(COL.guests).where('phoneE164', '==', phoneE164).limit(25).get();
  let sms = false;
  let whatsapp = false;
  for (const d of snap.docs) {
    if (d.get('smsOptOut') === true) sms = true;
    if (d.get('whatsappOptOut') === true) whatsapp = true;
  }
  return { sms, whatsapp };
}

async function handleConnect(event: EngineEvent, guest: GuestPayload, env: RouteEnv): Promise<void> {
  const venueId = event.venueId;
  const guestId = String(event.data.guestId ?? '');
  if (!venueId || !guestId) return;
  if (!identityReady()) throw new Error('identity key missing (GUEST_OTP_PEPPER)');

  const ctx = await loadVenueContext(venueId);
  if (!ctx || (!ctx.marketing && !ctx.utility)) return;
  const mode = modeFor(env.settings, ctx.tenantUserId);
  if (mode === 'off') return;

  const guestSnap = await db.collection(COL.guests).doc(guestId).get();
  const g = (guestSnap.data() ?? {}) as Record<string, any>;
  const email = normalizeEmail(guest.email ?? g.email ?? '');
  const phoneE164 = guest.phoneE164 ?? g.phoneE164 ?? normalizeE164(guest.phoneCountryCode ?? g.phoneCountryCode ?? '', guest.phone ?? g.phone ?? '');
  if (!email && !phoneE164) return; // nothing to reach this guest on

  const stops = phoneE164 ? await legacyPhoneStops(phoneE164) : { sms: false, whatsapp: false };
  const resolved = await resolveContact({
    tenantUserId: ctx.tenantUserId,
    venueId,
    guestId,
    email,
    phoneE164,
    firstName: guest.firstName ?? g.firstName ?? null,
    lastName: guest.lastName ?? g.lastName ?? null,
    lang: asLang(event.data.lang) ?? asLang(g.language),
    consentGiven: event.data.consentGiven === true,
    emailVerified: Boolean(guest.emailVerified || g.emailVerified),
    phoneVerified: Boolean(guest.phoneVerified || g.phoneVerified),
    legacy: {
      smsStop: stops.sms || g.smsOptOut === true,
      whatsappStop: stops.whatsapp || g.whatsappOptOut === true,
      emailUnsubscribed: g.unsubscribed === true,
    },
    occurredAt: event.occurredAt,
    sourceEventId: event.id,
  });

  const visit = await recordConnect({
    tenantUserId: ctx.tenantUserId,
    venueId,
    contactId: resolved.contactId,
    guestId,
    apId: (event.data.apId as string) ?? null,
    connectEventId: event.id,
    occurredAt: event.occurredAt,
    gapHours: await revisitGapHours(),
  });

  const contact = await loadContact(resolved.contactId);
  if (!contact) return;

  // A connect handled long after it happened (the worker was stopped) still updates
  // the guest's record, but starts nothing — no welcome hours after the visit.
  const fresh = env.now - event.occurredAt <= env.settings.safety.staleAfterHours * HOUR_MS;

  if (visit.isNew) {
    const started: EngineEvent = {
      id: eventIdFor('engine', `visit:${visit.visitId}:started`),
      type: 'visit.started',
      occurredAt: event.occurredAt,
      venueId,
      contactId: resolved.contactId,
      data: { visitId: visit.visitId, visitNumber: visit.visitNumber, isFirstVisit: visit.isFirstVisit, isRevisit: visit.isRevisit, guestId },
    };
    await appendEvent(
      { type: started.type, occurredAt: started.occurredAt, tenantUserId: ctx.tenantUserId, venueId, contactId: resolved.contactId, guestId, data: started.data },
      started.id,
    );
    if (visit.isRevisit) await wakeRunningJourneys(ctx, resolved.contactId, started, env);
    const visitFacts: VisitFacts = { visitId: visit.visitId, visitNumber: visit.visitNumber, isFirstVisit: visit.isFirstVisit, isRevisit: visit.isRevisit };
    if (fresh) await enrolForEvent({ ctx, who: { contactId: resolved.contactId, networkId: resolved.networkId, contact }, event: started, mode, visit: visitFacts, now: env.now });
    else console.warn('[ADAPTIVE] connect handled late — no journeys started:', event.id);
  }

  await armVisitEnd(ctx, resolved.contactId, visit.visitId, visit.lastSeenAt);
}

/**
 * A new visit wakes the guest's running journeys at this venue. If A1's offer is
 * still valid, the revisit also counts as `offer.redeemed` (no codes yet).
 */
async function wakeRunningJourneys(ctx: VenueContext, contactId: string, started: EngineEvent, env: RouteEnv): Promise<void> {
  const snap = await db.collection(COL.journeyInstances).where('contactId', '==', contactId).where('status', '==', 'active').get();
  for (const doc of snap.docs) {
    const inst = fromDoc(doc.id, doc.data() as Record<string, unknown>);
    if (inst.meta.venueId !== ctx.venueId) continue;
    await deliverEvent(inst.id, started, env);
    const expires = Number(inst.state.vars?.offerExpiresAt);
    if (Number.isFinite(expires) && expires > started.occurredAt && !inst.state.goal) {
      const redeemed: EngineEvent = {
        id: eventIdFor('engine', `redeem:${inst.id}:${started.data.visitId}`),
        type: 'offer.redeemed',
        occurredAt: started.occurredAt,
        venueId: ctx.venueId,
        contactId,
        instanceId: inst.id,
        data: { offerKey: inst.state.vars.offerKey ?? null, redeemedVia: 'revisit_auto', visitId: started.data.visitId },
      };
      await appendEvent(
        { type: redeemed.type, occurredAt: redeemed.occurredAt, tenantUserId: ctx.tenantUserId, venueId: ctx.venueId, contactId, instanceId: inst.id, journeyKey: inst.meta.journeyKey, data: redeemed.data },
        redeemed.id,
      );
      await deliverEvent(inst.id, redeemed, env);
    }
  }
}

/** Arms (or re-arms after a later connect) the "visit ended" fallback for journeys that start on it. */
async function armVisitEnd(ctx: VenueContext, contactId: string, visitId: string, lastSeenAt: number): Promise<void> {
  let fallbackMs: number | null = null;
  for (const j of await enabledJourneys(ctx)) {
    if (j.definition.entry.trigger.type !== 'visit.ended') continue;
    const f = (j.definition.entry.trigger.config ?? {}).fallbackAfterConnect;
    const ms = typeof f === 'string' ? durationMs(f) : durationMs('3h');
    fallbackMs = fallbackMs === null ? ms : Math.min(fallbackMs, ms);
  }
  if (fallbackMs === null) return;
  await firestoreScheduler.schedule({
    dedupeKey: `visit_end:${visitId}:${lastSeenAt}`,
    kind: 'visit_end',
    dueAt: lastSeenAt + fallbackMs,
    payload: { venueId: ctx.venueId, contactId, visitId, lastSeenAt, dueAt: lastSeenAt + fallbackMs },
    tenantUserId: ctx.tenantUserId,
    venueId: ctx.venueId,
  });
}

/**
 * The fallback fires: if no later connect moved the visit on, tell journeys the
 * visit ended (A2 starts). The visit itself stays open until the revisit gap
 * passes, so a guest back 4 h later is still on the same visit.
 */
export async function handleVisitEnd(
  payload: { venueId: string; contactId: string; visitId: string; lastSeenAt: number; dueAt?: number },
  env: RouteEnv,
): Promise<void> {
  const vSnap = await db.collection(COL.visits).doc(payload.visitId).get();
  const visit = vSnap.data() as VisitDoc | undefined;
  if (!visit || tsMs(visit.lastSeenAt) !== payload.lastSeenAt) return;
  // Handled long after it was due (the worker was stopped): too late for a review ask.
  if (payload.dueAt !== undefined && env.now - payload.dueAt > env.settings.safety.staleAfterHours * HOUR_MS) {
    console.warn('[ADAPTIVE] visit-end fallback handled late — no journeys started:', payload.visitId);
    return;
  }

  const ctx = await loadVenueContext(payload.venueId);
  if (!ctx) return;
  const mode: RunMode | 'off' = modeFor(env.settings, ctx.tenantUserId);
  if (mode === 'off') return;
  const contact = await loadContact(payload.contactId);
  if (!contact) return;

  const ended: EngineEvent = {
    id: eventIdFor('engine', `visit:${payload.visitId}:ended:${payload.lastSeenAt}`),
    type: 'visit.ended',
    occurredAt: env.now,
    venueId: payload.venueId,
    contactId: payload.contactId,
    data: { visitId: payload.visitId, endSource: 'timeout', dwellMinutes: null, visitNumber: visit.visitNumber },
  };
  await appendEvent(
    { type: ended.type, occurredAt: ended.occurredAt, tenantUserId: ctx.tenantUserId, venueId: payload.venueId, contactId: payload.contactId, data: ended.data },
    ended.id,
  );
  await enrolForEvent({
    ctx,
    who: { contactId: payload.contactId, networkId: contact.networkId, contact },
    event: ended,
    mode,
    visit: { visitId: payload.visitId, visitNumber: visit.visitNumber, isFirstVisit: visit.isFirstVisit, isRevisit: visit.isRevisit },
    now: env.now,
  });
}
