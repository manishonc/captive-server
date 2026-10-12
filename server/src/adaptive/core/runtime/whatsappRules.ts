/**
 * PR W3: when a journey may use WhatsApp for one guest — the channel rules on top of the shared
 * ones (address, consent, block, audience, wording in core/runtime/pickers.ts). Pure.
 *
 *  - the launch setting `whatsappSending` is off            → whatsapp_off
 *  - Meta said the number can't get WhatsApp (131026)        → whatsapp_unreachable (30 days)
 *  - marketing to a +1 number (Meta delivers no marketing     → whatsapp_us_marketing
 *    templates to US numbers; +1 is the whole NANP region)
 *  - Meta held a marketing message back (131049)             → whatsapp_limited (24 hours)
 *
 * The block: the phone's own WhatsApp block (STOP, 131050) — and, for marketing, an SMS STOP
 * (W3-D1: one STOP ends marketing on SMS and WhatsApp).
 */

import { DAY_MS, HOUR_MS } from './time';

/** The channel reasons only WhatsApp has (Replay and the owner's words skip/explain them like `whatsapp_off`). */
export const WHATSAPP_CHANNEL_REASONS = ['whatsapp_off', 'whatsapp_unreachable', 'whatsapp_us_marketing', 'whatsapp_limited'] as const;

/** After Meta's 131049 ("held back to keep engagement healthy"): no WhatsApp marketing to the number for this long. */
export const WA_LIMITED_MS = 24 * HOUR_MS;
/** After Meta's 131026 (not on WhatsApp, or can't receive): no WhatsApp to the number for this long. */
export const WA_UNREACHABLE_MS = 30 * DAY_MS;

export interface WhatsAppRuleInput {
  on: boolean;
  purpose: 'marketing' | 'service';
  /** The phone's country (core/runtime/phoneCountry.ts): +1 reads as US. */
  phoneCountry: string | null;
  limitedUntil: number | null;
  unreachableUntil: number | null;
  now: number;
}

export function whatsappRuleFail(i: WhatsAppRuleInput): string | null {
  if (!i.on) return 'whatsapp_off';
  if (i.unreachableUntil !== null && i.unreachableUntil > i.now) return 'whatsapp_unreachable';
  if (i.purpose === 'marketing') {
    if (i.phoneCountry === 'US') return 'whatsapp_us_marketing';
    if (i.limitedUntil !== null && i.limitedUntil > i.now) return 'whatsapp_limited';
  }
  return null;
}

/** Why WhatsApp is blocked for this phone (null = not blocked): its own block, else an SMS STOP for marketing. */
export function whatsappBlocked(point: { suppression?: Partial<Record<string, { reason?: string } | undefined>> | null } | null, purpose: 'marketing' | 'service'): string | null {
  const own = point?.suppression?.whatsapp?.reason;
  if (own) return own;
  if (purpose === 'marketing' && point?.suppression?.sms?.reason === 'stop') return 'sms_stop';
  return null;
}

/** What a failed WhatsApp message (Meta's error code) changes for the number. */
export function whatsappFailureEffect(code: string | null | undefined): 'limited' | 'unreachable' | 'stop' | null {
  if (code === '131049') return 'limited';
  if (code === '131026') return 'unreachable';
  if (code === '131050') return 'stop';
  return null;
}
