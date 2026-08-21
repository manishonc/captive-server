/**
 * The sweep that makes subscription expiry actually happen.
 *
 * Nothing else in the system moves a subscription off `active`/`trialing` when
 * its period runs out: Stripe drives its own subscriptions, but manual
 * subscriptions and card-free trials just sat there fully entitled forever.
 * This is the clock for those.
 *
 * Two passes, both idempotent:
 *   1. `active`/`trialing` past their end date  -> `past_due`, grace clock set
 *   2. `past_due` past `graceEndsAt`            -> `expired`, account on hold
 *
 * Plus the renewal email sequence, with each stage recorded on the subscription
 * so a second run the same day sends nothing.
 *
 * Safe to re-run at any time: every write is guarded by the pure predicates in
 * services/subscriptionState.ts, so a doc already in its target state produces
 * no write, no email, and no audit entry.
 *
 * The CMS holds the mirror of the account-state writes
 * (app/api/captive-portal/_lib/subscription-lifecycle.js) for the paths a
 * tenant can trigger interactively — the Stripe webhook and the admin panel.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';
import {
  GRACE_PERIOD_DAYS,
  LAPSABLE_STATUSES,
  addDays,
  computeExpiryTransition,
  needsGraceRepair,
  daysUntil,
  dueRenewalEmail,
  entitlementEndsAt,
} from './subscriptionState';
import { sendRenewalEmail } from './renewalEmails';
import { invalidateEntitlements } from './entitlements';

const SUBSCRIPTIONS = 'CaptivePortal_Subscriptions';
const USERS = 'Users';
const AUDIT_LOGS = 'CaptivePortal_AuditLogs';

/** Account status values on the Users doc. `OnHold` is the lockout state. */
const ACCOUNT_STATUS_ACTIVE = 'Active';
const ACCOUNT_STATUS_ON_HOLD = 'OnHold';

/** Statuses worth loading at all — everything else is terminal or not started. */
const SWEEPABLE_STATUSES = [...LAPSABLE_STATUSES, 'past_due', 'expired'];

export interface SweepSummary {
  scanned: number;
  pastDue: number;
  expired: number;
  graceRepaired: number;
  emailed: number;
  failed: number;
}

interface Candidate {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, unknown>;
}

/**
 * Load the candidate subscriptions.
 *
 * Filtered by status server-side; the date comparison happens in memory because
 * the cutoff differs per doc (a trial is bounded by `trialEndsAt`, a paid period
 * by `currentPeriodEnd`) and a composite index per status/date pair is not worth
 * it at this collection's size.
 */
async function listSweepableSubscriptions(): Promise<Candidate[]> {
  const snap = await db.collection(SUBSCRIPTIONS).where('status', 'in', SWEEPABLE_STATUSES).get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() as Record<string, unknown>,
  }));
}

/**
 * Deactivate a tenant for non-payment.
 *
 * Reversible by design: this flips `Users.accountStatus` and nothing else.
 * Guest data, venues, splash config and campaign definitions all stay exactly
 * as they are, so a payment restores a working account with no restore step.
 *
 * Mirrors `deactivateTenant` in the CMS's _lib/subscription-lifecycle.js —
 * same fields, same audit action — so an account held by this job and one held
 * by an admin are indistinguishable afterwards.
 */
