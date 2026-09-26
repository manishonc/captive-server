/**
 * What an owner (and the MCP) sees of a guest (PR D): "Anna M.", a masked email or phone.
 * Pure. Never an address in full, never another owner's anything.
 */

import { maskDestination } from '../../../services/phone';

/** "Anna M." — first name and the initial of the last name; "Guest" when there is no name. */
export function maskedName(firstName: unknown, lastName: unknown): string {
  const first = typeof firstName === 'string' ? firstName.trim() : '';
  const last = typeof lastName === 'string' ? lastName.trim() : '';
  if (!first && !last) return 'Guest';
  if (!first) return `${last.slice(0, 1).toUpperCase()}.`;
  return last ? `${first} ${last.slice(0, 1).toUpperCase()}.` : first;
}

export function maskedEmail(email: unknown): string | null {
  return typeof email === 'string' && email.includes('@') ? maskDestination('email', email) : null;
}

export function maskedPhone(phone: unknown): string | null {
  return typeof phone === 'string' && phone.replace(/\D/g, '').length >= 6 ? maskDestination('sms', phone) : null;
}

export interface MaskedGuest {
  name: string;
  email: string | null;
  phone: string | null;
}

export function maskedGuest(c: { firstName?: unknown; lastName?: unknown; email?: unknown; phoneE164?: unknown } | null | undefined): MaskedGuest {
  return { name: maskedName(c?.firstName, c?.lastName), email: maskedEmail(c?.email), phone: maskedPhone(c?.phoneE164) };
}
