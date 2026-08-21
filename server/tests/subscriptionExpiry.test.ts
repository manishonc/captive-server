/**
 * Tests for the expiry state machine in services/subscriptionState.ts — the
 * decisions behind jobs/subscriptionExpiry.ts.
 *
 * Run: npx tsx tests/subscriptionExpiry.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials: the transitions are pure, which is exactly why
 * they live in the pure module rather than inline in the sweep. The sweep's own
 * Firestore writes are exercised against the emulator/staging, not here.
 *
 * THE LOAD-BEARING PROPERTY
 *
 * Re-running the sweep must change nothing the second time. Every predicate
 * here returns null/false for a doc already in its target state, and the
 * renewal-email stages are keyed off what has already been sent — so an hourly
 * re-run, or a catch-up after an outage, cannot double-deactivate or spam.
 */

import {
  GRACE_PERIOD_DAYS,
  addDays,
  entitlementEndsAt,
  isStripeManaged,
  computeExpiryTransition,
  needsGraceRepair,
  daysUntil,
  dueRenewalEmail,
} from '../src/services/subscriptionState';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const NOW = new Date('2026-09-01T05:00:00Z');

/** A Firestore-Timestamp-shaped value, to prove toMillis handles both forms. */
function timestamp(date: Date) {
  return { toDate: () => date };
}

console.log('\nexpiry transitions\n');

test('a live trial is left alone', () => {
  assertEqual(computeExpiryTransition({ status: 'trialing', trialEndsAt: addDays(NOW, 3) }, NOW), null);
});

test('an expired trial enters grace with a stored deadline', () => {
  const endedAt = addDays(NOW, -1);
  const transition = computeExpiryTransition({ status: 'trialing', trialEndsAt: endedAt }, NOW);
  assertEqual(transition?.to, 'past_due');
  assertEqual(
    (transition as { graceEndsAt: Date }).graceEndsAt.getTime(),
    addDays(NOW, GRACE_PERIOD_DAYS).getTime(),
    'graceEndsAt',
  );
});

test('a manual subscription past its period end enters grace', () => {
  const sub = {
    status: 'active',
    paymentMethod: 'manual',
    currentPeriodEnd: timestamp(addDays(NOW, -2)),
  };
  assertEqual(computeExpiryTransition(sub, NOW)?.to, 'past_due');
});

test('Stripe-managed subscriptions are never touched by the sweep', () => {
  // Stripe drives these itself; sweeping them would race the invoice webhook
  // and flip a healthy subscription to past_due for a few hours.
  const sub = { status: 'active', stripeSubscriptionId: 'sub_123', currentPeriodEnd: addDays(NOW, -2) };
  assertEqual(computeExpiryTransition(sub, NOW), null);
});

test('a subscription with no end date is never expired on a guess', () => {
  assertEqual(computeExpiryTransition({ status: 'trialing' }, NOW), null, 'no date');
  assertEqual(
    computeExpiryTransition({ status: 'active', currentPeriodEnd: 'not-a-date' }, NOW),
    null,
    'unparseable',
  );
});

test('grace runs out into expired, and not a day early', () => {
  assertEqual(computeExpiryTransition({ status: 'past_due', graceEndsAt: addDays(NOW, 1) }, NOW), null);
  assertEqual(
    computeExpiryTransition({ status: 'past_due', graceEndsAt: addDays(NOW, -1) }, NOW)?.to,
    'expired',
  );
});

test('re-running over an already-transitioned doc is a no-op', () => {
  // The acceptance criterion: running the sweep twice in one day changes
  // nothing the second time.
  assertEqual(
    computeExpiryTransition({ status: 'past_due', graceEndsAt: addDays(NOW, GRACE_PERIOD_DAYS) }, NOW),
    null,
    'fresh grace',
  );
  for (const status of ['expired', 'cancelled', 'superseded', 'pending_payment']) {
    assertEqual(computeExpiryTransition({ status }, NOW), null, status);
  }
});

