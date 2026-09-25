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

function digitsOf(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

type OptOutFlag = 'smsOptOut' | 'whatsappOptOut';
const FLAGGED_TTL_MS = 5 * 60_000;
const FLAGGED_MAX = 5000;
const flaggedCache = new Map<OptOutFlag, { forms: string[][]; at: number }>();

/**
 * The digit forms of every guest doc an old STOP flagged, read once per 5 minutes.
 * STOPs are rare, so the set is small. Forms per doc: code + number as typed, the
 * same without a trunk 0, and the number alone — typed numbers can hold spaces,
 * a leading 0 or the country code twice, which no exact query can match.
 */
async function flaggedForms(flag: OptOutFlag): Promise<string[][]> {
  const hit = flaggedCache.get(flag);
  if (hit && Date.now() - hit.at < FLAGGED_TTL_MS) return hit.forms;
  const snap = await db.collection(COL.guests).where(flag, '==', true).select('phone', 'phoneCountryCode').limit(FLAGGED_MAX).get();
  if (snap.size >= FLAGGED_MAX) console.warn(`[ADAPTIVE] more than ${FLAGGED_MAX} guest docs carry ${flag} — only the first ${FLAGGED_MAX} are checked`);
  const forms = snap.docs.map((d) => {
    const cc = digitsOf(String(d.get('phoneCountryCode') ?? ''));
    const typed = digitsOf(String(d.get('phone') ?? ''));
    return Array.from(new Set([cc + typed, cc + typed.replace(/^0+/, ''), typed.replace(/^0+/, '')])).filter((f) => f.length >= 7);
  });
  flaggedCache.set(flag, { forms, at: Date.now() });
  return forms;
}

/**
 * Old STOP flags (services/optOut.ts) sit on the guest docs that existed when the
 * STOP arrived — `phoneE164` is only on docs written since July 2026. So: a fresh
 * query for flagged docs with this `phoneE164`, and the cached flagged set compared
 * by digits the way optOut.ts matched them (equal, or one ends with the other).
 * When unsure, stop: a false match only withholds SMS.
 */
async function legacyPhoneStops(phoneE164: string): Promise<{ sms: boolean; whatsapp: boolean }> {
  const digits = digitsOf(phoneE164);
  const flagged = async (flag: OptOutFlag): Promise<boolean> => {
    const byE164 = await db.collection(COL.guests).where('phoneE164', '==', phoneE164).where(flag, '==', true).limit(1).get();
    if (!byE164.empty) return true;
    return (await flaggedForms(flag)).some((forms) => forms.some((f) => f === digits || digits.endsWith(f) || f.endsWith(digits)));
  };
  const [sms, whatsapp] = await Promise.all([flagged('smsOptOut'), flagged('whatsappOptOut')]);
  return { sms, whatsapp };
}

/** For tests. */
export function __clearLegacyCaches(): void {
  flaggedCache.clear();
}

/** The address as typed plus its common capitalisations (Firestore matches case-sensitively). */
function emailCasings(email: string, typed: string[]): string[] {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const capParts = (s: string) => s.split(/([._-])/).map(cap).join('');
  const locals = [local, cap(local), capParts(local), local.toUpperCase()];
  const domains = [domain, cap(domain), domain.toUpperCase()];
  const out = new Set<string>(typed);
  out.add(email);
  for (const l of locals) for (const d of domains) out.add(`${l}@${d}`);
  return Array.from(out).slice(0, 30);
}

/**
 * Old email unsubscribes (routes/unsubscribe.ts) flag the one guest doc the link
 * was for — there is one per email (as typed) and access point. The page promised
 * "no more marketing emails from this venue", so a flag on any of this address's
 * docs at one of this venue's access points counts. Docs keep the address as typed
 * and Firestore can't match case-insensitively, so the common capitalisations are
 * asked for; an unusual one (e.g. "aNNa@x.ch") can still be missed.
 */
async function legacyEmailUnsubscribed(typed: Array<string | null | undefined>, email: string, venueId: string): Promise<boolean> {
  const values = emailCasings(email, typed.map((t) => String(t ?? '').trim()).filter((v) => v.length > 0));
  const snap = await db.collection(COL.guests).where('email', 'in', values).where('unsubscribed', '==', true).limit(20).get();
  const apIds = Array.from(new Set(snap.docs.map((d) => d.get('captivePortalAccessPointId')).filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (!apIds.length) return false;
  const aps = await db.getAll(...apIds.map((id) => db.collection(COL.accessPoints).doc(id)));
  return aps.some((ap) => ap.get('venueId') === venueId);
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

  const [stops, emailUnsubscribed] = await Promise.all([
    phoneE164 ? legacyPhoneStops(phoneE164) : { sms: false, whatsapp: false },
    email ? legacyEmailUnsubscribed([guest.email, g.email], email, venueId) : false,
  ]);
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
    // Only this request's own check: the guest doc's flag isn't tied to a number,
    // and a reconnect can change the number under it. A contact keeps a flag it
    // earned earlier for the same number (resolve.ts).
    phoneVerified: Boolean(guest.phoneVerified),
    legacy: {
      smsStop: stops.sms || g.smsOptOut === true,
      whatsappStop: stops.whatsapp || g.whatsappOptOut === true,
      emailUnsubscribed: g.unsubscribed === true || emailUnsubscribed,
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
