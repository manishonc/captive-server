/**
 * Unified credit wallet — send-time authority (cms docs/credit-system-spec.md §5.3).
 *
 * Mirrors cms/app/api/captive-portal/_lib/credits-wallet.js: one Firestore
 * transaction per mutation writing wallet + ledger entry, ledger doc id = the
 * idempotency key, integer credits, subscription bucket consumed before
 * purchased, reserve/release entries carry credits:0 + reservedDelta so
 * Σcredits always reconciles to the balance. Keep the two implementations'
 * semantics identical.
 *
 * Enforcement flag ENFORCE_CREDITS:
 *   unset/false → off (no wallet reads or writes on the send path)
 *   'warn'      → compute + log + creditsWarning, but never block or debit
 *   'true'      → reserve → in-memory count → settle (spec §5.3)
 */

import { db } from '../firebase';
import { sendEmail } from './brevo';
import { smsSegments } from './smsBilling';
import {
  CREDIT_CHANNELS,
  SHARED_KEY,
  allocateReservation,
  allocationFromDeltas,
  applyReservation,
  availableOf,
  availableTotal,
  channelKey,
  deriveTotals,
  drainAllowingNegative,
  normalizeChannelBalances,
  releaseFromKey,
  spendableForChannel,
  type Allocation,
  type ChannelBalances,
  type ChannelDeltas,
  type ChannelShortfall,
  type CreditChannel,
} from './creditBuckets';

export const WALLETS_COLLECTION = 'CaptivePortal_CreditWallets';
const LEDGER = 'ledger';
const CONFIG_COLLECTION = 'CaptivePortal_BillingConfig';
const CONFIG_DOC = 'credits';

export {
  CREDIT_CHANNELS,
  SHARED_KEY,
  allocateReservation,
  availableOf,
  availableTotal,
  channelKey,
  spendableForChannel,
};
export type { Allocation, ChannelBalances, ChannelDeltas, ChannelShortfall, CreditChannel };

export type EnforcementMode = 'off' | 'warn' | 'enforce';

export function creditsEnforcementMode(): EnforcementMode {
  const raw = String(process.env.ENFORCE_CREDITS || '').toLowerCase();
  if (raw === 'true') return 'enforce';
  if (raw === 'warn') return 'warn';
  return 'off';
}

// ── Rate card ─────────────────────────────────────────────────────────────────

export interface CreditConfig {
  defaultCurrency: string;
  currencies: Record<string, { creditsPerUnit: number; enabled: boolean }>;
  channelRates: {
    email: { creditsPerMessage: number };
    sms: { creditsPerSegment: number };
    whatsapp: { creditsPerMessage: number };
  };
  providerCosts: Record<string, { provider?: string; costMinor: number; currency?: string; perSegment?: boolean }>;
  lowBalanceThresholdCredits: number;
  testSendDailyLimit: number;
  rateCardVersion: number;
}

/** Seed defaults — keep in sync with cms _lib/credit-config.js. */
const DEFAULT_CONFIG: CreditConfig = {
  defaultCurrency: 'CHF',
  currencies: { CHF: { creditsPerUnit: 100, enabled: true } },
  channelRates: {
    email: { creditsPerMessage: 1 },
    sms: { creditsPerSegment: 15 },
    whatsapp: { creditsPerMessage: 12 },
  },
  providerCosts: {
    email: { provider: 'brevo', costMinor: 0.2 },
    sms: { provider: 'twilio', costMinor: 8, perSegment: true },
    whatsapp: { provider: 'meta', costMinor: 6 },
  },
  lowBalanceThresholdCredits: 200,
  testSendDailyLimit: 20,
  rateCardVersion: 0,
};

let configCache: { value: CreditConfig; expiresAt: number } | null = null;
const CONFIG_TTL_MS = 5 * 60 * 1000;

