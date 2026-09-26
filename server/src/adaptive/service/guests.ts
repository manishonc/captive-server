/**
 * The owner's guests (plan §5; PR D): the masked list per venue, one guest's timeline in plain
 * sentences, "Stop marketing to this guest" (and resume, D-D6), the venue's recent messages with
 * a one-line reason each (behind MCP `list_adaptive_messages`), and a lookup by guest id / email /
 * phone (behind MCP `explain_adaptive_guest`).
 *
 *  - A contact belongs to one owner (`{tenantUserId}_…`), so nothing here can show another
 *    owner's guest; ids of other owners that ride along (a STOP's send key, a block) never show.
 *  - Addresses only masked; no message bodies; rating feedback never (it isn't stored).
 *  - The timeline covers all of this owner's venues, each line labelled with its venue.
 */

import { FieldPath } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ConsentEntry, ContactDoc, ContactVenueDoc, JourneySendDoc } from '../store/engineTypes';
import type { Actor } from '../core/schemas';
import { pickLang } from '../core/schemas';
import type { Channel } from '../core/constants';
import { ApiError, notFound } from '../api/errors';
import { getVenues, listTenantVenues } from '../store/tenantData';
import { listVenuePlaybooks } from '../store/venueSetups';
import { toJson } from '../store/serialize';
import { tsMs } from '../store/time';
import { now, refreshClock } from '../engine/clock';
import { loadCatalogue } from './catalogue';
import { venueScope } from '../identity/resolve';
import { writeOwnerMarketing } from '../identity/consent';
import { contactPointId } from '../identity/key';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { ensureRollup } from '../rollups/rollup';
import { maskedGuest } from '../core/owner/mask';
import {
  buildTimeline,
  offerLabelsFrom,
  type OfferLabels,
  type TimelineConsentInput,
  type TimelineEventInput,
  type TimelineSendInput,
  type TimelineVenue,
} from '../core/owner/timeline';
import {
  contactAllStaysQuery,
  contactConsentQuery,
  contactEventsQuery,
  contactInstancesQuery,
  contactVenuesQuery,
  venueEventsOfTypesQuery,
  venueGuestsQuery,
} from '../store/ownerQueries';
import { assertLookupKeyMatches } from './identityGuard';

const TIMELINE_LIMIT = 500;
const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];

async function ownedVenue(tenantUserId: string, venueId: string) {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
  return venue;
}

function iso(v: unknown): string | null {
  const ms = tsMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

function langOf(v: unknown): 'en' | 'de' {
  return v === 'de' ? 'de' : 'en';
}

async function journeyNames(lang: 'en' | 'de'): Promise<Record<string, string>> {
  const cat = await loadCatalogue();
  const out: Record<string, string> = {};
  for (const [key, rec] of cat.templates) out[key] = pickLang(rec.header.name, lang);
  return out;
}

/**
 * For a German timeline: the offer labels of this tenant's venue setups, so an issued offer is
 * named in German (the event stores the English label). English needs no read: it uses the
 * stored label. Optional: if the read (or an odd setup doc) fails, the timeline keeps the stored
 * labels — never failing the owner's or HeidiFi's guest view. Only the error's name is logged.
 */
export async function tenantOfferLabels(tenantUserId: string, lang: 'en' | 'de'): Promise<OfferLabels> {
  if (lang !== 'de') return {};
  try {
    return offerLabelsFrom(await listVenuePlaybooks(tenantUserId));
  } catch (err) {
    console.error('[ADAPTIVE] German offer labels failed (stored labels used):', (err as Error)?.name ?? 'Error');
    return {};
  }
}

async function tenantVenueMap(tenantUserId: string): Promise<Record<string, TimelineVenue>> {
  const venues = await listTenantVenues(tenantUserId);
  const avs = venues.length ? await db.getAll(...venues.map((v) => db.collection(COL.adaptiveVenues).doc(`venue_${v.venueId}`))) : [];
  const out: Record<string, TimelineVenue> = {};
  venues.forEach((v, i) => {
    out[v.venueId] = { name: v.name, tz: String(avs[i]?.get('timezone') ?? v.timezone ?? 'Europe/Zurich') };
  });
  return out;
}

/** Per channel at one venue: yes / no / no answer, and whether the owner stopped it. */
function consentChips(contact: ContactDoc, venueId: string) {
  const byCh = contact.marketingConsent?.[venueScope(venueId)] ?? {};
  // Stopped at all venues: a venue without an answer yet counts as stopped too.
  const stoppedAll = Boolean(contact.ownerStoppedAll);
  const chip = (e: ConsentEntry | undefined) => ({
    state: e?.state === 'granted' ? 'yes' : e?.state === 'revoked' && e.revokedVia ? 'no' : 'none',
    ownerStopped: e?.ownerStopped === true || (!e && stoppedAll),
    at: iso(e?.at),
  });
  return Object.fromEntries(CHANNELS.map((c) => [c, chip(byCh[c])])) as Record<Channel, ReturnType<typeof chip>>;
}

// ── Guests list ──────────────────────────────────────────────────────────────

function encodeCursor(lastVisitAt: number | null, id: string): string {
  return Buffer.from(JSON.stringify([lastVisitAt ?? 0, id])).toString('base64url');
}

function decodeCursor(raw: unknown): { at: number; id: string } | null {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    // A time Firestore can hold, and a document id (not a path): anything else is a made-up cursor.
    const okAt = typeof at === 'number' && Number.isFinite(at) && at >= -62_135_596_800_000 && at <= 253_402_300_799_999;
    const okId = typeof id === 'string' && id.length > 0 && id.length <= 1500 && !id.includes('/');
    return okAt && okId ? { at, id } : null;
  } catch {
    return null;
  }
}

