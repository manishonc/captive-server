/**
 * Serializers for the public pricing feed — the field allowlist that keeps
 * internal plan data off the marketing site.
 *
 * Pure functions, no Firestore, so the allowlist is testable without
 * credentials (tests/publicPricing.test.ts) and so the boundary lives in one
 * reviewable place rather than inline in a request handler.
 *
 * ⚠️ THIS IS A SECOND COPY OF AN ALLOWLIST.
 *
 * The CMS serves the same shape at /api/captive-public/plans. These fields are
 * what stop `includedCredits`, `flags`, `quotas`, `maxVenues` and
 * `stripeProductId` reaching the public internet — they describe what the
 * business grants internally, and this response is world readable and cached.
 *
 * Adding a plan field therefore means remembering two repos. The test pins the
 * exact key set so that forgetting is a red test rather than a leak. If you
 * change the shape here, change it in the CMS route too.
 */

type Raw = Record<string, unknown>;

export interface PublicPrice {
  label: string;
  amount: number;
  currency: string;
  interval: string;
}

export interface PublicPlan {
  name: string;
  description: string;
  marketing: {
    displayOrder: number;
    tagline: string;
    badge: string;
    highlight: boolean;
    ctaLabel: string;
    features: string[];
  };
  freeTrialDays: number | null;
  prices: PublicPrice[];
}

export interface PublicPricing {
  plans: PublicPlan[];
  /**
   * Free-trial length in days, or null. Reported separately from the plans
   * because the trial plan is never sold and so never appears in `plans`.
   */
  trialDays: number | null;
  /**
   * Whether starting a trial requires a card up front.
   *
   * Top-level rather than per-plan because it is one global admin setting, and
   * because keeping it out of `PublicPlan` leaves the pinned per-plan key set
   * (and its test) untouched.
   *
   * The marketing site reads this to decide between "no credit card required"
   * and "card required, cancel any time" — copy that is legally load-bearing
   * and must flip with the setting, not with the next deploy.
   */
  trialRequiresCard: boolean;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Allowlist for a price. Nothing else from the doc reaches the response. */
export function serializePublicPrice(data: Raw): PublicPrice {
  return {
    label: str(data.label),
    amount: Number(data.amount) || 0,
    currency: str(data.currency, 'CHF'),
    interval: str(data.interval, 'monthly'),
  };
}

/** Allowlist for a plan. Nothing else from the doc reaches the response. */
export function serializePublicPlan(data: Raw, prices: PublicPrice[]): PublicPlan {
  const marketing = (data.marketing as Raw) || {};
  return {
    // The name is load-bearing, not decoration: the pricing page builds its
    // checkout link as ?plan=<name> and the CMS resolves it back to this
    // document by a case-insensitive name match.
    name: str(data.name),
    description: str(data.description),
    marketing: {
      displayOrder: Number(marketing.displayOrder) || 0,
      tagline: str(marketing.tagline),
      badge: str(marketing.badge),
      highlight: marketing.highlight === true,
      ctaLabel: str(marketing.ctaLabel),
      features: Array.isArray(marketing.features)
        ? (marketing.features as unknown[])
            .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
            .map((f) => f.trim())
        : [],
    },
    freeTrialDays: Number.isInteger(data.freeTrialDays) ? (data.freeTrialDays as number) : null,
    prices,
  };
}

/** Sort key: admin-controlled order, then name so ties are stable. */
export function comparePublicPlans(a: PublicPlan, b: PublicPlan): number {
  return a.marketing.displayOrder - b.marketing.displayOrder || a.name.localeCompare(b.name);
}

/**
 * Billing-cadence order for a plan's prices: recurring before one-time,
 * monthly before yearly, anything unrecognized last. The CMS admin routes only
 * ever write 'monthly' | 'yearly' | 'one-time', but this response is public
 * and consumers take `prices[0]` as the headline price, so the ranking is
 * normalized (trim, lowercase, `_` -> `-`) rather than trusting the doc.
 */
const INTERVAL_ORDER: Record<string, number> = { monthly: 0, yearly: 1, 'one-time': 2 };

function intervalRank(interval: string): number {
  const rank = INTERVAL_ORDER[interval.trim().toLowerCase().replace(/_/g, '-')];
  return rank === undefined ? Object.keys(INTERVAL_ORDER).length : rank;
}

/**
 * Sort key for a plan's prices. Firestore returns the `prices` subcollection in
 * doc-id order — effectively random — and a feed that happens to lead with the
 * yearly price checks visitors out on the wrong interval downstream. Interval
 * first (see INTERVAL_ORDER), then amount and label so ties are stable.
 */
export function comparePublicPrices(a: PublicPrice, b: PublicPrice): number {
  return (
    intervalRank(a.interval) - intervalRank(b.interval) ||
    a.amount - b.amount ||
    a.label.localeCompare(b.label)
  );
}

/** A plan is published only when active, not a trial, and explicitly ticked. */
export function isPublishable(data: Raw): boolean {
  const marketing = (data.marketing as Raw) || {};
  return data.isFreeTrial === false && marketing.publicVisible === true;
}

/** Trial length from the free-trial plan doc, or null when absent/invalid. */
export function trialDaysFrom(data: Raw | undefined): number | null {
  const raw = Number(data?.freeTrialDays);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Whether a card is required to start a trial, from `CaptivePortal_Settings/global`.
 *
 * Defaults to false on a missing or malformed settings document — the same
 * fail-safe the CMS applies. Claiming a card is required when it is not merely
 * loses signups; claiming it is not when it IS produces a customer who was
 * charged after being told they would not be.
 */
export function trialRequiresCardFrom(data: Raw | undefined): boolean {
  return data?.requireCardForTrial === true;
}