export async function getCreditConfig(): Promise<CreditConfig> {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.value;
  let value = DEFAULT_CONFIG;
  try {
    const snap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
    if (snap.exists) {
      const data = snap.data() as Partial<CreditConfig>;
      value = {
        ...DEFAULT_CONFIG,
        ...data,
        currencies: { ...DEFAULT_CONFIG.currencies, ...(data.currencies || {}) },
        channelRates: { ...DEFAULT_CONFIG.channelRates, ...(data.channelRates || {}) },
        providerCosts: { ...DEFAULT_CONFIG.providerCosts, ...(data.providerCosts || {}) },
      };
    }
  } catch (err) {
    console.error('[CREDITS] config read failed, using defaults:', err);
  }
  configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
  return value;
}

export function invalidateCreditConfig(): void {
  configCache = null;
}

// ── SMS segment math (GSM-7 vs UCS-2) ────────────────────────────────────────

// Lives in services/smsBilling.ts — pure, so the billing text (which depends on
// the guest's language variant) can be tested without Firestore. Re-exported
// here because callers have always imported it from this module.
export { smsSegments };

/** Credits one message consumes: per segment for SMS, flat otherwise. */
export function creditsForMessage(config: CreditConfig, channel: CreditChannel, smsContent?: string): number {
  if (channel === 'sms') {
    return config.channelRates.sms.creditsPerSegment * smsSegments(smsContent ?? '');
  }
  if (channel === 'email') return config.channelRates.email.creditsPerMessage;
  return config.channelRates.whatsapp.creditsPerMessage;
}

/** Provider COGS snapshot for one message in minor units (segments × cost for SMS). */
export function providerCostForMessage(config: CreditConfig, channel: CreditChannel, smsContent?: string): number {
  const cost = Number(config.providerCosts[channel]?.costMinor ?? 0);
  if (channel === 'sms' && config.providerCosts.sms?.perSegment !== false) {
    return cost * smsSegments(smsContent ?? '');
  }
  return cost;
}

// ── Wallet primitives ────────────────────────────────────────────────────────

export interface WalletSnapshot {
  balance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  reserved: number;
  spendable: number;
  suspended: boolean;
  channelBalances: ChannelBalances;
  /** Each key's OWN unreserved credits — NOT own+shared, which would count the
   *  shared pool once per channel. */
  channelSpendable: Record<string, number>;
}

interface WalletState {
  balance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  reserved: number;
  lifetimeSpentCredits: number;
  suspended: boolean;
  channelBalances: ChannelBalances;
  [key: string]: unknown;
}

/**
 * Read + heal a wallet doc. `ctx` only shapes the log line for the
 * already-seeded-but-drifted case, which is a genuine bug (see
 * creditBuckets.normalizeChannelBalances).
 */
function normalize(data: FirebaseFirestore.DocumentData | undefined, ctx = 'wallet'): WalletState {
  const top = {
    subscriptionBalance: Number(data?.subscriptionBalance) || 0,
    purchasedBalance: Number(data?.purchasedBalance) || 0,
    reserved: Number(data?.reserved) || 0,
  };
  const { balances, drift, seeded } = normalizeChannelBalances(data?.channelBalances, top);
  if (seeded && (drift.subscription || drift.purchased || drift.reserved)) {
    console.error(`[CREDITS] channelBalances drift healed into shared (${ctx}):`, drift);
  }
  return {
    ...(data || {}),
    balance: Number(data?.balance) || 0,
    ...top,
    lifetimeSpentCredits: Number(data?.lifetimeSpentCredits) || 0,
    suspended: data?.suspended === true,
    channelBalances: balances,
  };
}

function toSnapshot(w: WalletState): WalletSnapshot {
  const channelSpendable: Record<string, number> = {};
  for (const key of Object.keys(w.channelBalances)) {
    channelSpendable[key] = availableTotal(w.channelBalances[key]);
  }
  return {
    balance: w.balance,
    subscriptionBalance: w.subscriptionBalance,
    purchasedBalance: w.purchasedBalance,
    reserved: w.reserved,
    spendable: w.balance - w.reserved,
    suspended: w.suspended,
    channelBalances: w.channelBalances,
    channelSpendable,
  };
}

