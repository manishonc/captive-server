/**
 * Tests for services/creditBuckets.ts — the send-side half of per-channel credits.
 *
 * Run: npx tsx tests/creditBuckets.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials. Credits are earmarked per channel, so a
 * campaign can be blocked on SMS while the account holds plenty of email
 * credits. That is only defensible if the arithmetic is exact:
 *
 *  - **The allocator must not strand a feasible campaign.** A campaign fans out
 *    across channels that contend for one shared pool, and a naive proportional
 *    split fails claims that a smarter order would have covered. The
 *    deficit-priority counter-example below is the whole reason L2 is ordered
 *    rather than proportional.
 *  - **Every number stays an integer.** channelBalances is compared with `===`
 *    by the CMS reconcile script, so one fractional credit from a proportional
 *    split is a permanent red that healing cannot repair.
 *  - **Settle caps.** A run may only draw what its own reservation set aside,
 *    or one campaign's settle could eat shared credits another campaign is
 *    holding — a cross-campaign safety violation, not just a policy one.
 *  - **The heal rule keeps legacy reservations releasable.** A scalar
 *    reservation taken before this feature must land in `shared` and come back
 *    out of `shared`, or credits strand permanently on a redeploy.
 */

import {
  CREDIT_CHANNELS,
  allocateReservation,
  allocationFromDeltas,
  applyReservation,
  availableOf,
  availableTotal,
  deriveTotals,
  drainAllowingNegative,
  drainForChannel,
  emptyChannelBalances,
  normalizeChannelBalances,
  releaseFromKey,
  spendableForChannel,
  sumDeltas,
  type ChannelBalances,
  type ChannelDeltas,
  type CreditChannel,
} from '../src/services/creditBuckets';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Build a balances map from a terse spec: { sms: [sub, pur, reserved] }. */
function balances(spec: Record<string, [number, number, number?]>): ChannelBalances {
  const out = emptyChannelBalances();
  for (const [key, [subscription, purchased, reserved]] of Object.entries(spec)) {
    out[key] = { subscription, purchased, reserved: reserved ?? 0 };
  }
  return out;
}

/** The invariant that turns a bug into silently wrong money. */
function assertScalarsMatchMap(b: ChannelBalances, label: string) {
  const wallet = deriveTotals({ channelBalances: b });
  let subscription = 0;
  let purchased = 0;
  let reserved = 0;
  for (const key of Object.keys(b)) {
    subscription += b[key].subscription;
    purchased += b[key].purchased;
    reserved += b[key].reserved;
  }
  assertEqual(wallet.subscriptionBalance, subscription, `${label}: subscriptionBalance`);
  assertEqual(wallet.purchasedBalance, purchased, `${label}: purchasedBalance`);
  assertEqual(wallet.reserved, reserved, `${label}: reserved`);
  assertEqual(wallet.balance, subscription + purchased, `${label}: balance`);
}

function assertAllInteger(b: ChannelBalances, label: string) {
  for (const key of Object.keys(b)) {
    for (const bucket of ['subscription', 'purchased', 'reserved'] as const) {
      assert(
        Number.isInteger(b[key][bucket]),
        `${label}: ${key}.${bucket} is not an integer (${b[key][bucket]})`,
      );
    }
  }
}

console.log('\nnormalizeChannelBalances — the heal rule');

test('an un-migrated wallet puts everything in shared', () => {
  const { balances: b, seeded } = normalizeChannelBalances(null, {
    subscriptionBalance: 300,
    purchasedBalance: 700,
    reserved: 50,
  });
  assertEqual(seeded, false, 'seeded');
  assertEqual(b.shared, { subscription: 300, purchased: 700, reserved: 50 });
  assertScalarsMatchMap(b, 'un-migrated');
});

