/**
 * The monthly estimate shown before turning on (PRD PB-5, 04-engine-runtime §10):
 *
 *   credits  = opted-in captures (last 30 days) × Σ enabled marketing journeys
 *              (average messages per guest × price of the channel the ladder picks)
 *   return   = opted-in captures × return rate × average spend per visit
 *
 * The channel price is weighted by the contact details guests actually leave: a
 * guest with a phone gets the first of SMS/email on the ladder, an email-only
 * guest gets email. WhatsApp isn't counted until its templates are approved.
 * Info (service) journeys never cost credits. It is a rough estimate by design.
 */

import type { Channel } from './constants';

export interface EstimateVenueInput {
  venueId: string;
  /** Guests captured in the last 30 days (all of them). */
  captures30d: number;
  /** Of those, how many said yes to marketing. */
  optedIn30d: number;
  /** Opted-in guests who left a phone number. */
  withPhone: number;
  /** Opted-in guests who left only an email. */
  emailOnly: number;
}

export interface EstimateJourneyInput {
  journeyKey: string;
  purpose: 'marketing' | 'service' | 'mixed';
  avgTouchesPerGuest: number;
  ladder: Channel[];
}

export interface EstimatePrices {
  /** Credits per message (SMS: per segment; one segment assumed). */
  email: number;
  sms: number;
  /** Credits per 1 unit of currency, e.g. 100 per CHF. */
  creditsPerUnit: number;
  currency: string;
}

export interface EstimateResult {
  creditsPerMonth: number;
  costPerMonthMinor: number;
  revenuePerMonthMinor: number;
  currency: string;
  perVenue: Array<{ venueId: string; guestsPerMonth: number; optedInPerMonth: number; credits: number; revenueMinor: number }>;
  perJourney: Array<{ journeyKey: string; credits: number }>;
}

function firstUsable(ladder: Channel[], usable: Channel[]): Channel | null {
  return ladder.find((c) => usable.includes(c)) ?? null;
}

function priceOf(channel: Channel | null, prices: EstimatePrices): number {
  if (channel === 'sms') return prices.sms;
  if (channel === 'email') return prices.email;
  return 0;
}

export function estimateMonthly(
  venues: EstimateVenueInput[],
  journeys: EstimateJourneyInput[],
  prices: EstimatePrices,
  hints: { returnRate: number; avgSpendMinor: number },
): EstimateResult {
  const perJourney = new Map<string, number>();
  const perVenue = venues.map((v) => {
    const reachable = v.withPhone + v.emailOnly;
    const phoneShare = reachable > 0 ? v.withPhone / reachable : 0;
    let credits = 0;
    for (const j of journeys) {
      if (j.purpose === 'service') continue;
      const phonePrice = priceOf(firstUsable(j.ladder, ['sms', 'email']), prices);
      const emailPrice = priceOf(firstUsable(j.ladder, ['email']), prices);
      const perTouch = phoneShare * phonePrice + (1 - phoneShare) * emailPrice;
      const c = v.optedIn30d * j.avgTouchesPerGuest * perTouch;
      credits += c;
      perJourney.set(j.journeyKey, (perJourney.get(j.journeyKey) ?? 0) + c);
    }
    const revenueMinor = v.optedIn30d * hints.returnRate * hints.avgSpendMinor;
    return {
      venueId: v.venueId,
      guestsPerMonth: v.captures30d,
      optedInPerMonth: v.optedIn30d,
      credits: Math.round(credits),
      revenueMinor: Math.round(revenueMinor),
    };
  });

  const creditsPerMonth = perVenue.reduce((s, v) => s + v.credits, 0);
  const revenuePerMonthMinor = perVenue.reduce((s, v) => s + v.revenueMinor, 0);
  const costPerMonthMinor = prices.creditsPerUnit > 0 ? Math.round((creditsPerMonth / prices.creditsPerUnit) * 100) : 0;
  return {
    creditsPerMonth,
    costPerMonthMinor,
    revenuePerMonthMinor,
    currency: prices.currency,
    perVenue,
    perJourney: [...perJourney.entries()].map(([journeyKey, credits]) => ({ journeyKey, credits: Math.round(credits) })),
  };
}
