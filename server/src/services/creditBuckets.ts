/**
 * Per-channel credit bucket arithmetic — the send-side mirror of
 * cms/app/api/captive-portal/_lib/credit-buckets.js.
 *
 * Pure functions, no Firestore. The two files are a contract and MUST agree on:
 *
 *  - the key set (`email`, `sms`, `whatsapp`, `shared`)
 *  - CREDIT_CHANNELS *order* — it is the deterministic tie-break when a
 *    contended `shared` pool is split between channels, so a disagreement makes
 *    the two repos compute different splits from the same wallet
 *  - the consumption waterfall
 *  - the heal rule (top-level scalars are the authority; drift → `shared`)
 *
 * THE WATERFALL, for a send on channel c:
 *
 *   1. channelBalances[c].subscription
 *   2. channelBalances.shared.subscription
 *   3. channelBalances[c].purchased
 *   4. channelBalances.shared.purchased
 *
 * Expiring credits drain before permanent ones; within each, the channel's own
 * earmark drains before the shared pool. This preserves the original top-level
 * rule exactly — subscriptionBalance empties before purchasedBalance.
 *
 * `shared` holds everything channel-less by nature: plan grants, admin
 * adjustments, and any balance predating per-channel buckets. Every tenant
 * therefore has a working floor even with nothing earmarked.
 */

export type CreditChannel = 'email' | 'sms' | 'whatsapp';
export type WalletChannelKey = CreditChannel | 'shared';

/** Canonical order — part of the cross-repo contract, not just the members. */
export const CREDIT_CHANNELS: CreditChannel[] = ['email', 'sms', 'whatsapp'];
export const SHARED_KEY: WalletChannelKey = 'shared';
export const WALLET_CHANNEL_KEYS: WalletChannelKey[] = [...CREDIT_CHANNELS, SHARED_KEY];

export interface ChannelBuckets {
  subscription: number;
  purchased: number;
  reserved: number;
}

export type ChannelBalances = Record<string, ChannelBuckets>;
/** Signed per-bucket movements; same sign convention as credits/reservedDelta. */
export type ChannelDeltas = Record<string, ChannelBuckets>;

export function emptyBuckets(): ChannelBuckets {
  return { subscription: 0, purchased: 0, reserved: 0 };
}

export function emptyChannelBalances(): ChannelBalances {
  const out: ChannelBalances = {};
  for (const key of WALLET_CHANNEL_KEYS) out[key] = emptyBuckets();
  return out;
}

/** A channel name is only ever email/sms/whatsapp; anything else is shared. */
export function channelKey(channel: string | null | undefined): WalletChannelKey {
  return CREDIT_CHANNELS.includes(channel as CreditChannel) ? (channel as CreditChannel) : SHARED_KEY;
}

/**
 * Read `channelBalances` off a wallet doc, healing it against the top-level
 * scalars — which are the authority.
 *
 * Whatever the scalars hold that the map does not is parked in `shared`. That
 * single rule covers every legitimate skew with no special-casing:
 *
 *  - an un-migrated wallet → everything in `shared`, exactly where the CMS
 *    backfill would put it, so a per-channel ledger replay agrees with no extra
 *    entries;
 *  - a LEGACY SCALAR RESERVATION taken before per-channel reservations existed
 *    → the orphan top-level `reserved` is retro-attributed to `shared.reserved`,
 *    so the later release from `shared` is arithmetically exact and nothing
 *    strands;
 *  - the CMS one deploy behind on a grant → lands in `shared`, which is where
 *    channel-less grants belong anyway.
 *
 * `seeded` lets the caller tell a legitimate legacy wallet from a genuine bug:
 * healing an ALREADY seeded wallet means something wrote the scalars without
 * writing the map. Heal regardless so sends keep working, and log it — the CMS
 * reconcile script deliberately does not heal and is the detector.
 *
 * Sums over every key present, not just the known ones, so a channel added by a
 * newer deploy is never counted as "missing" and duplicated into `shared`.
 */
