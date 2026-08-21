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

/**
 * Our own grace state, written by the CMS expiry sweep when a trial or a manual
 * period runs out (and by the Stripe webhook when a card fails). Same treatment
 * as dunning — RETAINED ACCESS — because the whole point of the grace window is
 * that the tenant keeps working while we warn them. `graceEndsAt` on the doc
 * says when it becomes `expired`, and only then does access stop.
 */
const GRACE_STATUS = 'past_due';

/** Statuses that still entitle a tenant to send. */
const RETAINED_ACCESS_STATUSES = [DUNNING_STATUS, GRACE_STATUS];

export type SubscriptionState =
  | 'active'
  | 'trialing'
  | 'payment_failed'
  | 'past_due'
  | 'lapsed'
  | 'none';

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
 *  - 'past_due'             — our grace window; RETAINED ACCESS (see
 *                             GRACE_STATUS).
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
  // Dunning is reported ahead of grace when a tenant somehow has both: it is
  // the one the tenant can fix themselves, in the billing portal.
  if (allSubs.some((s) => s.status === DUNNING_STATUS)) return 'payment_failed';
  if (allSubs.some((s) => s.status === GRACE_STATUS)) return 'past_due';
  return 'lapsed';
}

/** Does this state still permit sending? The send path's single question. */
export function retainsAccess(state: SubscriptionState): boolean {
  return state !== 'lapsed';
}

export { DUNNING_STATUS, GRACE_STATUS, RETAINED_ACCESS_STATUSES };

// ─── Expiry state machine ────────────────────────────────────────────────────
//
//   trialing|active ──period/trial ends──► past_due  (grace, account usable)
//                                             │
//                        payment received ────┼──► active   (grace cleared)
//                        grace elapsed ───────┴──► expired  (deactivated)
//
// Pure, for the same reason the classification above is: this decides who gets
// deactivated, and it must be testable without credentials. The job that acts
// on these decisions is jobs/subscriptionExpiry.ts.

/**
 * Days between a subscription lapsing and the account being deactivated.
 * During this window the tenant keeps working — captive portal stays up,
 * campaigns still send. We warn, we don't cut off.
 */
export const GRACE_PERIOD_DAYS = 15;

/** Days before the period ends that the "renew now" heads-up goes out. */
export const EXPIRING_SOON_DAYS = 7;

/** Statuses the sweep considers live enough to lapse. */
export const LAPSABLE_STATUSES = ['active', 'trialing'];

/** The stages of the renewal email sequence, in the order they are sent. */
export type RenewalEmailStage =
  | 'expiringSoon'
  | 'graceStarted'
  | 'graceMidpoint'
  | 'graceFinal'
  | 'deactivated'
  | 'reactivated';

type DateLike = { toDate?: () => Date } | Date | string | null | undefined;

/**
 * Firestore Timestamp | Date | ISO string -> epoch ms, or null when the value
 * is absent or unparseable. An unparseable date is deliberately null rather
 * than 0: "we cannot tell when this ends" must never read as "it ended in 1970".
 */
