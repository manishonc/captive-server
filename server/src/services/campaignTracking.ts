/**
 * Campaign delivery + engagement tracking.
 *
 * Updates per-recipient `CaptivePortal_CampaignSends` records and appends an
 * append-only `CaptivePortal_CampaignEvents` row as provider webhooks (Twilio /
 * WhatsApp / Brevo) and the open pixel report back. First-time transitions bump
 * the campaign's denormalized `stats` counters (unique delivered/bounced/opened/
 * clicked) via guarded transactions, so repeated webhook deliveries can't inflate.
 *
 * Click tracking for SMS/WhatsApp lives on the short-link docs
 * (`CaptivePortal_ShortLinks`, written at send time with the campaign id encoded
 * in `marketingDocId`); the monitoring dashboard aggregates those. Brevo also
 * reports email opens/clicks, handled here.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';

const CAMPAIGN_SENDS = 'CaptivePortal_CampaignSends';
const CAMPAIGN_EVENTS = 'CaptivePortal_CampaignEvents';
const CAMPAIGNS = 'CaptivePortal_Campaigns';

type EventType = 'delivered' | 'bounce' | 'open' | 'click' | 'convert';

/** Map a raw provider status into our funnel buckets. */
import { shouldAdvanceStatus } from './deliveryStatus';

function classify(status: string): 'delivered' | 'bounced' | 'failed' | null {
  const s = String(status || '').toLowerCase();
  // Opens are handled by recordOpen*, never routed here.
  if (['delivered', 'read'].includes(s)) return 'delivered';
  // Permanent (hard) bounces only — soft_bounce/deferred are transient and are
  // often followed by a 'delivered', so they must NOT count as a bounce.
  if (['bounced', 'hard_bounce', 'blocked', 'spam', 'invalid_email'].includes(s)) return 'bounced';
  if (['failed', 'undelivered', 'error'].includes(s)) return 'failed';
  return null; // sent / queued / accepted / soft_bounce / deferred — no funnel bump
}

async function writeEvent(send: any, sendId: string, eventType: EventType, extra: Record<string, unknown> = {}) {
  await db
    .collection(CAMPAIGN_EVENTS)
    .add({
      campaignId: send.campaignId || null,
      sendId,
      wifiGuestId: send.wifiGuestId || null,
      tenantUserId: send.tenantUserId || null,
      channel: send.channel || null,
      eventType,
      ...extra,
      timestamp: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.error('[CAMPAIGN EVENT WRITE ERROR]', err));
}

function bumpCampaignStat(campaignId: string | undefined, field: string, tx: FirebaseFirestore.Transaction) {
  if (!campaignId) return;
  tx.update(db.collection(CAMPAIGNS).doc(campaignId), { [`stats.${field}`]: FieldValue.increment(1) });
}

/** Update a send's delivery status (idempotent on the first delivered/bounced). */
async function applyDeliveryStatus(
  ref: DocumentReference,
  rawStatus: string,
  error?: unknown,
): Promise<void> {
  const bucket = classify(rawStatus);
  let send: any = null;
  let bumped: 'delivered' | 'bounced' | null = null;

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const d = doc.data() as any;
    send = d;
    const update: Record<string, unknown> = {};
    // Provider callbacks aren't ordered — only move the status forward, so a
    // late `delivered` can't demote a record that already reached `read`. The
    // counted flags below are evaluated regardless: they have their own
    // first-outcome-wins guards and must still fire on an out-of-order arrival.
    if (shouldAdvanceStatus(d.deliveryStatus, rawStatus)) {
      update.deliveryStatus = rawStatus;
      update.statusUpdatedAt = FieldValue.serverTimestamp();
    }
    if (error) update.deliveryError = error;
    // Mutually exclusive: a recipient counts toward delivered OR bounced, never
    // both (a delivered-then-bounced or bounced-then-delivered sequence keeps the
    // first terminal outcome), so unique delivered + bounced can't exceed sent.
    if (bucket === 'delivered' && !d.deliveredCounted && !d.bouncedCounted) {
      update.deliveredCounted = true;
      update.deliveredAt = FieldValue.serverTimestamp();
      bumped = 'delivered';
    } else if (bucket === 'bounced' && !d.bouncedCounted && !d.deliveredCounted) {
      update.bouncedCounted = true;
      update.bouncedAt = FieldValue.serverTimestamp();
      bumped = 'bounced';
    }
    // A duplicate or out-of-order callback can leave nothing to write.
    if (Object.keys(update).length > 0) tx.update(ref, update);
    if (bumped) bumpCampaignStat(d.campaignId, bumped, tx);
  });

  if (bumped && send) {
    await writeEvent(send, ref.id, bumped === 'delivered' ? 'delivered' : 'bounce', error ? { error } : {});
  }
}