test('a legacy scalar reservation is retro-attributed to shared and releases cleanly', () => {
  // This is what stops a pre-per-channel reservation stranding credits when a
  // redeploy lands mid-dispatch.
  const { balances: b } = normalizeChannelBalances(
    { sms: { subscription: 0, purchased: 400, reserved: 0 } },
    { subscriptionBalance: 0, purchasedBalance: 400, reserved: 120 },
  );
  assertEqual(b.shared.reserved, 120, 'orphan hold parked in shared');

  const deltas: ChannelDeltas = {};
  const released = releaseFromKey(b, 'shared', 120, deltas);
  assertEqual(released, 120, 'released');
  assertEqual(b.shared.reserved, 0, 'nothing stranded');
  assertEqual(sumDeltas(deltas).reserved, -120, 'delta balances');
  assertScalarsMatchMap(b, 'legacy release');
});

test('an unknown channel key is preserved, not duplicated into shared', () => {
  const { balances: b, drift } = normalizeChannelBalances(
    {
      telegram: { subscription: 0, purchased: 250, reserved: 0 },
      shared: { subscription: 0, purchased: 100, reserved: 0 },
    },
    { subscriptionBalance: 0, purchasedBalance: 350, reserved: 0 },
  );
  assertEqual(drift.purchased, 0, 'no phantom drift');
  assertEqual(b.telegram?.purchased, 250, 'unknown key round-trips');
});

console.log('\ndrainForChannel — waterfall and caps');

test('the four-level order: c.sub → shared.sub → c.pur → shared.pur', () => {
  const b = balances({ sms: [10, 20], shared: [30, 40] });
  const deltas: ChannelDeltas = {};
  assertEqual(drainForChannel(b, 'sms', 100, deltas), 0, 'exactly covered');
  assertEqual(b.sms, { subscription: 0, purchased: 0, reserved: 0 });
  assertEqual(b.shared, { subscription: 0, purchased: 0, reserved: 0 });
  assertEqual(sumDeltas(deltas).credits, -100, 'delta balances');
});

test('a starved channel cannot reach another channel’s credits', () => {
  const b = balances({ email: [0, 100000], sms: [0, 0], shared: [0, 0] });
  const deltas: ChannelDeltas = {};
  assertEqual(drainForChannel(b, 'sms', 500, deltas), 500, 'fully short');
  assertEqual(b.email.purchased, 100000, 'email untouched');
});

test('caps stop a settle from eating another campaign’s shared reservation', () => {
  // shared holds 1000, but this run only reserved 100 of it. Without the cap
  // the settle would consume credits a concurrent campaign is holding.
  const b = balances({ sms: [0, 0], shared: [0, 1000] });
  const deltas: ChannelDeltas = {};
  const short = drainForChannel(b, 'sms', 500, deltas, { own: 0, shared: 100 });
  assertEqual(short, 400, 'only the capped amount was drawn');
  assertEqual(b.shared.purchased, 900, 'the rest is left for its owner');
});

test('drainAllowingNegative charges the residual rather than silently not billing', () => {
  const b = balances({ sms: [0, 30], shared: [0, 0] });
  const deltas: ChannelDeltas = {};
  drainAllowingNegative(b, 'sms', 100, deltas);
  assertEqual(b.shared.purchased, -70, 'residual goes negative on shared');
  assertEqual(sumDeltas(deltas).credits, -100, 'delta still balances');
  assertScalarsMatchMap(b, 'negative drain');
});

console.log('\nallocateReservation — multi-channel contention');

test('a single-channel campaign takes its own credits first', () => {
  const b = balances({ sms: [0, 500], shared: [0, 500] });
  const result = allocateReservation(b, { sms: 300 });
  assert(result.ok, 'should allocate');
  if (!result.ok) return;
  assertEqual(result.allocation.sms, { own: 300, shared: 0 });
  assertEqual(result.total, 300);
});

