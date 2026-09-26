/**
 * HeidiFi's own tools (plan §5 admin routes; PR D): the dead-task list and retry, the failing
 * calendar feeds, guest search across accounts and one guest's full record (every rule with its
 * fact, provider status history, consent ledger, stays, raw docs). SUPER_ADMIN only (the cms
 * checks; the routes also require `actor.kind: 'super_admin'` on writes).
 *
 *  - Search is POST: addresses never land in URLs or logs. It refuses when this API's identity
 *    key differs from the engine's (every lookup would silently find nobody).
 *  - Lists never carry a task's payload (a connect task holds the guest's details until it is
 *    done) or a calendar link (a secret).
 */

import { z } from 'zod';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ContactDoc } from '../store/engineTypes';
import type { Actor } from '../core/schemas';
import { ApiError, conflict, notFound } from '../api/errors';
import { toJson } from '../store/serialize';
import { tsMs } from '../store/time';
import { HOUR_MS } from '../core/runtime/time';
import { contactPointId } from '../identity/key';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { loadEvent } from '../engine/events';
import { failingFeedsQuery } from '../stays/store';
import { feedWords } from '../stays/words';
import { deadTasksQuery, contactVenuesQuery } from '../store/ownerQueries';
import { listTenantVenues } from '../store/tenantData';
import { loadCatalogue } from './catalogue';
import { pickLang } from '../core/schemas';
import { buildTimeline, type TimelineVenue } from '../core/owner/timeline';
import { assertLookupKeyMatches } from './identityGuard';
import { detailLessSignal, isUrgent, refusalText, urgentNote } from '../core/owner/deadTasks';
import { loadGuestRecord } from './guests';
import { now, refreshClock } from '../engine/clock';
import { readEngineSettings } from '../store/engineSettings';

const DEAD_LIST = 50;
const CONNECT_RETRY_MAX_AGE_MS = 72 * HOUR_MS;

function iso(v: unknown): string | null {
  const ms = tsMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

/** A short, address-free line of a task's last error (it is free text from any thrown error). */
function safeError(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  return raw
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .slice(0, 300);
}

/** For `GET /admin/engine`: the newest dead tasks and the failing calendar feeds. */
export async function healthLists() {
  const [dead, feeds] = await Promise.all([
    deadTasksQuery()
      .limit(DEAD_LIST)
      .get()
      .then((s) => ({ docs: s.docs, error: null as string | null }))
      .catch((err: unknown) => ({ docs: [], error: String((err as Error)?.message ?? err).slice(0, 300) })),
    failingFeedsQuery().limit(DEAD_LIST).get(),
  ]);
  // What each dead signal was (its event's type only — never the payload or the event's data).
  const eventIds = [
    ...new Set(
      dead.docs
        .filter((d) => d.get('kind') === 'signal' || d.get('kind') === 'event_route')
        .map((d) => d.get('payload.eventId'))
        .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_:.-]{1,200}$/.test(id) && !id.includes('/')),
    ),
  ];
  const events = new Map<string, { type: string; source: unknown; contactId: unknown }>();
  if (eventIds.length) {
    try {
      for (const s of await db.getAll(...eventIds.map((id) => db.collection(COL.journeyEvents).doc(id)))) {
        if (s.exists) events.set(s.id, { type: String(s.get('type') ?? ''), source: s.get('data.source'), contactId: s.get('contactId') });
      }
    } catch (err) {
      console.error('[ADAPTIVE] dead-list event lookup failed:', (err as Error)?.name ?? 'Error');
    }
  }
  const rows = dead.docs.map((d) => {
    const eventId = d.get('payload.eventId');
    const ev = typeof eventId === 'string' ? events.get(eventId) : undefined;
    const what = ev ? detailLessSignal(ev) : null;
    const urgent = isUrgent(what);
    return {
      taskId: d.id,
      kind: d.get('kind'),
      ...(ev ? { what: what ?? ev.type } : {}),
      ...(what || ev?.type === 'wifi.connected' ? { guestDetails: 'removed' as const } : {}),
      ...(urgent ? { urgent: true, note: urgentNote(what) } : {}),
      tenantUserId: d.get('tenantUserId') ?? null,
      venueId: d.get('venueId') ?? null,
      attempts: Number(d.get('attempts')) || 0,
      dueAt: iso(d.get('dueAt')),
      diedAt: iso(d.get('doneAt')),
      createdAt: iso(d.get('createdAt')),
      lastError: safeError(d.get('lastError')),
      retried: Number(d.get('retry.count')) || 0,
    };
  });
  // Urgent rows first (a guest's "no" never applied), then newest first as listed.
  const deadTasks = [...rows.filter((r) => 'urgent' in r), ...rows.filter((r) => !('urgent' in r))];
  return {
    deadTasks,
    urgentDeadTasks: deadTasks.filter((r) => 'urgent' in r).length,
    ...(dead.error ? { deadTasksError: dead.error } : {}),
    failingFeeds: feeds.docs.map((d) => ({
      feedId: d.id,
      tenantUserId: d.get('tenantUserId') ?? null,
      venueId: d.get('venueId') ?? null,
      lastError: d.get('lastError') ?? null,
      lastErrorWords: feedWords(d.get('lastError')),
      consecutiveErrors: Number(d.get('consecutiveErrors')) || 0,
      lastSuccessAt: iso(d.get('lastSuccessAt')),
      failingSince: iso(d.get('failingSince')),
    })),
  };
}

