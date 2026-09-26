/**
 * The owner's running-card numbers (plan §5 `GET /tenants/:t/results`, §6; PR D), summed from
 * the daily `CaptivePortal_JourneyStats` docs. Pure.
 *
 *  - Days are the venue's local calendar days (the rollup files each event under its local day).
 *  - Test runs (`dryRun`) are returned apart and never added to the live numbers.
 *  - "Came back" = guests who came back through a journey whose goal is a return visit;
 *    estimated revenue = that × the venue's average spend (D-D2), worked out here at read time
 *    (never stored, PR B2 D-14), so a changed average needs no recount.
 */

export const MAX_RANGE_DAYS = 92;
export const DEFAULT_RANGE_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtcDay(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real calendar date (no 2026-02-30, no month 13; years 0000–0099 fail too, Date.UTC reads them as 19xx). */
function validDay(d: string): boolean {
  return DATE.test(d) && fromUtcDay(toUtcDay(d)) === d;
}

/** `YYYY-MM-DD` + n days (calendar arithmetic, no time zone involved). */
export function addDaysIso(date: string, n: number): string {
  return fromUtcDay(toUtcDay(date) + n * 86_400_000);
}

/**
 * The inclusive range `from`…`to` (venue-local dates), defaulting to the last 30 days ending
 * `today`. Returns an error sentence instead of throwing, so the route answers 400.
 */
export function resultsRange(from: unknown, to: unknown, today: string): { from: string; to: string; days: string[] } | { error: string } {
  const t = typeof to === 'string' && to ? to : today;
  // The end first: the default start is worked out from it.
  if (!validDay(t)) return { error: 'Use real calendar dates, like 2026-09-25' };
  const f = typeof from === 'string' && from ? from : addDaysIso(t, -(DEFAULT_RANGE_DAYS - 1));
  if (!validDay(f)) return { error: 'Use real calendar dates, like 2026-09-25' };
  if (f > t) return { error: 'The start date is after the end date' };
  const n = Math.round((toUtcDay(t) - toUtcDay(f)) / 86_400_000) + 1;
  if (n > MAX_RANGE_DAYS) return { error: `At most ${MAX_RANGE_DAYS} days at a time` };
  const days: string[] = [];
  for (let i = 0; i < n; i += 1) days.push(addDaysIso(f, i));
  return { from: f, to: t, days };
}

/** `2026-09-25` → the stats doc's `20260925`. */
export function dayKeyOf(date: string): string {
  return date.replace(/-/g, '');
}

export type NumMap = { [k: string]: number | NumMap };

/** Adds numeric maps deeply (the stats docs' counters). Anything not a number or a map is ignored. */
export function addDeep(into: NumMap, from: unknown): NumMap {
  if (!from || typeof from !== 'object') return into;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) into[k] = (typeof into[k] === 'number' ? (into[k] as number) : 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof (v as { toMillis?: unknown }).toMillis !== 'function') {
      const sub = into[k] && typeof into[k] === 'object' ? (into[k] as NumMap) : {};
      into[k] = addDeep(sub, v);
    }
  }
  return into;
}

const COUNT_FIELDS = ['entered', 'converted', 'ended', 'exited', 'sends', 'bySlot', 'byVariant', 'credits', 'utility', 'skipped', 'visits', 'stays'];

