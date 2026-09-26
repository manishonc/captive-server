/**
 * An account's display name from its `Users` doc, for HeidiFi's admin screens (the launch card's
 * `accountNames`, guest search's `account.name`; PR E follow-up). Pure.
 *
 * The docs don't agree on the field: staff docs have `displayName` (cms `api/admin`), owners who
 * signed up through the captive portal have `display_name` (cms `captive-auth/register`), older
 * docs `companyName` or `name`. The first non-empty one wins; null when there is none.
 */

export const ACCOUNT_NAME_FIELDS = ['displayName', 'display_name', 'companyName', 'name'] as const;

export function accountNameOf(get: (field: string) => unknown): string | null {
  for (const field of ACCOUNT_NAME_FIELDS) {
    const value = get(field);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
