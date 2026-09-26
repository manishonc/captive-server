/**
 * Stored shapes of the engine's collections (02-firestore-schema §5–§6, with the
 * plan's Δ changes). Times are Timestamps on read; writes pass Dates.
 */

import type { Channel, Lang } from '../core/constants';
import type { StoredTime } from './types';
import type { DecisionRecord } from '../core/runtime/decision';
import type { ReplaySnapshot } from '../core/runtime/replay';

export type ConsentState = 'granted' | 'revoked';
export type RevokedVia = 'channel' | 'page' | 'owner' | 'splash';

export interface ConsentEntry {
  state: ConsentState;
  at: StoredTime;
  eventId: string;
  revokedVia?: RevokedVia | null;
  /** What caused the change (sms_keyword, unsubscribe_page, brevo_spam…): START re-grants only what STOP took. */
  source?: string | null;
  /**
   * The owner's "Stop marketing to this guest" covers this scope (PR D). It stays until the
   * owner resumes: a splash tick can't undo it, and START doesn't re-grant it.
   */
  ownerStopped?: boolean | null;
  /** On an owner revoke: was it granted before? Resume restores only a yes the guest gave. */
  ownerPrior?: 'granted' | 'none' | null;
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
  /** The last live Adaptive SMS to this number — a plain reply is matched to it. */
  lastLiveSms?: { sendKey: string; tenantUserId: string; at: StoredTime } | null;
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
  /** The owner stopped marketing to this guest at all their venues (PR D): venues opened later are covered too. */
  ownerStoppedAll?: { at: StoredTime; by: string } | null;
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
  /** The mode the visit started in (PR D): a visit from a test run never starts a live journey at its end. */
  startMode?: 'test' | 'live' | null;
  expireAt: StoredTime;
  schemaVersion: number;
}

export interface JourneySendDoc {
  tenantUserId: string;
  /** The channel's place on the journey's ladder, so a resumed step keeps it. */
  ladderPos?: number | null;
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
  /** Priced once in phase 1; every debit attempt reuses these numbers (debitOne's first write wins). */
  credits: { amount: number; ledgerId: string | null; rateCardVersion?: number } | null;
  providerCostMinor: number | null;
  smsSegments: number | null;
  shortCodes: string[];
  content: { subject?: string; preview: string; bodyHash: string };
  engagement: { deliveredAt: StoredTime; openedAt: StoredTime; firstClickAt: StoredTime; clicks: number; repliedAt: StoredTime };
  attribution: { convertedAt: StoredTime; conversionEventId: string } | null;
  decision: DecisionRecord;
  /** What the rules read, so Replay can re-run the decision (v2 decisions; null when it couldn't be built). */
  replay?: ReplaySnapshot | null;
  dispatchLease: { owner: string; until: StoredTime } | null;
  createdAt: StoredTime;
  sentAt: StoredTime;
  updatedAt: StoredTime;
  expireAt: StoredTime;
  schemaVersion: number;
  /** Reply notice: a service message outside any journey. */
  kind?: 'journey' | 'reply_notice';
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
  /** The instance's run mode, on engine events (test runs are kept apart in the rollups). */
  mode?: 'test' | 'live';
  source: 'portal' | 'engine' | 'brevo' | 'twilio' | 'meta' | 'shortlink' | 'cms' | 'scanner' | 'dev' | 'unsubscribe';
  occurredAt: StoredTime;
  recordedAt: StoredTime;
  data: Record<string, unknown>;
  expireAt: StoredTime;
  schemaVersion: number;
}

/**
 * `CaptivePortal_StayFeeds/venue_{venueId}` — one booking calendar per venue (plan §4.1,
 * Appendix A; the doc id is D-C34). The URL is stored unencrypted, in its standard form
 * (`normalizeFeedUrl`), and never logged or shown unmasked; `lastError` holds a code, never
 * a message.
 */
export interface StayFeedDoc {
  tenantUserId: string;
  venueId: string;
  kind: 'ical';
  url: string;
  status: 'active' | 'paused' | 'failing';
  lastPolledAt: StoredTime;
  lastSuccessAt: StoredTime;
  /** A code (`TIMEOUT`, `LINK_INVALID`, `HTTP_503`…), never raw error text. */
  lastError: string | null;
  consecutiveErrors: number;
  /** When the current run of errors started (the owner email after 24 h, D-C25). */
  failingSince?: StoredTime;
  etag: string | null;
  upcomingCount: number;
  overlapCount?: number;
  /** Successful parses so far — read with the poll lease, so a stale poll can't write over a newer one. */
  successSeq: number;
  /** One poll at a time per feed (real time; the owner is the task or dev call). */
  pollLease?: { owner: string; until: StoredTime } | null;
  /** When the chain's next grid-slot poll is due (the watchdog restarts a feed whose value is missing or stale). */
  nextPollAt?: StoredTime;
  /** Hash of the last successful parse's normalized stays (a same-hash 200 is unchanged content). */
  lastContentHash: string | null;
  /** The countable stays absent from the last successful content (a 304's absent set). */
  lastMissingStayIds: string[];
  /** The feed has given at least one stay (a non-Airbnb feed then stays supported, D-C4). */
  reservedSeen: boolean;
  feedWarning: 'mass_missing' | 'unsupported_source' | null;
  /** When the current run of suspect parses began (D-C35). */
  suspectSince: StoredTime;
  /** Set when the owner saves a different link: bookings missing from it count at once (no 24 h hold) until the feed is back to normal. */
  guardLiftedAt?: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

/**
 * `CaptivePortal_Stays/st_{hash(feedId:uid)}` — one booking (plan §4.1, Appendix A).
 * Dates, UID and status only (D-C28): never the calendar's text, names or phone digits.
 */
export interface StayDoc {
  tenantUserId: string;
  venueId: string;
  feedId: string;
  externalUid: string;
  status: 'confirmed' | 'cancelled' | 'overlap_flagged';
  /** Venue-local dates; checkout is exclusive. */
  checkIn: string;
  checkOut: string;
  checkInAt: StoredTime;
  checkOutAt: StoredTime;
  nights: number;
  /** +1 on every date or time change and on a reinstatement: moment task keys and change event ids carry it. */
  datesVersion: number;
  /** The first guest who connected in the stay's window (never their details). */
  contactId: string | null;
  linkedAt: StoredTime;
  linkedGuestId?: string | null;
  /** test / live, frozen when the guest was linked (D-C13). */
  linkMode: 'test' | 'live' | null;
  lastSeenInFeedAt: StoredTime;
  missingCount: number;
  lastMissAt: StoredTime;
  overlapWith: string[];
  /** +1 on every unlink (PR D): the next guest's link gets new moment ids (stays/times.ts `linkSeqSuffix`). */
  linkSeq?: number;
  /** People the owner unlinked from this stay: never linked to it again automatically (at most 10). */
  unlinkedContactIds?: string[];
  /**
   * An owner's re-link at this link generation whose worker follow-up (stays/link.ts
   * handleStayRelinked) hasn't finished: no other path schedules this stay's moments meanwhile.
   */
  relinkPendingSeq?: number | null;
  unlinkedAt?: StoredTime;
  unlinkedBy?: string | null;
  /** Who made the current link: the first guest to connect, or the owner picking one by hand. */
  linkedBy?: 'guest' | 'owner' | null;
  cancelledAt?: StoredTime;
  cancelReason?: 'missing' | 'feed_deleted' | null;
  expireAt: StoredTime;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}
