/**
 * Write-backs onto `CaptivePortal_Marketing` — the venue-automation send
 * records (as opposed to `CaptivePortal_CampaignSends`, handled in
 * campaignTracking.ts).
 *
 * The Twilio and WhatsApp webhooks already update Marketing docs inline. The
 * Brevo webhook never did, which is why venue-automation email sat at
 * `scheduled` forever and had no open tracking at all, while the identical
 * events were being recorded correctly against campaign sends.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { shouldAdvanceStatus } from './deliveryStatus';

const MARKETING = 'CaptivePortal_Marketing';

type ProviderField = 'messageSid' | 'wamid' | 'messageId';

async function findByProviderId(field: ProviderField, providerId: string) {
  const snap = await db.collection(MARKETING).where(field, '==', providerId).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Apply a delivery status to the matching Marketing doc.
 *
 * No-op when nothing matches — most provider callbacks belong to campaign
 * sends, not venue automation, and vice versa.
 *
 * @returns whether a Marketing record matched (not whether it was written —
 *          a duplicate or out-of-order callback matches but changes nothing)
 */
export async function recordMarketingDeliveryStatus(
  field: ProviderField,
  providerId: string,
  status: string,
  error?: unknown,
): Promise<boolean> {
  if (!providerId || !status) return false;

  const doc = await findByProviderId(field, providerId);
  if (!doc) return false;

  const update: Record<string, unknown> = {};
  // Provider callbacks aren't ordered; only ever move forward.
  if (shouldAdvanceStatus(doc.data()?.deliveryStatus, status)) {
    update.deliveryStatus = status;
    update.statusUpdatedAt = FieldValue.serverTimestamp();
  }
  if (error) update.deliveryError = error;

  if (Object.keys(update).length > 0) await doc.ref.update(update);
  return true;
}

/**
 * Record an email open. `openCounted` is the unique-open flag (first open only);
 * `openCount` counts every reported open including repeats.
 *
 * Deliberately mirrors the CampaignSends field names so the two collections
 * stay readable side by side.
 *
 * Note on accuracy: Brevo reports opens via a tracking pixel, so this inherits
 * the usual undercount from images-off clients and the usual overcount from
 * prefetching proxies. It is an engagement signal, not a headcount.
 */
export async function recordMarketingOpen(messageId: string): Promise<void> {
  if (!messageId) return;

  const doc = await findByProviderId('messageId', messageId);
  if (!doc) return;

  await applyMarketingOpen(doc.ref);
}

/**
 * Open-pixel hit — `sendId` is the Marketing doc id embedded in the pixel URL
 * by services/openPixel.ts. Mirrors campaignTracking.recordOpenBySendId.
 *
 * @returns whether a Marketing doc matched. `GET /t/o/:sendId` tries the
 *          campaign collection first and falls through to here, so a miss on
 *          both is simply an unknown id.
 */
export async function recordMarketingOpenBySendId(sendId: string): Promise<boolean> {
  if (!sendId) return false;
  return applyMarketingOpen(db.collection(MARKETING).doc(sendId));
}

/**
 * Shared open write for both entry points. Transactional because the pixel can
 * fire repeatedly and concurrently (mail clients prefetch, users reopen), and a
 * read-then-update would race itself into a lost `openCounted`.
 */
async function applyMarketingOpen(
  ref: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  let existed = false;
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    existed = true;

    const update: Record<string, unknown> = {
      lastOpenedAt: FieldValue.serverTimestamp(),
      openCount: FieldValue.increment(1),
    };
    if (!doc.data()?.openCounted) {
      update.openCounted = true;
      update.openedAt = FieldValue.serverTimestamp();
    }
    tx.update(ref, update);
  });
  return existed;
}
