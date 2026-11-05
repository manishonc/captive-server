/**
 * The owner dashboard (spec §13, §3; 2026-11-04): capture rate, the visits heatmap and each
 * journey's funnel, worked out from the summed daily numbers (`sumStats` in results.ts). Pure.
 * Behind `GET /tenants/:t/results?detail=1` (the cms Numbers page, the MCP's
 * `get_adaptive_results` with `detail`) and the weekly numbers email.
 *
 *  - Capture rate is per visit (the card's "Wi-Fi visits", 8 h gap): visits where the guest can
 *    get offers from this venue after logging in ÷ visits, new (first visit) and returning apart.
 *    Only visits counted since this change carry the answer, so the rate is over those.
 *  - The heatmap is visits started per weekday (Monday first) × local hour, in the venue's zone.
 *  - A funnel row is sent → delivered → opened → clicked → goal reached, with the credits it used
 *    and, next to them, what they are worth in money and the estimated revenue (spec §3: the
 *    revenue number stands next to every credit number). SMS has no open signal (`opened: null`).
 *    A goal reached is credited to the journey's last message before it (channel + send time).
 *    Sent counts every message of the journey, the free info ones too (`serviceSent` says how many),
 *    like the running card's "messages".
 *  - Estimated revenue is only for journeys whose goal is a visit (offer redeemed / came back):
 *    goal reached × the venue's average spend per visit, at read time.
 */

import type { NumMap } from './results';

export interface Money {
  amountMinor: number;
  currency: string;
}

// ── Capture rate ─────────────────────────────────────────────────────────────

export interface CaptureGroup {
  /** Visits that say whether the guest can get offers (counted since the dashboard change). */
  visits: number;
  /** Of those, visits where the guest can get offers from this venue (a yes on file). */
  yes: number;
  /** yes ÷ visits (0–1, 4 decimals); null with no such visit. */
  rate: number | null;
}

export interface CaptureNumbers {
  /** Every Wi-Fi visit in the range: first visits and returning ones. */
  visits: { total: number; first: number; returning: number };
  /** Splash logins (one visit can have several). */
  logins: number;
  all: CaptureGroup;
  first: CaptureGroup;
  returning: CaptureGroup;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function map(v: unknown): NumMap {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as NumMap) : {};
}

/** A share 0–1 with 4 decimals; null when there is nothing to divide by. */
export function share(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}

function group(v: NumMap): CaptureGroup {
  const visits = n(v.visits);
  const yes = Math.min(n(v.yes), visits);
  return { visits, yes, rate: share(yes, visits) };
}

/** Capture numbers from the summed `_venue` numbers. */
export function captureNumbers(venue: NumMap): CaptureNumbers {
  const visits = map(venue.visits);
  const capture = map(venue.capture);
  const first = group(map(capture.first));
  const returning = group(map(capture.returning));
  const all = group({ visits: first.visits + returning.visits, yes: first.yes + returning.yes });
  return {
    visits: { total: n(visits.total), first: n(visits.first), returning: n(visits.revisits) },
    logins: n(visits.captures),
    all,
    first,
    returning,
  };
}

// ── Heatmap ──────────────────────────────────────────────────────────────────

export interface Heatmap {
  timezone: string;
  /** Visits per weekday (row 0 = Monday … 6 = Sunday) and local hour (0–23). */
  cells: number[][];
  total: number;
  max: number;
  /** Per weekday (Monday first) and per hour. */
  byWeekday: number[];
  byHour: number[];
  /** The busiest hour of the week, day and hour (weekday 1 = Monday … 7 = Sunday); null with no visits. */
  busiest: { weekday: number; hour: number; visits: number } | null;
  busiestDay: { weekday: number; visits: number } | null;
  busiestHour: { hour: number; visits: number } | null;
}