test('expiring credits are taken before permanent ones across the whole run', () => {
  // shared.subscription must drain before either channel's own purchased —
  // otherwise the tenant loses it at renewal with paid credits sitting unused.
  const b = balances({ email: [0, 1000], sms: [0, 1000], shared: [100, 1000] });
  const result = allocateReservation(b, { email: 50, sms: 50 });
  assert(result.ok, 'should allocate');
  if (!result.ok) return;
  const sharedUsed = result.allocation.email.shared + result.allocation.sms.shared;
  assertEqual(sharedUsed, 100, 'the whole expiring pool was consumed first');
});

test('DEFICIT PRIORITY: the shared pool goes to the channel that cannot self-fund', () => {
  // The counter-example that justifies ordering L2 instead of splitting it
  // proportionally. email can pay its own way from purchased; sms cannot.
  // Proportional would give email 3 of the 5 shared and strand sms 3 short.
  const b = balances({
    email: [0, 10],
    sms: [0, 0],
    shared: [5, 0],
  });
  const result = allocateReservation(b, { email: 10, sms: 5 });
  assert(result.ok, 'deficit priority must make this feasible');
  if (!result.ok) return;
  assertEqual(result.allocation.sms, { own: 0, shared: 5 }, 'sms got the whole shared pool');
  assertEqual(result.allocation.email, { own: 10, shared: 0 }, 'email self-funded');
  assertEqual(result.total, 15);
});

test('a genuine shortfall reserves nothing and names every short channel', () => {
  // All-or-nothing at claim time, matching the pre-existing semantics.
  const b = balances({ email: [0, 0], sms: [0, 0], shared: [0, 4000] });
  const result = allocateReservation(b, { sms: 3000, email: 2000 });
  assert(!result.ok, 'should not allocate');
  if (result.ok) return;
  const totalShort = CREDIT_CHANNELS.reduce((sum, c) => sum + result.remaining[c], 0);
  assertEqual(totalShort, 1000, 'exactly the deficit');
  assertEqual(b.shared.purchased, 4000, 'nothing was consumed on a failed allocation');
});

test('a contended split stays integer-closed', () => {
  // 7 credits across three channels each wanting 100 — the largest-remainder
  // split must not produce 2.333.
  const b = balances({ shared: [0, 7] });
  const result = allocateReservation(b, { email: 100, sms: 100, whatsapp: 100 });
  assert(!result.ok, 'not enough to cover');
  if (result.ok) return;
  for (const c of CREDIT_CHANNELS) {
    assert(Number.isInteger(result.remaining[c]), `${c} remainder is fractional`);
  }
});

test('applying an allocation is integer-closed and balances its deltas', () => {
  const b = balances({ email: [0, 1000], sms: [0, 500], shared: [200, 300] });
  const result = allocateReservation(b, { email: 700, sms: 600 });
  assert(result.ok, 'should allocate');
  if (!result.ok) return;
  const deltas: ChannelDeltas = {};
  const total = applyReservation(b, result.allocation, deltas);
  assertEqual(total, 1300, 'held total');
  assertEqual(sumDeltas(deltas).reserved, 1300, 'Σ deltas.reserved === reservedDelta');
  assertEqual(sumDeltas(deltas).credits, 0, 'a reservation moves no credits');
  assertAllInteger(b, 'after applyReservation');
  assertScalarsMatchMap(b, 'after applyReservation');
});

test('a reservation makes its credits unspendable by anyone else', () => {
  const b = balances({ sms: [0, 500], shared: [0, 500] });
  const result = allocateReservation(b, { sms: 800 });
  assert(result.ok, 'should allocate');
  if (!result.ok) return;
  applyReservation(b, result.allocation, {});
  assertEqual(spendableForChannel(b, 'sms'), 200, 'sms sees only what is left');
  assertEqual(spendableForChannel(b, 'email'), 200, 'email sees only the free shared remainder');
});

console.log('\nallocationFromDeltas — the retried-claim path');