export function normalizeChannelBalances(
  raw: unknown,
  top: { subscriptionBalance: number; purchasedBalance: number; reserved: number },
): { balances: ChannelBalances; drift: ChannelBuckets; seeded: boolean } {
  const seeded = !!raw && typeof raw === 'object';
  const source = (seeded ? raw : {}) as Record<string, Partial<ChannelBuckets>>;

  const balances = emptyChannelBalances();
  for (const key of WALLET_CHANNEL_KEYS) {
    const bucket = source[key] || {};
    balances[key] = {
      subscription: Number(bucket.subscription) || 0,
      purchased: Number(bucket.purchased) || 0,
      reserved: Number(bucket.reserved) || 0,
    };
  }

  let subscription = 0;
  let purchased = 0;
  let reserved = 0;
  for (const key of Object.keys(source)) {
    const bucket = source[key] || {};
    subscription += Number(bucket.subscription) || 0;
    purchased += Number(bucket.purchased) || 0;
    reserved += Number(bucket.reserved) || 0;
    if (!balances[key]) {
      // Unknown key from a newer deploy — keep it so the write below round-trips
      // it instead of silently dropping the credits it holds.
      balances[key] = {
        subscription: Number(bucket.subscription) || 0,
        purchased: Number(bucket.purchased) || 0,
        reserved: Number(bucket.reserved) || 0,
      };
    }
  }

  const drift: ChannelBuckets = {
    subscription: top.subscriptionBalance - subscription,
    purchased: top.purchasedBalance - purchased,
    reserved: top.reserved - reserved,
  };
  balances[SHARED_KEY].subscription += drift.subscription;
  balances[SHARED_KEY].purchased += drift.purchased;
  balances[SHARED_KEY].reserved += drift.reserved;

  return { balances, drift, seeded };
}

/**
 * What one bucket key can still spend, split by sub-bucket. The key's
 * `reserved` is charged against its subscription credits first — the same order
 * settle consumes them in — so this split is exact, not an approximation.
 */
export function availableOf(bucket: ChannelBuckets): { subscription: number; purchased: number } {
  const subscription = Math.max(0, bucket.subscription - Math.min(bucket.reserved, bucket.subscription));
  const purchased = Math.max(0, bucket.purchased - Math.max(0, bucket.reserved - bucket.subscription));
  return { subscription, purchased };
}

export function availableTotal(bucket: ChannelBuckets): number {
  const { subscription, purchased } = availableOf(bucket);
  return subscription + purchased;
}

/**
 * What channel `c` can spend right now: its own earmark plus the shared pool.
 * NOT summable across channels — `shared` is one pool counted once per channel.
 */
export function spendableForChannel(balances: ChannelBalances, channel: string | null): number {
  const own = channelKey(channel);
  const ownAvailable = availableTotal(balances[own]);
  return own === SHARED_KEY ? ownAvailable : ownAvailable + availableTotal(balances[SHARED_KEY]);
}

export function bumpDelta(
  deltas: ChannelDeltas,
  key: string,
  bucket: keyof ChannelBuckets,
  amount: number,
): void {
  if (!amount) return;
  if (!deltas[key]) deltas[key] = emptyBuckets();
  deltas[key][bucket] += amount;
}

/**
 * Drain `credits` for `channel` through the waterfall, optionally capped per
 * source. Returns the shortfall (0 when fully covered).
 *
 * `caps` is what stops a settle from consuming `shared` credits that a
 * CONCURRENT campaign reserved: each run may only draw the amount its own
 * reservation set aside. Without it, hard lock would only be an intra-campaign
 * guarantee.
 */
export function drainForChannel(
  balances: ChannelBalances,
  channel: string | null,
  credits: number,
  deltas: ChannelDeltas,
  caps?: { own: number; shared: number },
): number {
  const own = channelKey(channel);
  let remaining = credits;
  let ownCap = caps ? caps.own : Infinity;
  let sharedCap = caps ? caps.shared : Infinity;

  const take = (key: WalletChannelKey, bucket: keyof ChannelBuckets) => {
    const cap = key === SHARED_KEY ? sharedCap : ownCap;
    const amount = Math.min(remaining, balances[key][bucket], cap);
    if (amount <= 0) return;
    balances[key][bucket] -= amount;
    remaining -= amount;
    if (key === SHARED_KEY) sharedCap -= amount;
    else ownCap -= amount;
    bumpDelta(deltas, key, bucket, -amount);
  };

  take(own, 'subscription');
  take(SHARED_KEY, 'subscription');
  take(own, 'purchased');
  take(SHARED_KEY, 'purchased');

  return remaining;
}

/**
 * Drain that may go negative — the documented bounded overspend for automations
 * (spec §5.3.6) and for a settle whose buckets moved between reserve and settle
 * (a non-rollover renewal, an admin adjustment, a Stripe clawback). The credits
 * WERE spent, so charge them; residual lands on `shared.purchased`, the same
 * place the original scalar implementation let the balance go negative.
 */
export function drainAllowingNegative(
  balances: ChannelBalances,
  channel: string | null,
  credits: number,
  deltas: ChannelDeltas,
  caps?: { own: number; shared: number },
): void {
  const remaining = drainForChannel(balances, channel, credits, deltas, caps);
  if (remaining > 0) {
    balances[SHARED_KEY].purchased -= remaining;
    bumpDelta(deltas, SHARED_KEY, 'purchased', -remaining);
  }
}

