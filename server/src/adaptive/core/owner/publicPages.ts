/**
 * The two small guest pages (plan §5 `GET /public/offer|info/:shortCode`, §6; PR D decision
 * D-D7): how long a link works, what the offer's status is, and when the info page may show
 * the Wi-Fi password and door code. Pure.
 *
 * The info page reads the CURRENT Guest info, so an old or forwarded link would show the next
 * guest's door code. Hence:
 *  - a stay link shows the Wi-Fi password, door code and key instructions only from 12 h before
 *    check-in to 2 h after checkout, while the stay is still this guest's;
 *  - any other link shows the Wi-Fi password only, for 30 days after the send — never a door code;
 *  - info links work until checkout + 7 days (stays) or 30 days after the send; offer links until
 *    the offer's expiry + 7 days ("expired" is shown before that).
 */

import { DAY_MS, HOUR_MS } from '../runtime/time';

export const SECRETS_BEFORE_CHECKIN_MS = 12 * HOUR_MS;
export const SECRETS_AFTER_CHECKOUT_MS = 2 * HOUR_MS;
export const NON_STAY_SECRETS_MS = 30 * DAY_MS;
export const STAY_LINK_AFTER_CHECKOUT_MS = 7 * DAY_MS;
export const NON_STAY_LINK_MS = 30 * DAY_MS;
export const OFFER_LINK_AFTER_EXPIRY_MS = 7 * DAY_MS;

export type OfferStatus = 'valid' | 'expired' | 'redeemed';

export function offerStatus(now: number, expiresAt: number | null, redeemed: boolean): OfferStatus {
  if (redeemed) return 'redeemed';
  if (expiresAt !== null && now > expiresAt) return 'expired';
  return 'valid';
}

/** Does an offer link still open (else: gone)? Without an expiry, 30 days after the send. */
export function offerLinkOpen(now: number, expiresAt: number | null, sentAt: number): boolean {
  const until = expiresAt !== null ? expiresAt + OFFER_LINK_AFTER_EXPIRY_MS : sentAt + NON_STAY_LINK_MS;
  return now <= until;
}

export interface InfoStay {
  checkInAt: number;
  checkOutAt: number;
  /** Still this guest's (not unlinked, not cancelled). */
  current: boolean;
}

/** Does an info link still open? */
export function infoLinkOpen(now: number, sentAt: number, stay: InfoStay | null): boolean {
  if (stay) return stay.current && now <= stay.checkOutAt + STAY_LINK_AFTER_CHECKOUT_MS;
  return now <= sentAt + NON_STAY_LINK_MS;
}

export interface SecretsView {
  wifiPassword: boolean;
  doorCode: boolean;
  from: number | null;
  until: number | null;
}

/** Which secrets the page may show now. */
export function secretsShown(now: number, sentAt: number, stay: InfoStay | null): SecretsView {
  if (stay) {
    const from = stay.checkInAt - SECRETS_BEFORE_CHECKIN_MS;
    const until = stay.checkOutAt + SECRETS_AFTER_CHECKOUT_MS;
    const open = stay.current && now >= from && now <= until;
    return { wifiPassword: open, doorCode: open, from, until };
  }
  const until = sentAt + NON_STAY_SECRETS_MS;
  return { wifiPassword: now <= until, doorCode: false, from: sentAt, until };
}

/**
 * A Guest info field for the info page: the guest's language, then English, then any other
 * language (map §7.3). The info link goes out when any language has content (D-C21), so the page
 * must show it. (Messages stay guest's language → English, `guestInfoField`.)
 */
export function pageField(gi: { locales?: Record<string, Record<string, unknown> | undefined> } | null, lang: string, field: string): string | null {
  const locales = gi?.locales ?? {};
  const order = [lang, 'en', ...Object.keys(locales).filter((l) => l !== lang && l !== 'en').sort()];
  for (const l of order) {
    const v = locales[l]?.[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