/** Sums the counter fields of several daily docs: live numbers, and the test-run numbers apart. */
export function sumStats(docs: Array<Record<string, unknown> | undefined>): { live: NumMap; testRun: NumMap } {
  const live: NumMap = {};
  const testRun: NumMap = {};
  for (const d of docs) {
    if (!d) continue;
    for (const f of COUNT_FIELDS) if (f in d) addDeep(live, { [f]: d[f] });
    addDeep(testRun, d.dryRun);
  }
  return { live, testRun };
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function sumOver(map: unknown, field?: string): number {
  if (!map || typeof map !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(map as Record<string, unknown>)) total += field ? n((v as Record<string, unknown> | undefined)?.[field]) : n(v);
  return total;
}

export interface CardNumbers {
  guestsStarted: number;
  cameBack: number;
  messages: { total: number; byChannel: Record<string, number>; service: number };
  creditsUsed: { total: number; byChannel: Record<string, number> };
  estimatedRevenue: { amountMinor: number; currency: string; averageSpendMinor: number; basis: string } | null;
  visits: { total: number; first: number; revisits: number; captures: number };
  stays: { syncedInRange: number; changed: number; cancelled: number; linked: number; upcoming: number | null };
  skipped: Record<string, number>;
}

/**
 * The running card from the summed `_venue` numbers and the summed conversions of the
 * venue's return-visit journeys.
 */
export function cardNumbers(args: {
  venue: NumMap;
  returnConversions: number;
  averageSpend: { amountMinor: number; currency: string } | null;
  upcomingStays: number | null;
}): CardNumbers {
  const v = args.venue;
  const sends = (v.sends ?? {}) as NumMap;
  const byChannel: Record<string, number> = {};
  for (const [ch, c] of Object.entries(sends)) byChannel[ch] = n((c as NumMap).sent);
  const credits = (v.credits ?? {}) as NumMap;
  const creditsByChannel: Record<string, number> = {};
  for (const [ch, c] of Object.entries(credits)) creditsByChannel[ch] = n(c);
  const utility = (v.utility ?? {}) as NumMap;
  const visits = (v.visits ?? {}) as NumMap;
  const stays = (v.stays ?? {}) as NumMap;
  const avg = args.averageSpend && args.averageSpend.amountMinor > 0 ? args.averageSpend : null;
  return {
    guestsStarted: n(v.entered),
    cameBack: args.returnConversions,
    // `sends.*.sent` counts service messages too; utility.sends says how many of them were service.
    messages: { total: sumOver(sends, 'sent'), byChannel, service: n(utility.sends) },
    creditsUsed: { total: sumOver(credits), byChannel: creditsByChannel },
    estimatedRevenue: avg
      ? {
          amountMinor: args.returnConversions * avg.amountMinor,
          currency: avg.currency,
          averageSpendMinor: avg.amountMinor,
          basis: 'Guests who came back through a journey × the average spend per visit',
        }
      : null,
    visits: { total: n(visits.total), first: n(visits.first), revisits: n(visits.revisits), captures: n(visits.captures) },
    stays: { syncedInRange: n(stays.created), changed: n(stays.changed), cancelled: n(stays.cancelled), linked: n(stays.linked), upcoming: args.upcomingStays },
    skipped: Object.fromEntries(Object.entries((v.skipped ?? {}) as NumMap).map(([k, c]) => [k, n(c)])),
  };
}

/** The goal events that mean "the guest came back" (a return visit), whatever the journey. */
export const RETURN_VISIT_GOALS = ['offer.redeemed', 'visit.revisit'];

// ── Waiting for credits ──────────────────────────────────────────────────────

/** A running journey whose message couldn't be paid at its last look (`waiting.creditsShortFor`). */
export interface FlaggedWait {
  venueId: string;
  channel: string | null;
  price: number | null;
}

/** The account's wallet as the engine spends it: each channel's own credits first, then one shared pool. */
export interface CreditBudget {
  own: Record<string, number>;
  shared: number;
}

/**
 * How many of the flagged messages the wallet can't pay now, per venue. One budget for the whole
 * account (the wallet is the account's): cheapest first, each from its channel's own credits then
 * the shared pool; a message that doesn't fit takes nothing. Unknown budget, channel or price: it
 * counts as waiting.
 */
export function waitingByVenue(flagged: FlaggedWait[], budget: CreditBudget | null): Map<string, number> {
  const out = new Map<string, number>();
  const add = (venueId: string) => out.set(venueId, (out.get(venueId) ?? 0) + 1);
  const own: Record<string, number> = { ...(budget?.own ?? {}) };
  let shared = Math.max(0, budget?.shared ?? 0);
  const known = flagged.filter((f) => budget && f.channel !== null && typeof f.price === 'number' && Number.isFinite(f.price) && f.price >= 0);
  for (const f of flagged) if (!known.includes(f)) add(f.venueId);
  for (const f of [...known].sort((a, b) => a.price! - b.price!)) {
    const ch = f.channel!;
    const mine = Math.max(0, own[ch] ?? 0);
    if (mine + shared < f.price!) {
      add(f.venueId);
      continue;
    }
    const fromOwn = Math.min(mine, f.price!);
    own[ch] = mine - fromOwn;
    shared -= f.price! - fromOwn;
  }
  return out;
}

