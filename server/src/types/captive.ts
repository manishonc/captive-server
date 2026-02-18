import { FieldValue } from 'firebase-admin/firestore';

export interface CreateUserRequestBody {
  name?: string;
  email?: string;
  mac?: string;
  ip?: string;
  url?: string;
  post?: string;
  timestamp?: string;
}

export interface CaptivePortalUserDocument {
  name: string;
  email: string;
  mac: string;
  ip: string;
  url: string;
  post: string;
  timestamp: string;
  createdAt: FieldValue;
  captivePortalAccessPointId: string | null;
}
