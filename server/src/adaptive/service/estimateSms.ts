/**
 * The owner estimate's SMS price, the way the engine really sends SMS (PR F0).
 *
 * `core/estimate.ts` prices every touch of a guest with a phone as a one-part SMS. The engine
 * sends the first message of an SMS-first journey by SMS and moves the follow-ups on to the next
 * rung of the ladder (an SMS is never "opened", so a follow-up goes `next_on_ladder`: email for
 * every seeded SMS-first journey). So the old estimate over-counted the follow-ups, and under-
 * counted a first SMS longer than one part. This measures the first message's parts per venue
 * and journey (its wording in English and German, rendered with the example guest, the venue's
 * own name, production-length links and the STOP line) and adds the difference to the estimate —
 * negative where the follow-ups are emails. Pure — no Firestore.
 *
 * An approximation: a guest who taps the SMS link gets the welcome's last reminder by SMS again
 * (`same_as_last_click`), priced here as email — the bill can be higher by about one SMS per
 * clicking guest (the estimate has no click rate to price it with).
 */

import type { EstimateJourneyInput, EstimatePrices, EstimateResult, EstimateVenueInput } from '../core/estimate';
import type { JourneyDefinition, Offer, SlotValue } from '../core/schemas';
import type { Channel, Lang } from '../core/constants';
import type { VariantDoc } from '../store/types';
import { sampleValues } from '../core/render';
import { smsSegmentCount } from '../core/runtime/smsParts';
import { smsFinalText } from '../send/compose';
import { renderMessage, variantContent, variantEligible } from '../engine/renderSend';

const LANGS: Lang[] = ['en', 'de'];

type NodeLike = { type?: string; config?: { purpose?: string; pool?: string }; edges?: Record<string, string> };

/** The pool of the journey's first marketing send (walking the steps from the start), or null. */
export function firstMarketingPool(definition: JourneyDefinition): string | null {
  const nodes = (definition.nodes ?? {}) as Record<string, NodeLike>;
  const seen = new Set<string>();
  const queue: string[] = definition.start ? [definition.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (!node) continue;
    if (node.type === 'send' && node.config?.purpose === 'marketing' && typeof node.config.pool === 'string') return node.config.pool;
    for (const next of Object.values(node.edges ?? {})) if (typeof next === 'string' && !seen.has(next)) queue.push(next);
  }
  return null;
}

/**
 * Parts of the journey's first marketing SMS at one venue: the longest of that pool's active
 * wordings (the ones these slot values allow) in English and German. 1 when it has no SMS.
 */
export function journeySmsParts(args: {
  definition: JourneyDefinition;
  variants: Array<Pick<VariantDoc, 'poolKey' | 'status' | 'channels' | 'locales' | 'when'>>;
  venueName: string;
  slots: Record<string, SlotValue>;
  offers: Offer[];
  /** A production-length stand-in for every link (send/links.ts `pricingLinks`). */
  link: string;
}): number {
  const pool = firstMarketingPool(args.definition);
  if (!pool) return 1;
  let most = 0;
  for (const v of args.variants) {
    if (v.poolKey !== pool || v.status !== 'active' || !variantEligible(v, args.slots)) continue;
    for (const lang of LANGS) {
      const found = variantContent(v, 'sms', lang);
      if (!found) continue;
      const template = String((found.content as { text?: string }).text ?? '');
      const values = sampleValues({ lang, venueName: args.venueName, slots: args.slots, offers: args.offers });
      for (const key of Object.keys(values)) if (key.startsWith('link.') || key === 'guestinfo.hostContactUrl') values[key] = args.link;
      const text = smsFinalText(renderMessage({ text: template }, 'sms', values).text, found.locale, template);
      most = Math.max(most, smsSegmentCount(text));
    }
  }
  return most || 1;
}

/** The first of SMS / email on the ladder from `from` (the channel a guest with a phone gets there). */
function firstOf(ladder: Channel[], from = 0): Channel | null {
  for (let i = from; i < ladder.length; i += 1) if (ladder[i] === 'sms' || ladder[i] === 'email') return ladder[i];
  return null;
}

/**
 * The estimate with each SMS-first journey priced as the engine sends it: for a guest with a
 * phone, the first message by SMS at its real parts at this venue, the other touches on the next
 * rung (email; when there is none, SMS again). `estimateMonthly` priced all of them as one-part
 * SMS; the difference is added per venue and per journey. Journeys that start by email, and info
 * journeys, are left as they are.
 */
export function withSmsSteps(
  result: EstimateResult,
  venues: EstimateVenueInput[],
  journeys: Array<EstimateJourneyInput & { smsParts: Record<string, number> }>,
  prices: EstimatePrices,
): EstimateResult {
  const perJourney = new Map(result.perJourney.map((j) => [j.journeyKey, j.credits]));
  const deltaByJourney = new Map<string, number>();
  const perVenue = result.perVenue.map((row) => {
    const v = venues.find((x) => x.venueId === row.venueId);
    if (!v) return row;
    const reachable = v.withPhone + v.emailOnly;
    const phoneShare = reachable > 0 ? v.withPhone / reachable : 0;
    let delta = 0;
    for (const j of journeys) {
      if (j.purpose === 'service' || firstOf(j.ladder) !== 'sms') continue;
      const parts = Math.max(1, j.smsParts[v.venueId] ?? 1);
      const touches = j.avgTouchesPerGuest;
      const next = firstOf(j.ladder, j.ladder.indexOf('sms') + 1);
      const nextPrice = next === 'email' ? prices.email : prices.sms * parts;
      const asSent = prices.sms * parts * Math.min(1, touches) + Math.max(0, touches - 1) * nextPrice;
      const d = v.optedIn30d * phoneShare * (asSent - touches * prices.sms);
      delta += d;
      deltaByJourney.set(j.journeyKey, (deltaByJourney.get(j.journeyKey) ?? 0) + d);
    }
    return { ...row, credits: Math.max(0, Math.round(row.credits + delta)) };
  });
  for (const [key, d] of deltaByJourney) perJourney.set(key, Math.max(0, Math.round((perJourney.get(key) ?? 0) + d)));
  const creditsPerMonth = perVenue.reduce((s, v) => s + v.credits, 0);
  const costPerMonthMinor = prices.creditsPerUnit > 0 ? Math.round((creditsPerMonth / prices.creditsPerUnit) * 100) : 0;
  return {
    ...result,
    creditsPerMonth,
    costPerMonthMinor,
    perVenue,
    perJourney: [...perJourney.entries()].map(([journeyKey, credits]) => ({ journeyKey, credits })),
  };
}