/**
 * The wallet fields every mutation writes. Always the FULL channelBalances map
 * from the healed in-transaction read — Firestore deep-merges nested maps, so a
 * partial write silently preserves stale siblings with no error.
 */
function walletWrite(w: WalletState): Record<string, unknown> {
  deriveTotals(w);
  return {
    balance: w.balance,
    subscriptionBalance: w.subscriptionBalance,
    purchasedBalance: w.purchasedBalance,
    reserved: w.reserved,
    channelBalances: w.channelBalances,
    lifetimeSpentCredits: w.lifetimeSpentCredits,
    suspended: w.suspended,
    updatedAt: new Date(),
  };
}

/**
 * Ledger entry skeleton — same field set as the cms lib (spec §4.3).
 *
 * `channelDeltas` is REQUIRED on every entry this file writes. The CMS
 * reconcile script replays a null as `shared` (correct for pre-migration
 * entries), so an SMS debit written without it would credit SMS's spend to
 * `shared` while every total still reconciles — the quietest failure mode in
 * this design.
 */
function baseEntry(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: fields.type,
    credits: fields.credits ?? 0,
    balanceAfter: fields.balanceAfter,
    channel: fields.channel ?? null,
    segments: fields.segments ?? null,
    rateCardVersion: fields.rateCardVersion ?? null,
    campaignId: fields.campaignId ?? null,
    sendId: fields.sendId ?? null,
    stripeSessionId: null,
    amountMinor: null,
    currency: fields.currency ?? null,
    providerCostMinorSnapshot: fields.providerCostMinorSnapshot ?? null,
    reservedDelta: fields.reservedDelta ?? null,
    channelDeltas: fields.channelDeltas ?? null,
    note: fields.note ?? null,
    createdAt: new Date(),
    createdBy: 'system',
  };
}

export async function getWalletSnapshot(tenantUserId: string): Promise<WalletSnapshot> {
  const snap = await db.collection(WALLETS_COLLECTION).doc(tenantUserId).get();
  return toSnapshot(normalize(snap.exists ? snap.data() : undefined, `get ${tenantUserId}`));
}

export class InsufficientCreditsError extends Error {
  code = 'insufficient_credits' as const;
  constructor(
    public needed: number,
    public spendable: number,
    /** Which channels fell short, and by how much. */
    public shortfalls: ChannelShortfall[] = [],
    /**
     * True when the account holds enough credits overall but they are earmarked
     * for other channels — i.e. the fix is "move credits", not "top up". This
     * is the whole UX justification for hard lock; without it a tenant with
     * 200k email credits sees "not enough credits" and files a bug.
     */
    public sharedContended = false,
  ) {
    super(`Insufficient credits: need ${needed}, spendable ${spendable}`);
  }
}

/**
 * Per-channel hold recorded on the campaign doc. `own` came from
 * channelBalances[c], `shared` from channelBalances.shared.
 */
export type ReservationSplit = Record<CreditChannel, { own: number; shared: number }>;

/**
 * A campaign's reservation, normalized across shapes.
 *
 * `legacyScalar` is a reservation taken before per-channel reservations
 * existed. It releases from `shared` only — which balances exactly against the
 * heal in normalizeChannelBalances (that parked the orphan top-level `reserved`
 * into `shared.reserved`), so nothing strands.
 */
export type NormalizedReservation =
  | { kind: 'perChannel'; runId: string; total: number; rateCardVersion: number; perChannel: ReservationSplit }
  | { kind: 'legacyScalar'; runId: string; total: number; rateCardVersion: number };

export function normalizeReservation(raw: unknown): NormalizedReservation | null {
  const r = raw as
    | { runId?: string; reserved?: number; rateCardVersion?: number; perChannel?: Record<string, { own?: number; shared?: number }> }
    | null
    | undefined;
  if (!r?.runId) return null;
  const total = Number(r.reserved) || 0;
  const rateCardVersion = Number(r.rateCardVersion) || 0;

  if (r.perChannel && typeof r.perChannel === 'object') {
    const perChannel = {} as ReservationSplit;
    for (const c of CREDIT_CHANNELS) {
      perChannel[c] = {
        own: Number(r.perChannel[c]?.own) || 0,
        shared: Number(r.perChannel[c]?.shared) || 0,
      };
    }
    return { kind: 'perChannel', runId: r.runId, total, rateCardVersion, perChannel };
  }
  return { kind: 'legacyScalar', runId: r.runId, total, rateCardVersion };
}

