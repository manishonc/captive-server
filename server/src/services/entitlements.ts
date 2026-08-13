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
import {
  classifySubscriptionState,
  isLapsedTrial,
  type SubscriptionState,
} from './subscriptionState';

export type { SubscriptionState } from './subscriptionState';

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

/**
 * Every flag defaults PERMISSIVE. These gate real features now, so an absent
 * field on an old plan doc must never take something away from a paying
 * tenant — a gate only bites once an admin deliberately turns it off.
 *
 * `analyticsEnabled` / `customBrandingEnabled` used to live top-level rather
 * than under `flags`; `resolvePlanFlags` folds the legacy shape in.
 * Mirrors DEFAULT_FLAGS in cms _lib/plan-quotas.js.
 */
const DEFAULT_FLAGS: PlanFlags = {
  aiEnabled: true,
  hidePoweredBy: false,
  mcpEnabled: true,
  analyticsEnabled: true,
  customBrandingEnabled: true,
};

/** Credit bucket keys on a plan grant. Order is part of the cross-repo contract. */
const PLAN_CREDIT_KEYS = ['email', 'sms', 'whatsapp', 'shared'] as const;

export type PlanFlags = {
  aiEnabled: boolean;
  hidePoweredBy: boolean;
  mcpEnabled: boolean;
  analyticsEnabled: boolean;
  customBrandingEnabled: boolean;
};

export type PlanIncludedCredits = Record<(typeof PLAN_CREDIT_KEYS)[number], number>;

/**
 * The ONLY way plan feature flags should be read.
 * Resolution order: defaults -> legacy top-level fields -> `plan.flags`.
 * Mirrors resolvePlanFlags in cms _lib/plan-quotas.js.
 */
function resolvePlanFlags(plan: Record<string, unknown> | null): PlanFlags {
  const flags: PlanFlags = { ...DEFAULT_FLAGS };
  if (!plan) return flags;

  if (plan.analyticsEnabled !== undefined) flags.analyticsEnabled = Boolean(plan.analyticsEnabled);
  if (plan.customBrandingEnabled !== undefined) {
    flags.customBrandingEnabled = Boolean(plan.customBrandingEnabled);
  }

  const raw = plan.flags as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_FLAGS) as Array<keyof PlanFlags>) {
      if (raw[key] !== undefined) flags[key] = Boolean(raw[key]);
    }
  }
  return flags;
}

/**
 * Resolve a plan's per-channel credit grant.
 *
 * A plan carrying only the legacy scalar `includedCreditsPerMonth` resolves to
 * `{ shared: N }` — channel-less credits ARE shared credits, which is what the
 * pre-per-channel grant wrote. Mirrors resolvePlanCredits in cms
 * _lib/plan-quotas.js.
 */