/**
 * Puts a dead task back in the queue — once; a task that isn't dead (it ran meanwhile, or was
 * retried already) is left alone (409). Its due time is kept, so a timer that died days ago is
 * still judged by the stale rule instead of sending late. Refused for signals whose guest
 * details were removed when they died (a STOP, START, reply or old-style unsubscribe would run
 * and apply nothing) and for Wi-Fi connects older than 72 h.
 */
export async function retryTask(taskId: string, actor: Actor) {
  const ref = db.collection(COL.journeyTasks).doc(taskId);
  const first = await ref.get();
  if (!first.exists) throw notFound('No such task');
  if (first.get('status') !== 'dead') throw conflict('Only a dead task can be retried');
  const kind = String(first.get('kind'));
  const payload = (first.get('payload') ?? {}) as Record<string, unknown>;
  let warning: string | null = null;
  if (kind === 'signal' || kind === 'event_route') {
    const event = typeof payload.eventId === 'string' ? await loadEvent(payload.eventId) : null;
    if (event && !payload.guest) {
      const lost = detailLessSignal({ type: event.type, source: event.data.source, contactId: event.contactId });
      if (lost) throw conflict(refusalText(lost));
      if (event.type === 'rating.submitted') {
        // Only a rating never applied loses anything, and only its private feedback on a low rating (the owner's alert).
        const applied = Boolean((await db.collection(COL.journeyEvents).doc(event.id).get()).get('appliedAt'));
        if (!applied && event.data.hasFeedback === true && Number(event.data.stars) <= 3) {
          warning = "This rating was never applied: the guest's private feedback was removed when the task failed, so the owner's alert email goes out without it.";
        }
      }
      if (event.type === 'wifi.connected') {
        // The engine clock, as the worker judges it (the same as real time outside the sandbox).
        await refreshClock();
        const age = now() - event.occurredAt;
        if (age > CONNECT_RETRY_MAX_AGE_MS) throw conflict('This Wi-Fi login is more than 72 hours old: too late to retry it.');
        warning = "The guest's details from the login were removed when it failed: the saved guest record is used (a phone verified at that login counts as not verified).";
        // The worker starts journeys only for a login younger than the stale limit (engine/route.ts).
        const staleHours = (await readEngineSettings()).safety.staleAfterHours;
        if (age > staleHours * HOUR_MS) {
          warning += ` This login is more than ${staleHours} hours old: the guest record and visit are updated, but no journey starts and no stay is linked.`;
        }
      }
    }
  }
  const retried = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'dead') return false;
    const count = (Number(snap.get('retry.count')) || 0) + 1;
    tx.update(ref, {
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      doneAt: null,
      expireAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
      retry: { at: new Date(), by: actor.uid, count },
    });
    return true;
  });
  if (!retried) throw conflict('This task is not dead any more (it ran, or was retried already)');
  return { taskId, kind, retried: true, ...(warning ? { warning } : {}) };
}

// ── Guest search and record ──────────────────────────────────────────────────

const searchSchema = z
  .object({ email: z.string().min(3).max(254).optional(), phone: z.string().min(6).max(32).optional() })
  .refine((b) => Boolean(b.email || b.phone), 'Give an email or a phone number (+41 …)');