/** Per-channel caps a settle may draw against, from the run's own reservation. */
function capsFor(reservation: NormalizedReservation, channel: CreditChannel): { own: number; shared: number } {
  return reservation.kind === 'perChannel'
    ? { ...reservation.perChannel[channel] }
    : // Legacy scalar: the whole hold sits in `shared`, uncapped per channel.
      { own: 0, shared: reservation.total };
}

/** Build the shortfall report from a failed allocation. */
function shortfallsFrom(
  balances: ChannelBalances,
  need: Partial<Record<CreditChannel, number>>,
  remaining: Record<CreditChannel, number>,
): ChannelShortfall[] {
  const sharedAvailable = availableTotal(balances[SHARED_KEY]);
  return CREDIT_CHANNELS.filter((c) => remaining[c] > 0).map((c) => ({
    channel: c,
    needed: Math.max(0, Math.trunc(need[c] ?? 0)),
    short: remaining[c],
    ownAvailable: availableTotal(balances[c]),
    sharedAvailable,
  }));
}

/**
 * Reserve credits for a campaign run. Ledger `resv_{campaignId}_{runId}`,
 * credits:0 + reservedDelta. Throws InsufficientCreditsError when spendable
 * is short (enforce mode blocks the claim on this).
 */
export async function reserveCredits(opts: {
  tenantUserId: string;
  campaignId: string;
  runId: string;
  need: Partial<Record<CreditChannel, number>>;
  rateCardVersion: number;
}): Promise<{ wallet: WalletSnapshot; allocation: Allocation; total: number }> {
  const { tenantUserId, campaignId, runId, need, rateCardVersion } = opts;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`resv_${campaignId}_${runId}`);

  return db.runTransaction(async (tx) => {
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined, `reserve ${campaignId}`);
    if (entrySnap.exists) {
      // Retried claim — the wallet already moved. Recover the split from the
      // entry rather than re-allocating against the post-reserve balances.
      const { allocation, total } = allocationFromDeltas(
        entrySnap.data()?.channelDeltas as ChannelDeltas | undefined,
        need,
      );
      return { wallet: toSnapshot(wallet), allocation, total };
    }

    const totalNeeded = CREDIT_CHANNELS.reduce((sum, c) => sum + Math.max(0, Math.trunc(need[c] ?? 0)), 0);
    const spendable = wallet.balance - wallet.reserved;
    if (wallet.suspended) {
      throw new InsufficientCreditsError(totalNeeded, Math.max(0, spendable));
    }

    const alloc = allocateReservation(wallet.channelBalances, need);
    if (!alloc.ok) {
      throw new InsufficientCreditsError(
        totalNeeded,
        Math.max(0, spendable),
        shortfallsFrom(wallet.channelBalances, need, alloc.remaining),
        spendable >= totalNeeded,
      );
    }

    const deltas: ChannelDeltas = {};
    const total = applyReservation(wallet.channelBalances, alloc.allocation, deltas);

    tx.set(wRef, walletWrite(wallet), { merge: true });
    tx.set(
      entryRef,
      baseEntry({
        type: 'reserve',
        credits: 0,
        balanceAfter: wallet.balance,
        reservedDelta: total,
        channelDeltas: deltas,
        campaignId,
        rateCardVersion,
        note: `Reserved for campaign run ${runId}`,
      }),
    );
    return { wallet: toSnapshot(wallet), allocation: alloc.allocation, total };
  });
}

