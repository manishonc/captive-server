/**
 * Credit metering for venue marketing (`CaptivePortal_EntityMarketing`).
 *
 * These are the on-connect SMS / WhatsApp / email messages a venue configures
 * per Wi-Fi event. Until now they were the one send path in the product that
 * cost the business real provider money and charged the tenant nothing: no
 * admissibility check, no debit, no ledger entry. A venue with three enabled
 * channels could message every guest forever on an empty wallet.
 *
 * Modelled on the automation gate in services/campaigns.ts (spec §5.3.6) and
 * deliberately the same shape: no reservation at this volume — take one wallet
 * snapshot per guest event, admit message by message against it, debit each
 * accepted send. Concurrent events can drift by a message or two; that is the
 * bounded overspend the spec accepts, and it settles on the next read.
 *
 * Fails OPEN everywhere. A wallet read that errors, or enforcement switched
 * off, admits everything — a metering fault must never silence a paying
 * venue's marketing.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import {
  getCreditConfig,
  getWalletSnapshot,
  creditsForMessage,
  providerCostForMessage,
  debitOne,
  creditsEnforcementMode,
  onCreditsSpent,
  type CreditChannel,
} from './credits';
import { availableTotal } from './creditBuckets';
import { isLapsedForSending } from './entitlements';

const MARKETING_SENDS = 'CaptivePortal_Marketing';

export interface VenueMarketingBudget {
  /** False when enforcement is off or the wallet could not be read. */
  enforcing: boolean;
  own: Record<CreditChannel, number>;
  sharedPool: number;
  rateCardVersion: number;
  tenantUserId: string;
  config: Awaited<ReturnType<typeof getCreditConfig>>;
}

/**
 * Take the per-event snapshot. One wallet read per guest event, shared by all
 * three channels — call once at the top of an event handler, not per message.
 *
 * Returns a non-enforcing budget rather than null on any failure, so callers
 * have one code path instead of a null check at every send site.
 */
export async function openVenueMarketingBudget(
  tenantUserId: string,
): Promise<VenueMarketingBudget> {
  const config = await getCreditConfig().catch(() => null);
  const open: VenueMarketingBudget = {
    enforcing: false,
    own: { email: 0, sms: 0, whatsapp: 0 },
    sharedPool: 0,
    rateCardVersion: config?.rateCardVersion ?? 0,
    tenantUserId,
    config: config!,
  };

  if (!config || creditsEnforcementMode() !== 'enforce') return open;

  try {
    const wallet = await getWalletSnapshot(tenantUserId);
    // A suspended wallet admits nothing — that is the hard lock, and it is the
    // one case where failing closed is the point.
    if (wallet.suspended) {
      return { ...open, enforcing: true, own: { email: 0, sms: 0, whatsapp: 0 }, sharedPool: 0 };
    }
    return {
      ...open,
      enforcing: true,
      own: {
        email: availableTotal(wallet.channelBalances.email),
        sms: availableTotal(wallet.channelBalances.sms),
        whatsapp: availableTotal(wallet.channelBalances.whatsapp),
      },
      sharedPool: availableTotal(wallet.channelBalances.shared),
    };
  } catch (error) {
    console.error('[VENUE MARKETING CREDITS] wallet read failed; admitting sends:', error);
    return open;
  }
}

/**
 * The single gate every venue-marketing send path opens before dispatching:
 * is this venue's tenant allowed to send at all, and what can they afford?
 *
 * Combines the subscription check and the wallet snapshot so one guest event
 * costs one venue read plus one wallet read, shared across all three channels,
 * instead of each channel resolving the tenant for itself.
 *
 * Returns null when the venue must not send — a lapsed subscription, or a venue
 * with no tenant. Callers treat null as "skip this channel entirely".
 */
export async function openVenueMarketingGate(
  venueId: string,
  logTag: string,
): Promise<VenueMarketingBudget | null> {
  let tenantUserId: string | undefined;
  try {
    const venueDoc = await db.collection('CaptivePortal_Venues').doc(venueId).get();
    tenantUserId = venueDoc.data()?.tenantUserId as string | undefined;
  } catch (error) {
    console.error(`${logTag} venue lookup failed; admitting sends:`, error);
    return openNonEnforcingBudget('');
  }
  // An orphan venue has no wallet to charge and no subscription to check.
  // Historic behaviour is to send anyway; metering it is a separate question.
  if (!tenantUserId) return openNonEnforcingBudget('');

  try {
    if (await isLapsedForSending(tenantUserId)) {
      console.warn(`${logTag} Skipping: subscription lapsed for tenant of venue`, venueId);
      return null;
    }
  } catch (error) {
    console.error(`${logTag} billing check failed; allowing send:`, error);
  }

  return openVenueMarketingBudget(tenantUserId);
}

