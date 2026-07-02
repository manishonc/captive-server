/**
 * Plan usage/entitlements read tool. Mirrors the CMS entitlements resolver
 * (cms app/api/captive-portal/_lib/entitlements.js): plan quotas/flags +
 * month-to-date usage + purchased credits.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../firebase';
import { NO_TENANT, errorResult, jsonResult, tenantFrom, type ToolExtra } from '../shared';

type Raw = Record<string, unknown>;

const DEFAULT_QUOTAS: Record<string, number | null> = {
  emailsPerMonth: null,
  smsPerMonth: null,
  whatsappPerMonth: null,
};
const DEFAULT_FLAGS = { aiEnabled: true, hidePoweredBy: false };
const CHANNELS = [
  { channel: 'email', quotaKey: 'emailsPerMonth' },
  { channel: 'sms', quotaKey: 'smsPerMonth' },
  { channel: 'whatsapp', quotaKey: 'whatsappPerMonth' },
] as const;

function currentUsageMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function registerUsageTools(server: McpServer): void {
  server.tool(
    'get_usage',
    'Get the tenant’s plan limits and month-to-date messaging usage: monthly quotas per channel (null = unlimited), messages already sent this month, purchased addon credits, and how many sends remain. Check this before launching large campaigns and warn the user about projected overages.',
    async (extra: ToolExtra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      // Active subscription → plan (quotas/flags default open for old docs).
      const subsSnap = await db
        .collection('CaptivePortal_Subscriptions')
        .where('tenantUserId', '==', tenantUserId)
        .get();
      const subs = subsSnap.docs
        .map((doc) => doc.data() as Raw)
        .filter((s) => ['active', 'trialing'].includes(s.status as string))
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

      const quotas = { ...DEFAULT_QUOTAS, ...((plan?.quotas as Raw) ?? {}) };
      const flags = { ...DEFAULT_FLAGS, ...((plan?.flags as Raw) ?? {}) };

      const month = currentUsageMonth();
      const [usageSnap, creditsSnap] = await Promise.all([
        db.collection('CaptivePortal_TenantUsage').doc(`${tenantUserId}_${month}`).get(),
        db.collection('CaptivePortal_TenantCredits').doc(tenantUserId).get(),
      ]);
      const usageData = (usageSnap.exists ? usageSnap.data() : {}) as Raw;
      const creditsData = (creditsSnap.exists ? creditsSnap.data() : {}) as Raw;

      const usage: Record<string, number> = {};
      const credits: Record<string, number> = {};
      const remaining: Record<string, number | null> = {};
      for (const { channel, quotaKey } of CHANNELS) {
        usage[channel] = Number((usageData[channel] as Raw)?.sent ?? 0);
        credits[channel] = Number((creditsData[channel] as Raw)?.balance ?? 0);
        const quota = quotas[quotaKey];
        remaining[channel] =
          quota === null || quota === undefined
            ? null // unlimited
            : Math.max(0, Number(quota) - usage[channel]) + credits[channel];
      }

      return jsonResult({
        planName: subscription?.planName ?? (plan?.name as string) ?? null,
        month,
        quotas,
        flags,
        usage,
        credits,
        remaining,
        note: 'remaining: null means unlimited. Credits are consumed after the monthly quota is exhausted.',
      });
    },
  );
}