/**
 * Reserve INSIDE an existing transaction — used by the campaign claim so
 * status flip + reservation are one atomic unit (spec §5.3.2). All tx.get
 * calls happen here before the caller performs any writes of its own.
 * Returns ok:false with the shortfall instead of throwing (the claim maps it
 * to a `cannot_send`-style reason).
 *
 * The ALLOCATION is computed here, inside the transaction, not by the caller:
 * it depends on wallet state, and Firestore re-runs the callback on contention.
 * Precomputing it outside would let two concurrent claims allocate the same
 * shared credits twice.
 */
export async function reserveInTransaction(
  tx: FirebaseFirestore.Transaction,
  opts: {
    tenantUserId: string;
    campaignId: string;
    runId: string;
    need: Partial<Record<CreditChannel, number>>;
    rateCardVersion: number;
  },
): Promise<
  | { ok: true; allocation: Allocation; total: number }
  | { ok: false; needed: number; spendable: number; shortfalls: ChannelShortfall[]; sharedContended: boolean }
> {
  const { tenantUserId, campaignId, runId, need, rateCardVersion } = opts;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`resv_${campaignId}_${runId}`);

  const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
  if (entrySnap.exists) {
    // Already reserved (retried claim): rebuild the split from the entry — the
    // wallet has moved, so re-allocating would produce a different answer.
    const { allocation, total } = allocationFromDeltas(
      entrySnap.data()?.channelDeltas as ChannelDeltas | undefined,
      need,
    );
    return { ok: true, allocation, total };
  }

  const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined, `reserve ${campaignId}`);
  const totalNeeded = CREDIT_CHANNELS.reduce((sum, c) => sum + Math.max(0, Math.trunc(need[c] ?? 0)), 0);
  const spendable = Math.max(0, wallet.balance - wallet.reserved);

  if (wallet.suspended) {
    return { ok: false, needed: totalNeeded, spendable, shortfalls: [], sharedContended: false };
  }

  const alloc = allocateReservation(wallet.channelBalances, need);
  if (!alloc.ok) {
    return {
      ok: false,
      // Totals stay in the response: campaign-proxy and routes/internal format
      // the tenant-facing message from `needed`/`spendable`.
      needed: totalNeeded,
      spendable,
      shortfalls: shortfallsFrom(wallet.channelBalances, need, alloc.remaining),
      sharedContended: spendable >= totalNeeded,
    };
  }

  const deltas: ChannelDeltas = {};
  const total = applyReservation(wallet.channelBalances, alloc.allocation, deltas);

  tx.set(wRef, walletWrite(wallet), { merge: true });
  tx.set(
    entryRef,
    baseEntry({
      type: 'reserve',
      credits: 0,
      balanceAfter: wallet.balance,
      reservedDelta: total,
      channelDeltas: deltas,
      campaignId,
      rateCardVersion,
      note: `Reserved for campaign run ${runId}`,
    }),
  );
  return { ok: true, allocation: alloc.allocation, total };
}

export interface SettleBreakdown {
  perChannel: Partial<Record<CreditChannel, { messages: number; credits: number; segments?: number }>>;
  providerCostMinorSnapshot: number;
}

/**
 * Settle a campaign run in ONE transaction: debit the credits actually used
 * (subscription bucket first) and release the whole reservation. Two ledger
 * entries — `debit_{campaignId}_{runId}` (credits:-used, reservedDelta:-used)
 * and `rel_{campaignId}_{runId}` (credits:0, reservedDelta:-(unused)) — so
 * both Σcredits→balance and ΣreservedDelta→reserved reconcile. Idempotent on
 * the debit entry.
 */