/** A page boundary Firestore refuses is the caller's bad cursor (400), not a server error. */
function withCursor<T>(build: () => T): T {
  try {
    return build();
  } catch {
    throw new ApiError('bad_request', 'That page cursor is not valid');
  }
}

export async function listGuests(tenantUserId: string, venueId: string, query: { cursor?: unknown; limit?: unknown; lang?: unknown }) {
  await ownedVenue(tenantUserId, venueId);
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit)) || 25));
  const lang = langOf(query.lang);
  let q = venueGuestsQuery(venueId);
  const cursor = decodeCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== '' && !cursor) throw new ApiError('bad_request', 'That page cursor is not valid');
  if (cursor) q = withCursor(() => q.startAfter(new Date(cursor.at), cursor.id));
  const snap = await q.limit(limit + 1).get();
  const page = snap.docs.slice(0, limit);
  const cvs = page.map((d) => ({ id: d.id, doc: d.data() as ContactVenueDoc })).filter((c) => c.doc.tenantUserId === tenantUserId);
  const contactSnaps = cvs.length ? await db.getAll(...cvs.map((c) => db.collection(COL.contacts).doc(c.doc.contactId))) : [];
  const instanceIds = cvs.flatMap((c) => Object.values(c.doc.journeys ?? {}).map((j) => j.activeInstanceId).filter((x): x is string => Boolean(x)));
  const instSnaps = instanceIds.length ? await db.getAll(...instanceIds.map((id) => db.collection(COL.journeyInstances).doc(id))) : [];
  const insts = new Map(instSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as Record<string, any>]));
  const names = await journeyNames(lang);
  const guests = cvs.map((c, i) => {
    const contact = (contactSnaps[i]?.data() ?? null) as ContactDoc | null;
    const journeys = Object.entries(c.doc.journeys ?? {})
      .map(([key, j]) => {
        const inst = j.activeInstanceId ? insts.get(j.activeInstanceId) : undefined;
        return {
          journeyKey: key,
          name: names[key] ?? key,
          running: Boolean(inst && inst.status === 'active'),
          mode: inst?.mode === 'live' ? 'live' : inst ? 'test' : null,
          nextAt: iso(inst?.waiting?.untilAt),
          waitingFor: inst?.waiting?.kind ?? null,
          lastExitReason: j.lastExitReason ?? null,
          lastEnteredAt: iso(j.lastEnteredAt),
        };
      })
      .sort((a, b) => String(b.lastEnteredAt ?? '').localeCompare(String(a.lastEnteredAt ?? '')));
    return {
      contactId: c.doc.contactId,
      ...maskedGuest(contact),
      lang: contact?.lang ?? null,
      firstVisitAt: iso(c.doc.firstVisitAt),
      lastVisitAt: iso(c.doc.lastVisitAt),
      visitCount: Number(c.doc.visitCount) || 0,
      consent: contact ? consentChips(contact, venueId) : null,
      lowRating: Boolean(c.doc.lowRatingAt),
      journeys,
    };
  });
  const last = page[page.length - 1];
  const nextCursor = snap.docs.length > limit && last ? encodeCursor(tsMs(last.get('lastVisitAt')), last.id) : null;
  return { guests, nextCursor };
}

