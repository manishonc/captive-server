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
  /** Raw {fieldId: value} answers for loginPage.customFields — validated server-side. */
  splashResponses?: Record<string, unknown>;
  /** Splash-screen language the guest chose ('en'|'de'|'it'|'fr'). Absent when
   *  the venue offers one language or the guest never picked — see
   *  services/guestLanguage.ts for why absent is meaningful. */
  language?: string;
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
  /** Send guests to redirectUrl instead of rendering this page. Takes precedence
   *  over customFields — guests leave before they could answer. */
  redirectEnabled: boolean;
  /** https-only; anything else disables the redirect. Empty when unset. */
  redirectUrl: string;
  /** Seconds the connected page is shown before redirecting. Clamped 0-30. */
  redirectDelaySeconds: number;
}

export interface ConnectedFormResponse {
  value: boolean | string;
  label: string;
  submittedAt: string;  // ISO 8601
}

export interface SplashFieldConfig {
  /** Show/hide the field's .field-group on the splash form. */
  enabled: boolean;
  /** Custom label; '' keeps the template's baked-in label. */
  label: string;
  /** Enforced client-side in goToConsent(); server stays permissive like /create-user. */
  required: boolean;
}

export interface LoginPageConfig {
  fields: {
    firstName: SplashFieldConfig;
    lastName: SplashFieldConfig;
    email: SplashFieldConfig;
    phone: SplashFieldConfig;
  };
  /** #btnNext label. */
  buttonText: string;
  /** Extra splash-form fields, same shape/rules as the connected page (max 8). */
  customFields: ConnectedPageField[];
}

export interface ConsentPageConfig {
  /** .consent-heading */
  heading: string;
  /** .consent-sub */
  subheading: string;
  /** .consent-box paragraphs (1..4, each ≤1000 chars). Joined with '\n\n' this is the
   *  exact text stored in each guest's ConsentRecord. */
  bodyParagraphs: string[];
  /** #btnAccept label. */
  acceptButtonText: string;
  /** #btnDecline label. */
  declineButtonText: string;
}

export type VerificationChannel = 'email' | 'sms' | 'whatsapp';

/**
 * Guest contact verification (OTP). The runtime defaults and the resolver that
 * subtracts unusable channels live in services/verificationConfig.ts — this is
 * the shape only.
 *
 * `enabled` defaults to FALSE everywhere. Every venue predating this key reads
 * through the defaults, so a true default would put an OTP wall in front of the
 * whole estate's wifi on deploy.
 */
export interface VerificationPageConfig {
  enabled: boolean;
  channels: Record<VerificationChannel, { enabled: boolean }>;
  /** Pre-selected channel; always one of the enabled set after resolution. */
  defaultChannel: VerificationChannel;
  /** When false, only defaultChannel is offered. */
  allowGuestChoice: boolean;
  /** 'any' = one contact point suffices. 'all' = every enabled target. */
  requirement: 'any' | 'all';
  heading: string;
  subheading: string;
  codeInputLabel: string;
  sendButtonText: string;
  verifyButtonText: string;
  resendLabel: string;
  /** Skip re-verification on the same device for N days. 0 = every visit. */
  rememberDays: number;
}

export interface SplashScreenConfig {
  templateId: string;
  title: string;
  subtitle: string;
  logoUrl: string;
  showLogo: boolean;
  primaryColor: string;
  backgroundColor: string;
  /** @deprecated superseded by loginPage.fields; kept for stale portal builds and old docs. */
  collectEmail: boolean;
  /** @deprecated superseded by loginPage.fields; kept for stale portal builds and old docs. */
  collectName: boolean;
  /** false skips the consent step entirely (submitConsent(false)). */
  showMarketingOptIn: boolean;
  showPrivacyPolicy: boolean;
  showTermsOfService: boolean;
  loginPage: LoginPageConfig;
  consentPage: ConsentPageConfig;
  verificationPage: VerificationPageConfig;
  connectedPage: ConnectedPageConfig;
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
  /** Answers from splash-form custom fields (loginPage.customFields), keyed by field id. */
  splashFormResponses?: Record<string, ConnectedFormResponse>;
  /** Splash-screen language the guest chose ('en'|'de'|'it'|'fr'). Absent when
   *  the venue offers one language or the guest never picked — see
   *  services/guestLanguage.ts for why absent is meaningful. */
  language?: string;
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
  /** Raw {fieldId: value} answers for loginPage.customFields — validated server-side. */
  splashResponses?: Record<string, unknown>;
  /** Splash-screen language the guest chose ('en'|'de'|'it'|'fr'). Absent when
   *  the venue offers one language or the guest never picked — see
   *  services/guestLanguage.ts for why absent is meaningful. */
  language?: string;
}
