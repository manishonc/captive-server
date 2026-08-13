/**
 * Tests for services/subscriptionState.ts — the lapse semantics behind the
 * billing gates, most critically the campaign scheduler's dispatch-time gate
 * (a lapsed tenant's scheduled broadcast must NOT go out at the business's
 * provider cost).
 *
 * Run: npx tsx tests/subscriptionState.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials: the classification is pure, which is exactly
 * why it lives in its own module rather than inline in entitlements.ts.
 *
 * THE LOAD-BEARING SEMANTIC
 *
 * `payment_failed` (Stripe dunning) is RETAINED ACCESS — a card being retried,
 * not a tenant who left. Only genuinely dead doc sets classify as 'lapsed':
 * nothing but cancelled/expired/superseded docs, or a trial whose
 * `trialEndsAt` has passed. 'none' (no history at all) is NOT lapsed — that is
 * every pre-billing tenant. This must match the CMS's classification in
 * _lib/entitlements.js: the two repos gate the same sends.
 *
 * The surrounding gate conditions (requireCardForTrial kill-switch,
 * `trialActivatedAt` grandfathering, fail-open on lookup errors) live in
 * entitlements.ts `isLapsedForSending` and need Firestore; they are exercised
 * against real data, not here.
 */

import {
  classifySubscriptionState,
  isLapsedTrial,
  type SubscriptionState,
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

const NOW = new Date('2026-09-01T00:00:00Z');
const PAST = '2026-08-20T00:00:00Z';
const FUTURE = '2026-09-15T00:00:00Z';

type Raw = Record<string, unknown>;

/**
 * Mirror of getEntitlements' entitling-doc selection: newest non-expired
 * active/trialing doc. Order does not matter for these single-candidate
 * fixtures; what matters is that the classifier sees exactly what the caller
 * would hand it.
 */
function classify(allSubs: Raw[], now = NOW): SubscriptionState {
  const entitling =
    allSubs
      .filter((s) => ['active', 'trialing'].includes(s.status as string))
      .filter((s) => !isLapsedTrial(s, now))[0] ?? null;
  return classifySubscriptionState(entitling, allSubs);
}

console.log('\nretained access\n');

test('an active subscription is active', () => {
  assertEqual(classify([{ status: 'active' }]), 'active');
});

test('an unexpired trial is trialing', () => {
  assertEqual(classify([{ status: 'trialing', trialEndsAt: FUTURE }]), 'trialing');
});

test('no history at all is none — the pre-billing tenant, never gated', () => {
  assertEqual(classify([]), 'none');
});

test('payment_failed alone is dunning, NOT lapsed — the card is being retried', () => {
  assertEqual(classify([{ status: 'payment_failed' }]), 'payment_failed');
});

test('payment_failed next to dead history still retains access', () => {
  // Upgrade left a superseded doc, an old plan was cancelled, and the current
  // subscription bounced a charge: the tenant is mid-dunning, not gone.
  assertEqual(
    classify([{ status: 'superseded' }, { status: 'cancelled' }, { status: 'payment_failed' }]),
    'payment_failed',
  );
});

test('an active doc wins over payment_failed history', () => {
  assertEqual(classify([{ status: 'payment_failed' }, { status: 'active' }]), 'active');
});

console.log('\ngenuinely dead states\n');

test('cancelled-only history is lapsed', () => {
  assertEqual(classify([{ status: 'cancelled' }]), 'lapsed');
});

test('expired-only history is lapsed', () => {
  assertEqual(classify([{ status: 'expired' }]), 'lapsed');
});

test('superseded-only history is lapsed', () => {
  assertEqual(classify([{ status: 'superseded' }]), 'lapsed');
});

test('a trial whose trialEndsAt has passed is lapsed, not trialing', () => {
  assertEqual(classify([{ status: 'trialing', trialEndsAt: PAST }]), 'lapsed');
});

test('an unrecognized status is lapsed — matching the CMS filter, not a free pass', () => {
  assertEqual(classify([{ status: 'incomplete' }]), 'lapsed');
});

console.log('\ntrial expiry edge cases\n');

test('a trial with no trialEndsAt stays entitling — a data problem is not a cutoff', () => {
  assertEqual(classify([{ status: 'trialing' }]), 'trialing');
});

test('a trial with an unparseable trialEndsAt stays entitling', () => {
  assertEqual(classify([{ status: 'trialing', trialEndsAt: 'not-a-date' }]), 'trialing');
});

test('isLapsedTrial ignores non-trialing docs entirely', () => {
  assertEqual(isLapsedTrial({ status: 'active', trialEndsAt: PAST }, NOW), false);
});

test('isLapsedTrial flips exactly at trialEndsAt', () => {
  assertEqual(isLapsedTrial({ status: 'trialing', trialEndsAt: PAST }, NOW), true, 'past');
  assertEqual(isLapsedTrial({ status: 'trialing', trialEndsAt: FUTURE }, NOW), false, 'future');
  assertEqual(
    isLapsedTrial({ status: 'trialing', trialEndsAt: NOW.toISOString() }, NOW),
    true,
    'boundary counts as expired',
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
