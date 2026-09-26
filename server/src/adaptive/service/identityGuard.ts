/**
 * Looking a person up by email or phone in the API process (PR D: admin guest search, the MCP's
 * guest lookup) hashes the address with the key derived from `GUEST_OTP_PEPPER`. If this API's
 * pepper differs from the one the engine pinned, every lookup would quietly find nobody — so
 * refuse instead (fail closed), as the worker does for its own work.
 */

import { db } from '../../firebase';
import { COL, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { identityReady, keyFingerprint } from '../identity/key';
import { conflict } from '../api/errors';
import { unavailable } from '../api/http';
import { tsMs } from '../store/time';

export async function assertLookupKeyMatches(): Promise<void> {
  if (!identityReady()) throw unavailable("Guest lookups aren't possible: the identity key isn't configured on the server");
  const fp = keyFingerprint();
  const status = await db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get();
  const pinned = status.get('identity.keyFingerprint');
  if (typeof pinned === 'string') {
    if (pinned !== fp) throw conflict("The server's identity key differs from the engine's (GUEST_OTP_PEPPER) — lookups are off until it is fixed");
    return;
  }
  // Nothing pinned yet (no guest seen): compare with the workers that are running.
  const workers = (status.get('workers') ?? {}) as Record<string, { lastBeatAt?: unknown; keyFingerprint?: unknown }>;
  const alive = Object.values(workers).filter((w) => {
    const beat = tsMs(w.lastBeatAt);
    return beat !== null && Date.now() - beat < 3 * 60_000;
  });
  if (alive.some((w) => typeof w.keyFingerprint === 'string' && w.keyFingerprint !== fp)) {
    throw conflict("The server's identity key differs from the worker's (GUEST_OTP_PEPPER) — lookups are off until it is fixed");
  }
}