/** Release a hold on one key, clamped so `reserved` can never go negative. */
export function releaseFromKey(
  balances: ChannelBalances,
  key: WalletChannelKey,
  credits: number,
  deltas: ChannelDeltas,
): number {
  const amount = Math.min(Math.max(0, credits), balances[key].reserved);
  if (amount <= 0) return 0;
  balances[key].reserved -= amount;
  bumpDelta(deltas, key, 'reserved', -amount);
  return amount;
}

/**
 * Derive every scalar from `channelBalances`. The ONLY place these numbers are
 * computed, which is what makes
 * `subscriptionBalance === Σ channelBalances[*].subscription` (and the same for
 * purchased/reserved) impossible to drift rather than merely unlikely.
 */
export interface WalletTotals {
  subscriptionBalance: number;
  purchasedBalance: number;
  reserved: number;
  balance: number;
  suspended: boolean;
}

export function deriveTotals<T extends { channelBalances: ChannelBalances }>(wallet: T): T & WalletTotals {
  let subscription = 0;
  let purchased = 0;
  let reserved = 0;
  for (const key of Object.keys(wallet.channelBalances)) {
    const bucket = wallet.channelBalances[key];
    subscription += bucket.subscription;
    purchased += bucket.purchased;
    reserved += bucket.reserved;
  }
  const out = wallet as T & WalletTotals;
  out.subscriptionBalance = subscription;
  out.purchasedBalance = purchased;
  out.reserved = reserved;
  out.balance = subscription + purchased;
  out.suspended = subscription + purchased < 0;
  return out;
}

// ── Multi-channel reservation allocation ─────────────────────────────────────

export interface ChannelShortfall {
  channel: CreditChannel;
  needed: number;
  short: number;
  ownAvailable: number;
  sharedAvailable: number;
}

export type Allocation = Record<CreditChannel, { own: number; shared: number }>;

function emptyAllocation(): Allocation {
  return {
    email: { own: 0, shared: 0 },
    sms: { own: 0, shared: 0 },
    whatsapp: { own: 0, shared: 0 },
  };
}

/**
 * Integer largest-remainder split of `pool` across channels by `weight`.
 *
 * Integer-closed on purpose: `channelBalances` values are compared with `===`
 * by the reconcile script, so a single fractional credit is a permanent red
 * that no amount of healing repairs. Ties break by CREDIT_CHANNELS order, which
 * is why that order is part of the cross-repo contract.
 *
 * Returns the unconsumed remainder of the pool.
 */
function distribute(
  pool: number,
  remaining: Record<CreditChannel, number>,
  out: Record<CreditChannel, number>,
  weight: (c: CreditChannel) => number,
): number {
  if (pool <= 0) return Math.max(0, pool);

  const claims = CREDIT_CHANNELS.map((c) => ({ c, w: Math.min(remaining[c], Math.max(0, weight(c))) })).filter(
    (x) => x.w > 0,
  );
  const total = claims.reduce((sum, x) => sum + x.w, 0);
  if (total === 0) return pool;

  if (total <= pool) {
    for (const { c, w } of claims) {
      out[c] += w;
      remaining[c] -= w;
    }
    return pool - total;
  }

  let leftover = pool;
  const shares = claims.map(({ c, w }) => {
    const exact = (w * pool) / total;
    const base = Math.floor(exact);
    leftover -= base;
    return { c, base, frac: exact - base };
  });
  shares.sort((a, b) => b.frac - a.frac || CREDIT_CHANNELS.indexOf(a.c) - CREDIT_CHANNELS.indexOf(b.c));
  for (let i = 0; i < leftover; i += 1) shares[i].base += 1;
  for (const { c, base } of shares) {
    out[c] += base;
    remaining[c] -= base;
  }
  return 0;
}

/**
 * Allocate a multi-channel campaign reservation across the buckets.
 *
 * A campaign fans out over `channels: Channel[]`, so one run needs credits on
 * several channels at once and they contend for the single `shared` pool. The
 * allocation runs in four passes over BUCKET LEVELS rather than over channels,
 * which is what preserves the waterfall (all subscription credits drain before
 * any purchased ones) while still making contention resolvable:
 *
 *   L1  each channel's own subscription   (private — no contention)
 *   L2  shared.subscription               (contended — deficit priority)
 *   L3  each channel's own purchased      (private — no contention)
 *   L4  shared.purchased                  (contended — proportional)
 *
 * L2 serves channels that CANNOT self-fund from L3 first. That is provably at
 * least as feasible as any other strict-order rule: shared credits handed to a
 * channel that could have paid from its own purchased bucket only free private
 * credits, which no other channel can use. Concretely — email needs 10 with 10
 * of its own purchased, SMS needs 5 with nothing, shared.subscription is 5: a
 * proportional split strands SMS 3 short, deficit-priority covers both.
 *
 * All-or-nothing, matching the pre-existing claim semantics: a shortfall
 * reserves nothing and reports which channels are short.
 */
