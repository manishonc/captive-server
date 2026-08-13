/**
 * Tests for routes/publicPricing.ts — the world-readable pricing feed.
 *
 * Run: npx tsx tests/publicPricing.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials: the serializers are pure, which is precisely
 * why the allowlist lives in them rather than inline in the handler.
 *
 * WHY THIS FILE EXISTS
 *
 * The same allowlist exists in the CMS (app/api/captive-public/plans/route.js).
 * Two copies of a security boundary in two repos is a drift risk that was
 * accepted deliberately, so this file converts the failure mode from "internal
 * pricing fields silently leak to the public internet" into "a test goes red".
 *
 * The load-bearing assertion is `emits exactly the allowlisted keys`: it pins
 * the key SET, so a plan document gaining a field cannot widen the response.
 * A serializer that spread `...data` would pass every other test here and fail
 * that one. Do not relax it into a subset check.
 *
 * What must never appear: includedCredits, includedCreditsPerMonth, flags,
 * quotas, maxVenues, maxAccessPointsPerVenue, creditRollover, stripeProductId,
 * stripePriceId, createdBy, status, marketing.publicVisible.
 */

import {
  serializePublicPlan,
  serializePublicPrice,
  trialRequiresCardFrom,
} from '../src/services/publicPricing';

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

/** A plan doc carrying every internal field we must never publish. */
const FULL_PLAN_DOC = {
  name: 'Growth',
  description: 'Adds the internal AI agent chat.',
  status: 'active',
  isFreeTrial: false,
  freeTrialDays: null,
  maxVenues: 1,
  maxAccessPointsPerVenue: 10,
  quotas: { emailsPerMonth: null, smsPerMonth: null, whatsappPerMonth: null },
  flags: {
    aiEnabled: true,
    mcpEnabled: true,
    analyticsEnabled: true,
    customBrandingEnabled: true,
    hidePoweredBy: false,
  },
  includedCredits: { email: 1000, sms: 750, whatsapp: 600, shared: 0 },
  includedCreditsPerMonth: 2350,
  creditRollover: false,
  stripeProductId: 'prod_secret',
  createdBy: 'admin-uid',
  marketing: {
    publicVisible: true,
    displayOrder: 1,
    tagline: 'Per venue',
    badge: 'Recommended',
    highlight: true,
    ctaLabel: 'Get Started',
    features: ['1 venue, 10 access points', 'Internal AI agent chat'],
  },
};

console.log('\npublic pricing allowlist\n');

test('emits exactly the allowlisted keys — nothing more', () => {
  const out = serializePublicPlan(FULL_PLAN_DOC, []);
  assertEqual(
    Object.keys(out).sort(),
    ['description', 'freeTrialDays', 'marketing', 'name', 'prices'],
    'plan keys',
  );
  assertEqual(
    Object.keys(out.marketing).sort(),
    ['badge', 'ctaLabel', 'displayOrder', 'features', 'highlight', 'tagline'],
    'marketing keys',
  );
});

test('no internal field survives, however the doc is shaped', () => {
  const serialized = JSON.stringify(serializePublicPlan(FULL_PLAN_DOC, []));
  for (const leak of [
    'includedCredits',
    'includedCreditsPerMonth',
    'creditRollover',
    'flags',
    'quotas',
    'maxVenues',
    'maxAccessPointsPerVenue',
    'stripeProductId',
    'createdBy',
    'publicVisible',
    'aiEnabled',
    'prod_secret',
    'admin-uid',
  ]) {
    assert(!serialized.includes(leak), `"${leak}" reached the public payload`);
  }
});

test('price serializer drops stripePriceId and status', () => {
  const out = serializePublicPrice({
    label: 'Monthly',
    amount: 25,
    currency: 'CHF',
    interval: 'monthly',
    status: 'active',
    stripePriceId: 'price_secret',
  });
  assertEqual(Object.keys(out).sort(), ['amount', 'currency', 'interval', 'label'], 'price keys');
  assert(!JSON.stringify(out).includes('price_secret'), 'stripePriceId leaked');
});

console.log('\nshape and defaults\n');

test('values round-trip', () => {
  const out = serializePublicPlan(FULL_PLAN_DOC, [
    serializePublicPrice({ label: 'Monthly', amount: 25, currency: 'CHF', interval: 'monthly' }),
  ]);
  assertEqual(out.name, 'Growth', 'name');
  assertEqual(out.marketing.badge, 'Recommended', 'badge');
  assertEqual(out.marketing.highlight, true, 'highlight');
  assertEqual(out.prices[0].amount, 25, 'amount');
  assertEqual(out.prices[0].currency, 'CHF', 'currency');
});

test('a bare plan doc still produces a well-formed payload', () => {
  // Missing marketing must not throw or emit undefined into JSON — the site
  // renders this directly.
  const out = serializePublicPlan({ name: 'Bare' }, []);
  assertEqual(out.marketing.features, [], 'features');
  assertEqual(out.marketing.tagline, '', 'tagline');
  assertEqual(out.marketing.highlight, false, 'highlight');
  assertEqual(out.freeTrialDays, null, 'freeTrialDays');
});

test('non-string bullets are dropped rather than rendered', () => {
  const out = serializePublicPlan(
    { name: 'X', marketing: { features: ['keep', '', '  trim  ', 42, null, { a: 1 }] } },
    [],
  );
  assertEqual(out.marketing.features, ['keep', 'trim'], 'features');
});

test('currency defaults to CHF, the house currency', () => {
  assertEqual(serializePublicPrice({ label: 'M', amount: 5 }).currency, 'CHF', 'currency');
});

test('trialRequiresCard is true only on an explicit boolean true', () => {
  assertEqual(trialRequiresCardFrom({ requireCardForTrial: true }), true, 'explicit true');
  assertEqual(trialRequiresCardFrom({ requireCardForTrial: false }), false, 'explicit false');
});

test('trialRequiresCard fails safe to false', () => {
  // A missing settings doc, an unset flag, or a truthy-but-not-true value must
  // all read as "no card required". Wrongly telling the marketing site a card
  // is NOT needed loses signups; wrongly telling it one IS needed when the
  // product does not collect one produces customers who were charged after
  // being told they would not be.
  assertEqual(trialRequiresCardFrom(undefined), false, 'missing doc');
  assertEqual(trialRequiresCardFrom({}), false, 'unset flag');
  assertEqual(trialRequiresCardFrom({ requireCardForTrial: 'yes' }), false, 'truthy string');
  assertEqual(trialRequiresCardFrom({ requireCardForTrial: 1 }), false, 'truthy number');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