export async function searchGuests(body: unknown) {
  const input = searchSchema.parse(body ?? {});
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone ? normalizeE164('', input.phone) : null;
  if (input.email && !email) throw new ApiError('bad_request', "That email address isn't valid");
  if (input.phone && !phone) throw new ApiError('bad_request', 'Give the phone number with its country code (+41 …)');
  await assertLookupKeyMatches();
  const found = new Map<string, { contactId: string; tenantUserId: string; via: string[]; blocks: Record<string, unknown> }>();
  for (const [kind, value] of [['email', email], ['phone', phone]] as const) {
    if (!value) continue;
    const cp = await db.collection(COL.contactPoints).doc(contactPointId(kind, value)).get();
    if (!cp.exists) continue;
    for (const [tenantUserId, contactId] of Object.entries((cp.get('tenantContacts') ?? {}) as Record<string, string>)) {
      const f = found.get(contactId) ?? { contactId, tenantUserId, via: [], blocks: {} };
      f.via.push(kind);
      f.blocks = { ...f.blocks, ...(toJson(cp.get('suppression') ?? {}) as Record<string, unknown>) };
      found.set(contactId, f);
    }
  }
  const results = [];
  for (const f of found.values()) {
    const [contact, user, places] = await Promise.all([
      db.collection(COL.contacts).doc(f.contactId).get(),
      db.collection(COL.tenantUsers).doc(f.tenantUserId).get(),
      contactVenuesQuery(f.contactId).get(),
    ]);
    results.push({
      contactId: f.contactId,
      tenantUserId: f.tenantUserId,
      account: { name: user.get('displayName') ?? user.get('companyName') ?? user.get('name') ?? null, email: user.get('email') ?? null },
      matchedBy: f.via,
      name: contact.exists ? [contact.get('firstName'), contact.get('lastName')].filter(Boolean).join(' ') || null : null,
      lastSeenAt: iso(contact.get('lastSeenAt')),
      venues: places.docs.map((d) => ({ venueId: d.get('venueId'), lastVisitAt: iso(d.get('lastVisitAt')), visitCount: Number(d.get('visitCount')) || 0 })),
      blocks: f.blocks,
    });
  }
  return { results };
}

/** Everything about one person, for HeidiFi: every rule with its fact, statuses, consent, stays, raw docs. */
export async function adminGuest(contactId: string, query: { lang?: unknown }) {
  const lang = query.lang === 'de' ? 'de' : 'en';
  const snap = await db.collection(COL.contacts).doc(contactId).get();
  if (!snap.exists) throw notFound('No such guest');
  const contact = snap.data() as ContactDoc;
  const [record, venuesList, places, cat] = await Promise.all([
    loadGuestRecord(contactId, contact.tenantUserId),
    listTenantVenues(contact.tenantUserId),
    contactVenuesQuery(contactId).get(),
    loadCatalogue(),
  ]);
  const venues: Record<string, TimelineVenue> = Object.fromEntries(venuesList.map((v) => [v.venueId, { name: v.name, tz: v.timezone ?? 'Europe/Zurich' }]));
  const journeyNames: Record<string, string> = {};
  for (const [key, rec] of cat.templates) journeyNames[key] = pickLang(rec.header.name, lang);
  const timeline = buildTimeline({ tenantUserId: contact.tenantUserId, events: record.events, sends: record.sends, consents: record.consents, venues, journeyNames, lang, audience: 'admin' });
  // Provider status history per send: its message.* events in order.
  const statusHistory: Record<string, Array<{ type: string; at: string }>> = {};
  for (const e of [...record.events].sort((a, b) => a.occurredAt - b.occurredAt)) {
    if (!e.sendKey || !e.type.startsWith('message.')) continue;
    (statusHistory[e.sendKey] ??= []).push({ type: e.type, at: new Date(e.occurredAt).toISOString() });
  }
  const pointIds = [contact.emailPointId, contact.phonePointId].filter((p): p is string => Boolean(p));
  const [points, network] = await Promise.all([
    pointIds.length ? db.getAll(...pointIds.map((id) => db.collection(COL.contactPoints).doc(id))) : Promise.resolve([]),
    contact.networkId ? db.collection(COL.networkPeople).doc(contact.networkId).get() : Promise.resolve(null),
  ]);
  return {
    contactId,
    tenantUserId: contact.tenantUserId,
    contact: toJson(contact),
    places: places.docs.map((d) => ({ id: d.id, ...(toJson(d.data()) as Record<string, unknown>) })),
    sends: Object.values(record.sends).map((s) => ({
      sendKey: s.sendKey,
      ...(toJson(s.raw) as unknown as Record<string, unknown>),
      statusHistory: statusHistory[s.sendKey] ?? [],
    })),
    consentLedger: record.consentDocs.map((d) => ({ id: d.id, ...(toJson(d.data()) as Record<string, unknown>) })),
    instances: record.instances.map((i) => ({ id: i.id, ...(toJson(i.data) as Record<string, unknown>) })),
    stays: record.stays.map((s) => ({ id: s.id, ...(toJson(s.data) as Record<string, unknown>) })),
    blocks: points.map((p) => ({ pointId: p.id, kind: p.get('kind') ?? null, suppression: toJson(p.get('suppression') ?? {}) })),
    weeklyWindow: toJson(network?.get('recentMarketingTouches') ?? []),
    events: record.events.map((e) => ({ ...e, at: new Date(e.occurredAt).toISOString() })),
    timeline,
    truncated: record.truncated,
  };
}
