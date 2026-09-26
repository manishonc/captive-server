/**
 * JourneyStats (plan §4.1, 02 §6.7): the daily numbers per venue and journey — pure.
 *
 * Doc `CaptivePortal_JourneyStats/{venueId}_{journeyKey}_{yyyymmdd}`; `_venue` holds
 * the venue's totals over all journeys (plus visits); the date is the day the event
 * happened in the venue's time zone.
 *
 *   journey.entered / converted      → entered / converted
 *   journey.exited                   → ended{status}, exited{reason}
 *   message.sent (live)              → sends.{ch}.sent, bySlot, byVariant, and
 *                                      credits.{ch} (marketing) or utility (service)
 *   message.delivered/opened/clicked/bounced/failed/unknown → sends.{ch}.*
 *   send.skipped / send.blocked      → skipped{reason}
 *   send.dry_run and every event of a test-run guest → dryRun{…} (same shape), so a
 *                                      test run never shows up in sends or credits
 *   visit.started / wifi.connected   → visits.{total, first, revisits} / visits.captures (`_venue` only)
 *   stay.created / changed / cancelled / linked / overlap_flagged / moment_skipped
 *                                    → stays.{created, changed, cancelled, linked, overlapFlagged,
 *                                      momentsSkipped} (`_venue` only, whatever the mode)
 *
 * Counters are nested objects of numbers, so a reason like
 * `missing_value:guestinfo.wifiName` stays one map key (never a dotted path).
 */

import { localParts } from '../core/runtime/time';

export const VENUE_KEY = '_venue';
export const STATS_SCHEMA_VERSION = 1;

/** A nested object of counts (leaves are numbers to add). */
export interface Counts {
  [key: string]: number | Counts;
}

export interface RollupEvent {
  id: string;
  type: string;
  journeyKey: string | null;
  instanceId: string | null;
  channel: string | null;
  slot: string | null;
  variantId: string | null;
  /** When it happened (engine clock, epoch ms) — decides the day. */
  occurredAt: number;
  /** test / live; null when the event doesn't say (the caller resolves it from the instance). */
  mode: 'test' | 'live' | null;
  data: Record<string, unknown>;
}

const STAY_COUNTERS: Record<string, string> = {
  'stay.created': 'created',
  'stay.changed': 'changed',
  'stay.cancelled': 'cancelled',
  'stay.linked': 'linked',
  'stay.overlap_flagged': 'overlapFlagged',
  'stay.moment_skipped': 'momentsSkipped',
  // PR D: the owner took a wrongly linked person off a stay.
  'stay.unlinked': 'unlinked',
};

const MESSAGE_STATUS: Record<string, string> = {
  'message.delivered': 'delivered',
  'message.opened': 'opened',
  'message.clicked': 'clicked',
  'message.bounced': 'bounced',
  'message.failed': 'failed',
  'message.unknown': 'unknown',
};

/** A safe map key: never empty, never `__…__` (reserved), not absurdly long. */
export function statKey(value: unknown, fallback = 'unknown'): string {
  let k = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!k) k = fallback;
  if (k.length > 120) k = k.slice(0, 120);
  if (/^__.*__$/.test(k)) k = `x${k}`;
  return k;
}