/** Find the send by a provider id and apply the status. No-op if not a campaign send. */
export async function recordDeliveryStatus(
  providerField: 'messageSid' | 'wamid' | 'messageId',
  providerId: string,
  rawStatus: string,
  error?: unknown,
): Promise<void> {
  if (!providerId) return;
  const snap = await db.collection(CAMPAIGN_SENDS).where(providerField, '==', providerId).limit(1).get();
  if (snap.empty) return;
  await applyDeliveryStatus(snap.docs[0].ref, rawStatus, error);
}

/** Record an email open (idempotent unique-open; counts repeats in openCount). */
async function applyOpen(ref: DocumentReference): Promise<void> {
  let send: any = null;
  let firstOpen = false;
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const d = doc.data() as any;
    send = d;
    const update: Record<string, unknown> = {
      lastOpenedAt: FieldValue.serverTimestamp(),
      openCount: FieldValue.increment(1),
    };
    if (!d.openCounted) {
      update.openCounted = true;
      update.openedAt = FieldValue.serverTimestamp();
      firstOpen = true;
    }
    tx.update(ref, update);
    if (firstOpen) bumpCampaignStat(d.campaignId, 'opened', tx);
  });
  if (firstOpen && send) await writeEvent(send, ref.id, 'open');
}

/** Open pixel hit — sendId is the CampaignSends doc id embedded in the pixel URL. */
export async function recordOpenBySendId(sendId: string): Promise<void> {
  if (!sendId) return;
  await applyOpen(db.collection(CAMPAIGN_SENDS).doc(sendId));
}

/** Brevo "opened" event — resolve the send via the stored Brevo messageId. */
export async function recordOpenByMessageId(messageId: string): Promise<void> {
  if (!messageId) return;
  const snap = await db.collection(CAMPAIGN_SENDS).where('messageId', '==', messageId).limit(1).get();
  if (snap.empty) return;
  await applyOpen(snap.docs[0].ref);
}

/** Record an email click (idempotent unique-click; counts repeats in clickCount). */
export async function recordClickByMessageId(messageId: string, targetUrl?: string): Promise<void> {
  if (!messageId) return;
  const snap = await db.collection(CAMPAIGN_SENDS).where('messageId', '==', messageId).limit(1).get();
  if (snap.empty) return;
  const ref = snap.docs[0].ref;
  let send: any = null;
  let firstClick = false;
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const d = doc.data() as any;
    send = d;
    const update: Record<string, unknown> = {
      lastClickedAt: FieldValue.serverTimestamp(),
      clickCount: FieldValue.increment(1),
    };
    if (!d.clickCounted) {
      update.clickCounted = true;
      update.firstClickedAt = FieldValue.serverTimestamp();
      firstClick = true;
    }
    tx.update(ref, update);
    if (firstClick) bumpCampaignStat(d.campaignId, 'clicked', tx);
  });
  if (firstClick && send) await writeEvent(send, ref.id, 'click', targetUrl ? { targetUrl } : {});
}