// ── One guest ────────────────────────────────────────────────────────────────

/** Everything the engine has on one of this owner's guests (the timeline's inputs). */
export async function loadGuestRecord(contactId: string, tenantUserId: string | null) {
  const [eventsSnap, consentSnap, instSnap, staySnap] = await Promise.all([
    contactEventsQuery(contactId).limit(TIMELINE_LIMIT + 1).get(),
    contactConsentQuery(contactId).limit(TIMELINE_LIMIT).get(),
    contactInstancesQuery(contactId).get(),
    contactAllStaysQuery(contactId).get(),
  ]);
  const own = (d: FirebaseFirestore.DocumentSnapshot) => tenantUserId === null || d.get('tenantUserId') === tenantUserId;
  const eventDocs = eventsSnap.docs.slice(0, TIMELINE_LIMIT).filter(own);
  const events: TimelineEventInput[] = eventDocs.map((d) => {
    const e = d.data() as Record<string, any>;
    return {
      id: d.id,
      type: String(e.type),
      occurredAt: tsMs(e.occurredAt) ?? 0,
      venueId: e.venueId ?? null,
      tenantUserId: e.tenantUserId ?? null,
      contactId: e.contactId ?? null,
      instanceId: e.instanceId ?? null,
      journeyKey: e.journeyKey ?? null,
      nodeId: e.nodeId ?? null,
      sendKey: e.sendKey ?? null,
      channel: e.channel ?? null,
      mode: e.mode === 'live' || e.mode === 'test' ? e.mode : null,
      source: e.source ?? null,
      data: (e.data ?? {}) as Record<string, unknown>,
    };
  });
  const consentDocs = consentSnap.docs.filter(own);
  // The sends the log names, and those a consent change came through (a STOP answering one of ours).
  const sendKeys = [
    ...new Set(
      [...events.map((e) => e.sendKey), ...consentDocs.map((d) => d.get('sourceRef.sendKey'))].filter((k): k is string => typeof k === 'string' && k.startsWith('js_')),
    ),
  ];
  const sendSnaps = sendKeys.length ? await db.getAll(...sendKeys.map((k) => db.collection(COL.journeySends).doc(k))) : [];
  const sends: Record<string, TimelineSendInput & { raw: JourneySendDoc }> = {};
  for (const s of sendSnaps) {
    if (!s.exists || !own(s)) continue;
    const d = s.data() as JourneySendDoc;
    sends[s.id] = {
      sendKey: s.id,
      status: d.status,
      channel: d.channel ?? null,
      purpose: d.purpose ?? null,
      mode: d.mode ?? null,
      credits: d.credits?.amount ?? null,
      toMasked: d.toMasked ?? null,
      tenantUserId: d.tenantUserId,
      venueId: d.venueId,
      decision: d.decision ?? null,
      kind: d.kind ?? null,
      raw: d,
    };
  }
  const consents: TimelineConsentInput[] = consentDocs.map((d) => ({
    id: d.id,
    occurredAt: tsMs(d.get('occurredAt')) ?? 0,
    venueId: String(d.get('venueId') ?? ''),
    channel: String(d.get('channel') ?? ''),
    action: d.get('action') === 'grant' ? 'grant' : 'revoke',
    source: String(d.get('source') ?? ''),
    tenantUserId: d.get('tenantUserId') ?? null,
    sourceRef: (d.get('sourceRef') ?? null) as Record<string, unknown> | null,
  }));
  return {
    events,
    truncated: eventsSnap.docs.length > TIMELINE_LIMIT,
    sends,
    consents,
    consentDocs,
    instances: instSnap.docs.filter(own).map((d) => ({ id: d.id, data: d.data() as Record<string, any> })),
    stays: staySnap.docs.filter(own).map((d) => ({ id: d.id, data: d.data() as Record<string, any> })),
  };
}

