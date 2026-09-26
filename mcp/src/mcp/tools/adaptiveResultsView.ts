/**
 * Pure view code for the Adaptive Campaigns result tools (`adaptiveResults.ts`): the input
 * schemas, the server paths, and the shaping of the server's answers into small, masked tool
 * output. PURE on purpose — it imports only zod (never `../shared` or anything that loads
 * firebase), so `tests/adaptiveResults.test.ts` can import it without credentials.
 *
 * Every tool result is stored by the cms AI in `CaptivePortal_AiChatSessions`, so the shaping
 * here is an allow-list: only the fields named below ever leave, addresses are (re-)masked, no
 * message bodies, no Guest info, no raw ids other than this account's venue / contact ids.
 */

import { z } from 'zod';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** The characters the server's ids use (server/src/adaptive/api/http.ts `idParam`). */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const venueIdField = z.string().regex(ID, 'venueId is not valid');

export const resultsInputShape = {
  venueId: venueIdField
    .optional()
    .describe('One venue (from list_venues or list_playbook_setups). Default: every venue of this account that uses Adaptive Campaigns.'),
  from: z.string().regex(DAY, 'Dates look like 2026-09-25').optional().describe("First day, YYYY-MM-DD in the venue's local time. Default: 30 days before `to`."),
  to: z.string().regex(DAY, 'Dates look like 2026-09-25').optional().describe('Last day, YYYY-MM-DD (default today). At most 92 days in all.'),
  byJourney: z.boolean().optional().describe("Also give each journey's own numbers."),
};

export const messagesInputShape = {
  venueId: venueIdField.describe('The venue (from list_venues or list_playbook_setups).'),
  kind: z.enum(['sends', 'skips']).optional().describe('sends = messages that went out (or were tried); skips = held back or not sent. Default: both.'),
  days: z.number().int().min(1).max(92).optional().describe('How many days back (1–92, default 7).'),
  limit: z.number().int().min(1).max(50).optional().describe('Rows per page (1–50, default 25).'),
  cursor: z.string().min(1).max(400).optional().describe('nextCursor from the previous page, for older rows.'),
  lang: z.enum(['en', 'de']).optional().describe('Language of the reason lines (default en).'),
};

export const explainInputShape = {
  guestId: z.string().min(1).max(128).optional().describe('The Wi-Fi guest id from list_guests / search_guests.'),
  email: z.string().email().max(254).optional().describe("The guest's email."),
  phone: z.string().min(6).max(32).optional().describe("The guest's phone in international form, e.g. +41791234567."),
  contactId: z.string().regex(ID, 'contactId is not valid').optional().describe('The contactId from list_adaptive_messages.'),
  venueId: venueIdField.optional().describe('Explain this venue. Default: the venue the guest visited last.'),
  lang: z.enum(['en', 'de']).optional().describe('Language of the timeline sentences (default en).'),
};

export const resultsInputSchema = z.object(resultsInputShape);
export const messagesInputSchema = z.object(messagesInputShape);
export const EXPLAIN_NEEDS_ONE = 'Give one of guestId, email, phone or contactId.';
/** The explain input with its "at least one way to find the guest" rule (a shape can't carry it). */
export const explainInputSchema = z
  .object(explainInputShape)
  .refine((a) => Boolean(a.guestId || a.email || a.phone || a.contactId), { message: EXPLAIN_NEEDS_ONE });

export type ResultsInput = z.infer<typeof resultsInputSchema>;
export type MessagesInput = z.infer<typeof messagesInputSchema>;
export type ExplainInput = z.infer<typeof explainInputSchema>;

// ── Server paths (tenant only from the token; never /admin) ─────────────────

function assertId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`${label} is not valid`);
  return value;
}

function tenantBase(tenantUserId: string): string {
  return `/internal/adaptive/tenants/${encodeURIComponent(tenantUserId)}`;
}

export function resultsPath(tenantUserId: string, a: ResultsInput): string {
  const q = new URLSearchParams();
  if (a.venueId) q.set('venueId', assertId(a.venueId, 'venueId'));
  if (a.from) q.set('from', a.from);
  if (a.to) q.set('to', a.to);
  if (a.byJourney) q.set('journeys', '1');
  const qs = q.toString();
  return `${tenantBase(tenantUserId)}/results${qs ? `?${qs}` : ''}`;
}

export const MESSAGES_DEFAULT_DAYS = 7;
export const MESSAGES_DEFAULT_LIMIT = 25;

