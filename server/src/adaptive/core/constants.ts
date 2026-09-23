/**
 * Adaptive Campaigns — shared constants for the pure core.
 *
 * Everything under `adaptive/core` is pure TypeScript: no Firestore, no network,
 * no env. That is what lets the same rules run in the API, in the seed, in the
 * CMS-facing checks and in plain `npx tsx` tests.
 */

/** Semver of the (future) journey engine the definitions are validated against. */
export const ENGINE_VERSION = '1.0.0';
/** Range written onto every definition version we accept. */
export const ENGINE_RANGE = '^1.0.0';
/** Bumped whenever a rule in validatePlaybook / validateJourneyTemplate / validateSetup changes. */
export const VALIDATOR_VERSION = 'adaptive-validator@1';

export const SCHEMA_VERSION = 1;

export const LANGS = ['en', 'de', 'it', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

/**
 * `CaptivePortal_Venues.venue_type` is restaurant | cafe | airbnb today; `other`
 * is reserved for the Local business playbook and future venue kinds.
 */
export const VENUE_TYPES = ['restaurant', 'cafe', 'airbnb', 'other'] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

export const CHANNELS = ['sms', 'email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PLAYBOOK_KINDS = ['marketing', 'utility'] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

export const PLAYBOOK_ICONS = ['utensils', 'home', 'store', 'key', 'gift', 'layers', 'spark'] as const;
export type PlaybookIcon = (typeof PLAYBOOK_ICONS)[number];

export const OFFER_KINDS = ['free_item', 'percent', 'amount', 'upsell'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

/** Keys are stable ids: lowercase, start with a letter, underscores allowed. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
/** Playbook keys are also Firestore doc ids and part of `{venueId}_{playbookKey}`. */
export const PLAYBOOK_KEY_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

/** Human labels for venue types, used in check messages and owner-facing fit labels. */
export const VENUE_TYPE_LABELS: Record<VenueType, string> = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  airbnb: 'Airbnb',
  other: 'Other',
};

/** "Restaurants & cafés", "Restaurants, cafés & other businesses" — "Any venue" only when every type fits. */
export function fitLabel(types: VenueType[]): string {
  const has = (t: VenueType) => types.includes(t);
  if (has('restaurant') && has('cafe') && has('airbnb') && has('other')) return 'Any venue';
  if (types.length === 1 && has('airbnb')) return 'Airbnb & holiday rentals';
  const parts: string[] = [];
  if (has('restaurant')) parts.push('restaurants');
  if (has('cafe')) parts.push('cafés');
  if (has('airbnb')) parts.push('holiday rentals');
  if (has('other')) parts.push('other businesses');
  if (!parts.length) return 'No venue type yet';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Platform rules used when `CaptivePortal_AdaptiveConfig/global` cannot be read.
 * Same numbers as the seeded config (PRD 02 §3.4) so a read failure never loosens a bound.
 */
export const DEFAULT_RULES = {
  maxTouchesPerJourney: 5,
  stopAfterClicks: 3,
  maxDiscountPct: 50,
  offerExpiryDays: [1, 90] as [number, number],
};
