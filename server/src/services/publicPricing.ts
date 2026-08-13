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
