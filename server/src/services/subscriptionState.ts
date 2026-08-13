/**
 * Subscription-state classification — the lapse semantics behind every billing
 * gate, in one pure module.
 *
 * Pure functions, no Firestore, for the same reason services/publicPricing.ts
 * is pure: the semantics are load-bearing (they decide whose scheduled
 * campaigns dispatch) and must be testable without credentials
 * (tests/subscriptionState.test.ts). services/entitlements.ts owns the reads
 * and calls in here.
 *
 * Must match the CMS's classification in _lib/entitlements.js — the two repos
 * gate the same sends, at different moments (the CMS when the tenant clicks
 * send/schedule, this server when the scheduler dispatches).
 */

/**
 * Stripe dunning — a card being retried, not a tenant who left. Counts as
 * RETAINED ACCESS in the lapse classification: Stripe resolves dunning on its
 * own (back to `active`, or through cancellation to `cancelled`), so cutting a
 * tenant off mid-retry would punish a bounced card as if it were a
 * cancellation. Only genuinely dead doc sets classify as lapsed: nothing but
 * `cancelled` / `expired` / `superseded` docs (or a trial whose `trialEndsAt`
 * has passed).
 */
const DUNNING_STATUS = 'payment_failed';

export type SubscriptionState = 'active' | 'trialing' | 'payment_failed' | 'lapsed' | 'none';

/**
 * A `trialing` subscription stops entitling the tenant once `trialEndsAt` has
 * passed. Nothing flips the stored status when a trial lapses, so the date is
 * the only source of truth — without this an expired trial keeps sending
 * forever. Must stay identical to isLapsedTrial in cms _lib/entitlements.js,
 * or the two repos disagree about who may send.
 *
 * Missing/unparseable `trialEndsAt` counts as NOT expired: an open-ended trial
 * is a data problem, not a reason to cut a tenant off mid-campaign.
 */
export function isLapsedTrial(subscription: Record<string, unknown>, now = new Date()): boolean {
  if (subscription?.status !== 'trialing') return false;
  const rawEnd = subscription.trialEndsAt as { toDate?: () => Date } | Date | string | undefined;
  const endsAt =
    (rawEnd as { toDate?: () => Date })?.toDate?.() ?? (rawEnd as Date | string | undefined);
  if (!endsAt) return false;
  const time = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
  if (!Number.isFinite(time)) return false;
  return time <= now.getTime();
}

/**
 * Classify a tenant's billing standing from their full subscription-doc set.
 *
 * `entitling` is the doc `getEntitlements` already selected (newest
 * non-expired active/trialing), `allSubs` is every subscription doc the
 * tenant has.
 *
 *  - 'active' / 'trialing'  — an entitling subscription exists.
 *  - 'payment_failed'       — dunning; RETAINED ACCESS (see DUNNING_STATUS).
 *  - 'lapsed'               — subscription history exists but every doc is
 *                             genuinely dead (cancelled/expired/superseded, or
 *                             an expired trial). The only state gates act on.
 *  - 'none'                 — no history at all: the pre-billing tenant the
 *                             documented fail-open exists to protect.
 */
export function classifySubscriptionState(
  entitling: Record<string, unknown> | null,
  allSubs: Array<Record<string, unknown>>,
): SubscriptionState {
  if (entitling?.status === 'active') return 'active';
  if (entitling?.status === 'trialing') return 'trialing';
  if (allSubs.length === 0) return 'none';
  if (allSubs.some((s) => s.status === DUNNING_STATUS)) return 'payment_failed';
  return 'lapsed';
}
