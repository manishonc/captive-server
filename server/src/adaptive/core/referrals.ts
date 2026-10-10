/**
 * Bring-a-friend (PR A7, the manager's spec §5 A7): "after 2nd revisit — dual-redemption code,
 * both get the offer; friend's splash signup attributes the referral". Pure rules, no Firestore:
 * the code's shape, what a guest typed, and whether a sign-up with a code counts.
 *
 * A regular gets one personal code per venue (`MIA-7K2Q`) in their invite. A friend types it on
 * the splash when they sign up; it counts when the friend is new at that venue, isn't the regular
 * and the code still has room (the first 3 friends, A7-D4) and hasn't expired (60 days).
 */

import type { I18n, Offer } from './schemas';

/** Prices the invite before the code exists: as long as the longest code (8 + dash + 4). */
export const REFERRAL_CODE_STANDIN = 'XXXXXXXX-XXXX';

/** What a friend gets, stored on the code: enough to say it on the splash ("10% off today"). */
export interface FriendOffer {
  offerKey: string;
  label: I18n;
  kind: Offer['kind'];
  value: number;
}

/** The friend's offer for the code (the invite's `friend_offer` blank → the playbook's offer). */
export function friendOfferOf(slotValue: unknown, offers: Offer[]): FriendOffer | null {
  if (typeof slotValue !== 'string') return null;
  const offer = offers.find((o) => o.offerKey === slotValue);
  return offer ? { offerKey: offer.offerKey, label: offer.label, kind: offer.kind, value: offer.value } : null;
}

/** How long a code works, from its invite (days). */
export const REFERRAL_CODE_DAYS = 60;
/** Friends a regular is rewarded for (A7-D4). */
export const REFERRAL_MAX_FRIENDS = 3;
/** Letters and digits nobody misreads: no 0/O, 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SUFFIX_LENGTH = 4;
const NAME_MAX = 8;

/** The name part: the first name's letters A–Z (accents dropped), at most 8; else FRIEND. */
export function codeNamePart(firstName: string | null | undefined): string {
  const letters = String(firstName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, NAME_MAX);
  return letters.length >= 2 ? letters : 'FRIEND';
}

/** A code: the name part, a dash and 4 characters from the alphabet (`random` gives 0 ≤ x < 1). */
export function makeReferralCode(firstName: string | null | undefined, random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) suffix += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return `${codeNamePart(firstName)}-${suffix}`;
}

/**
 * What a guest typed, as a code to look up: upper case, spaces gone, a missing dash put back
 * before the last 4 characters (`mia7k2q` → `MIA-7K2Q`). Null when it can't be a code.
 */
export function normalizeFriendCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[\s_.]/g, '');
  if (!s) return null;
  if (!s.includes('-') && s.length > SUFFIX_LENGTH) s = `${s.slice(0, -SUFFIX_LENGTH)}-${s.slice(-SUFFIX_LENGTH)}`;
  return /^[A-Z]{2,8}-[A-Z0-9]{4}$/.test(s) ? s : null;
}

/** The parts of a stored code the rules read. */
export interface ReferralCodeFacts {
  venueId: string;
  contactId: string;
  expiresAt: number;
  friendsCredited: number;
  maxFriends: number;
  friendContactIds: string[];
}

export type FriendCodeCheck = 'ok' | 'unknown' | 'other_venue' | 'expired' | 'full';

/** On the splash (before we know who the friend is): may this code show its offer here? */
export function checkCodeForVenue(code: ReferralCodeFacts | null, venueId: string, now: number): FriendCodeCheck {
  if (!code) return 'unknown';
  if (code.venueId !== venueId) return 'other_venue';
  if (now >= code.expiresAt) return 'expired';
  if (code.friendsCredited >= code.maxFriends) return 'full';
  return 'ok';
}

export type ReferralDecision = FriendCodeCheck | 'own_code' | 'not_new' | 'already_counted';

/**
 * When the friend's sign-up is handled (the worker, after the guest is known): does it count?
 * Only a first visit at this venue by someone other than the regular, once per friend.
 */
export function decideReferral(
  code: ReferralCodeFacts | null,
  friend: { venueId: string; contactId: string; isFirstVisit: boolean; at: number },
): ReferralDecision {
  const base = checkCodeForVenue(code, friend.venueId, friend.at);
  if (base !== 'ok') return base;
  if (code!.contactId === friend.contactId) return 'own_code';
  if (code!.friendContactIds.includes(friend.contactId)) return 'already_counted';
  if (!friend.isFirstVisit) return 'not_new';
  return 'ok';
}
