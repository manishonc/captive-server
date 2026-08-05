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

export const WALLETS_COLLECTION = 'CaptivePortal_CreditWallets';
const LEDGER = 'ledger';
const CONFIG_COLLECTION = 'CaptivePortal_BillingConfig';
const CONFIG_DOC = 'credits';

export type CreditChannel = 'email' | 'sms' | 'whatsapp';

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

// GSM 03.38 basic character set + extension characters (which count double).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

/**
 * Segments a message body will consume (spec §3 SMS note): GSM-7 texts fit 160
 * chars in one segment (153/segment when concatenated); any non-GSM character
 * forces UCS-2 at 70 / 67. Mirrors the CMS composer's preview math.
 */
export function smsSegments(content: string): number {
  const text = String(content ?? '');
  if (text.length === 0) return 1;

  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  const chars = [...text].length;
  return chars <= 70 ? 1 : Math.ceil(chars / 67);
}

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
}

interface WalletState {
  balance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  reserved: number;
  lifetimeSpentCredits: number;
  suspended: boolean;
  [key: string]: unknown;
}

function normalize(data: FirebaseFirestore.DocumentData | undefined): WalletState {
  return {
    ...(data || {}),
    balance: Number(data?.balance) || 0,
    subscriptionBalance: Number(data?.subscriptionBalance) || 0,
    purchasedBalance: Number(data?.purchasedBalance) || 0,
    reserved: Number(data?.reserved) || 0,
    lifetimeSpentCredits: Number(data?.lifetimeSpentCredits) || 0,
    suspended: data?.suspended === true,
  };
}

function toSnapshot(w: WalletState): WalletSnapshot {
  return {
    balance: w.balance,
    subscriptionBalance: w.subscriptionBalance,
    purchasedBalance: w.purchasedBalance,
    reserved: w.reserved,
    spendable: w.balance - w.reserved,
    suspended: w.suspended,
  };
}

/** Ledger entry skeleton — same field set as the cms lib (spec §4.3). */
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
    note: fields.note ?? null,
    createdAt: new Date(),
    createdBy: 'system',
  };
}

export async function getWalletSnapshot(tenantUserId: string): Promise<WalletSnapshot> {
  const snap = await db.collection(WALLETS_COLLECTION).doc(tenantUserId).get();
  return toSnapshot(normalize(snap.exists ? snap.data() : undefined));
}

export class InsufficientCreditsError extends Error {
  code = 'insufficient_credits' as const;
  constructor(
    public needed: number,
    public spendable: number,
  ) {
    super(`Insufficient credits: need ${needed}, spendable ${spendable}`);
  }
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
  credits: number;
  rateCardVersion: number;
}): Promise<WalletSnapshot> {
  const { tenantUserId, campaignId, runId, credits, rateCardVersion } = opts;
  if (!Number.isInteger(credits) || credits < 0) throw new Error('reserve credits must be a non-negative integer');
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`resv_${campaignId}_${runId}`);

  return db.runTransaction(async (tx) => {
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined);
    if (entrySnap.exists) return toSnapshot(wallet); // retried claim — already reserved

    const spendable = wallet.balance - wallet.reserved;
    if (wallet.suspended || spendable < credits) {
      throw new InsufficientCreditsError(credits, Math.max(0, spendable));
    }

    wallet.reserved += credits;
    tx.set(wRef, { reserved: wallet.reserved, updatedAt: new Date() }, { merge: true });
    tx.set(
      entryRef,
      baseEntry({
        type: 'reserve',
        credits: 0,
        balanceAfter: wallet.balance,
        reservedDelta: credits,
        campaignId,
        rateCardVersion,
        note: `Reserved for campaign run ${runId}`,
      }),
    );
    return toSnapshot(wallet);
  });
}

/**
 * Reserve INSIDE an existing transaction — used by the campaign claim so
 * status flip + reservation are one atomic unit (spec §5.3.2). All tx.get
 * calls happen here before the caller performs any writes of its own.
 * Returns ok:false with the shortfall instead of throwing (the claim maps it
 * to a `cannot_send`-style reason).
 */