export async function settleCampaignRun(opts: {
  tenantUserId: string;
  campaignId: string;
  runId: string;
  reservation: NormalizedReservation;
  usedPerChannel: Partial<Record<CreditChannel, number>>;
  rateCardVersion: number;
  breakdown: SettleBreakdown;
}): Promise<WalletSnapshot> {
  const { tenantUserId, campaignId, runId, reservation, usedPerChannel, rateCardVersion, breakdown } = opts;
  const usedCredits = CREDIT_CHANNELS.reduce((sum, c) => sum + Math.max(0, Math.trunc(usedPerChannel[c] ?? 0)), 0);
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const debitRef = wRef.collection(LEDGER).doc(`debit_${campaignId}_${runId}`);
  const releaseRef = wRef.collection(LEDGER).doc(`rel_${campaignId}_${runId}`);

  return db.runTransaction(async (tx) => {
    const [debitSnap, releaseSnap, walletSnap] = await Promise.all([
      tx.get(debitRef),
      tx.get(releaseRef),
      tx.get(wRef),
    ]);
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined, `settle ${campaignId}`);
    if (debitSnap.exists) return toSnapshot(wallet); // already settled

    // Debit each channel's actual usage through the waterfall, CAPPED by what
    // that channel's own reservation set aside. The caps are what stop this
    // settle from consuming shared credits a concurrent campaign reserved —
    // without them hard lock would only hold within a single campaign.
    const debitDeltas: ChannelDeltas = {};
    for (const channel of CREDIT_CHANNELS) {
      const used = Math.max(0, Math.trunc(usedPerChannel[channel] ?? 0));
      if (used === 0) continue;
      // Allowing negative here is deliberate: the credits WERE spent. Buckets
      // can legitimately have moved since the reserve (a non-rollover renewal
      // zeroing subscription mid-run, an admin adjustment, a Stripe clawback),
      // and the alternative is silently not charging for delivered messages.
      drainAllowingNegative(wallet.channelBalances, channel, used, debitDeltas, capsFor(reservation, channel));
    }
    wallet.lifetimeSpentCredits += usedCredits;

    // Release this run's hold, per key, clamped per key. If the sweeper already
    // released it, THIS run holds nothing — any remaining `reserved` belongs to
    // other campaigns and must not be touched.
    const releaseDeltas: ChannelDeltas = {};
    let releasedTotal = 0;
    if (!releaseSnap.exists) {
      if (reservation.kind === 'perChannel') {
        for (const channel of CREDIT_CHANNELS) {
          const { own, shared } = reservation.perChannel[channel];
          releasedTotal += releaseFromKey(wallet.channelBalances, channel, own, releaseDeltas);
          releasedTotal += releaseFromKey(wallet.channelBalances, SHARED_KEY, shared, releaseDeltas);
        }
      } else {
        // Legacy scalar: the heal parked the whole orphan hold in `shared`.
        releasedTotal += releaseFromKey(wallet.channelBalances, SHARED_KEY, reservation.total, releaseDeltas);
      }
    }

    // Split the release across the two entries the way the original did: the
    // debit entry claims the used part of the hold, the release entry the rest.
    const debitReserved = Math.min(usedCredits, releasedTotal);
    const unused = releasedTotal - debitReserved;

    // Attribute the reserved movement between the two entries so each one's
    // Σ channelDeltas.reserved matches its own reservedDelta.
    const debitReservedDeltas: ChannelDeltas = {};
    const releaseReservedDeltas: ChannelDeltas = {};
    let toDebit = debitReserved;
    for (const key of Object.keys(releaseDeltas)) {
      const amount = -releaseDeltas[key].reserved; // positive magnitude
      const forDebit = Math.min(toDebit, amount);
      toDebit -= forDebit;
      if (forDebit > 0) {
        debitReservedDeltas[key] = { subscription: 0, purchased: 0, reserved: -forDebit };
      }
      const forRelease = amount - forDebit;
      if (forRelease > 0) {
        releaseReservedDeltas[key] = { subscription: 0, purchased: 0, reserved: -forRelease };
      }
    }

    // Merge the debit's bucket movements with its share of the release.
    const debitEntryDeltas: ChannelDeltas = {};
    for (const key of new Set([...Object.keys(debitDeltas), ...Object.keys(debitReservedDeltas)])) {
      debitEntryDeltas[key] = {
        subscription: debitDeltas[key]?.subscription ?? 0,
        purchased: debitDeltas[key]?.purchased ?? 0,
        reserved: debitReservedDeltas[key]?.reserved ?? 0,
      };
    }

    tx.set(wRef, walletWrite(wallet), { merge: true });

    tx.set(
      debitRef,
      baseEntry({
        type: 'debit',
        credits: -usedCredits,
        balanceAfter: wallet.balance,
        reservedDelta: -debitReserved,
        channelDeltas: debitEntryDeltas,
        campaignId,
        rateCardVersion,
        providerCostMinorSnapshot: usedCredits > 0 ? breakdown.providerCostMinorSnapshot : null,
        // Business detail (messages/segments per channel) stays separate from
        // the accounting movements in channelDeltas — conflating them invites a
        // reconciliation that sums `credits` where it meant `purchased`.
        note: usedCredits > 0 ? JSON.stringify(breakdown.perChannel) : 'No credits consumed this run',
      }),
    );

    // The sweeper may have already released this run's reservation (crash →
    // sweep → late settle). Its entry shares this doc id — never overwrite it.
    if (!releaseSnap.exists) {
      tx.set(
        releaseRef,
        baseEntry({
          type: 'release',
          credits: 0,
          balanceAfter: wallet.balance,
          reservedDelta: -unused,
          channelDeltas: releaseReservedDeltas,
          campaignId,
          rateCardVersion,
          note: `Released unused reservation (run ${runId})`,
        }),
      );
    }
    return toSnapshot(wallet);
  });
}

