import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Same service account + project (web-app-inhouse) as captive-server/server and the CMS.
// The MCP server reads CaptivePortal_* collections directly, tenant-scoped by the
// resolved tenantUserId from the OAuth access token.
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

export const db = getFirestore(app);
