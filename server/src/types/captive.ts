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
  privacyPolicyConsent: ConsentRecord;
  termsConsent: ConsentRecord;
  marketingConsent: ConsentRecord;
}