/**
 * Release a (stale) reservation without debiting — the sweeper's tool for
 * dispatch crashes between reserve and settle.
 */
export async function releaseReservation(opts: {
  tenantUserId: string;
  campaignId: string;
  runId: string;
  reservation: NormalizedReservation;
  note?: string;
}): Promise<void> {
  const { tenantUserId, campaignId, runId, reservation, note } = opts;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`rel_${campaignId}_${runId}`);

  await db.runTransaction(async (tx) => {
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
    if (entrySnap.exists) return; // settle already released it
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined, `sweep ${campaignId}`);

    const deltas: ChannelDeltas = {};
    let released = 0;
    if (reservation.kind === 'perChannel') {
      for (const channel of CREDIT_CHANNELS) {
        const { own, shared } = reservation.perChannel[channel];
        released += releaseFromKey(wallet.channelBalances, channel, own, deltas);
        released += releaseFromKey(wallet.channelBalances, SHARED_KEY, shared, deltas);
      }
    } else {
      // Legacy scalar reservation: the heal already parked the orphan
      // top-level `reserved` in `shared`, so releasing from `shared` is exact.
      released += releaseFromKey(wallet.channelBalances, SHARED_KEY, reservation.total, deltas);
    }

    tx.set(wRef, walletWrite(wallet), { merge: true });
    tx.set(
      entryRef,
      baseEntry({
        type: 'release',
        credits: 0,
        balanceAfter: wallet.balance,
        reservedDelta: -released,
        channelDeltas: deltas,
        campaignId,
        note: note ?? `Reservation released (run ${runId})`,
      }),
    );
  });
}

/**
 * Single-message debit for automations (spec §5.3.6). Idempotent on
 * `debit_auto_{sendId}`. Never blocks retroactively — the caller checks
 * spendable BEFORE dispatching; this debit allows the bounded overspend the
 * spec accepts for cached automation reads.
 */
export async function debitOne(opts: {
  tenantUserId: string;
  sendId: string;
  credits: number;
  channel: CreditChannel;
  segments?: number;
  campaignId?: string;
  rateCardVersion: number;
  providerCostMinorSnapshot: number;
}): Promise<void> {
  const { tenantUserId, sendId, credits, channel, segments, campaignId, rateCardVersion, providerCostMinorSnapshot } = opts;
  if (!Number.isInteger(credits) || credits < 1) return;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`debit_auto_${sendId}`);

  await db.runTransaction(async (tx) => {
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
    if (entrySnap.exists) return;
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined, `debitOne ${sendId}`);

    // Uncapped (automations hold no reservation) and allowed to go negative —
    // the bounded overspend the spec accepts for cached automation reads.
    const deltas: ChannelDeltas = {};
    drainAllowingNegative(wallet.channelBalances, channel, credits, deltas);
    wallet.lifetimeSpentCredits += credits;

    tx.set(wRef, walletWrite(wallet), { merge: true });
    tx.set(
      entryRef,
      baseEntry({
        type: 'debit',
        credits: -credits,
        balanceAfter: wallet.balance,
        channel,
        segments: segments ?? null,
        channelDeltas: deltas,
        campaignId: campaignId ?? null,
        sendId,
        rateCardVersion,
        providerCostMinorSnapshot,
        note: 'Automation send',
      }),
    );
  });
}