export function messagesPath(tenantUserId: string, a: MessagesInput): string {
  const q = new URLSearchParams();
  if (a.kind) q.set('kind', a.kind);
  q.set('days', String(a.days ?? MESSAGES_DEFAULT_DAYS));
  q.set('limit', String(Math.min(50, a.limit ?? MESSAGES_DEFAULT_LIMIT)));
  if (a.cursor) q.set('cursor', a.cursor);
  q.set('lang', a.lang ?? 'en');
  return `${tenantBase(tenantUserId)}/venues/${encodeURIComponent(assertId(a.venueId, 'venueId'))}/messages?${q.toString()}`;
}

export function findPath(tenantUserId: string): string {
  return `${tenantBase(tenantUserId)}/guests/find`;
}

/** The POST body for guests/find: only the fields given (addresses stay out of URLs). */
export function findBody(a: ExplainInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['guestId', 'contactId', 'email', 'phone'] as const) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

export function guestPath(tenantUserId: string, venueId: string, contactId: string, lang: 'en' | 'de'): string {
  return `${tenantBase(tenantUserId)}/venues/${encodeURIComponent(assertId(venueId, 'venueId'))}/guests/${encodeURIComponent(assertId(contactId, 'contactId'))}?lang=${lang}`;
}

/** The owner sentence for a failed server call (the server's own words, short; 403 → the MCP's usual line). */
export function errorText(status: number, data: Record<string, unknown> | null | undefined): string {
  if (status === 403) return 'Venue not found or not owned by this account.';
  const said = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : `Adaptive Campaigns request failed (${status})`;
  return scrub(said).slice(0, 200);
}

// ── Small helpers ────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, c] of Object.entries(rec(v))) if (typeof c === 'number' && Number.isFinite(c)) out[k] = c;
  return out;
}

function sumSent(sends: unknown): { total: number; byChannel: Record<string, number> } {
  const byChannel: Record<string, number> = {};
  let total = 0;
  for (const [ch, c] of Object.entries(rec(sends))) {
    const sent = num(rec(c).sent);
    byChannel[ch] = sent;
    total += sent;
  }
  return { total, byChannel };
}

function sumValues(m: unknown): number {
  return Object.values(rec(m)).reduce<number>((s, v) => s + num(v), 0);
}

export function formatMoney(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

// ── Masking (defensive: the server already masks; this makes sure) ──────────

const BULLET = '•';

/** A masked email / phone. Already-masked values pass; a raw address is masked like the server does. */
export function maskTo(v: unknown): string | null {
  const s = str(v, 120);
  if (!s) return null;
  const at = s.indexOf('@');
  if (at >= 0) {
    const name = s.slice(0, at);
    const domain = s.slice(at).replace(/\s/g, '');
    const visible = name.replace(new RegExp(BULLET, 'g'), '');
    if (visible.length <= 1 && name.includes(BULLET)) return `${name}${domain}`;
    if (at < 1) return BULLET.repeat(3);
    return `${name.slice(0, 1)}${BULLET.repeat(Math.max(2, Math.min(6, name.length - 1)))}${domain}`;
  }
  if (s.includes(BULLET) && !/\d{4,}/.test(s)) return s;
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 4) return BULLET.repeat(3);
  return `${digits.slice(0, 3)} ${BULLET.repeat(3)} ${BULLET.repeat(3)} ${digits.slice(-3)}`;
}

