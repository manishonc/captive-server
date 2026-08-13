/**
 * Plan feature flags for the MCP service.
 *
 * MCP access is itself a plan feature (`flags.mcpEnabled`). Gating it lives
 * here rather than in a tool because it has to apply to EVERY request: a
 * tenant whose plan loses MCP must stop working immediately, not merely be
 * unable to connect a new client.
 *
 * Mirrors resolvePlanFlags in:
 *   - cms  app/api/captive-portal/_lib/plan-quotas.js
 *   - server  src/services/entitlements.ts
 * Keep the defaults and the resolution order identical across all three.
 */

import { db } from './firebase';

type Raw = Record<string, unknown>;

export interface PlanFlags {
  aiEnabled: boolean;
  hidePoweredBy: boolean;
  mcpEnabled: boolean;
  analyticsEnabled: boolean;
  customBrandingEnabled: boolean;
}

/** Every default is permissive — an absent field must not remove a feature. */
export const DEFAULT_FLAGS: PlanFlags = {
  aiEnabled: true,
  hidePoweredBy: false,
  mcpEnabled: true,
  analyticsEnabled: true,
  customBrandingEnabled: true,
};

/** Resolution order: defaults -> legacy top-level fields -> `plan.flags`. */
export function resolvePlanFlags(plan: Raw | null): PlanFlags {
  const flags: PlanFlags = { ...DEFAULT_FLAGS };
  if (!plan) return flags;

  if (plan.analyticsEnabled !== undefined) flags.analyticsEnabled = Boolean(plan.analyticsEnabled);
  if (plan.customBrandingEnabled !== undefined) {
    flags.customBrandingEnabled = Boolean(plan.customBrandingEnabled);
  }

  const raw = plan.flags as Raw | undefined;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_FLAGS) as Array<keyof PlanFlags>) {
      if (raw[key] !== undefined) flags[key] = Boolean(raw[key]);
    }
  }
  return flags;
}

/** A lapsed trial entitles nothing — see isLapsedTrial in the other two repos. */
function isLapsedTrial(subscription: Raw, now = new Date()): boolean {
  if (subscription?.status !== 'trialing') return false;
  const rawEnd = subscription.trialEndsAt as { toDate?: () => Date } | Date | string | undefined;
  const endsAt =
    (rawEnd as { toDate?: () => Date })?.toDate?.() ?? (rawEnd as Date | string | undefined);
  if (!endsAt) return false;
  const time = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
  if (!Number.isFinite(time)) return false;
  return time <= now.getTime();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: PlanFlags; expiresAt: number }>();

/**
 * Flags for a tenant, cached for five minutes to keep the per-request cost off
 * the hot path. The TTL means switching MCP off takes up to five minutes to
 * bite — acceptable for a plan change, and it matches the server's own
 * entitlements cache.
 */
export async function getPlanFlags(tenantUserId: string): Promise<PlanFlags> {
  const cached = cache.get(tenantUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const subsSnap = await db
    .collection('CaptivePortal_Subscriptions')
    .where('tenantUserId', '==', tenantUserId)
    .get();
  const subs = subsSnap.docs
    .map((doc) => doc.data() as Raw)
    .filter((s) => ['active', 'trialing'].includes(s.status as string))
    .filter((s) => !isLapsedTrial(s))
    .sort((a, b) => {
      const at = (a.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      const bt = (b.createdAt as { toDate?: () => Date })?.toDate?.()?.getTime?.() ?? 0;
      return bt - at;
    });

  let plan: Raw | null = null;
  const planId = subs[0]?.planId as string | undefined;
  if (planId) {
    const planSnap = await db.collection('CaptivePortal_Plans').doc(planId).get();
    if (planSnap.exists) plan = planSnap.data() as Raw;
  }

  const value = resolvePlanFlags(plan);
  cache.set(tenantUserId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Drop a tenant's cached flags (e.g. right after a plan change). */
export function invalidatePlanFlags(tenantUserId: string): void {
  cache.delete(tenantUserId);
}
