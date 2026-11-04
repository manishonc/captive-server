/**
 * The weekly numbers email to the owner (spec §12 P0 interim; decisions D6–D10 of 2026-11-04).
 *
 *  - Who: the account owner's login email (`Users/{tenant}.email`, like the owner alerts).
 *  - When: Monday 08:00 in the account's time zone (its first Adaptive venue's, else Zurich),
 *    for the Monday-to-Sunday week before; only for an account whose launch is live; a week with
 *    no visits and no messages at any venue sends nothing.
 *  - Off switch: on by default; the owner (or a manager) turns it off or picks German on the
 *    Adaptive tab (`PUT …/weekly-email`). The footer says where. No unsubscribe link: it is a
 *    service email to our customer, not marketing.
 *  - The numbers: `getResults` for that week and the week before — the same API the cms and
 *    the MCP read — rendered by core/owner/weeklyEmail.ts (a template, no AI).
 *  - Sent through Adaptive's email adapter: Brevo in production, the sandbox outbox locally.
 *    One record per account and Monday (`week_{tenant}_{date}`, created first), so a Monday's
 *    email goes at most once; a provider "try later" retries the task, an unclear answer is
 *    never resent.
 *
 * Collection `CaptivePortal_AdaptiveOwnerEmails`: `settings_{tenant}` and `week_{tenant}_{date}`
 * (numbers only, no guest data; the week records expire after 400 days).
 */

import { z } from 'zod';
import { db } from '../../firebase';
import { COL, ownerEmailSettingsId, ownerEmailWeekId } from '../store/collections';
import type { AdaptiveVenueDoc } from '../store/types';
import type { Actor } from '../core/schemas';
import { pickLang } from '../core/schemas';
import { ApiError } from '../api/errors';
import { listAdaptiveVenues } from '../store/venueSetups';
import { getVenues } from '../store/tenantData';
import { modeFor, readEngineSettings, venueHeld, type EngineSettings } from '../store/engineSettings';
import { now, refreshClock, sandboxEnabled } from '../engine/clock';
import { venueTz } from '../scans/schedule';
import { loadCatalogue } from './catalogue';
import { getResults } from './results';
import { getCreditConfig, getWalletSnapshot } from '../../services/credits';
import { maskedEmail } from '../core/owner/mask';
import { hashId } from '../core/checksum';
import { DAY_MS, HOUR_MS } from '../core/runtime/time';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { registerAdapters, type AdapterRegistry } from '../send/adapters';
import {
  isQuietWeek,
  lastFullWeek,
  renderWeeklyEmail,
  weeklySchedule,
  type WeeklyInput,
  type WeeklyLang,
  type WeeklyResults,
  type WeeklyVenue,
} from '../core/owner/weeklyEmail';

const DEFAULT_TZ = 'Europe/Zurich';
const KEEP_MS = 400 * DAY_MS;
/** The tenant dashboard (the same env and default as services/brevo.ts uses for its links). */
const DASHBOARD_URL = process.env.CMS_DASHBOARD_URL ?? 'https://portal.heidifi.ai';
export const ADAPTIVE_TAB_URL = `${DASHBOARD_URL.replace(/\/+$/, '')}/captive-venue?view=campaigns&section=adaptive`;

export interface WeeklyEmailSettings {
  enabled: boolean;
  lang: WeeklyLang;
  updatedAt: string | null;
}

const col = () => db.collection(COL.ownerEmails);