export function addInto(target: Counts, add: Counts): void {
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v === 0) continue;
      const cur = target[k];
      target[k] = (typeof cur === 'number' ? cur : 0) + v;
    } else {
      const cur = target[k];
      const child: Counts = cur && typeof cur === 'object' ? cur : {};
      addInto(child, v);
      if (Object.keys(child).length) target[k] = child;
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** What one event adds: to the journey's doc and `_venue` (`both`), or only to `_venue` (`venueOnly`). */
export function countsFor(e: RollupEvent): { both: Counts | null; venueOnly: Counts | null } {
  const test = e.mode === 'test' || e.type === 'send.dry_run';
  const wrap = (c: Counts): { both: Counts; venueOnly: null } => ({ both: test ? { dryRun: c } : c, venueOnly: null });
  const channel = statKey(e.channel ?? e.data.channel);
  // A booking isn't a send: stays count on `_venue` whatever the mode (never under dryRun).
  const stay = STAY_COUNTERS[e.type];
  if (stay) return { both: null, venueOnly: { stays: { [stay]: 1 } } };

  switch (e.type) {
    case 'journey.entered':
      return wrap({ entered: 1 });
    case 'journey.converted':
      return wrap({ converted: 1 });
    case 'journey.exited':
      return wrap({ ended: { [statKey(e.data.status)]: 1 }, exited: { [statKey(e.data.reason ?? e.data.status)]: 1 } });
    case 'message.sent': {
      const purpose = e.data.purpose === 'service' ? 'service' : 'marketing';
      const slot = statKey(e.slot ?? e.data.slot, 'now');
      const variant = e.variantId ?? e.data.variantId;
      const c: Counts = { sends: { [channel]: { sent: 1 } }, bySlot: { [slot]: { sent: 1 } } };
      if (variant) c.byVariant = { [statKey(variant)]: { sent: 1 } };
      if (purpose === 'marketing') c.credits = { [channel]: num(e.data.credits) };
      else c.utility = { sends: 1, providerCostMinor: num(e.data.providerCostMinor) };
      return wrap(c);
    }
    case 'send.dry_run': {
      const decision = (e.data.decision ?? {}) as { purpose?: string; credits?: { price?: number } | null; slot?: { picked?: string }; variant?: { picked?: string | null } };
      const slot = statKey(e.slot ?? decision.slot?.picked, 'now');
      const variant = e.variantId ?? decision.variant?.picked ?? null;
      const c: Counts = { sends: { [channel]: { sent: 1 } }, bySlot: { [slot]: { sent: 1 } } };
      if (variant) c.byVariant = { [statKey(variant)]: { sent: 1 } };
      if (decision.purpose === 'service') c.utility = { sends: 1 };
      else c.credits = { [channel]: num(decision.credits?.price) };
      return { both: { dryRun: c }, venueOnly: null };
    }
    case 'send.skipped':
    case 'send.blocked': {
      const decision = e.data.decision as { reason?: string | null } | undefined;
      return wrap({ skipped: { [statKey(decision?.reason ?? e.data.reason)]: 1 } });
    }
    case 'visit.started':
      return {
        both: null,
        venueOnly: { visits: { total: 1, ...(e.data.isFirstVisit === true ? { first: 1 } : {}), ...(e.data.isRevisit === true ? { revisits: 1 } : {}) } },
      };
    case 'wifi.connected':
      return { both: null, venueOnly: { visits: { captures: 1 } } };
    default: {
      const status = MESSAGE_STATUS[e.type];
      if (!status) return { both: null, venueOnly: null };
      const c: Counts = { sends: { [channel]: { [status]: 1 } } };
      if (status === 'clicked') {
        if (e.slot) c.bySlot = { [statKey(e.slot)]: { clicked: 1 } };
        if (e.variantId) c.byVariant = { [statKey(e.variantId)]: { clicked: 1 } };
      }
      return wrap(c);
    }
  }
}

/** `yyyymmdd` of an instant in a time zone. */
export function dayId(ms: number, tz: string): string {
  const p = localParts(new Date(ms), tz);
  return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`;
}

export function statsDocId(venueId: string, journeyKey: string, day: string): string {
  return `${venueId}_${journeyKey}_${day}`;
}

export interface StatsDelta {
  docId: string;
  journeyKey: string;
  /** `YYYY-MM-DD`. */
  date: string;
  counts: Counts;
}

/** Adds up a page of events into one delta per stats doc. */
export function aggregate(venueId: string, tz: string, events: RollupEvent[]): StatsDelta[] {
  const out = new Map<string, StatsDelta>();
  const add = (journeyKey: string, day: string, counts: Counts) => {
    const docId = statsDocId(venueId, journeyKey, day);
    let d = out.get(docId);
    if (!d) {
      d = { docId, journeyKey, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`, counts: {} };
      out.set(docId, d);
    }
    addInto(d.counts, counts);
  };
  for (const e of events) {
    const c = countsFor(e);
    if (!c.both && !c.venueOnly) continue;
    const day = dayId(e.occurredAt, tz);
    if (c.both) {
      add(VENUE_KEY, day, c.both);
      if (e.journeyKey && e.journeyKey !== VENUE_KEY) add(e.journeyKey, day, c.both);
    }
    if (c.venueOnly) add(VENUE_KEY, day, c.venueOnly);
  }
  return [...out.values()].filter((d) => Object.keys(d.counts).length > 0);
}