export function allocateReservation(
  balances: ChannelBalances,
  need: Partial<Record<CreditChannel, number>>,
): { ok: true; allocation: Allocation; total: number } | { ok: false; remaining: Record<CreditChannel, number> } {
  const remaining = {} as Record<CreditChannel, number>;
  const own = {} as Record<CreditChannel, number>;
  const shared = {} as Record<CreditChannel, number>;
  const ownPurchasedLeft = {} as Record<CreditChannel, number>;

  for (const c of CREDIT_CHANNELS) {
    remaining[c] = Math.max(0, Math.trunc(need[c] ?? 0));
    own[c] = 0;
    shared[c] = 0;
  }

  const sharedAvailable = availableOf(balances[SHARED_KEY]);
  let sharedSub = sharedAvailable.subscription;
  let sharedPur = sharedAvailable.purchased;

  // L1 — private subscription.
  for (const c of CREDIT_CHANNELS) {
    const a = availableOf(balances[c]);
    const take = Math.min(remaining[c], a.subscription);
    own[c] += take;
    remaining[c] -= take;
    ownPurchasedLeft[c] = a.purchased;
  }

  // L2 — shared.subscription, deficit first, then spread the rest.
  sharedSub = distribute(sharedSub, remaining, shared, (c) => Math.max(0, remaining[c] - ownPurchasedLeft[c]));
  sharedSub = distribute(sharedSub, remaining, shared, (c) => remaining[c]);

  // L3 — private purchased.
  for (const c of CREDIT_CHANNELS) {
    const take = Math.min(remaining[c], ownPurchasedLeft[c]);
    own[c] += take;
    remaining[c] -= take;
    ownPurchasedLeft[c] -= take;
  }

  // L4 — shared.purchased, last resort.
  sharedPur = distribute(sharedPur, remaining, shared, (c) => remaining[c]);

  if (CREDIT_CHANNELS.some((c) => remaining[c] > 0)) {
    return { ok: false, remaining };
  }

  const allocation = emptyAllocation();
  let total = 0;
  for (const c of CREDIT_CHANNELS) {
    allocation[c] = { own: own[c], shared: shared[c] };
    total += own[c] + shared[c];
  }
  return { ok: true, allocation, total };
}

/** Apply an allocation to the balances as reservations, recording deltas. */
export function applyReservation(
  balances: ChannelBalances,
  allocation: Allocation,
  deltas: ChannelDeltas,
): number {
  let total = 0;
  for (const c of CREDIT_CHANNELS) {
    const { own, shared } = allocation[c];
    if (own > 0) {
      balances[c].reserved += own;
      bumpDelta(deltas, c, 'reserved', own);
      total += own;
    }
    if (shared > 0) {
      balances[SHARED_KEY].reserved += shared;
      bumpDelta(deltas, SHARED_KEY, 'reserved', shared);
      total += shared;
    }
  }
  return total;
}

/** Reconstruct an allocation from a reserve entry's channelDeltas. */
export function allocationFromDeltas(
  deltas: ChannelDeltas | null | undefined,
  need: Partial<Record<CreditChannel, number>>,
): { allocation: Allocation; total: number } {
  const allocation = emptyAllocation();
  let total = 0;
  const source = deltas || {};

  for (const c of CREDIT_CHANNELS) {
    const own = Number(source[c]?.reserved) || 0;
    allocation[c] = { own, shared: 0 };
    total += own;
  }

  // The shared hold is one number for the whole run; split it back across the
  // channels in proportion to what each still needed after its own earmark.
  const sharedHeld = Number(source[SHARED_KEY]?.reserved) || 0;
  if (sharedHeld > 0) {
    const remaining = {} as Record<CreditChannel, number>;
    const out = {} as Record<CreditChannel, number>;
    for (const c of CREDIT_CHANNELS) {
      remaining[c] = Math.max(0, Math.trunc(need[c] ?? 0) - allocation[c].own);
      out[c] = 0;
    }
    distribute(sharedHeld, remaining, out, (c) => remaining[c]);
    for (const c of CREDIT_CHANNELS) {
      allocation[c].shared = out[c];
      total += out[c];
    }
  }

  return { allocation, total };
}

/** Σ of a channelDeltas map, for the per-entry ledger cross-checks. */
export function sumDeltas(deltas: ChannelDeltas | null | undefined): { credits: number; reserved: number } {
  let credits = 0;
  let reserved = 0;
  for (const key of Object.keys(deltas || {})) {
    const bucket = (deltas as ChannelDeltas)[key];
    credits += (Number(bucket?.subscription) || 0) + (Number(bucket?.purchased) || 0);
    reserved += Number(bucket?.reserved) || 0;
  }
  return { credits, reserved };
}
