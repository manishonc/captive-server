/**
 * Collection names for Adaptive Campaigns. `store/` is the only place that knows
 * them (04-engine-runtime §1), so the rules in `core/` stay free of Firestore.
 */

export const COL = {
  // Owned by Adaptive Campaigns (new in this release)
  playbooks: 'CaptivePortal_Playbooks',
  journeyTemplates: 'CaptivePortal_JourneyTemplates',
  variants: 'CaptivePortal_Variants',
  questionBank: 'CaptivePortal_QuestionBank',
  config: 'CaptivePortal_AdaptiveConfig',
  adaptiveVenues: 'CaptivePortal_AdaptiveVenues',
  venuePlaybooks: 'CaptivePortal_VenuePlaybooks',
  // The engine (people + runtime), 02-firestore-schema §5–§7
  contactPoints: 'CaptivePortal_ContactPoints',
  networkPeople: 'CaptivePortal_NetworkPeople',
  contacts: 'CaptivePortal_Contacts',
  contactVenues: 'CaptivePortal_ContactVenues',
  consentEvents: 'CaptivePortal_ConsentEvents',
  visits: 'CaptivePortal_Visits',
  journeyInstances: 'CaptivePortal_JourneyInstances',
  journeyTasks: 'CaptivePortal_JourneyTasks',
  journeySends: 'CaptivePortal_JourneySends',
  journeyEvents: 'CaptivePortal_JourneyEvents',
  journeyStats: 'CaptivePortal_JourneyStats',
  venueGuestInfo: 'CaptivePortal_VenueGuestInfo',
  // Sending (PR B)
  alerts: 'CaptivePortal_AdaptiveAlerts',
  breakers: 'CaptivePortal_AdaptiveBreakers',
  /** Local sandbox only: messages the fake provider "sent". */
  sandboxOutbox: 'CaptivePortal_AdaptiveSandboxOutbox',
  // Existing collections the engine only reads
  settings: 'CaptivePortal_Settings',
  creditWallets: 'CaptivePortal_CreditWallets',
  tenantUsers: 'Users',
  // Existing collections — read only, never written from here
  venues: 'CaptivePortal_Venues',
  accessPoints: 'CaptivePortal_AccessPoints',
  guests: 'CaptivePortal_Users',
  entityMarketing: 'CaptivePortal_EntityMarketing',
  campaigns: 'CaptivePortal_Campaigns',
} as const;

export const VERSIONS = 'versions';
export const HISTORY = 'history';
export const CONFIG_DOC_ID = 'global';

export const adaptiveVenueId = (venueId: string) => `venue_${venueId}`;
export const venuePlaybookId = (venueId: string, playbookKey: string) => `${venueId}_${playbookKey}`;

/** `AdaptiveConfig/engine_status`: worker heartbeats, queue lag, the identity-key check. */
export const ENGINE_STATUS_DOC_ID = 'engine_status';
/** `AdaptiveConfig/dev_clock`: the sandbox's fake clock offset (local emulator only). */
export const DEV_CLOCK_DOC_ID = 'dev_clock';
export const contactVenueId = (contactId: string, venueId: string) => `${contactId}_${venueId}`;
export const guestInfoId = (venueId: string) => `venue_${venueId}`;