export async function getGuest(tenantUserId: string, venueId: string, contactId: string, query: { lang?: unknown }) {
  await ownedVenue(tenantUserId, venueId);
  const lang = langOf(query.lang);
  const [contactSnap, cvSnap] = await Promise.all([
    db.collection(COL.contacts).doc(contactId).get(),
    db.collection(COL.contactVenues).doc(contactVenueId(contactId, venueId)).get(),
  ]);
  if (!contactSnap.exists || contactSnap.get('tenantUserId') !== tenantUserId || !cvSnap.exists) throw notFound('This guest was not found at this venue');
  const contact = contactSnap.data() as ContactDoc;
  const [record, venues, names, offerLabels] = await Promise.all([
    loadGuestRecord(contactId, tenantUserId),
    tenantVenueMap(tenantUserId),
    journeyNames(lang),
    tenantOfferLabels(tenantUserId, lang),
  ]);
  const timeline = buildTimeline({
    tenantUserId,
    events: record.events,
    sends: record.sends,
    consents: record.consents,
    venues,
    journeyNames: names,
    lang,
    audience: 'owner',
    defaultTz: venues[venueId]?.tz,
    offerLabels,
  });
  const cv = cvSnap.data() as ContactVenueDoc;
  return {
    contactId,
    guest: { ...maskedGuest(contact), lang: contact.lang ?? null },
    venue: {
      venueId,
      firstVisitAt: iso(cv.firstVisitAt),
      lastVisitAt: iso(cv.lastVisitAt),
      visitCount: Number(cv.visitCount) || 0,
      consent: consentChips(contact, venueId),
      lowRating: Boolean(cv.lowRatingAt),
    },
    journeys: record.instances
      .filter((i) => venues[i.data.venueId])
      .map((i) => ({
        journeyKey: i.data.journeyKey,
        name: names[i.data.journeyKey] ?? i.data.journeyKey,
        venueId: i.data.venueId,
        venueName: venues[i.data.venueId]?.name ?? null,
        status: i.data.status,
        mode: i.data.mode === 'live' ? 'live' : 'test',
        startedAt: iso(i.data.startedAt),
        endedAt: iso(i.data.endedAt),
        exitReason: i.data.exitReason ?? null,
        nextAt: i.data.status === 'active' ? iso(i.data.waiting?.untilAt) : null,
      }))
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))),
    stays: record.stays
      .filter((s) => venues[s.data.venueId])
      .map((s) => ({ stayId: s.id, venueId: s.data.venueId, checkIn: s.data.checkIn, checkOut: s.data.checkOut, nights: s.data.nights, status: s.data.status, linkedBy: s.data.linkedBy ?? 'guest' })),
    creditsUsed: Object.values(record.sends).reduce((sum, s) => sum + (s.mode === 'live' && s.status !== 'failed' ? Number(s.credits) || 0 : 0), 0),
    timeline,
    truncated: record.truncated,
  };
}

// ── Stop / resume marketing ──────────────────────────────────────────────────

const marketingInputSchema = z.object({ action: z.enum(['stop', 'resume']), scope: z.enum(['venue', 'all']) });

export async function setGuestMarketing(tenantUserId: string, venueId: string, contactId: string, body: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId);
  const b = (body ?? {}) as Record<string, unknown>;
  const input = marketingInputSchema.parse({ action: b.action, scope: b.scope });
  const venueIds = input.scope === 'venue' ? [venueId] : (await listTenantVenues(tenantUserId)).map((v) => v.venueId);
  await refreshClock();
  const at = now();
  const changed = await db.runTransaction(async (tx) => {
    const [contactSnap, cvSnap] = await Promise.all([
      tx.get(db.collection(COL.contacts).doc(contactId)),
      tx.get(db.collection(COL.contactVenues).doc(contactVenueId(contactId, venueId))),
    ]);
    if (!contactSnap.exists || contactSnap.get('tenantUserId') !== tenantUserId || !cvSnap.exists) throw notFound('This guest was not found at this venue');
    return writeOwnerMarketing(tx, contactId, contactSnap.data() as ContactDoc, { action: input.action, venueIds, at, by: actor.uid, scope: input.scope });
  });
  if (changed) await ensureRollup(venueId, tenantUserId);
  const contact = (await db.collection(COL.contacts).doc(contactId).get()).data() as ContactDoc;
  return {
    contactId,
    action: input.action,
    scope: input.scope,
    changed,
    consent: consentChips(contact, venueId),
    note: 'Adaptive Campaigns only: the Marketing tab and Campaign Manager are separate.',
  };
}

