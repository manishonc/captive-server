/**
 * Tenant entitlements at SEND TIME — the authority for quota/flag decisions.
 *
 * Mirrors cms/app/api/captive-portal/_lib/entitlements.js (keep resolution
 * rules identical): active subscription -> plan quotas/flags (defaults keep
 * pre-billing tenants working: unlimited, aiEnabled:true, hidePoweredBy:false)
 * -> current UTC-month usage -> purchased credits -> remaining. The unified
 * credit wallet (CaptivePortal_CreditWallets) is exposed read-only; send-time
 * enforcement arrives with ENFORCE_CREDITS (cms docs/credit-system-spec.md §5.3).
 *
 * A 5-minute in-memory cache keeps the per-send overhead negligible; the
 * dispatch loop's own counters handle intra-run accounting.
 */

import { db } from '../firebase';

export const USAGE_COLLECTION = 'CaptivePortal_TenantUsage';
export const CREDITS_COLLECTION = 'CaptivePortal_TenantCredits';
export const WALLETS_COLLECTION = 'CaptivePortal_CreditWallets';

const CACHE_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'];

export type Channel = 'email' | 'sms' | 'whatsapp';

const CHANNELS: Array<{ channel: Channel; quotaKey: string }> = [
  { channel: 'email', quotaKey: 'emailsPerMonth' },
  { channel: 'sms', quotaKey: 'smsPerMonth' },
  { channel: 'whatsapp', quotaKey: 'whatsappPerMonth' },
];

const DEFAULT_QUOTAS: Record<string, number | null> = {
  emailsPerMonth: null,
  smsPerMonth: null,
  whatsappPerMonth: null,
};
const DEFAULT_FLAGS = { aiEnabled: true, hidePoweredBy: false };

export interface CreditWalletSnapshot {
  balance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  reserved: number;
  spendable: number;
  suspended: boolean;
}

export interface Entitlements {
  planId: string | null;
  quotas: Record<string, number | null>;
  flags: { aiEnabled: boolean; hidePoweredBy: boolean };
  usage: Record<Channel, number>;
  credits: Record<Channel, number>;
  /** null = unlimited; otherwise quota-remaining + credits. */
  remaining: Record<Channel, number | null>;
  month: string;
  /** Unified credit wallet — read-only exposure; enforcement is ENFORCE_CREDITS (Phase 3). */
  wallet: CreditWalletSnapshot;
  includedCreditsPerMonth: number | null;
  creditRollover: boolean;
}

interface CacheEntry {
  value: Entitlements;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** UTC calendar month id, e.g. "2026-07". */
export function currentUsageMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageDocId(tenantUserId: string, now = new Date()): string {
  return `${tenantUserId}_${currentUsageMonth(now)}`;
}

/** True once ENFORCE_QUOTAS=true is set — flips soft warnings into hard stops. */
export function quotasEnforced(): boolean {
  return process.env.ENFORCE_QUOTAS === 'true';
}

export async function getEntitlements(tenantUserId: string): Promise<Entitlements> {
  const cached = cache.get(tenantUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  type Raw = Record<string, unknown>;

  const subsSnap = await db
    .collection('CaptivePortal_Subscriptions')
    .where('tenantUserId', '==', tenantUserId)
    .get();
  const subs = subsSnap.docs
    .map((doc) => doc.data() as Raw)
    .filter((s) => ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status as string))
    .sort((a, b) => {
      const at = (a.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      const bt = (b.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      return bt - at;
    });
  const subscription = subs[0] ?? null;

  let plan: Raw | null = null;
  if (subscription?.planId) {
    const planSnap = await db.collection('CaptivePortal_Plans').doc(subscription.planId as string).get();
    if (planSnap.exists) plan = planSnap.data() as Raw;
  }

  const quotas: Record<string, number | null> = {
    ...DEFAULT_QUOTAS,
    ...((plan?.quotas as Record<string, number | null>) ?? {}),
  };
  const flags = { ...DEFAULT_FLAGS, ...((plan?.flags as Raw) ?? {}) } as Entitlements['flags'];

  const month = currentUsageMonth();
  const [usageSnap, creditsSnap, walletSnap] = await Promise.all([
    db.collection(USAGE_COLLECTION).doc(usageDocId(tenantUserId)).get(),
    db.collection(CREDITS_COLLECTION).doc(tenantUserId).get(),
    db.collection(WALLETS_COLLECTION).doc(tenantUserId).get(),
  ]);
  const usageData = (usageSnap.exists ? usageSnap.data() : {}) as Raw;
  const creditsData = (creditsSnap.exists ? creditsSnap.data() : {}) as Raw;
  const walletData = (walletSnap.exists ? walletSnap.data() : {}) as Raw;

  const usage = {} as Record<Channel, number>;
  const credits = {} as Record<Channel, number>;
  const remaining = {} as Record<Channel, number | null>;
  for (const { channel, quotaKey } of CHANNELS) {
    usage[channel] = Number((usageData[channel] as Raw)?.sent ?? 0);
    credits[channel] = Number((creditsData[channel] as Raw)?.balance ?? 0);
    const quota = quotas[quotaKey];
    remaining[channel] =
      quota === null || quota === undefined
        ? null
        : Math.max(0, Number(quota) - usage[channel]) + credits[channel];
  }

  const balance = Number(walletData.balance ?? 0);
  const reserved = Number(walletData.reserved ?? 0);
  const wallet: CreditWalletSnapshot = {
    balance,
    subscriptionBalance: Number(walletData.subscriptionBalance ?? 0),
    purchasedBalance: Number(walletData.purchasedBalance ?? 0),
    reserved,
    spendable: balance - reserved,
    suspended: walletData.suspended === true,
  };

  const includedRaw = Number(plan?.includedCreditsPerMonth);
  const value: Entitlements = {
    planId: (subscription?.planId as string) ?? null,
    quotas,
    flags,
    usage,
    credits,
    remaining,
    month,
    wallet,
    includedCreditsPerMonth: Number.isInteger(includedRaw) ? includedRaw : null,
    creditRollover: plan?.creditRollover === true,
  };
  cache.set(tenantUserId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Drop the cache entry (e.g. right after recording a large batch of sends). */
export function invalidateEntitlements(tenantUserId: string): void {
  cache.delete(tenantUserId);
}