async function deactivateTenant(tenantUserId: string, subscriptionId: string): Promise<boolean> {
  if (!tenantUserId) return false;
  const userRef = db.collection(USERS).doc(tenantUserId);
  const snap = await userRef.get();
  if (!snap.exists) return false;
  if (snap.data()?.accountStatus === ACCOUNT_STATUS_ON_HOLD) return false; // idempotent

  await userRef.update({
    accountStatus: ACCOUNT_STATUS_ON_HOLD,
    billingDeactivatedAt: FieldValue.serverTimestamp(),
    billingDeactivationReason: 'grace_period_elapsed',
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection(AUDIT_LOGS).add({
    action: 'subscription.deactivate',
    scope: 'account',
    accountId: tenantUserId,
    tenantUserId,
    targetId: subscriptionId,
    actorUid: null,
    actorEmail: 'system:subscriptionExpirySweep',
    details: { reason: 'grace_period_elapsed', accountStatus: ACCOUNT_STATUS_ON_HOLD },
    timestamp: FieldValue.serverTimestamp(),
  });

  // The entitlement cache would otherwise keep this tenant sending for up to
  // its TTL after the account went on hold.
  invalidateEntitlements(tenantUserId);
  return true;
}

/** Apply one transition. Returns what happened, for the run summary. */
async function applyTransition(
  candidate: Candidate,
  transition: NonNullable<ReturnType<typeof computeExpiryTransition>>,
): Promise<'past_due' | 'expired'> {
  const { id, ref, data } = candidate;

  if (transition.to === 'past_due') {
    await ref.update({
      status: 'past_due',
      graceEndsAt: transition.graceEndsAt,
      pastDueSince: transition.lapsedAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(
      `[EXPIRY SWEEP] ${id} entered grace, deactivates ${transition.graceEndsAt.toISOString()}`,
    );
    return 'past_due';
  }

  await ref.update({
    status: 'expired',
    deactivatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await deactivateTenant(data.tenantUserId as string, id);
  console.log(`[EXPIRY SWEEP] ${id} expired; tenant deactivated`);
  return 'expired';
}

/**
 * Send the due renewal email, if any, and record the stage.
 *
 * The stage is marked ONLY after the send actually succeeds: a failure leaves
 * it unmarked so the next run retries, which is the right way round — a
 * duplicate email is a nuisance, a silent non-warning before deactivation is a
 * support ticket.
 */
async function sendDueEmail(candidate: Candidate, now: Date): Promise<string | null> {
  const { id, ref, data } = candidate;
  const stage = dueRenewalEmail(data, now);
  if (!stage) return null;

  const recipient = data.tenantEmail as string | undefined;
  if (!recipient) {
    console.warn(`[EXPIRY SWEEP] ${id} has no tenantEmail; skipping ${stage} email`);
    return null;
  }

  const endsAt = entitlementEndsAt(data);
  const sent = await sendRenewalEmail(recipient, stage, {
    // During a card-backed trial `planName` points at the Trial plan, so the
    // plan the tenant recognises is the one they selected.
    planName: (data.selectedPlanName as string) || (data.planName as string),
    endsAt: endsAt === null ? null : new Date(endsAt),
    graceEndsAt: (data.graceEndsAt as { toDate?: () => Date })?.toDate?.() ?? null,
    daysLeft: daysUntil(data.graceEndsAt as never, now),
    graceDays: GRACE_PERIOD_DAYS,
  });
  if (!sent) {
    console.warn(`[EXPIRY SWEEP] ${id} ${stage} email not sent; will retry next run`);
    return null;
  }

  await ref.update({
    [`renewalEmailsSent.${stage}`]: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`[EXPIRY SWEEP] ${id} sent ${stage} email`);
  return stage;
}

/**
 * One full run. Exported so it can be invoked directly (a manual catch-up, or a
 * test against the emulator) rather than only on the cron tick.
 */
export async function runSubscriptionExpirySweep(now = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scanned: 0,
    pastDue: 0,
    expired: 0,
    graceRepaired: 0,
    emailed: 0,
    failed: 0,
  };

  const candidates = await listSweepableSubscriptions();
  summary.scanned = candidates.length;

  for (const candidate of candidates) {
    try {
      // Repair before deciding: a past_due doc with no deadline would
      // otherwise be skipped forever by computeExpiryTransition.
      if (needsGraceRepair(candidate.data)) {
        const graceEndsAt = addDays(now, GRACE_PERIOD_DAYS);
        await candidate.ref.update({
          graceEndsAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
        candidate.data = { ...candidate.data, graceEndsAt };
        summary.graceRepaired += 1;
      }

      const transition = computeExpiryTransition(candidate.data, now);
      if (transition) {
        await applyTransition(candidate, transition);
        // Reflect the new state locally so this same run also sends the email
        // that the new state calls for — the day-0 "your subscription has
        // expired" notice lands the moment the grace clock starts, rather than
        // waiting for tomorrow's run.
        if (transition.to === 'past_due') {
          summary.pastDue += 1;
          candidate.data = {
            ...candidate.data,
            status: 'past_due',
            graceEndsAt: transition.graceEndsAt,
          };
        } else {
          summary.expired += 1;
          candidate.data = { ...candidate.data, status: 'expired' };
        }
      }

      if (await sendDueEmail(candidate, now)) summary.emailed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[EXPIRY SWEEP] ${candidate.id} failed:`, error);
    }
  }

  console.log('[EXPIRY SWEEP] complete', summary);
  return summary;
}

export const _test = {
  SWEEPABLE_STATUSES,
  ACCOUNT_STATUS_ACTIVE,
  ACCOUNT_STATUS_ON_HOLD,
};