/** The heatmap from the summed `_venue` numbers (`heat.w{1–7}.h{00–23}`). */
export function heatmapNumbers(venue: NumMap, timezone: string): Heatmap {
  const heat = map(venue.heat);
  const cells: number[][] = [];
  for (let d = 1; d <= 7; d += 1) {
    const row = map(heat[`w${d}`]);
    const hours: number[] = [];
    for (let h = 0; h < 24; h += 1) hours.push(Math.max(0, n(row[`h${String(h).padStart(2, '0')}`])));
    cells.push(hours);
  }
  const byWeekday = cells.map((r) => r.reduce((s, x) => s + x, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => cells.reduce((s, r) => s + r[h], 0));
  const total = byWeekday.reduce((s, x) => s + x, 0);
  let max = 0;
  let busiest: Heatmap['busiest'] = null;
  cells.forEach((r, d) =>
    r.forEach((x, h) => {
      if (x > max) {
        max = x;
        busiest = { weekday: d + 1, hour: h, visits: x };
      }
    }),
  );
  const topDay = byWeekday.reduce((best, x, i) => (x > byWeekday[best] ? i : best), 0);
  const topHour = byHour.reduce((best, x, i) => (x > byHour[best] ? i : best), 0);
  return {
    timezone,
    cells,
    total,
    max,
    byWeekday,
    byHour,
    busiest,
    busiestDay: total > 0 ? { weekday: topDay + 1, visits: byWeekday[topDay] } : null,
    busiestHour: total > 0 ? { hour: topHour, visits: byHour[topHour] } : null,
  };
}

// ── Journey funnel ───────────────────────────────────────────────────────────

/** What a journey works towards, from its goal event (and a rating ending it). */
export type GoalKind = 'visit' | 'booking' | 'rating' | 'other' | 'none';

/** The goal events that mean "the guest came back" (results.ts RETURN_VISIT_GOALS). */
const VISIT_GOALS = ['offer.redeemed', 'visit.revisit'];

export function goalKindOf(goalEvent: string | null | undefined, endsOnRating = false): GoalKind {
  if (goalEvent && VISIT_GOALS.includes(goalEvent)) return 'visit';
  if (goalEvent === 'booking.direct') return 'booking';
  if (goalEvent) return 'other';
  return endsOnRating ? 'rating' : 'none';
}

export interface FunnelRow {
  /** The channel (`sms`, `email`, `whatsapp`) or send time (`morning` … `now`); `all` for the journey's line. */
  key: string;
  sent: number;
  delivered: number;
  /** Email and WhatsApp only: null for SMS, which has no open signal. */
  opened: number | null;
  clicked: number;
  /** Goals reached, credited to the last message before them. */
  converted: number;
  credits: number;
  /** The credits in money (the credit price of the currency); null when unknown. */
  creditsValue: Money | null;
  /** converted × the venue's average spend; null when the goal isn't a visit or no average is saved. */
  revenue: Money | null;
}

export interface JourneyFunnel {
  goal: GoalKind;
  started: number;
  total: FunnelRow;
  byChannel: FunnelRow[];
  bySlot: FunnelRow[];
  /** Goals reached before the guest got any message of the journey. */
  convertedBeforeMessage: number;
  /** Goals reached before this split was counted (they show only in the journey's line). */
  convertedNotSplit: number;
  /** Of the messages sent, the free info ones (e.g. a thank-you after the goal): they count as sent too. */
  serviceSent: number;
  /** Ratings from the journey's rating link (count, average stars 1 decimal, ≤ 2 stars). */
  ratings: { count: number; averageStars: number | null; low: number };
}

export interface FunnelMoney {
  /** The venue's average spend per visit (null: none saved). */
  averageSpend: Money | null;
  /** Credits per one unit of each currency (CreditConfig.currencies, e.g. CHF 100). */
  creditsPerUnit: Record<string, number>;
  /** The currency to price credits in when the venue has no average spend. */
  defaultCurrency: string;
}

const CHANNEL_ORDER = ['sms', 'email', 'whatsapp'];
export const SLOT_ORDER = ['morning', 'afternoon', 'evening', 'fixed', 'now'];

function ordered(keys: Iterable<string>, order: string[]): string[] {
  const all = [...new Set(keys)].filter((k) => k !== 'none');
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Credits → money in a currency (minor units, rounded); null when the currency has no credit price. */
export function creditsValue(credits: number, money: FunnelMoney): Money | null {
  const currency = money.averageSpend?.currency ?? money.defaultCurrency;
  const perUnit = money.creditsPerUnit[currency];
  if (!currency || !(perUnit > 0)) return null;
  return { amountMinor: Math.round((credits / perUnit) * 100), currency };
}

function revenueOf(converted: number, goal: GoalKind, money: FunnelMoney): Money | null {
  const avg = money.averageSpend;
  if (goal !== 'visit' || !avg || !(avg.amountMinor > 0)) return null;
  return { amountMinor: converted * avg.amountMinor, currency: avg.currency };
}

function row(key: string, x: { sent: number; delivered: number; opened: number | null; clicked: number; converted: number; credits: number }, goal: GoalKind, money: FunnelMoney): FunnelRow {
  return { key, ...x, creditsValue: creditsValue(x.credits, money), revenue: revenueOf(x.converted, goal, money) };
}

/**
 * One journey's funnel from its summed numbers (`live`, or the test run's `dryRun` map: a test
 * run only has sends and credits).
 */
export function journeyFunnel(stats: NumMap, goal: GoalKind, money: FunnelMoney): JourneyFunnel {
  const sends = map(stats.sends);
  const credits = map(stats.credits);
  const bySlot = map(stats.bySlot);
  const funnel = map(stats.funnel);
  const fChannel = map(funnel.channel);
  const fSlot = map(funnel.slot);
  const ratings = map(stats.ratings);

  const byChannel = ordered([...Object.keys(sends), ...Object.keys(credits), ...Object.keys(fChannel)], CHANNEL_ORDER).map((ch) => {
    const s = map(sends[ch]);
    return row(
      ch,
      {
        sent: n(s.sent),
        delivered: n(s.delivered),
        opened: ch === 'sms' ? null : n(s.opened),
        clicked: n(s.clicked),
        converted: n(map(fChannel[ch]).converted),
        credits: n(credits[ch]),
      },
      goal,
      money,
    );
  });

  const slots = ordered([...Object.keys(bySlot), ...Object.keys(fSlot)], SLOT_ORDER).map((slot) => {
    const a = map(bySlot[slot]);
    const b = map(fSlot[slot]);
    return row(slot, { sent: n(a.sent), delivered: n(b.delivered), opened: n(b.opened), clicked: n(a.clicked), converted: n(b.converted), credits: n(b.credits) }, goal, money);
  });

  const sum = (f: (r: FunnelRow) => number) => byChannel.reduce((s, r) => s + f(r), 0);
  const converted = n(stats.converted);
  const split = Object.values(fChannel).reduce<number>((s, c) => s + n(map(c).converted), 0);
  const count = n(ratings.count);
  return {
    goal,
    started: n(stats.entered),
    total: row(
      'all',
      {
        sent: sum((r) => r.sent),
        delivered: sum((r) => r.delivered),
        opened: sum((r) => r.opened ?? 0),
        clicked: sum((r) => r.clicked),
        converted,
        credits: Object.values(credits).reduce<number>((s, c) => s + n(c), 0),
      },
      goal,
      money,
    ),
    byChannel,
    bySlot: slots,
    convertedBeforeMessage: n(map(fChannel.none).converted),
    convertedNotSplit: Math.max(0, converted - split),
    serviceSent: n(map(stats.utility).sends),
    ratings: { count, averageStars: count > 0 ? Math.round((n(ratings.stars) / count) * 10) / 10 : null, low: n(ratings.low) },
  };
}