/** A budget that admits everything — the shape returned on every fail-open path. */
function openNonEnforcingBudget(tenantUserId: string): VenueMarketingBudget {
  return {
    enforcing: false,
    own: { email: 0, sms: 0, whatsapp: 0 },
    sharedPool: 0,
    rateCardVersion: 0,
    tenantUserId,
    config: null as unknown as Awaited<ReturnType<typeof getCreditConfig>>,
  };
}

export interface Admission {
  /** False when this channel cannot pay for the message. */
  ok: boolean;
  /** What the message costs, whether or not it was admitted. */
  cost: number;
}

/**
 * May this message be sent, and what does it cost?
 *
 * SMS is priced from the FINAL content — segments depend on the actual text
 * after variant resolution, link swapping and any opt-out suffix — so callers
 * must pass what they are really about to send, not the template.
 *
 * Reserving against the channel's own credits before the shared pool is
 * deliberate: it is the order that admits the most subsequent messages.
 */
export function admitVenueMarketingMessage(
  budget: VenueMarketingBudget,
  channel: CreditChannel,
  smsContent?: string,
): Admission {
  if (!budget.enforcing || !budget.config) return { ok: true, cost: 0 };

  const cost = creditsForMessage(budget.config, channel, smsContent);
  if (cost <= 0) return { ok: true, cost: 0 };

  const fromOwn = Math.min(cost, budget.own[channel]);
  const fromShared = cost - fromOwn;
  if (fromShared > budget.sharedPool) return { ok: false, cost };

  // Held locally so the next message in this same event sees the spend.
  budget.own[channel] -= fromOwn;
  budget.sharedPool -= fromShared;
  return { ok: true, cost };
}

/**
 * Debit an admitted send. Idempotent on `sendId` via `debit_auto_{sendId}`.
 *
 * Best-effort by design: the message has already gone out by the time this
 * runs, so a failure here must not throw back into the send path. It is logged
 * and the wallet self-corrects on the next reconcile.
 */
export async function chargeVenueMarketingMessage(
  budget: VenueMarketingBudget,
  opts: { sendId: string; channel: CreditChannel; cost: number; smsContent?: string },
): Promise<void> {
  if (!budget.enforcing || !budget.config || opts.cost <= 0) return;

  try {
    await debitOne({
      tenantUserId: budget.tenantUserId,
      sendId: opts.sendId,
      credits: opts.cost,
      channel: opts.channel,
      rateCardVersion: budget.rateCardVersion,
      providerCostMinorSnapshot: providerCostForMessage(
        budget.config,
        opts.channel,
        opts.smsContent,
      ),
    });
    await onCreditsSpent(budget.tenantUserId).catch(() => {});
  } catch (error) {
    console.error('[VENUE MARKETING CREDITS] debit failed:', error);
  }
}

/**
 * Record a message that could not be paid for.
 *
 * Written rather than dropped so "why did my venue stop texting guests" has an
 * answer in the data, and so the same held-send shape the campaign engine uses
 * covers this path too.
 */
export async function recordHeldVenueMarketingSend(opts: {
  tenantUserId: string;
  venueId: string;
  wifiGuestId: string;
  channel: CreditChannel;
  cost: number;
  wifiEvent: string;
  messageIndex: number;
}): Promise<void> {
  try {
    await db.collection(MARKETING_SENDS).add({
      tenantUserId: opts.tenantUserId,
      venueId: opts.venueId,
      wifiGuestId: opts.wifiGuestId,
      channel: opts.channel,
      messageIndex: opts.messageIndex,
      deliveryStatus: 'held_insufficient_credits',
      heldChannel: opts.channel,
      heldCredits: opts.cost,
      heldReason: 'channel_budget',
      wifiEvent: opts.wifiEvent,
      source: 'venue_marketing',
      statusUpdatedAt: FieldValue.serverTimestamp(),
      scheduledAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('[VENUE MARKETING CREDITS] held-send record failed:', error);
  }
}
