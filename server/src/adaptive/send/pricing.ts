/**
 * What an Adaptive message costs (PR F0): the rate card's prices, with SMS parts counted
 * by `core/runtime/smsParts.ts` (an emoji is two UTF-16 units, as Twilio bills it).
 *
 * The same rules as `creditsForMessage` / `providerCostForMessage` in `services/credits.ts`
 * (left as they are for the legacy campaigns), except for the SMS part count. Pure — the
 * rate card is only imported as a type, so the tests need no Firestore.
 */

import type { CreditConfig } from '../../services/credits';
import { smsSegmentCount } from '../core/runtime/smsParts';

type PricedChannel = 'email' | 'sms' | 'whatsapp';

/** Credits one message consumes: per part for SMS, flat otherwise. */
export function creditsFor(config: CreditConfig, channel: PricedChannel, smsText?: string): number {
  if (channel === 'sms') return config.channelRates.sms.creditsPerSegment * smsSegmentCount(smsText ?? '');
  if (channel === 'email') return config.channelRates.email.creditsPerMessage;
  return config.channelRates.whatsapp.creditsPerMessage;
}

/** HeidiFi's own provider cost for one message, in minor units (parts × cost for SMS). */
export function providerCostFor(config: CreditConfig, channel: PricedChannel, smsText?: string): number {
  const cost = Number(config.providerCosts[channel]?.costMinor ?? 0);
  if (channel === 'sms' && config.providerCosts.sms?.perSegment !== false) return cost * smsSegmentCount(smsText ?? '');
  return cost;
}
