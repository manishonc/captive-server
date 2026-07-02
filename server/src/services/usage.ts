/**
 * Usage metering — counts provider-accepted sends per tenant per UTC month.
 *
 * The dispatch loop is the single choke point for all outbound marketing
 * (broadcasts, automations), so incrementing here captures everything.
 * Counters use FieldValue.increment (atomic); credits are decremented only
 * for sends past the monthly quota, mirroring the entitlements math.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import {
  CREDITS_COLLECTION,
  USAGE_COLLECTION,
  currentUsageMonth,
  getEntitlements,
  invalidateEntitlements,
  usageDocId,
  type Channel,
} from './entitlements';

/**
 * Record `count` accepted sends on a channel. Also consumes purchased credits
 * for the portion that exceeds the monthly quota (based on the usage BEFORE
 * this batch), so credit balances drain in step with overage.
 */
export async function recordSends(tenantUserId: string, channel: Channel, count: number): Promise<void> {
  if (!tenantUserId || count <= 0) return;

  try {
    const entitlements = await getEntitlements(tenantUserId);

    const usageRef = db.collection(USAGE_COLLECTION).doc(usageDocId(tenantUserId));
    await usageRef.set(
      {
        tenantUserId,
        month: currentUsageMonth(),
        [channel]: { sent: FieldValue.increment(count) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Credits cover the overage past the plan quota (null quota = unlimited,
    // so nothing to consume).
    const quotaKey =
      channel === 'email' ? 'emailsPerMonth' : channel === 'sms' ? 'smsPerMonth' : 'whatsappPerMonth';
    const quota = entitlements.quotas[quotaKey];
    if (quota !== null && quota !== undefined) {
      const usedBefore = entitlements.usage[channel];
      const overage = Math.max(0, usedBefore + count - Number(quota)) - Math.max(0, usedBefore - Number(quota));
      const consume = Math.min(overage, entitlements.credits[channel]);
      if (consume > 0) {
        await db
          .collection(CREDITS_COLLECTION)
          .doc(tenantUserId)
          .set(
            { [channel]: { balance: FieldValue.increment(-consume) }, updatedAt: FieldValue.serverTimestamp() },
            { merge: true },
          );
      }
    }

    invalidateEntitlements(tenantUserId);
  } catch (err) {
    // Metering must never break sending.
    console.error('[USAGE] recordSends failed:', err);
  }
}