function iso(v: unknown): string | null {
  const d = v instanceof Date ? v : (v as { toDate?: () => Date } | null)?.toDate?.();
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

async function readSettings(tenantUserId: string): Promise<WeeklyEmailSettings> {
  const snap = await col().doc(ownerEmailSettingsId(tenantUserId)).get();
  const lang = snap.get('lang');
  return {
    // On by default (D8): only an explicit `false` turns it off.
    enabled: snap.get('enabled') !== false,
    lang: lang === 'de' ? 'de' : 'en',
    updatedAt: iso(snap.get('updatedAt')),
  };
}

async function ownerEmail(tenantUserId: string): Promise<string | null> {
  const snap = await db.collection(COL.tenantUsers).doc(tenantUserId).get();
  const email = snap.get('email');
  return typeof email === 'string' && email.includes('@') ? email.trim() : null;
}

/** The account's venues that use Adaptive (set up here, owned here), first one first (by id). */
async function accountVenues(tenantUserId: string): Promise<{ docs: AdaptiveVenueDoc[]; names: Map<string, string>; tz: string }> {
  const docs = (await listAdaptiveVenues(tenantUserId)).filter((a) => a.venueId && a.tenantUserId === tenantUserId);
  const venues = await getVenues(docs.map((a) => a.venueId));
  const mine = docs.filter((a) => venues.get(a.venueId)?.tenantUserId === tenantUserId).sort((a, b) => a.venueId.localeCompare(b.venueId));
  const first = mine.find((a) => a.status === 'on') ?? mine[0];
  const tz = first ? venueTz(first, venues.get(first.venueId)?.timezone) : DEFAULT_TZ;
  const names = new Map(mine.map((a) => [a.venueId, venues.get(a.venueId)?.name ?? a.venueId]));
  return { docs: mine, names, tz };
}

/** Journey names in the email's language (the catalogue's; English when there is none). */
async function journeyNames(lang: WeeklyLang): Promise<Record<string, string>> {
  if (lang === 'en') return {};
  const cat = await loadCatalogue();
  const out: Record<string, string> = {};
  for (const [key, rec] of cat.templates) out[key] = pickLang(rec.header.name, lang);
  return out;
}

function hasNumbers(r: WeeklyResults): boolean {
  return (r.card.visits.total ?? 0) > 0 || (r.card.messages.total ?? 0) > 0;
}

/** Everything the template needs for one week: this week's and the week before's results per venue, the wallet. */
export async function weeklyInput(
  tenantUserId: string,
  week: { weekStart: string; weekEnd: string },
  lang: WeeklyLang,
  settings: EngineSettings,
  at: number,
): Promise<WeeklyInput> {
  const prevStart = addDays(week.weekStart, -7);
  const prevEnd = addDays(week.weekEnd, -7);
  const [{ docs, names }, thisWeek, lastWeek, rate, wallet, translated] = await Promise.all([
    accountVenues(tenantUserId),
    getResults(tenantUserId, { from: week.weekStart, to: week.weekEnd, detail: '1' }),
    getResults(tenantUserId, { from: prevStart, to: prevEnd, detail: '1' }),
    getCreditConfig(),
    getWalletSnapshot(tenantUserId).catch(() => null),
    journeyNames(lang),
  ]);
  const prevById = new Map(lastWeek.venues.map((v) => [v.venueId, v as unknown as WeeklyResults]));
  const venues: WeeklyVenue[] = [];
  for (const v of thisWeek.venues) {
    const av = docs.find((a) => a.venueId === v.venueId);
    const r = v as unknown as WeeklyResults;
    // A venue that is set up but off counts only when it had numbers that week.
    const status = String(av?.status ?? 'off');
    if (status === 'off' && !hasNumbers(r)) continue;
    venues.push({
      venueId: v.venueId,
      name: names.get(v.venueId) ?? v.name ?? v.venueId,
      week: r,
      prev: prevById.get(v.venueId) ?? null,
      status,
      needsStartSending: Boolean(av && status === 'on' && venueHeld(settings, av, at)),
      journeyNames: translated,
    });
  }
  return {
    lang,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    venues,
    creditsLeft: wallet ? (wallet.suspended ? 0 : wallet.spendable) : null,
    creditsPerUnit: Object.fromEntries(Object.entries(rate.currencies ?? {}).map(([c, x]) => [c, Number(x?.creditsPerUnit) || 0])),
    defaultCurrency: rate.defaultCurrency || 'CHF',
    dashboardUrl: ADAPTIVE_TAB_URL,
  };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Owner routes ─────────────────────────────────────────────────────────────

/** `GET /tenants/:t/weekly-email`: the switch, the language, where it goes, the next and the last one. */
export async function getWeeklyEmail(tenantUserId: string) {
  await refreshClock();
  const [settings, engine, email, { docs, tz }] = await Promise.all([readSettings(tenantUserId), readEngineSettings(), ownerEmail(tenantUserId), accountVenues(tenantUserId)]);
  const live = modeFor(engine, tenantUserId) === 'live';
  const anyOn = docs.some((a) => a.status === 'on');
  let next = weeklySchedule(now(), tz);
  const lastSnap = await col().where('tenantUserId', '==', tenantUserId).where('kind', '==', 'week').get();
  // That Monday's email already ran (this morning): the next one is a week later.
  if (lastSnap.docs.some((d) => d.get('sendDate') === next.sendDate && d.get('status') !== 'retry')) {
    next = weeklySchedule(next.dueAt + 12 * HOUR_MS + 60_000, tz);
  }
  const last = lastSnap.docs
    .map((d) => d.data())
    .sort((a, b) => String(b.sendDate ?? '').localeCompare(String(a.sendDate ?? '')))[0];
  return {
    settings,
    recipient: maskedEmail(email),
    timezone: tz,
    // Why it wouldn't go next Monday, in the order the sender checks.
    wouldSend: settings.enabled && live && anyOn && Boolean(email),
    reason: !settings.enabled ? 'off' : !live ? 'not_live' : !anyOn ? 'no_venues' : !email ? 'no_email' : null,
    next: { at: new Date(next.dueAt).toISOString(), sendDate: next.sendDate, weekStart: next.weekStart, weekEnd: next.weekEnd },
    last: last
      ? { sendDate: String(last.sendDate), weekStart: String(last.weekStart), weekEnd: String(last.weekEnd), status: String(last.status), reason: last.reason ?? null, at: iso(last.sentAt) ?? iso(last.createdAt) }
      : null,
  };
}

const settingsInput = z.object({ enabled: z.boolean().optional(), lang: z.enum(['en', 'de']).optional() }).strict();

/** `PUT /tenants/:t/weekly-email {enabled?, lang?}` (adaptive.configure in the cms). */
export async function saveWeeklyEmail(tenantUserId: string, body: unknown, actor: Actor) {
  const { actor: _actor, ...rest } = (body ?? {}) as Record<string, unknown>;
  const parsed = settingsInput.safeParse(rest);
  if (!parsed.success) throw new ApiError('bad_request', 'Send enabled (true or false) and/or lang (en or de)');
  if (parsed.data.enabled === undefined && parsed.data.lang === undefined) throw new ApiError('bad_request', 'Nothing to change');
  await col()
    .doc(ownerEmailSettingsId(tenantUserId))
    .set(
      {
        tenantUserId,
        kind: 'settings',
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.lang !== undefined ? { lang: parsed.data.lang } : {}),
        updatedAt: new Date(),
        updatedBy: { uid: actor.uid, kind: actor.kind },
      },
      { merge: true },
    );
  return getWeeklyEmail(tenantUserId);
}

/** `GET /tenants/:t/weekly-email/preview?lang`: last full week's email as it would go out (nothing is sent). */
export async function previewWeeklyEmail(tenantUserId: string, query: { lang?: unknown }) {
  await refreshClock();
  const settings = await readSettings(tenantUserId);
  const lang: WeeklyLang = query.lang === 'de' ? 'de' : query.lang === 'en' ? 'en' : settings.lang;
  const [{ tz }, engine, email] = await Promise.all([accountVenues(tenantUserId), readEngineSettings(), ownerEmail(tenantUserId)]);
  const week = lastFullWeek(now(), tz);
  const input = await weeklyInput(tenantUserId, week, lang, engine, now());
  const out = renderWeeklyEmail(input);
  return { lang, weekStart: week.weekStart, weekEnd: week.weekEnd, recipient: maskedEmail(email), quiet: out.quiet, subject: out.subject, html: out.html, text: out.text };
}

// ── The worker: arm each Monday's task, send it ──────────────────────────────

export interface WeeklyEmailPayload {
  tenantUserId: string;
  /** The Monday it goes out (account-local YYYY-MM-DD). */
  sendDate: string;
}

export const weeklyEmailKey = (tenantUserId: string, sendDate: string) => `weekly_email:${tenantUserId}:${sendDate}`;

/**
 * Hourly from the worker (while any account isn't off): the next Monday's task for every live
 * account with a venue that is on. Create-only keys: arming twice is a no-op. The task checks
 * everything again when it runs (the switch, the launch, the numbers).
 */
export async function weeklyEmailWatchdog(env: { now: number; settings: EngineSettings }): Promise<{ armed: number }> {
  const snap = await db.collection(COL.adaptiveVenues).where('status', '==', 'on').get();
  const tenants = new Set<string>();
  for (const d of snap.docs) {
    const t = d.get('tenantUserId');
    if (typeof t === 'string' && t && modeFor(env.settings, t) === 'live') tenants.add(t);
  }
  let armed = 0;
  for (const t of tenants) {
    const { tz } = await accountVenues(t);
    const s = weeklySchedule(env.now, tz);
    await firestoreScheduler.schedule({
      dedupeKey: weeklyEmailKey(t, s.sendDate),
      kind: 'weekly_email',
      dueAt: s.dueAt,
      payload: { tenantUserId: t, sendDate: s.sendDate } satisfies WeeklyEmailPayload,
      tenantUserId: t,
      venueId: null,
    });
    armed += 1;
  }
  return { armed };
}

export type WeeklyEmailOutcome =
  | { status: 'sent'; to: string | null; subject: string }
  | { status: 'skipped'; reason: 'off' | 'not_live' | 'no_venues' | 'quiet_week' | 'no_email' }
  | { status: 'failed' | 'unknown'; reason: string }
  | { status: 'retry'; reason: string; retryAfterMs: number | null }
  | { status: 'done_before'; was: string };

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message));
}

