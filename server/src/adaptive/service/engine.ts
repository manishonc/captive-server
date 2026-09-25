/**
 * Engine status and the sandbox helpers behind `/internal/adaptive/admin/engine`
 * and `/internal/adaptive/dev/*`.
 *
 * The status is read-only. The dev helpers (fake clock, launch switch, guest log)
 * exist only when the sandbox is on — the local emulator stack — and are not
 * mounted in production. The real admin launch switch comes with PR D.
 */

import { db } from '../../firebase';
import { COL, CONFIG_DOC_ID, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { readEngineSettings, clearEngineSettingsCache, type LaunchMode } from '../store/engineSettings';
import { toJson } from '../store/serialize';
import { tsMs } from '../store/time';
import { ENGINE_RUNTIME_VERSION } from '../core/runtime/version';
import { contactPointId, identityReady, keyFingerprint } from '../identity/key';
import { advanceSandboxClock, now, refreshClock, resetSandboxClock, sandboxEnabled, setSandboxClock } from '../engine/clock';
import { durationMs, localDateKey } from '../core/runtime/time';
import { explainDecision, type DecisionRecord } from '../core/runtime/decision';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { ApiError } from '../api/errors';
import type { Lang } from '../core/constants';
import { z } from 'zod';
import type { ContactDoc, JourneySendDoc } from '../store/engineTypes';
import { rollupVenue } from '../rollups/rollup';
import { adaptiveOnBrevoEvents, adaptiveOnInboundSms, adaptiveOnTwilioStatus, adaptiveOnUnsubscribe, ingestClick, ingestRating } from '../ingest/signals';
import { randomUUID } from 'crypto';
import { stayFeedId } from '../store/collections';
import { ensureRollup } from '../rollups/rollup';
import { loadVenueContext } from '../engine/context';
import { addDays, parseIcal } from '../stays/ical';
import { buildSandboxCalendar, putSandboxCalendar, sandboxCalendarRef } from '../stays/source';
import { failingFeedsQuery } from '../stays/store';
import { pollFeed } from '../stays/sync';
import { checkStayFeed, getStayFeed, saveStayFeed } from './stays';

async function countWhere(status: string): Promise<number> {
  const snap = await db.collection(COL.journeyTasks).where('status', '==', status).count().get();
  return snap.data().count;
}

export async function getEngineStatus() {
  const [statusSnap, settings, queued, leased, dead, oldest, feedsTotal, feedsFailing] = await Promise.all([
    db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get(),
    readEngineSettings(),
    countWhere('queued'),
    countWhere('leased'),
    countWhere('dead'),
    // Needs the hand-made (status, dueAt) index: if it is missing or still building,
    // report that here instead of failing the whole status (which shows indexCheck).
    db.collection(COL.journeyTasks)
      .where('status', '==', 'queued')
      .where('dueAt', '<=', new Date(now()))
      .orderBy('dueAt')
      .limit(1)
      .get()
      .then((snap) => ({ snap, error: null as string | null }))
      .catch((err: unknown) => ({ snap: null, error: String((err as Error)?.message ?? err).slice(0, 300) })),
    // Airbnb calendar feeds: how many, and how many keep failing (plan Appendix A `engine_status.feeds`).
    db.collection(COL.stayFeeds).count().get().then((s) => s.data().count),
    failingFeedsQuery().count().get().then((s) => s.data().count),
  ]);
  const apiFingerprint = keyFingerprint();
  const workers = Object.entries((statusSnap.get('workers') ?? {}) as Record<string, Record<string, unknown>>).map(([id, w]) => {
    const lastBeat = tsMs(w.lastBeatAt);
    return {
      id,
      ...toJson(w),
      alive: lastBeat !== null && Date.now() - lastBeat < 3 * 60_000,
      sameVersion: w.version === ENGINE_RUNTIME_VERSION,
      sameKey: Boolean(apiFingerprint) && w.keyFingerprint === apiFingerprint,
    };
  });
  const oldestDue = oldest.snap?.docs[0] ? tsMs(oldest.snap.docs[0].get('dueAt')) : null;
  const pinned = statusSnap.get('identity.keyFingerprint');
  return {
    api: { version: ENGINE_RUNTIME_VERSION, identityReady: identityReady(), keyFingerprint: apiFingerprint, sandbox: sandboxEnabled() },
    launch: settings.launch,
    paused: settings.paused,
    safety: settings.safety,
    workers,
    identity: { pinnedFingerprint: typeof pinned === 'string' ? pinned : null, apiMatchesPinned: typeof pinned === 'string' ? pinned === apiFingerprint : null },
    queue: {
      queued,
      leased,
      dead,
      lagSeconds: oldest.error ? null : oldestDue !== null ? Math.max(0, Math.round((now() - oldestDue) / 1000)) : 0,
      ...(oldest.error ? { lagError: oldest.error } : {}),
    },
    feeds: { total: feedsTotal, failing: feedsFailing },
    indexCheck: toJson(statusSnap.get('indexCheck') ?? null),
  };
}

// ── Sandbox only ─────────────────────────────────────────────────────────────

function requireSandbox(): void {
  if (!sandboxEnabled()) throw new ApiError('not_found', 'Not found');
}

export async function devClock(body: { advance?: string; reset?: boolean; at?: string }) {
  requireSandbox();
  if (body.reset) await resetSandboxClock();
  else if (body.at) {
    const at = Date.parse(body.at);
    if (!Number.isFinite(at)) throw new ApiError('bad_request', 'at must be an ISO date-time');
    await setSandboxClock(at);
  } else if (body.advance) await advanceSandboxClock(durationMs(body.advance));
  await refreshClock(true);
  return { now: new Date(now()).toISOString() };
}

export async function devLaunch(body: { default?: LaunchMode; accounts?: Record<string, LaunchMode>; paused?: boolean }) {
  requireSandbox();
  const update: Record<string, unknown> = {};
  if (body.default) update['launch.default'] = body.default;
  for (const [tenant, mode] of Object.entries(body.accounts ?? {})) update[`launch.accounts.${tenant}`] = mode;
  if (typeof body.paused === 'boolean') update['killSwitch.sendingPaused'] = body.paused;
  if (Object.keys(update).length) {
    update['launch.changedBy'] = 'sandbox';
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update(update);
  }
  clearEngineSettingsCache();
  const settings = await readEngineSettings();
  return { launch: settings.launch, paused: settings.paused };
}

/** Everything the engine knows about one person — the local stand-in for the PR D guest timeline. */
export async function devGuestLog(query: { email?: string; phone?: string; lang?: string }) {
  requireSandbox();
  const pointIds: string[] = [];
  const email = query.email ? normalizeEmail(query.email) : null;
  const phone = query.phone ? normalizeE164('', query.phone) : null;
  if (email) pointIds.push(contactPointId('email', email));
  if (phone) pointIds.push(contactPointId('phone', phone));
  if (!pointIds.length) throw new ApiError('bad_request', 'Give an email or a phone (+41…)');

  const contactIds = new Set<string>();
  for (const id of pointIds) {
    const snap = await db.collection(COL.contactPoints).doc(id).get();
    for (const c of Object.values((snap.get('tenantContacts') ?? {}) as Record<string, string>)) contactIds.add(c);
  }
  const lang = (query.lang === 'de' ? 'de' : 'en') as Lang;
  const contacts = [];
  for (const contactId of contactIds) {
    const [contact, events, sends, instances, stays] = await Promise.all([
      db.collection(COL.contacts).doc(contactId).get(),
      db.collection(COL.journeyEvents).where('contactId', '==', contactId).get(),
      db.collection(COL.journeySends).where('contactId', '==', contactId).get(),
      db.collection(COL.journeyInstances).where('contactId', '==', contactId).get(),
      db.collection(COL.stays).where('contactId', '==', contactId).get(),
    ]);
    const tz = String(contact.get('lastVenueTz') ?? 'Europe/Zurich');
    const timeline = events.docs
      .map((d) => {
        const e = d.data();
        const decision = e.data?.decision as DecisionRecord | undefined;
        return {
          at: toJson(e.occurredAt),
          type: e.type,
          journeyKey: e.journeyKey,
          nodeId: e.nodeId,
          why: decision ? explainDecision(decision, lang, tz) : undefined,
          checks: decision?.checks,
        };
      })
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    contacts.push({
      contactId,
      contact: toJson(contact.data() ?? null),
      instances: instances.docs.map((d) => ({ id: d.id, ...toJson(d.data()) })),
      sends: sends.docs.map((d) => ({ sendKey: d.id, ...toJson(d.data()) })),
      stays: stays.docs.map((d) => ({ stayId: d.id, ...toJson(d.data()) })),
      timeline,
    });
  }
  return { now: new Date(now()).toISOString(), contacts };
}

const PROVIDER_EVENTS = ['delivered', 'failed', 'opened', 'bounce', 'spam', 'unsubscribe', 'click', 'rating', 'stop', 'start', 'reply'] as const;

/**
 * Sandbox only: fake what a provider or the CMS would send back for one send —
 * through the same hook functions the real webhooks call, so the whole path runs.
 */
export async function devProviderEvent(body: unknown) {
  requireSandbox();
  const p = z
    .object({
      sendKey: z.string().regex(/^js_[0-9a-f]{32}$/),
      event: z.enum(PROVIDER_EVENTS),
      stars: z.number().int().min(1).max(5).optional(),
      text: z.string().max(500).optional(),
    })
    .parse(body);
  const snap = await db.collection(COL.journeySends).doc(p.sendKey).get();
  const s = snap.data() as JourneySendDoc | undefined;
  if (!s) throw new ApiError('not_found', 'No such send');
  const contact = (await db.collection(COL.contacts).doc(s.contactId).get()).data() as ContactDoc | undefined;
  const brevo = (event: string) => adaptiveOnBrevoEvents([{ event, 'message-id': s.providerMessageId ?? '', 'X-Mailin-custom': p.sendKey }]);
  const inbound = (kind: 'stop' | 'start' | null, text: string) => {
    if (!contact?.phoneE164) throw new ApiError('bad_request', 'This guest has no phone number');
    return adaptiveOnInboundSms({ from: contact.phoneE164, body: text, legacyKind: kind, messageSid: `SMdev${Date.now()}`, optOutType: null, signatureChecked: true });
  };
  switch (p.event) {
    case 'delivered':
    case 'failed':
      if (s.channel === 'sms') await adaptiveOnTwilioStatus({ messageSid: s.providerMessageId ?? '', status: p.event === 'delivered' ? 'delivered' : 'undelivered', errorCode: p.event === 'failed' ? '30003' : null });
      else await brevo(p.event === 'delivered' ? 'delivered' : 'error');
      break;
    case 'opened':
      await brevo('opened');
      break;
    case 'bounce':
      await brevo('hard_bounce');
      break;
    case 'spam':
      await brevo('spam');
      break;
    case 'unsubscribe':
      await adaptiveOnUnsubscribe({ g: p.sendKey, v: s.venueId, c: p.sendKey });
      break;
    case 'click':
    case 'rating': {
      const codes = s.shortCodes ?? [];
      if (!codes.length) throw new ApiError('bad_request', 'This send has no links');
      const links = await Promise.all(codes.map((c) => db.collection('CaptivePortal_ShortLinks').doc(c).get()));
      const rating = links.find((l) => l.get('journeyLink') === 'rating');
      if (p.event === 'click') await ingestClick({ shortCode: codes[0] });
      else if (!rating) throw new ApiError('bad_request', 'This send has no rating link');
      else await ingestRating({ shortCode: rating.id, stars: p.stars ?? 5, feedback: p.text ?? null });
      break;
    }
    case 'stop':
      await inbound('stop', 'STOP');
      break;
    case 'start':
      await inbound('start', 'START');
      break;
    case 'reply':
      await inbound(null, p.text ?? 'danke');
      break;
  }
  return { queued: p.event, sendKey: p.sendKey };
}

/**
 * Sandbox only: roll the venue's (or every Adaptive venue's) events into the daily
 * numbers now, without the 2-minute lag, and return that day's docs — the local
 * stand-in for the PR D results route.
 */
export async function devRollup(body: { venueId?: string }) {
  requireSandbox();
  const venueIds = body.venueId
    ? [String(body.venueId)]
    : (await db.collection(COL.adaptiveVenues).select('venueId').get()).docs.map((d) => String(d.get('venueId') ?? '')).filter(Boolean);
  const out: Record<string, unknown> = {};
  for (const venueId of venueIds) {
    const result = await rollupVenue(venueId, { cutoffMs: Date.now() + 1000 });
    const stats = await db.collection(COL.journeyStats).where('venueId', '==', venueId).get();
    out[venueId] = { ...result, docs: stats.docs.filter((d) => d.get('kind') !== 'rollup_state').map((d) => ({ id: d.id, ...toJson(d.data()) })) };
  }
  return { venues: out };
}

// ── Airbnb stays (sandbox only) ──────────────────────────────────────────────

const CALENDAR_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function tenantOfVenue(venueId: string): Promise<string> {
  const tenant = (await db.collection(COL.venues).doc(venueId).get()).get('tenantUserId');
  if (typeof tenant !== 'string' || !tenant) throw new ApiError('not_found', 'No such venue');
  return tenant;
}

/** `today`, `+3d` / `-1d` (from the engine's today in the venue's zone) or `YYYY-MM-DD`. */
function devDay(value: string, today: string): string {
  const v = value.trim();
  if (v === 'today') return today;
  const rel = /^([+-])(\d{1,3})d$/.exec(v);
  if (rel) return addDays(today, (rel[1] === '-' ? -1 : 1) * Number(rel[2]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new ApiError('bad_request', `Bad day "${v}" — use today, +Nd, -Nd or YYYY-MM-DD`);
}

const calendarBody = z.object({
  ics: z.string().max(1_000_000).optional(),
  venueId: z.string().min(1).max(128).optional(),
  stays: z
    .array(
      z.object({
        uid: z.string().min(1).max(200).optional(),
        checkIn: z.string().min(1).max(12),
        /** A date, `+Nd`, or `Nn` (nights after check-in). */
        checkOut: z.string().min(1).max(12).optional(),
        nights: z.number().int().min(1).max(90).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * Sandbox only: the calendar a `sandbox:calendar/<name>` feed reads (D-C23). Either raw
 * `{ ics }`, or `{ venueId?, stays: [{ checkIn: 'today' | '+2d' | 'YYYY-MM-DD', checkOut | nights }] }`
 * built into an Airbnb-shaped calendar, relative days on the engine clock in the venue's zone.
 * The first stay's UID stays the same across calls, so a new date for it is a date change.
 */
export async function devPutCalendar(name: string, body: unknown) {
  requireSandbox();
  if (!CALENDAR_NAME.test(name)) throw new ApiError('bad_request', 'Calendar names are a-z, 0-9, - and _');
  const p = calendarBody.parse(body ?? {});
  await refreshClock(true);
  const tz = p.venueId ? (await loadVenueContext(p.venueId))?.tz ?? 'Europe/Zurich' : 'Europe/Zurich';
  const today = localDateKey(new Date(now()), tz);
  let ics = p.ics;
  if (ics === undefined) {
    const stays = (p.stays ?? []).map((st, i) => {
      const checkIn = devDay(st.checkIn, today);
      const nights = /^(\d{1,2})n$/.exec(st.checkOut ?? '');
      const checkOut = nights ? addDays(checkIn, Number(nights[1])) : st.checkOut ? devDay(st.checkOut, today) : addDays(checkIn, st.nights ?? 1);
      if (checkOut <= checkIn) throw new ApiError('bad_request', 'checkOut must be after checkIn');
      return { uid: st.uid ?? `${name}-${i + 1}@sandbox.heidifi.test`, checkIn, checkOut };
    });
    ics = buildSandboxCalendar(stays, now());
  }
  const { etag } = await putSandboxCalendar(name, ics);
  let stays: Array<{ uid: string; checkIn: string; checkOut: string; nights: number }> = [];
  try {
    stays = parseIcal(ics, tz).stays;
  } catch {
    // raw text that isn't a calendar: stored anyway (to test a broken feed)
  }
  return { name, url: `sandbox:calendar/${name}`, etag, today, stays };
}

/** Sandbox only: the stored calendar text (served as text/calendar by the route). */
export async function devGetCalendar(name: string): Promise<string> {
  requireSandbox();
  if (!CALENDAR_NAME.test(name)) throw new ApiError('bad_request', 'Calendar names are a-z, 0-9, - and _');
  const snap = await sandboxCalendarRef(name).get();
  if (!snap.exists) throw new ApiError('not_found', 'No such calendar');
  return String(snap.get('ics') ?? '');
}

const venueUrlBody = z.object({ venueId: z.string().min(1).max(128), url: z.unknown() });

/** Sandbox only: save a venue's calendar link, as PR D's PUT will (saveStayFeed). */
export async function devStayFeed(body: unknown) {
  requireSandbox();
  const p = venueUrlBody.parse(body ?? {});
  return saveStayFeed(await tenantOfVenue(p.venueId), p.venueId, p.url, { uid: 'sandbox', kind: 'seed' });
}

/** Sandbox only: "Check link" in this process, with the sandbox calendar (checkStayFeed). */
export async function devStayCheck(body: unknown) {
  requireSandbox();
  const p = venueUrlBody.parse(body ?? {});
  return checkStayFeed(await tenantOfVenue(p.venueId), p.venueId, p.url);
}

/**
 * Sandbox only: poll the venue's feed now, in this process, under the same feed lease as
 * the worker (so they never overlap), counting misses like a scheduled poll (two syncs
 * back to back count one). Starts the feed's 4-hourly chain if it isn't running (the demo
 * feed has none). Returns what the sync did and the stays.
 */
export async function devStaySync(body: unknown) {
  requireSandbox();
  const p = z.object({ venueId: z.string().min(1).max(128) }).parse(body ?? {});
  const tenant = await tenantOfVenue(p.venueId);
  await refreshClock(true);
  const settings = await readEngineSettings();
  const result = await pollFeed(stayFeedId(p.venueId), { now: now(), settings }, { kind: 'manual', owner: `dev:${randomUUID()}` });
  // Written outside a worker task: arm the venue's daily numbers here.
  await ensureRollup(p.venueId, tenant);
  const view = await getStayFeed(tenant, p.venueId);
  return { now: new Date(now()).toISOString(), result, ...view };
}