// ── The venue's recent messages (MCP list_adaptive_messages) ─────────────────

const MESSAGE_TYPES = ['message.sent', 'send.dry_run', 'message.failed', 'message.unknown'];
const SKIP_TYPES = ['send.skipped', 'send.blocked', 'send.deferred'];

export async function listMessages(tenantUserId: string, venueId: string, query: { kind?: unknown; days?: unknown; cursor?: unknown; limit?: unknown; lang?: unknown }) {
  await ownedVenue(tenantUserId, venueId);
  const lang = langOf(query.lang);
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit)) || 25));
  const days = Math.min(92, Math.max(1, Number(query.days) || 7));
  const types = query.kind === 'sends' ? MESSAGE_TYPES : query.kind === 'skips' ? SKIP_TYPES : [...MESSAGE_TYPES, ...SKIP_TYPES];
  await refreshClock();
  let q = venueEventsOfTypesQuery(venueId, types, new Date(now() - days * 86_400_000));
  const cursor = decodeCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== '' && !cursor) throw new ApiError('bad_request', 'That page cursor is not valid');
  if (cursor) q = withCursor(() => q.orderBy(FieldPath.documentId(), 'desc').startAfter(new Date(cursor.at), cursor.id));
  else q = q.orderBy(FieldPath.documentId(), 'desc');
  const snap = await q.limit(limit + 1).get();
  const page = snap.docs.slice(0, limit).filter((d) => d.get('tenantUserId') === tenantUserId);
  const events: TimelineEventInput[] = page.map((d) => {
    const e = d.data() as Record<string, any>;
    return {
      id: d.id,
      type: String(e.type),
      occurredAt: tsMs(e.occurredAt) ?? 0,
      venueId: e.venueId ?? null,
      tenantUserId: e.tenantUserId ?? null,
      contactId: e.contactId ?? null,
      instanceId: e.instanceId ?? null,
      journeyKey: e.journeyKey ?? null,
      nodeId: e.nodeId ?? null,
      sendKey: e.sendKey ?? null,
      channel: e.channel ?? null,
      mode: e.mode === 'live' || e.mode === 'test' ? e.mode : null,
      source: e.source ?? null,
      data: (e.data ?? {}) as Record<string, unknown>,
    };
  });
  const sendKeys = [...new Set(events.map((e) => e.sendKey).filter((k): k is string => typeof k === 'string' && k.startsWith('js_')))];
  const sendSnaps = sendKeys.length ? await db.getAll(...sendKeys.map((k) => db.collection(COL.journeySends).doc(k))) : [];
  const sends: Record<string, TimelineSendInput> = {};
  for (const s of sendSnaps) {
    if (!s.exists || s.get('tenantUserId') !== tenantUserId) continue;
    const d = s.data() as JourneySendDoc;
    sends[s.id] = { sendKey: s.id, status: d.status, channel: d.channel ?? null, purpose: d.purpose ?? null, mode: d.mode ?? null, credits: d.credits?.amount ?? null, toMasked: d.toMasked ?? null, tenantUserId: d.tenantUserId, venueId: d.venueId, decision: d.decision ?? null, kind: d.kind ?? null };
  }
  const contactIds = [...new Set(events.map((e) => e.contactId).filter((c): c is string => Boolean(c)))];
  const contactSnaps = contactIds.length ? await db.getAll(...contactIds.map((id) => db.collection(COL.contacts).doc(id))) : [];
  const guestNames = new Map(contactSnaps.filter((c) => c.exists && c.get('tenantUserId') === tenantUserId).map((c) => [c.id, maskedGuest(c.data() as ContactDoc).name]));
  const venues = await tenantVenueMap(tenantUserId);
  const names = await journeyNames(lang);
  const messages = events.map((e) => {
    const s = e.sendKey ? sends[e.sendKey] : undefined;
    // The same sentence the guest's timeline shows for this event.
    const item = buildTimeline({ tenantUserId, events: [e], sends, consents: [], venues, journeyNames: names, lang, audience: 'owner', defaultTz: venues[venueId]?.tz })[0];
    return {
      at: new Date(e.occurredAt).toISOString(),
      type: e.type,
      mode: e.mode ?? s?.mode ?? null,
      journeyKey: e.journeyKey ?? null,
      journeyName: e.journeyKey ? names[e.journeyKey] ?? e.journeyKey : null,
      channel: e.channel ?? s?.channel ?? null,
      status: s?.status ?? null,
      credits: s?.mode === 'live' ? s?.credits ?? null : null,
      to: s?.toMasked ?? null,
      contactId: e.contactId ?? null,
      guest: e.contactId ? guestNames.get(e.contactId) ?? null : null,
      line: item?.sentence ?? null,
    };
  });
  const last = snap.docs[limit - 1];
  const nextCursor = snap.docs.length > limit && last ? encodeCursor(tsMs(last.get('occurredAt')), last.id) : null;
  return { messages, nextCursor };
}