const registry: AdapterRegistry = {};

/** One Monday's email for one account. Never sends twice (the week record is created first). */
export async function runWeeklyEmail(payload: WeeklyEmailPayload, env: { now: number; settings: EngineSettings }): Promise<WeeklyEmailOutcome> {
  const { tenantUserId, sendDate } = payload;
  if (!tenantUserId || !/^\d{4}-\d{2}-\d{2}$/.test(sendDate ?? '')) return { status: 'skipped', reason: 'no_venues' };
  const weekStart = addDays(sendDate, -7);
  const weekEnd = addDays(sendDate, -1);
  const ref = col().doc(ownerEmailWeekId(tenantUserId, sendDate));
  const base = { tenantUserId, kind: 'week', sendDate, weekStart, weekEnd, expireAt: new Date(Date.now() + KEEP_MS) };

  // Claim the Monday: a record that exists means it ran (or runs) — except a provider "try later".
  try {
    await ref.create({ ...base, status: 'sending', createdAt: new Date() });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const reclaimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.get('status') !== 'retry') return String(s.get('status') ?? 'unknown');
      tx.update(ref, { status: 'sending', retriedAt: new Date() });
      return null;
    });
    if (reclaimed !== null) return { status: 'done_before', was: reclaimed };
  }
  const finish = async (update: Record<string, unknown>) => ref.set({ ...base, ...update, updatedAt: new Date() }, { merge: true });
  const skip = async (reason: Extract<WeeklyEmailOutcome, { status: 'skipped' }>['reason']): Promise<WeeklyEmailOutcome> => {
    await finish({ status: 'skipped', reason });
    return { status: 'skipped', reason };
  };

  // Everything before the provider call can fail and be tried again (the record goes back to
  // `retry`, so the task's next attempt takes it again); only the send itself may have left.
  let prepared: { settings: WeeklyEmailSettings; to: string; input: WeeklyInput } | WeeklyEmailOutcome;
  try {
    prepared = await (async (): Promise<{ settings: WeeklyEmailSettings; to: string; input: WeeklyInput } | WeeklyEmailOutcome> => {
      const settings = await readSettings(tenantUserId);
      if (!settings.enabled) return skip('off');
      if (modeFor(env.settings, tenantUserId) !== 'live') return skip('not_live');
      const to = await ownerEmail(tenantUserId);
      const input = await weeklyInput(tenantUserId, { weekStart, weekEnd }, settings.lang, env.settings, env.now);
      if (!input.venues.length) return skip('no_venues');
      if (isQuietWeek(input)) return skip('quiet_week');
      if (!to) return skip('no_email');
      return { settings, to, input };
    })();
  } catch (err) {
    await finish({ status: 'retry', reason: 'error before sending' }).catch(() => undefined);
    throw err;
  }
  if ('status' in prepared) return prepared;
  const { settings, to, input } = prepared;

  const email = renderWeeklyEmail(input);
  registerAdapters(registry);
  const sendKey = hashId('wk', `${tenantUserId}:${sendDate}`);
  let result: Awaited<ReturnType<NonNullable<AdapterRegistry['email']>['send']>>;
  try {
    result = await registry.email!.send({ kind: 'email', to, subject: email.subject, html: email.html, text: email.text, sendKey, unsubscribeUrl: null });
  } catch (err) {
    result = { kind: 'unknown', provider: registry.email!.provider, reason: `send threw: ${(err as Error)?.name ?? 'Error'}` };
  }
  const summary = {
    lang: settings.lang,
    to: maskedEmail(to),
    subject: email.subject,
    venues: input.venues.length,
    cameBack: input.venues.reduce((s, v) => s + (v.week.card.cameBack ?? 0), 0),
    credits: input.venues.reduce((s, v) => s + (v.week.card.creditsUsed.total ?? 0), 0),
  };
  switch (result.kind) {
    case 'accepted':
      await finish({ status: 'sent', sentAt: new Date(), provider: result.provider, providerMessageId: result.providerMessageId ?? null, sendKey, ...summary });
      return { status: 'sent', to: summary.to, subject: email.subject };
    case 'retry':
      await finish({ status: 'retry', reason: result.reason, ...summary });
      return { status: 'retry', reason: result.reason, retryAfterMs: result.retryAfterMs ?? null };
    case 'rejected':
      await finish({ status: 'failed', reason: `${result.code}: ${result.message}`.slice(0, 300), ...summary });
      return { status: 'failed', reason: result.code };
    default:
      // It may have left: never sent again.
      await finish({ status: 'unknown', reason: result.reason, ...summary });
      return { status: 'unknown', reason: result.reason };
  }
}

/** `POST /dev/weekly-email {tenantUserId, sendDate?, force?}` (sandbox only): run a Monday's email now. */
export async function devWeeklyEmail(body: { tenantUserId?: unknown; sendDate?: unknown; force?: unknown }) {
  if (!sandboxEnabled()) throw new ApiError('not_found', 'Not found');
  const tenantUserId = typeof body.tenantUserId === 'string' ? body.tenantUserId : '';
  if (!tenantUserId) throw new ApiError('bad_request', 'tenantUserId is required');
  await refreshClock(true);
  const engine = await readEngineSettings();
  const { tz } = await accountVenues(tenantUserId);
  const sendDate = typeof body.sendDate === 'string' && body.sendDate ? body.sendDate : addDays(lastFullWeek(now(), tz).weekEnd, 1);
  if (body.force === true) await col().doc(ownerEmailWeekId(tenantUserId, sendDate)).delete();
  const outcome = await runWeeklyEmail({ tenantUserId, sendDate }, { now: now(), settings: engine });
  return { sendDate, outcome };
}