export async function reserveInTransaction(
  tx: FirebaseFirestore.Transaction,
  opts: { tenantUserId: string; campaignId: string; runId: string; credits: number; rateCardVersion: number },
): Promise<{ ok: true } | { ok: false; needed: number; spendable: number }> {
  const { tenantUserId, campaignId, runId, credits, rateCardVersion } = opts;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`resv_${campaignId}_${runId}`);

  const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
  if (entrySnap.exists) return { ok: true }; // already reserved (retried claim)

  const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined);
  const spendable = wallet.balance - wallet.reserved;
  if (wallet.suspended || spendable < credits) {
    return { ok: false, needed: credits, spendable: Math.max(0, spendable) };
  }

  tx.set(wRef, { reserved: wallet.reserved + credits, updatedAt: new Date() }, { merge: true });
  tx.set(
    entryRef,
    baseEntry({
      type: 'reserve',
      credits: 0,
      balanceAfter: wallet.balance,
      reservedDelta: credits,
      campaignId,
      rateCardVersion,
      note: `Reserved for campaign run ${runId}`,
    }),
  );
  return { ok: true };
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
  reservedCredits: number;
  usedCredits: number;
  rateCardVersion: number;
  breakdown: SettleBreakdown;
}): Promise<WalletSnapshot> {
  const { tenantUserId, campaignId, runId, reservedCredits, usedCredits, rateCardVersion, breakdown } = opts;
  if (!Number.isInteger(usedCredits) || usedCredits < 0) throw new Error('usedCredits must be a non-negative integer');
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const debitRef = wRef.collection(LEDGER).doc(`debit_${campaignId}_${runId}`);
  const releaseRef = wRef.collection(LEDGER).doc(`rel_${campaignId}_${runId}`);

  return db.runTransaction(async (tx) => {
    const [debitSnap, releaseSnap, walletSnap] = await Promise.all([
      tx.get(debitRef),
      tx.get(releaseRef),
      tx.get(wRef),
    ]);
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined);
    if (debitSnap.exists) return toSnapshot(wallet); // already settled

    // Debit used (subscription first) — the reservation guaranteed coverage,
    // but clamp against pathological states rather than throwing mid-settle.
    const fromSubscription = Math.min(wallet.subscriptionBalance, usedCredits);
    wallet.subscriptionBalance -= fromSubscription;
    wallet.purchasedBalance -= usedCredits - fromSubscription;
    wallet.balance = wallet.subscriptionBalance + wallet.purchasedBalance;
    wallet.lifetimeSpentCredits += usedCredits;

    // Release the entire reservation (used part consumed, remainder freed).
    // If the sweeper already released this run, THIS run holds nothing — any
    // remaining `reserved` belongs to other campaigns and must not be touched.
    const releasable = releaseSnap.exists ? 0 : Math.min(wallet.reserved, reservedCredits);
    wallet.reserved -= releasable;
    wallet.suspended = wallet.balance < 0;

    tx.set(
      wRef,
      {
        balance: wallet.balance,
        subscriptionBalance: wallet.subscriptionBalance,
        purchasedBalance: wallet.purchasedBalance,
        reserved: wallet.reserved,
        lifetimeSpentCredits: wallet.lifetimeSpentCredits,
        suspended: wallet.suspended,
        updatedAt: new Date(),
      },
      { merge: true },
    );

    if (usedCredits > 0) {
      tx.set(
        debitRef,
        baseEntry({
          type: 'debit',
          credits: -usedCredits,
          balanceAfter: wallet.balance,
          reservedDelta: -Math.min(usedCredits, releasable),
          campaignId,
          rateCardVersion,
          providerCostMinorSnapshot: breakdown.providerCostMinorSnapshot,
          note: JSON.stringify(breakdown.perChannel),
        }),
      );
    } else {
      // Zero-usage runs still need the idempotency marker.
      tx.set(
        debitRef,
        baseEntry({
          type: 'debit',
          credits: 0,
          balanceAfter: wallet.balance,
          campaignId,
          rateCardVersion,
          note: 'No credits consumed this run',
        }),
      );
    }
    // The sweeper may have already released this run's reservation (crash →
    // sweep → late settle). Its entry shares this doc id — never overwrite it.
    if (!releaseSnap.exists) {
      const unused = releasable - Math.min(usedCredits, releasable);
      tx.set(
        releaseRef,
        baseEntry({
          type: 'release',
          credits: 0,
          balanceAfter: wallet.balance,
          reservedDelta: -unused,
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
  credits: number;
  note?: string;
}): Promise<void> {
  const { tenantUserId, campaignId, runId, credits, note } = opts;
  const wRef = db.collection(WALLETS_COLLECTION).doc(tenantUserId);
  const entryRef = wRef.collection(LEDGER).doc(`rel_${campaignId}_${runId}`);

  await db.runTransaction(async (tx) => {
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(wRef)]);
    if (entrySnap.exists) return; // settle already released it
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined);
    const released = Math.min(wallet.reserved, credits);
    tx.set(wRef, { reserved: wallet.reserved - released, updatedAt: new Date() }, { merge: true });
    tx.set(
      entryRef,
      baseEntry({
        type: 'release',
        credits: 0,
        balanceAfter: wallet.balance,
        reservedDelta: -released,
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
    const wallet = normalize(walletSnap.exists ? walletSnap.data() : undefined);

    const fromSubscription = Math.min(wallet.subscriptionBalance, credits);
    wallet.subscriptionBalance -= fromSubscription;
    wallet.purchasedBalance -= credits - fromSubscription;
    wallet.balance = wallet.subscriptionBalance + wallet.purchasedBalance;
    wallet.lifetimeSpentCredits += credits;
    wallet.suspended = wallet.balance < 0;

    tx.set(
      wRef,
      {
        balance: wallet.balance,
        subscriptionBalance: wallet.subscriptionBalance,
        purchasedBalance: wallet.purchasedBalance,
        lifetimeSpentCredits: wallet.lifetimeSpentCredits,
        suspended: wallet.suspended,
        updatedAt: new Date(),
      },
      { merge: true },
    );
    tx.set(
      entryRef,
      baseEntry({
        type: 'debit',
        credits: -credits,
        balanceAfter: wallet.balance,
        channel,
        segments: segments ?? null,
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
    const wallet = normalize(snap.data());
    const spendable = wallet.balance - wallet.reserved;
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
      const emailsLeft = Math.floor(Math.max(0, spendable) / config.channelRates.email.creditsPerMessage);
      const smsLeft = Math.floor(Math.max(0, spendable) / config.channelRates.sms.creditsPerSegment);
      const waLeft = Math.floor(Math.max(0, spendable) / config.channelRates.whatsapp.creditsPerMessage);
      await sendEmail(
        email,
        'HeidiFi: your messaging credits are running low',
        `<p>Your credit balance is down to <strong>${Math.max(0, spendable)} credits</strong> — roughly ` +
          `${emailsLeft} emails, ${smsLeft} one-segment SMS or ${waLeft} WhatsApp messages.</p>` +
          `<p>Top up in your HeidiFi dashboard under <strong>My Plan → Credit wallet</strong> to keep campaigns running.</p>`,
        0,
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[CREDITS] low-balance check failed:', err);
  }
}