// ── Low-balance alert (spec §5.4) ────────────────────────────────────────────

const LOW_BALANCE_DEDUPE_MS = 24 * 60 * 60 * 1000;

/**
 * After a debit: if spendable dropped under the configured threshold and the
 * tenant hasn't been notified in 24h, mark + notify (best-effort email).
 */
export async function maybeNotifyLowBalance(tenantUserId: string): Promise<void> {
  try {
    const config = await getCreditConfig();
    const threshold = Number(config.lowBalanceThresholdCredits) || 0;
    if (threshold <= 0) return;

    const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
    const snap = await wRef.get();
    if (!snap.exists) return;
    const wallet = normalize(snap.data(), `lowBalance ${tenantUserId}`);
    const spendable = wallet.balance - wallet.reserved;
    // The TRIGGER stays global (total spendable under the threshold) and so
    // does the 24h dedupe. A per-channel trigger would spam any tenant who
    // deliberately keeps one channel at zero; the per-hold creditsWarning is
    // what carries the channel-starvation signal.
    if (spendable >= threshold) return;

    const lastRaw = snap.data()?.lowBalanceNotifiedAt;
    const last = lastRaw?.toDate?.()?.getTime?.() ?? (lastRaw ? new Date(lastRaw).getTime() : 0);
    if (last && Date.now() - last < LOW_BALANCE_DEDUPE_MS) return;

    await wRef.set({ lowBalanceNotifiedAt: new Date() }, { merge: true });

    console.warn(`[CREDITS] Low balance for tenant ${tenantUserId}: ${spendable} spendable (threshold ${threshold})`);

    // Best-effort email to the account owner.
    const userSnap = await db.collection('Users').doc(tenantUserId).get();
    const email = userSnap.data()?.email;
    if (typeof email === 'string' && email.includes('@')) {
      // Per channel, NOT one pooled number divided three ways. Credits are
      // earmarked, so dividing the total by each rate would tell a tenant with
      // 50k email credits and no SMS that they have thousands of SMS available.
      const rateFor = (c: CreditChannel) =>
        c === 'sms' ? config.channelRates.sms.creditsPerSegment : config.channelRates[c].creditsPerMessage;
      const labels: Record<CreditChannel, string> = { email: 'emails', sms: 'one-segment SMS', whatsapp: 'WhatsApp messages' };

      const rows = CREDIT_CHANNELS.map((c) => {
        const credits = spendableForChannel(wallet.channelBalances, c);
        const rate = rateFor(c);
        const count = rate > 0 ? Math.floor(Math.max(0, credits) / rate) : 0;
        return `<li><strong>${count.toLocaleString()}</strong> ${labels[c]}</li>`;
      }).join('');

      const sharedCredits = availableTotal(wallet.channelBalances[SHARED_KEY]);
      const sharedNote = sharedCredits > 0
        ? `<p>${sharedCredits.toLocaleString()} of those are shared credits, usable on any channel — which is why the numbers above overlap.</p>`
        : '';

      await sendEmail(
        email,
        'HeidiFi: your messaging credits are running low',
        `<p>Your balance is down to <strong>${Math.max(0, spendable).toLocaleString()} credits</strong>. ` +
          `Here's what each channel can still send:</p><ul>${rows}</ul>${sharedNote}` +
          `<p>Top up — or move credits between channels — in your HeidiFi dashboard under ` +
          `<strong>Billing &amp; Credits</strong> to keep campaigns running.</p>`,
        0,
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[CREDITS] low-balance check failed:', err);
  }
}