/** "Anna M." — first name and the last name's initial (idempotent on an already-short name). */
export function maskName(v: unknown): string | null {
  const s = str(v, 80);
  if (!s) return null;
  const parts = s.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].slice(0, 1).toUpperCase()}.`;
}

/** A plain sentence, short, with any unmasked email or long number run masked. */
export function scrub(sentence: string): string {
  return sentence
    .replace(/[^\s@()<>,;:"']+@[^\s@()<>,;:"']+\.[A-Za-z]{2,}/g, (m) => maskTo(m) ?? BULLET.repeat(3))
    .replace(/\+?\d[\d ]{6,}\d/g, (m) => maskTo(m) ?? BULLET.repeat(3));
}

function sentence(v: unknown, max = 300): string | null {
  const s = str(v, max);
  return s ? scrub(s) : null;
}

// ── get_adaptive_results ─────────────────────────────────────────────────────

export const RESULTS_FRESHNESS = 'From the daily rollups, counted every 15 minutes: the newest ~15 minutes may not be in yet.';
const TEST_RUN_LABEL = 'Test run: nothing was sent or charged. These are what would have happened, and they are not in the numbers above.';
const MAX_JOURNEYS = 20;

function card(c: unknown) {
  const x = rec(c);
  const messages = rec(x.messages);
  const credits = rec(x.creditsUsed);
  return {
    guestsStarted: num(x.guestsStarted),
    cameBack: num(x.cameBack),
    messages: { total: num(messages.total), byChannel: numMap(messages.byChannel), freeInfoMessages: num(messages.service) },
    credits: { total: num(credits.total), byChannel: numMap(credits.byChannel) },
    revenue: x.estimatedRevenue,
    visits: rec(x.visits),
    stays: rec(x.stays),
    skipped: numMap(x.skipped),
  };
}

/** The estimate, always labelled as one with its basis; null + a reason when there is no average spend. */
export function revenueView(raw: unknown, cameBack: number) {
  const r = rec(raw);
  const currency = str(r.currency, 8);
  const avg = num(r.averageSpendMinor);
  if (!currency || !(avg > 0)) {
    return { estimatedRevenue: null, estimatedRevenueNote: 'No estimate: this venue has no average spend per visit saved.' };
  }
  const amountMinor = num(r.amountMinor);
  return {
    estimatedRevenue: {
      estimate: true,
      amount: formatMoney(amountMinor, currency),
      amountMinor,
      currency,
      basis: `An estimate, not measured takings: ${cameBack} guest${cameBack === 1 ? '' : 's'} who came back through a journey × ${formatMoney(avg, currency)} (the venue's saved average spend per visit).`,
    },
  };
}

function testRunView(raw: unknown) {
  const t = card(raw);
  const any = t.guestsStarted > 0 || t.cameBack > 0 || t.messages.total > 0 || t.credits.total > 0 || Object.keys(t.skipped).length > 0;
  if (!any) return null;
  return {
    label: TEST_RUN_LABEL,
    guestsStarted: t.guestsStarted,
    cameBack: t.cameBack,
    messagesWouldHaveSent: t.messages,
    creditsWouldHaveUsed: t.credits.total,
    ...(Object.keys(t.skipped).length ? { notSent: t.skipped } : {}),
  };
}

function journeyView(raw: unknown) {
  const j = rec(raw);
  const live = rec(j.live);
  const test = rec(j.testRun);
  const liveSent = sumSent(live.sends);
  const testSent = sumSent(test.sends);
  const skipped = numMap(live.skipped);
  const testAny = num(test.entered) > 0 || testSent.total > 0;
  return {
    journeyKey: str(j.journeyKey, 80),
    name: str(j.name, 120),
    goalIsReturnVisit: j.returnVisit === true,
    started: num(live.entered),
    reachedGoal: num(live.converted),
    messages: liveSent,
    creditsUsed: sumValues(live.credits),
    ...(Object.keys(skipped).length ? { notSent: skipped } : {}),
    testRun: testAny ? { label: 'Test run: nothing sent or charged.', started: num(test.entered), messagesWouldHaveSent: testSent.total } : null,
  };
}

function venueResultView(raw: unknown, byJourney: boolean) {
  const v = rec(raw);
  const c = card(v.card);
  const stays = c.stays;
  const upcoming = typeof stays.upcoming === 'number' ? stays.upcoming : null;
  const createdInRange = num(stays.syncedInRange);
  const wait = rec(v.waitingForCredits);
  const range = rec(v.range);
  return {
    venueId: str(v.venueId, 128),
    name: str(v.name, 120),
    timezone: str(v.timezone, 64),
    // The venue's own local dates (venues in other time zones can be a day apart).
    period: str(range.from, 10) && str(range.to, 10) ? { from: str(range.from, 10), to: str(range.to, 10) } : null,
    guestsStarted: c.guestsStarted,
    cameBack: c.cameBack,
    messages: c.messages,
    creditsUsed: c.credits,
    ...revenueView(c.revenue, c.cameBack),
    visits: { total: num(c.visits.total), firstVisits: num(c.visits.first), returnVisits: num(c.visits.revisits), captures: num(c.visits.captures) },
    staysSynced: upcoming === null && createdInRange === 0 ? null : { createdInRange, upcoming },
    ...(Object.keys(c.skipped).length ? { notSent: c.skipped } : {}),
    waitingForCredits: {
      waiting: wait.waiting === true,
      balanceTooLow: wait.lowBalance === true,
      messagesWaiting:
        wait.messagesWaitingUnknown === true ? 'unknown' : wait.messagesWaitingTruncated === true ? `${num(wait.messagesWaiting)}+` : num(wait.messagesWaiting),
      // "N+" when the server stopped counting (a very busy venue).
      startedWaitingLast72h: wait.startedWaitingLast72hTruncated === true ? `${num(wait.startedWaitingLast72h)}+` : num(wait.startedWaitingLast72h),
    },
    testRun: testRunView(v.testRun),
    ...(byJourney ? { journeys: list(v.journeys).slice(0, MAX_JOURNEYS).map(journeyView) } : {}),
  };
}

