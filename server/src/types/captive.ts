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

export interface MarketingWhatsAppMessage {
  templateName: string;
  languageCode: string;
  content: string;
  delayMinutes: number;
}

export interface MarketingChannelConfig<T> {
  enabled: boolean;
  messages: T[];
}

export interface AccessPointMarketing {
  sms?: MarketingChannelConfig<MarketingSmsMessage>;
  email?: MarketingChannelConfig<MarketingEmailMessage>;
  whatsapp?: MarketingChannelConfig<MarketingWhatsAppMessage>;
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
  templateMessageId?: string | null;
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

export type ConnectedPageFieldType = 'checkbox' | 'text';

export interface ConnectedPageField {
  /** Slug (^[a-z0-9][a-z0-9_-]{0,39}$) — also used as a Firestore field-path segment. */
  id: string;
  type: ConnectedPageFieldType;
  label: string;
  placeholder?: string;   // text type only
  required?: boolean;
  enabled?: boolean;
}

export interface ConnectedPageConfig {
  title: string;
  subtitle: string;
  showTitle: boolean;
  showSubtitle: boolean;
  /** Connected-page-specific logo visibility (splash logo asset is reused). */
  showLogo: boolean;
  buttonText: string;
  buttonUrl: string;
  showButton: boolean;
  /** When true the Submit button is hidden and answers store on each interaction. */
  autoSubmit: boolean;
  customFields: ConnectedPageField[];
}

export interface ConnectedFormResponse {
  value: boolean | string;
  label: string;
  submittedAt: string;  // ISO 8601
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
  /** Set when the guest used an unsubscribe link / one-click. Excludes them from
   *  every future marketing send (see services/campaigns.ts isOptedIn). */
  unsubscribed?: boolean;
  unsubscribedAt?: FieldValue | null;
  /** Answers submitted from the post-connection "connected" page custom fields, keyed by field id. */
  connectedFormResponses?: Record<string, ConnectedFormResponse>;
  connectedFormUpdatedAt?: FieldValue;
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

export type UnifiControllerType = 'classic' | 'udm';

export interface UnifiConfig {
  controllerType: UnifiControllerType;
  controllerUrl: string;
  site: string;
  username: string;
  password: string;
}

export interface UnifiAuthorizeRequestBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneCountryCode?: string;
  clientMac?: string;
  apMac?: string;
  url?: string;
  ssid?: string;
  timestamp?: string;
  privacyPolicyConsent?: ConsentRecord;
  termsConsent?: ConsentRecord;
  marketingConsent?: ConsentRecord;
}