test('a past_due doc with no grace deadline is repaired, not expired', () => {
  const orphan = { status: 'past_due' };
  assertEqual(needsGraceRepair(orphan), true, 'needs repair');
  assertEqual(computeExpiryTransition(orphan, NOW), null, 'not expired');
  assertEqual(needsGraceRepair({ status: 'past_due', graceEndsAt: NOW }), false, 'already set');
});

test('a trial is bounded by trialEndsAt even when it carries a period end', () => {
  const sub = { status: 'trialing', trialEndsAt: addDays(NOW, -1), currentPeriodEnd: addDays(NOW, 30) };
  assertEqual(entitlementEndsAt(sub), addDays(NOW, -1).getTime());
  assertEqual(computeExpiryTransition(sub, NOW)?.to, 'past_due');
});

test('isStripeManaged keys on the subscription id, not the payment method', () => {
  assertEqual(isStripeManaged({ paymentMethod: 'stripe' }), false, 'method alone');
  assertEqual(isStripeManaged({ stripeSubscriptionId: 'sub_1' }), true, 'id present');
});

console.log('\nrenewal email sequence\n');

test('daysUntil rounds up and floors at zero', () => {
  assertEqual(daysUntil(addDays(NOW, 2), NOW), 2, 'two days');
  assertEqual(daysUntil(new Date(NOW.getTime() + 1000), NOW), 1, 'partial day rounds up');
  assertEqual(daysUntil(addDays(NOW, -5), NOW), 0, 'past floors at 0');
  assertEqual(daysUntil(null, NOW), null, 'missing');
});

test('the heads-up email fires inside the last week and only once', () => {
  const soon = { status: 'active', currentPeriodEnd: addDays(NOW, 5) };
  assertEqual(dueRenewalEmail(soon, NOW), 'expiringSoon');
  assertEqual(dueRenewalEmail({ ...soon, renewalEmailsSent: { expiringSoon: NOW } }, NOW), null, 'sent');
  assertEqual(
    dueRenewalEmail({ status: 'active', currentPeriodEnd: addDays(NOW, 20) }, NOW),
    null,
    'far off',
  );
});

test('grace emails escalate and never repeat', () => {
  assertEqual(
    dueRenewalEmail({ status: 'past_due', graceEndsAt: addDays(NOW, 15), renewalEmailsSent: {} }, NOW),
    'graceStarted',
  );
  assertEqual(
    dueRenewalEmail(
      { status: 'past_due', graceEndsAt: addDays(NOW, 7), renewalEmailsSent: { graceStarted: NOW } },
      NOW,
    ),
    'graceMidpoint',
  );
  const final = {
    status: 'past_due',
    graceEndsAt: addDays(NOW, 2),
    renewalEmailsSent: { graceStarted: NOW, graceMidpoint: NOW },
  };
  assertEqual(dueRenewalEmail(final, NOW), 'graceFinal');
  assertEqual(
    dueRenewalEmail({ ...final, renewalEmailsSent: { ...final.renewalEmailsSent, graceFinal: NOW } }, NOW),
    null,
    'all sent',
  );
});

test('a tenant who lapsed while the job was down gets the urgent mail, not a backlog', () => {
  // One day of grace left, nothing sent yet: the final warning is the honest
  // message, and "you have 15 days" here would be a lie.
  assertEqual(
    dueRenewalEmail({ status: 'past_due', graceEndsAt: addDays(NOW, 1), renewalEmailsSent: {} }, NOW),
    'graceFinal',
  );
});

test('the deactivation email is sent once, after expiry', () => {
  assertEqual(dueRenewalEmail({ status: 'expired' }, NOW), 'deactivated');
  assertEqual(
    dueRenewalEmail({ status: 'expired', renewalEmailsSent: { deactivated: NOW } }, NOW),
    null,
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
