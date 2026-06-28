import { db } from '../firebase';

/**
 * Periodic sweep of expired OAuth artifacts.
 *
 * Firestore TTL policies are the primary cleanup, but they lag (up to ~24h batches),
 * which is far too slow for 60-second auth codes. This hourly sweep is the
 * belt-and-suspenders. Lazy delete-on-read in the store functions covers the rest.
 */
const COLLECTIONS = [
  'McpOAuth_AuthRequests',
  'McpOAuth_Codes',
  'McpOAuth_AccessTokens',
  'McpOAuth_RefreshTokens',
] as const;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_LIMIT = 200;

async function sweepOnce(): Promise<void> {
  const now = Date.now();
  for (const collection of COLLECTIONS) {
    try {
      const snapshot = await db.collection(collection).where('expiresAt', '<=', now).limit(BATCH_LIMIT).get();
      if (snapshot.empty) continue;
      const batch = db.batch();
      snapshot.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    } catch (err) {
      console.error(`[tokenCleanup] error sweeping ${collection}:`, err);
    }
  }
}

export function startTokenCleanup(): void {
  // Fire once shortly after boot, then hourly.
  setTimeout(() => sweepOnce().catch(() => {}), 10_000);
  setInterval(() => sweepOnce().catch(() => {}), SWEEP_INTERVAL_MS);
  console.log('[heidifi-mcp] token cleanup scheduled (hourly sweep)');
}