export function toMillis(value: DateLike): number | null {
  if (!value) return null;
  const date = (value as { toDate?: () => Date })?.toDate?.() ?? (value as Date | string);
  const time = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Number.isFinite(time) ? time : null;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * When does this subscription's current entitlement run out? A trial ends at
 * `trialEndsAt`; a paid period at `currentPeriodEnd`. A trialing doc carrying
 * both is bounded by the trial — that is the date the tenant was shown.
 */
export function entitlementEndsAt(subscription: Record<string, unknown>): number | null {
  if (subscription?.status === 'trialing') {
    return (
      toMillis(subscription.trialEndsAt as DateLike) ??
      toMillis(subscription.currentPeriodEnd as DateLike)
    );
  }
  return toMillis(subscription?.currentPeriodEnd as DateLike);
}

/**
 * Is Stripe the authority for this subscription's lifecycle?
 *
 * Stripe-backed subscriptions transition themselves — an auto-converting trial
 * becomes `active` on its own, and a failed renewal arrives as a webhook. The
 * sweep must not race that: it would flip a healthy subscription to `past_due`
 * in the hours between the period ending and the invoice webhook landing.
 * Manual and card-free-trial docs have no such clock, which is exactly why they
 * need the sweep.
 */
export function isStripeManaged(subscription: Record<string, unknown>): boolean {
  return Boolean(subscription?.stripeSubscriptionId);
}

export type ExpiryTransition =
  | { to: 'past_due'; graceEndsAt: Date; lapsedAt: Date }
  | { to: 'expired' }
  | null;

/**
 * The core decision.
 *
 * Returns null when nothing is due — the answer for the overwhelming majority
 * of docs on any given day, and what makes re-running the sweep a no-op.
 */
export function computeExpiryTransition(
  subscription: Record<string, unknown>,
  now = new Date(),
): ExpiryTransition {
  const status = subscription?.status as string;

  if (LAPSABLE_STATUSES.includes(status)) {
    if (isStripeManaged(subscription)) return null;
    const endsAt = entitlementEndsAt(subscription);
    // No end date is a data problem, not a reason to cut someone off.
    if (endsAt === null || endsAt > now.getTime()) return null;
    return {
      to: 'past_due',
      lapsedAt: new Date(endsAt),
      graceEndsAt: addDays(now, GRACE_PERIOD_DAYS),
    };
  }

  if (status === GRACE_STATUS) {
    const graceEndsAt = toMillis(subscription?.graceEndsAt as DateLike);
    if (graceEndsAt === null || graceEndsAt > now.getTime()) return null;
    return { to: 'expired' };
  }

  return null;
}

/**
 * A `past_due` doc with no `graceEndsAt` — written by an older code path, or by
 * an admin flipping status by hand. Given a full grace window from now by the
 * sweep, rather than being expired immediately or left stuck forever.
 */
export function needsGraceRepair(subscription: Record<string, unknown>): boolean {
  return (
    subscription?.status === GRACE_STATUS &&
    toMillis(subscription?.graceEndsAt as DateLike) === null
  );
}

/**
 * Whole days from `now` until `target`, rounded up, floored at 0. This is the
 * number the tenant is told ("2 days left"), so it must match what the CMS
 * shows — both read the same stored `graceEndsAt`.
 */
export function daysUntil(target: DateLike, now = new Date()): number | null {
  const time = toMillis(target);
  if (time === null) return null;
  return Math.max(0, Math.ceil((time - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Which renewal email, if any, is due for this subscription right now.
 *
 * Stages already present in `renewalEmailsSent` are skipped, which is what
 * makes running the sweep twice in one day send nothing the second time.
 */
export function dueRenewalEmail(
  subscription: Record<string, unknown>,
  now = new Date(),
): RenewalEmailStage | null {
  const sent = (subscription?.renewalEmailsSent as Record<string, unknown>) || {};
  const status = subscription?.status as string;

  if (LAPSABLE_STATUSES.includes(status)) {
    const endsAt = entitlementEndsAt(subscription);
    if (endsAt === null) return null;
    const daysLeft = daysUntil(new Date(endsAt), now);
    if (daysLeft !== null && daysLeft <= EXPIRING_SOON_DAYS && !sent.expiringSoon) {
      return 'expiringSoon';
    }
    return null;
  }

  if (status === GRACE_STATUS) {
    const graceLeft = daysUntil(subscription?.graceEndsAt as DateLike, now);
    if (graceLeft === null) return null;
    // Ordered most-urgent first: a tenant who lapsed while the job was down
    // gets the message that matches where they actually are, not a backlog.
    if (graceLeft <= 2 && !sent.graceFinal) return 'graceFinal';
    if (graceLeft <= GRACE_PERIOD_DAYS - 7 && !sent.graceMidpoint) return 'graceMidpoint';
    if (!sent.graceStarted) return 'graceStarted';
    return null;
  }

  if (status === 'expired' && !sent.deactivated) return 'deactivated';

  return null;
}
