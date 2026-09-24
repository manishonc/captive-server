/**
 * Stored shapes of the engine's collections (02-firestore-schema §5–§6, with the
 * plan's Δ changes). Times are Timestamps on read; writes pass Dates.
 */

import type { Channel, Lang } from '../core/constants';
import type { StoredTime } from './types';
import type { DecisionRecord } from '../core/runtime/decision';

export type ConsentState = 'granted' | 'revoked';
export type RevokedVia = 'channel' | 'page' | 'owner' | 'splash';

export interface ConsentEntry {
  state: ConsentState;
  at: StoredTime;
  eventId: string;
  revokedVia?: RevokedVia | null;
}

/** `{ 'venue:abc': { email?: …, sms?: …, whatsapp?: … } }` */
export type ConsentProjection = Record<string, Partial<Record<Channel, ConsentEntry>>>;

export interface SuppressionEntry {
  reason: 'hard_bounce' | 'spam_complaint' | 'stop' | 'erasure' | 'invalid';
  source: string;
  at: StoredTime;
  sendKey?: string | null;
}

export interface ContactPointDoc {
  kind: 'email' | 'phone';
  networkId: string;
  tenantContacts: Record<string, string>;
  suppression: Partial<Record<Channel, SuppressionEntry>>;
  hardBounceCount: number;
  lastBounceAt: StoredTime;
  verifiedAt: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface MarketingTouch {
  at: StoredTime;
  channel: Channel;
  tenantUserId: string;
  venueId: string;
  sendKey: string;
}

export interface NetworkPersonDoc {
  pointIds: string[];
  recentMarketingTouches: MarketingTouch[];
  status: 'active' | 'erased';
  erasedAt: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface ContactDoc {
  tenantUserId: string;
  networkId: string;
  status: 'active' | 'anonymized' | 'erased';
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailPointId: string | null;
  emailVerified: boolean;
  phoneE164: string | null;
  phonePointId: string | null;
  phoneVerified: boolean;
  phoneCountry: string | null;
  lang: Lang | null;
  langSource: 'splash' | 'default' | null;
  guestIds: string[];
  firstVenueId: string;
  firstSeenAt: StoredTime;
  lastSeenAt: StoredTime;
  marketingConsent: ConsentProjection;
  channelHealth: Partial<Record<Channel, { status: string; at: StoredTime }>>;
  engagement: {
    preferredChannel: Channel | null;
    preferredChannelSetAt: StoredTime;
    consecutiveNoClickOnPreferred: number;
    preferredSlot: string | null;
    slotHistogram: Record<string, number>;
    opens: number;
    clicks: number;
    lastClickAt: StoredTime;
    lastClickChannel: Channel | null;
  };
  replyNoticeSentAt: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface ContactVenueJourney {
  activeInstanceId: string | null;
  entries: number;
  lastEnteredAt: StoredTime;
  lastExitAt: StoredTime;
  lastExitReason: string | null;
}

export interface ContactVenueDoc {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  firstVisitAt: StoredTime;
  lastVisitAt: StoredTime;
  lastVisitEndedAt: StoredTime;
  lastSeenAt: StoredTime;
  visitCount: number;
  currentVisitId: string | null;
  lastConnectEventId: string | null;
  journeys: Record<string, ContactVenueJourney>;
  lowRatingAt: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface VisitDoc {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  guestId: string;
  apIds: string[];
  status: 'open' | 'closed';
  startedAt: StoredTime;
  lastSeenAt: StoredTime;
  endedAt: StoredTime;
  endSource: 'timeout' | 'next_visit' | null;
  startEventId: string;
  visitNumber: number;
  isFirstVisit: boolean;
  isRevisit: boolean;
  expireAt: StoredTime;
  schemaVersion: number;
}

export interface JourneySendDoc {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  instanceId: string | null;
  journeyKey: string | null;
  nodeId: string | null;
  templateVersion: number | null;
  configVersion: number | null;
  mode: 'test' | 'live';
  purpose: 'marketing' | 'service';
  channel: Channel;
  toPointId: string | null;
  toMasked: string;
  variantId: string | null;
  locale: Lang;
  slot: string;
  status: 'dispatching' | 'sent' | 'delivered' | 'read' | 'failed' | 'bounced' | 'unknown' | 'cancelled' | 'dry_run';
  provider: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  credits: { amount: number; ledgerId: string | null } | null;
  providerCostMinor: number | null;
  smsSegments: number | null;
  shortCodes: string[];
  content: { subject?: string; preview: string; bodyHash: string };
  engagement: { deliveredAt: StoredTime; openedAt: StoredTime; firstClickAt: StoredTime; clicks: number; repliedAt: StoredTime };
  attribution: { convertedAt: StoredTime; conversionEventId: string } | null;
  decision: DecisionRecord;
  dispatchLease: { owner: string; until: StoredTime } | null;
  createdAt: StoredTime;
  sentAt: StoredTime;
  updatedAt: StoredTime;
  expireAt: StoredTime;
  schemaVersion: number;
}

export interface JourneyEventDoc {
  type: string;
  tenantUserId: string | null;
  venueId: string | null;
  contactId: string | null;
  guestId: string | null;
  instanceId: string | null;
  journeyKey: string | null;
  nodeId: string | null;
  sendKey: string | null;
  variantId: string | null;
  channel: string | null;
  slot: string | null;
  source: 'portal' | 'engine' | 'brevo' | 'twilio' | 'meta' | 'shortlink' | 'cms' | 'scanner' | 'dev';
  occurredAt: StoredTime;
  recordedAt: StoredTime;
  data: Record<string, unknown>;
  expireAt: StoredTime;
  schemaVersion: number;
}