test('a retried claim rebuilds its split instead of re-allocating', () => {
  // reserveInTransaction's already-reserved branch cannot re-allocate: the
  // wallet has already moved, so it would compute a different answer.
  const b = balances({ email: [0, 1000], sms: [0, 100], shared: [0, 1000] });
  const need = { email: 300, sms: 400 };
  const result = allocateReservation(b, need);
  assert(result.ok, 'should allocate');
  if (!result.ok) return;
  const deltas: ChannelDeltas = {};
  const total = applyReservation(b, result.allocation, deltas);

  const rebuilt = allocationFromDeltas(deltas, need);
  assertEqual(rebuilt.total, total, 'total round-trips');
  for (const c of CREDIT_CHANNELS) {
    const original = result.allocation[c].own + result.allocation[c].shared;
    const recovered = rebuilt.allocation[c].own + rebuilt.allocation[c].shared;
    assertEqual(recovered, original, `${c} split round-trips`);
  }
});

console.log('\nend-to-end: reserve → partial use → settle');

test('settle debits what was used and releases the rest, per channel', () => {
  const b = balances({ email: [0, 1000], sms: [0, 1000], shared: [500, 0] });
  const need = { email: 400, sms: 600 };

  const alloc = allocateReservation(b, need);
  assert(alloc.ok, 'should allocate');
  if (!alloc.ok) return;
  const reserveDeltas: ChannelDeltas = {};
  const held = applyReservation(b, alloc.allocation, reserveDeltas);
  assertEqual(held, 1000, 'held the full estimate');

  // Only half the emails actually sent; SMS all sent.
  const usedPerChannel: Record<CreditChannel, number> = { email: 200, sms: 600, whatsapp: 0 };
  const debitDeltas: ChannelDeltas = {};
  for (const c of CREDIT_CHANNELS) {
    if (!usedPerChannel[c]) continue;
    drainAllowingNegative(b, c, usedPerChannel[c], debitDeltas, { ...alloc.allocation[c] });
  }

  const releaseDeltas: ChannelDeltas = {};
  let released = 0;
  for (const c of CREDIT_CHANNELS) {
    released += releaseFromKey(b, c, alloc.allocation[c].own, releaseDeltas);
    released += releaseFromKey(b, 'shared', alloc.allocation[c].shared, releaseDeltas);
  }

  assertEqual(released, 1000, 'the whole hold came back');
  assertEqual(b.email.reserved + b.sms.reserved + b.shared.reserved, 0, 'nothing left held');
  assertEqual(sumDeltas(debitDeltas).credits, -800, 'debited exactly what was used');
  assertEqual(sumDeltas(releaseDeltas).reserved, -1000, 'released exactly what was held');
  assertAllInteger(b, 'after settle');
  assertScalarsMatchMap(b, 'after settle');

  // Ledger reconciles: the run cost 800 out of a 2500 starting balance.
  const wallet = deriveTotals({ channelBalances: b });
  assertEqual(wallet.balance, 2500 - 800, 'balance after the run');
  assertEqual(wallet.reserved, 0, 'no leaked reservation');
});

test('an exhausted channel holds while the others keep sending', () => {
  // The behaviour hard lock exists for, and the reason the warning copy has to
  // name the channel.
  const b = balances({ email: [0, 10000], sms: [0, 0], shared: [0, 0] });
  const result = allocateReservation(b, { email: 1000, sms: 500 });
  assert(!result.ok, 'the claim fails as a whole');
  if (result.ok) return;
  assertEqual(result.remaining.sms, 500, 'sms is the blocker');
  assertEqual(result.remaining.email, 0, 'email was coverable');
  // A tenant seeing "not enough credits" here with 10,000 email credits would
  // reasonably file a bug — hence sharedContended + the per-channel copy.
  assertEqual(availableTotal(b.email), 10000, 'the credits really are there');
});

console.log('\navailableOf');

test('reserved is charged against subscription credits first', () => {
  assertEqual(availableOf({ subscription: 100, purchased: 200, reserved: 150 }), {
    subscription: 0,
    purchased: 150,
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