// ── Find a guest (MCP explain_adaptive_guest) ────────────────────────────────

const findInputSchema = z
  .object({
    // Doc ids: our id characters only (a `/` would reach Firestore as a path and answer a 500).
    contactId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    guestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    email: z.string().min(3).max(254).optional(),
    phone: z.string().min(6).max(32).optional(),
  })
  .refine((b) => Boolean(b.contactId || b.guestId || b.email || b.phone), 'Give a contactId, guestId, email or phone');

/**
 * One of this owner's guests from what the owner knows — the id `search_guests` gives, an email
 * or a phone (POST, so addresses never go into URLs). Anything not this owner's is a 404.
 */
export async function findGuest(tenantUserId: string, body: unknown) {
  const input = findInputSchema.parse(body ?? {});
  let contactId: string | null = null;
  if (input.contactId) contactId = input.contactId;
  else {
    let email: string | null = null;
    let phone: string | null = null;
    if (input.guestId) {
      const g = (await db.collection(COL.guests).doc(input.guestId).get()).data() as Record<string, any> | undefined;
      if (!g) throw notFound('No such guest in this account');
      // The guest doc must be from one of this owner's access points.
      const apId = typeof g.captivePortalAccessPointId === 'string' ? g.captivePortalAccessPointId : null;
      const ap = apId ? (await db.collection(COL.accessPoints).doc(apId).get()).data() : undefined;
      const venueOf = typeof ap?.venueId === 'string' ? (await getVenues([ap.venueId])).get(ap.venueId) : undefined;
      if (!venueOf || venueOf.tenantUserId !== tenantUserId) throw notFound('No such guest in this account');
      email = normalizeEmail(String(g.email ?? ''));
      phone = typeof g.phoneE164 === 'string' ? g.phoneE164 : normalizeE164(String(g.phoneCountryCode ?? ''), String(g.phone ?? ''));
    } else {
      email = input.email ? normalizeEmail(input.email) : null;
      phone = input.phone ? normalizeE164('', input.phone) : null;
    }
    if (!email && !phone) throw notFound('No such guest in this account');
    await assertLookupKeyMatches();
    for (const [kind, value] of [['email', email], ['phone', phone]] as const) {
      if (!value || contactId) continue;
      const cp = await db.collection(COL.contactPoints).doc(contactPointId(kind, value)).get();
      const id = (cp.get('tenantContacts') ?? {})[tenantUserId];
      if (typeof id === 'string') contactId = id;
    }
  }
  if (!contactId) throw notFound('No such guest in this account');
  const snap = await db.collection(COL.contacts).doc(contactId).get();
  if (!snap.exists || snap.get('tenantUserId') !== tenantUserId) throw notFound('No such guest in this account');
  const cvs = await contactVenuesQuery(contactId).get();
  const places = cvs.docs
    .filter((d) => d.get('tenantUserId') === tenantUserId)
    .map((d) => ({ venueId: String(d.get('venueId')), lastVisitAt: iso(d.get('lastVisitAt')) }))
    .sort((a, b) => String(b.lastVisitAt ?? '').localeCompare(String(a.lastVisitAt ?? '')));
  return { contactId, guest: maskedGuest(snap.data() as ContactDoc), venues: places };
}

