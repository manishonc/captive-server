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
