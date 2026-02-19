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

export interface MarketingChannelConfig<T> {
  enabled: boolean;
  messages: T[];
}

export interface AccessPointMarketing {
  sms?: MarketingChannelConfig<MarketingSmsMessage>;
  email?: MarketingChannelConfig<unknown>;
  whatsapp?: MarketingChannelConfig<unknown>;
}

export interface CaptivePortalMarketingDocument {
  channel: 'sms';
  accessPointId: string;
  userId: string;
  messageSid: string;
  to: string;
  content: string;
  messageIndex: number;
  delayMinutes: number;
  sendAt: string;
  scheduledAt: FieldValue;
  deliveryStatus: string;
  statusUpdatedAt?: FieldValue;
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
  marketingOptIn: boolean;
  privacyPolicyConsent: ConsentRecord;
  termsConsent: ConsentRecord;
  marketingConsent: ConsentRecord;
}