/** The server's `{ range, venues }` → the tool's answer. */
export function resultsView(data: unknown, opts: { byJourney?: boolean; venueId?: string } = {}) {
  const d = rec(data);
  const range = rec(d.range);
  const venues = list(d.venues).map((v) => venueResultView(v, Boolean(opts.byJourney)));
  return {
    // One shared period, or null when the venues' local dates differ (each venue then has its own).
    period: str(range.from, 10) && str(range.to, 10) ? { from: str(range.from, 10), to: str(range.to, 10) } : null,
    freshness: RESULTS_FRESHNESS,
    notes: [
      'guestsStarted counts journey starts: a guest in two journeys counts twice.',
      'messages include the free info messages (freeInfoMessages); credits are marketing only.',
    ],
    count: venues.length,
    venues,
    ...(venues.length === 0
      ? { note: opts.venueId ? 'Adaptive Campaigns is not set up at this venue yet.' : 'No venue of this account uses Adaptive Campaigns yet.' }
      : {}),
  };
}

// ── list_adaptive_messages ───────────────────────────────────────────────────

const OUTCOME: Record<string, string> = {
  'message.sent': 'sent',
  'send.dry_run': 'test run (not sent)',
  'message.failed': 'failed',
  'message.unknown': 'outcome unknown',
  'send.skipped': 'not sent',
  'send.blocked': 'not sent (blocked)',
  'send.deferred': 'held back',
};

/** One row, allow-listed: never a body, a preview, an error text or anything not named here. */
export function messageRowView(raw: unknown) {
  const m = rec(raw);
  const type = str(m.type, 40) ?? '';
  const contactId = str(m.contactId, 128);
  return {
    at: str(m.at, 40),
    outcome: OUTCOME[type] ?? 'other',
    testRun: m.mode === 'test' || type === 'send.dry_run',
    journey: str(m.journeyName, 120) ?? str(m.journeyKey, 80),
    channel: str(m.channel, 20),
    status: str(m.status, 20),
    credits: typeof m.credits === 'number' && Number.isFinite(m.credits) ? m.credits : null,
    to: maskTo(m.to),
    guest: maskName(m.guest),
    contactId: contactId && ID.test(contactId) ? contactId : null,
    reason: sentence(m.line),
  };
}

export function messagesView(data: unknown, a: MessagesInput) {
  const d = rec(data);
  const rows = list(d.messages).slice(0, 50).map(messageRowView);
  const next = str(d.nextCursor, 400);
  return {
    venueId: a.venueId,
    kind: a.kind ?? 'sends and skips',
    days: a.days ?? MESSAGES_DEFAULT_DAYS,
    count: rows.length,
    messages: rows,
    nextCursor: next,
    ...(next ? { more: 'There are older rows: call again with cursor = nextCursor.' } : {}),
  };
}

// ── explain_adaptive_guest ───────────────────────────────────────────────────

export const TIMELINE_CAP = 40;

/** The answer when guests/find says 404. Never echoes what was looked up. */
export function notFoundView() {
  return {
    found: false,
    note: 'No guest with those details is known to Adaptive Campaigns in this account.',
    likelyReasons: [
      'They connected before Adaptive Campaigns was on at the venue.',
      'They gave no email or phone at the Wi-Fi login.',
      'The details differ from what they entered (try the guestId from search_guests).',
    ],
  };
}

interface FoundVenue {
  venueId: string;
  lastVisitAt: string | null;
}

export function foundVenues(find: unknown): FoundVenue[] {
  return list(rec(find).venues)
    .map((v) => ({ venueId: str(rec(v).venueId, 128) ?? '', lastVisitAt: str(rec(v).lastVisitAt, 40) }))
    .filter((v) => ID.test(v.venueId))
    .sort((x, y) => (Date.parse(y.lastVisitAt ?? '') || 0) - (Date.parse(x.lastVisitAt ?? '') || 0));
}

