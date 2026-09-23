/**
 * Merge fields (03-playbook-format §7): the `{{ … }}` blanks inside wording.
 *
 * Today's tokens ({{firstName}}, {{venueName}}, {{ratingUrl}}, {{unsubscribeUrl}})
 * are accepted as aliases so existing copy keeps working. Secret Guest info fields
 * (Wi-Fi password, door code) are only allowed in service wording (PRD UT-2, V14).
 */

export interface MergeFilter {
  name: string;
  arg?: string;
}

export interface MergeExpression {
  raw: string;
  name: string;
  filters: MergeFilter[];
}

const EXPRESSION = /\{\{\s*([a-zA-Z][\w.]*)\s*((?:\|\s*[a-zA-Z]+(?:\s*:\s*"[^"]*")?\s*)*)\}\}/g;
const FILTER = /\|\s*([a-zA-Z]+)(?:\s*:\s*"([^"]*)")?/g;

export const LEGACY_ALIASES: Record<string, string> = {
  firstName: 'contact.firstName',
  lastName: 'contact.lastName',
  venueName: 'venue.name',
  ratingUrl: 'link.rating',
  unsubscribeUrl: 'link.unsubscribe',
};

export const KNOWN_FILTERS = new Set(['default', 'date']);

const FIELDS = new Set([
  'contact.firstName',
  'contact.lastName',
  'venue.name',
  'offer.label',
  'offer.expiryDate',
  'offer.days',
  'link.offer',
  'link.rating',
  'link.hub',
  'link.unsubscribe',
  'link.booking',
  'stay.checkInDate',
  'stay.checkOutDate',
  'stay.nights',
  'guestinfo.wifiName',
  'guestinfo.checkInTime',
  'guestinfo.checkOutTime',
  'guestinfo.houseRules',
  'guestinfo.hostContactUrl',
  'guestinfo.openingHours',
  'guestinfo.menuUrl',
]);

const SECRET_PREFIX = 'guestinfo.secret.';
const SECRET_FIELDS = new Set(['wifiPassword', 'doorCode', 'keyInstructions']);

/** Every `{{ … }}` in a text, in order. Malformed braces are simply not matched. */
export function parseMergeExpressions(text: string): MergeExpression[] {
  const out: MergeExpression[] = [];
  for (const match of text.matchAll(EXPRESSION)) {
    const filters: MergeFilter[] = [];
    for (const f of (match[2] || '').matchAll(FILTER)) {
      filters.push(f[2] !== undefined ? { name: f[1], arg: f[2] } : { name: f[1] });
    }
    out.push({ raw: match[0], name: match[1], filters });
  }
  return out;
}

export function canonicalField(name: string): string {
  return LEGACY_ALIASES[name] ?? name;
}

/**
 * Whether a merge field may be used in wording of this purpose.
 * Returns a short reason when it may not, or null when it is fine.
 */
export function checkMergeField(
  name: string,
  opts: { purpose: 'marketing' | 'service'; slotKeys: string[] },
): string | null {
  const field = canonicalField(name);
  if (field.startsWith('slot.')) {
    return opts.slotKeys.includes(field.slice(5)) ? null : `refers to a blank this journey doesn't have (${field})`;
  }
  if (field.startsWith(SECRET_PREFIX)) {
    if (!SECRET_FIELDS.has(field.slice(SECRET_PREFIX.length))) return `is not a known field (${field})`;
    return opts.purpose === 'service' ? null : `secret Guest info can only go in info messages (${field})`;
  }
  return FIELDS.has(field) ? null : `is not a known field (${field})`;
}
