import { FieldValue } from 'firebase-admin/firestore';

export interface ConsentRecord {
  given: boolean;
  timestamp: string;   // ISO 8601 — moment checkbox was checked
  version: string;     // '1.0' — bump when policy text changes
  text?: string;       // exact consent copy shown to the user
}

export interface CreateUserRequestBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneCountryCode?: string;
  mac?: string;
  apmac?: string;
  ip?: string;
  url?: string;
  post?: string;
  timestamp?: string;
  privacyPolicyConsent?: ConsentRecord;
  termsConsent?: ConsentRecord;
  marketingConsent?: ConsentRecord;
}

export interface MarketingSmsMessage {
  content: string;
  delayMinutes: number;
}

export interface MarketingEmailMessage {
  subject: string;
  body: string;
  delayMinutes: number;
}

export interface MarketingChannelConfig<T> {
  enabled: boolean;
  messages: T[];
}

export interface AccessPointMarketing {
  sms?: MarketingChannelConfig<MarketingSmsMessage>;
  email?: MarketingChannelConfig<MarketingEmailMessage>;
  whatsapp?: MarketingChannelConfig<unknown>;
}

export type WifiEvent = 'onConnect' | 'onReconnect' | 'onDisconnect';

export interface AccessPointEvents {
  onConnect?: AccessPointMarketing;
  onReconnect?: AccessPointMarketing;
  // TODO: onDisconnect – implement when disconnect event is supported
}

export interface CaptivePortalMarketingDocument {
  wifiEvent: WifiEvent;
  channel: 'sms' | 'email';
  accessPointId: string;
  wifiGuestId: string;
  to: string;
  messageIndex: number;
  delayMinutes: number;
  sendAt: string;
  scheduledAt: FieldValue;
  deliveryStatus: string;
  statusUpdatedAt?: FieldValue;
  // SMS-specific
  messageSid?: string;
  content?: string;
  // Email-specific
  messageId?: string;
  subject?: string;
  body?: string;
  // Funnel tracking (short-link feature)
  shortCodes?: string[];
  clickCount?: number;
  firstClickedAt?: FieldValue | null;
  lastClickedAt?: FieldValue | null;
  firstVisitId?: string | null;
  visitedAt?: FieldValue | null;
  visitCount?: number;
  ratingId?: string | null;
  ratedAt?: FieldValue | null;
  rating?: number | null;
}

export interface CaptivePortalUserDocument {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCountryCode: string;
  mac: string;
  ip: string;
  url: string;
  post: string;
  timestamp: string;
  createdAt: FieldValue;
  captivePortalAccessPointId: string | null;
  connectionCount: number;
  marketingOptIn: boolean;
  privacyPolicyConsent: ConsentRecord;
  termsConsent: ConsentRecord;
  marketingConsent: ConsentRecord;
}

export interface CaptivePortalSessionDocument {
  wifiEvent: WifiEvent;
  wifiGuestId: string;
  accessPointId: string | null;
  mac: string;
  ip: string;
  timestamp: string;
  createdAt: FieldValue;
}