/** The venue to explain: the one asked for (if the guest was seen there), else the most recent. */
export function pickVenue(requested: string | undefined, venues: FoundVenue[]): { venueId: string } | { none: string } {
  if (requested) {
    return venues.some((v) => v.venueId === requested)
      ? { venueId: requested }
      : { none: 'This guest has no visits recorded at that venue. See otherVenues for where they were seen.' };
  }
  return venues.length ? { venueId: venues[0].venueId } : { none: 'This guest has no visits recorded at a venue with Adaptive Campaigns yet.' };
}

function maskedGuest(raw: unknown) {
  const g = rec(raw);
  return {
    name: maskName(g.name) ?? 'Guest',
    email: maskTo(g.email),
    phone: maskTo(g.phone),
    ...(g.lang === 'en' || g.lang === 'de' || g.lang === 'it' || g.lang === 'fr' ? { language: g.lang } : {}),
  };
}

/** Found, but no venue to explain (none seen, or not the one asked for). */
export function explainNoVenueView(find: unknown, reason: string) {
  const f = rec(find);
  return {
    found: true,
    contactId: str(f.contactId, 128),
    guest: maskedGuest(f.guest),
    note: reason,
    otherVenues: foundVenues(find).slice(0, 10),
  };
}

const CONSENT_WORDS: Record<string, string> = { yes: 'yes', no: 'no', none: 'no answer' };

function consentView(raw: unknown) {
  const out: Record<string, string> = {};
  for (const [ch, c] of Object.entries(rec(raw))) {
    const x = rec(c);
    const state = CONSENT_WORDS[String(x.state)] ?? 'no answer';
    out[ch] = x.ownerStopped === true ? `${state} (you stopped marketing)` : state;
  }
  return out;
}

/** One timeline line: only when it is a plain sentence; only at / venueName / journey / sentence pass. */
export function timelineLine(raw: unknown, journeyNames: Record<string, string>) {
  const t = rec(raw);
  const s = sentence(t.sentence);
  if (!s) return null;
  const key = str(t.journeyKey, 80);
  return {
    at: str(t.at, 40),
    venueName: str(t.venueName, 120),
    journey: key ? journeyNames[key] ?? key : null,
    sentence: s,
  };
}

/** find + the guest's owner record → the tool's answer. Timeline newest first, capped. */
export function explainView(find: unknown, guest: unknown, venueId: string, cap = TIMELINE_CAP) {
  const f = rec(find);
  const g = rec(guest);
  const journeysRaw = list(g.journeys).map(rec);
  const names: Record<string, string> = {};
  for (const j of journeysRaw) {
    const k = str(j.journeyKey, 80);
    const n = str(j.name, 120);
    if (k && n) names[k] = n;
  }
  const lines = list(g.timeline)
    .map((t) => timelineLine(t, names))
    .filter((t): t is NonNullable<ReturnType<typeof timelineLine>> => t !== null)
    .sort((x, y) => (Date.parse(y.at ?? '') || 0) - (Date.parse(x.at ?? '') || 0));
  const truncated = g.truncated === true || lines.length > cap;
  const venue = rec(g.venue);
  const venueName =
    journeysRaw.find((j) => j.venueId === venueId && str(j.venueName))?.venueName ??
    list(g.timeline).map(rec).find((t) => t.venueId === venueId && str(t.venueName))?.venueName ??
    null;
  return {
    found: true,
    contactId: str(g.contactId, 128) ?? str(f.contactId, 128),
    guest: maskedGuest(g.guest ?? f.guest),
    venue: {
      venueId,
      name: str(venueName, 120),
      firstVisitAt: str(venue.firstVisitAt, 40),
      lastVisitAt: str(venue.lastVisitAt, 40),
      visitCount: num(venue.visitCount),
      marketingConsent: consentView(venue.consent),
    },
    otherVenues: foundVenues(find).filter((v) => v.venueId !== venueId).slice(0, 10),
    journeys: journeysRaw.slice(0, 10).map((j) => ({
      name: str(j.name, 120) ?? str(j.journeyKey, 80),
      venueName: str(j.venueName, 120),
      status: str(j.status, 40),
      testRun: j.mode !== 'live',
      startedAt: str(j.startedAt, 40),
      ...(str(j.endedAt, 40) ? { endedAt: str(j.endedAt, 40), endedBecause: str(j.exitReason, 60) } : {}),
      ...(str(j.nextAt, 40) ? { nextStepAt: str(j.nextAt, 40) } : {}),
    })),
    creditsUsed: num(g.creditsUsed),
    timeline: lines.slice(0, cap),
    timelineTruncated: truncated,
    ...(truncated ? { timelineNote: `Showing the newest ${Math.min(cap, lines.length)} lines; older history is left out.` } : {}),
  };
}
