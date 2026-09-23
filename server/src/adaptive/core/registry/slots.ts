/**
 * Slot types (03-playbook-format §6): the blanks an owner fills in.
 *
 * One function decides whether a value fits its slot, used for playbook
 * defaults (V04), owner setups (S03) and the CMS form hints alike.
 */

import { isI18n, type Offer, type SlotDef, type SlotValue } from '../schemas';

export interface SlotCheckContext {
  /** The offer menu the value must come from (playbook defaults or the venue's menu). */
  offers: Offer[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isEmpty(value: SlotValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (isI18n(value)) return !value.en.trim();
  return false;
}

/** Returns a short reason ("must be between 1 and 90") or null when the value fits. */
export function checkSlotValue(def: SlotDef, value: SlotValue | undefined, ctx: SlotCheckContext): string | null {
  if (isEmpty(value)) return def.required ? 'is required' : null;

  switch (def.type) {
    case 'text': {
      if (typeof value === 'string') {
        return value.length > def.maxLength ? `must be ${def.maxLength} characters or fewer` : null;
      }
      if (!def.i18n || !isI18n(value)) return 'must be plain text';
      const tooLong = Object.values(value).some((t) => typeof t === 'string' && t.length > def.maxLength);
      return tooLong ? `must be ${def.maxLength} characters or fewer` : null;
    }
    case 'int':
    case 'days': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
      return value < def.min || value > def.max ? `must be between ${def.min} and ${def.max}` : null;
    }
    case 'url': {
      if (typeof value !== 'string') return 'must be a link';
      if (value.length > 500) return 'is too long';
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'must start with https://';
      } catch {
        return 'must be a valid link';
      }
    }
    case 'offer': {
      if (typeof value !== 'string') return 'must be an offer from the menu';
      const offer = ctx.offers.find((o) => o.offerKey === value);
      if (!offer) return 'must be one of the offers in the menu';
      if (def.kinds && !def.kinds.includes(offer.kind)) return `must be a ${def.kinds.join(' or ')} offer`;
      return null;
    }
    case 'time':
      return typeof value === 'string' && HHMM.test(value) ? null : 'must look like 09:00';
    default:
      return 'has an unknown slot type';
  }
}

/** The value a slot starts with when neither the playbook nor the owner set one. */
export function slotStartValue(def: SlotDef): SlotValue {
  switch (def.type) {
    case 'text':
    case 'url':
      return def.default ?? null;
    case 'int':
    case 'days':
      return def.default ?? null;
    case 'time':
      return def.default ?? null;
    case 'offer':
      return null;
    default:
      return null;
  }
}