function resolvePlanCredits(plan: Record<string, unknown> | null): {
  includedCredits: PlanIncludedCredits;
  total: number;
} {
  const includedCredits = Object.fromEntries(
    PLAN_CREDIT_KEYS.map((k) => [k, 0]),
  ) as PlanIncludedCredits;

  const raw = plan?.includedCredits as Record<string, unknown> | undefined;
  let sawAnyValue = false;
  if (raw && typeof raw === 'object') {
    for (const key of PLAN_CREDIT_KEYS) {
      const num = Number(raw[key]);
      if (Number.isInteger(num) && num > 0) {
        includedCredits[key] = num;
        sawAnyValue = true;
      }
    }
  }
  if (!sawAnyValue) {
    const scalar = Number(plan?.includedCreditsPerMonth);
    if (Number.isInteger(scalar) && scalar > 0) includedCredits.shared = scalar;
  }

  const total = PLAN_CREDIT_KEYS.reduce((sum, k) => sum + includedCredits[k], 0);
  return { includedCredits, total };
}

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
  /**
   * Reported, not enforced — quotas/flags keep their documented fail-open
   * defaults. Lets a caller tell "billing lapsed" from "never had billing"
   * instead of inferring either from a null plan. Mirrors the CMS field of the
   * same name (_lib/entitlements.js).
   */
  subscriptionState: SubscriptionState;
  quotas: Record<string, number | null>;
  flags: PlanFlags;
  /** -1 = unlimited. Enforced in the CMS at venue / access-point creation. */
  limits: { maxVenues: number; maxAccessPointsPerVenue: number };
  usage: Record<Channel, number>;
  credits: Record<Channel, number>;
  /** null = unlimited; otherwise quota-remaining + credits. */
  remaining: Record<Channel, number | null>;
  month: string;
  /** Unified credit wallet — read-only exposure; enforcement is ENFORCE_CREDITS (Phase 3). */
  wallet: CreditWalletSnapshot;
  /** Per-channel plan grant; `shared` is spendable on any channel. */
  includedCredits: PlanIncludedCredits;
  /** Derived total of includedCredits; null = plan grants nothing. */
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
  const allSubs = subsSnap.docs.map((doc) => doc.data() as Raw);
  const subs = allSubs
    .filter((s) => ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status as string))
    .filter((s) => !isLapsedTrial(s))
    .sort((a, b) => {
      const at = (a.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      const bt = (b.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      return bt - at;
    });
  const subscription = subs[0] ?? null;
  const subscriptionState = classifySubscriptionState(subscription, allSubs);

  let plan: Raw | null = null;
  if (subscription?.planId) {
    const planSnap = await db.collection('CaptivePortal_Plans').doc(subscription.planId as string).get();
    if (planSnap.exists) plan = planSnap.data() as Raw;
  }

  const quotas: Record<string, number | null> = {
    ...DEFAULT_QUOTAS,
    ...((plan?.quotas as Record<string, number | null>) ?? {}),
  };
  const flags = resolvePlanFlags(plan);
  const planCredits = resolvePlanCredits(plan);
  // -1 = unlimited. No plan resolves to unlimited rather than zero.
  const limits = {
    maxVenues: Number.isInteger(plan?.maxVenues) ? (plan!.maxVenues as number) : -1,
    maxAccessPointsPerVenue: Number.isInteger(plan?.maxAccessPointsPerVenue)
      ? (plan!.maxAccessPointsPerVenue as number)
      : -1,
  };

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

  const value: Entitlements = {
    planId: (subscription?.planId as string) ?? null,
    subscriptionState,
    quotas,
    flags,
    limits,
    usage,
    credits,
    remaining,
    month,
    wallet,
    includedCredits: planCredits.includedCredits,
    // Recomputed from the map, never read from the stored scalar — a plan doc
    // whose mirror has drifted still reports what the map actually grants.
    includedCreditsPerMonth: planCredits.total > 0 ? planCredits.total : null,
    creditRollover: plan?.creditRollover === true,
  };
  cache.set(tenantUserId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Drop the cache entry (e.g. right after recording a large batch of sends). */
export function invalidateEntitlements(tenantUserId: string): void {
  cache.delete(tenantUserId);
}

/**
 * Dispatch-time lapse gate for time-shifted sends (the campaign scheduler).
 *
 * The CMS's `requireActiveSubscription` (cms _lib/plan-gates.js) runs when the
 * tenant clicks send/schedule — but a broadcast scheduled for Sep 1 by a tenant
 * who cancels on Aug 20 sails straight past it. This is the same gate applied
 * at the moment that matters for a scheduled send: dispatch. Same three
 * narrowing conditions, and all three matter there and here:
 *
 *  1. `requireCardForTrial` is ON (`CaptivePortal_Settings/global`) — the flag
 *     stays a complete kill-switch; turning it off relaxes every gate,
 *     including this one. An unreadable settings doc reads as OFF, the
 *     historical behaviour.
 *  2. The account's `Users` doc has `trialActivatedAt`, i.e. it went through
 *     the card flow. A grandfathered card-free tenant has no such stamp and is
 *     never gated, even though their expired trial classifies as 'lapsed'.
 *  3. `subscriptionState === 'lapsed'` — history but nothing retained. 'none'
 *     is excluded (pre-billing tenants), and 'payment_failed' is retained
 *     access (see DUNNING_STATUS in services/subscriptionState.ts).
 *
 * Fails open: if the billing lookup itself errors, this reports NOT lapsed and
 * the send goes out — a Firestore hiccup in a billing check must not silently
 * kill a legitimate scheduled campaign.
 *
 * @returns true when the tenant is lapsed and the send must be withheld.
 */
export async function isLapsedForSending(tenantUserId: string): Promise<boolean> {
  try {
    const settingsSnap = await db.collection('CaptivePortal_Settings').doc('global').get();
    if (settingsSnap.data()?.requireCardForTrial !== true) return false;

    const userSnap = await db.collection('Users').doc(tenantUserId).get();
    if (!userSnap.exists || !userSnap.data()?.trialActivatedAt) return false;

    const { subscriptionState } = await getEntitlements(tenantUserId);
    return subscriptionState === 'lapsed';
  } catch (error) {
    console.error(`[ENTITLEMENTS] lapse check failed for ${tenantUserId}; allowing dispatch:`, error);
    return false; // fail open — dispatch anyway, matching the CMS gate
  }
}
