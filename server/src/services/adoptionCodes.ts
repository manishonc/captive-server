/**
 * Account code persistence — the Firestore half of services/accountCode.ts.
 *
 * TWO REPRESENTATIONS, deliberately, because the code has to be both unguessable at rest and
 * displayable on demand:
 *
 *   CaptivePortal_AccountCodes/{sha256(pepper:CODE)}  ->  { tenantUserId, ... }
 *       The lookup path. The document id is the hash, so a Firestore leak yields neither
 *       usable codes nor a reversible table, and resolution stays a single doc get.
 *
 *   Users/{tenantUserId}.captivePortalAccountCode     ->  SealedSecret (AES-256-GCM)
 *       The display path, for the CMS's "here is your code, copy it" card. Encrypted rather
 *       than hashed precisely so it CAN be shown again; readable only with
 *       ADOPTION_CODE_ENCRYPTION_KEY.
 *
 * Uniqueness comes from `.create()` throwing ALREADY_EXISTS (gRPC code 6) on the hashed id,
 * retried — the same trick services/shortlinks.ts uses, and the reason the code is the id.
 *
 * ROTATION IS NOT DELETION. The old code is marked with a `revokedAt` in the future, not
 * removed: an installer part-way through a job keeps working for the grace window instead of
 * getting an inscrutable failure halfway through a site visit. `resolveAccountCode` enforces
 * the deadline.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase';
import {
  accountCodeDocId,
  formatAccountCode,
  generateAccountCode,
  normalizeAccountCode,
} from './accountCode';
import { decryptSecret, encryptSecret, isSealedSecret, SealedSecret } from './secretBox';

const CODES_COLLECTION = 'CaptivePortal_AccountCodes';
const USERS_COLLECTION = 'Users';
const KEY_ENV = 'ADOPTION_CODE_ENCRYPTION_KEY';

/** How long a rotated-away code keeps working, so mid-install helpers don't break. */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_COLLISION_RETRIES = 6;

export interface AccountCodeRecord {
  tenantUserId: string;
  createdAt: Timestamp;
  revokedAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
}

export interface AccountCodeView {
  /** Canonical, no separators. */
  code: string;
  /** Display form, `H7K2-M9QX`. */
  formatted: string;
  createdAt: string | null;
}

/** True when the display-copy encryption key is configured. */
export function adoptionCodeStorageReady(): boolean {
  return Boolean(process.env[KEY_ENV]);
}

function isAlreadyExists(err: unknown): boolean {
  return (err as { code?: number })?.code === 6;
}

/**
 * Write one hashed code document, retrying on the astronomically unlikely collision.
 * Returns the plaintext code.
 */
async function mintCode(tenantUserId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const code = generateAccountCode();
    const ref = db.collection(CODES_COLLECTION).doc(accountCodeDocId(code));
    try {
      await ref.create({
        tenantUserId,
        createdAt: FieldValue.serverTimestamp(),
        revokedAt: null,
        lastUsedAt: null,
      });
      return code;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Collision: try another code.
    }
  }
  throw new Error('Could not allocate a unique account code.');
}

/** Read + decrypt the tenant's stored display copy, or null when absent/unreadable. */
function readStoredCode(userData: Record<string, unknown> | undefined): string | null {
  const sealed = userData?.captivePortalAccountCode;
  if (!isSealedSecret(sealed)) return null;
  try {
    return decryptSecret(sealed as SealedSecret, KEY_ENV);
  } catch (err) {
    // A wrong/rotated key must not look like "this tenant has no code" — that would mint a
    // second one and silently orphan the first, which is still live on the lookup path.
    console.error('[ADOPTION CODE] Stored code could not be decrypted:', (err as Error).message);
    throw new Error('The stored account code could not be read. Check ADOPTION_CODE_ENCRYPTION_KEY.');
  }
}

/**
 * The tenant's current code, minting one on first use. Idempotent: repeated calls return the
 * same code, so the CMS can call this on every render of the setup card.
 */
export async function ensureAccountCode(tenantUserId: string): Promise<AccountCodeView> {
  if (!tenantUserId) throw new Error('tenantUserId is required.');

  const userRef = db.collection(USERS_COLLECTION).doc(tenantUserId);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('Account not found.');

  const existing = readStoredCode(snap.data());
  if (existing) {
    return {
      code: existing,
      formatted: formatAccountCode(existing),
      createdAt: toIso(snap.data()?.captivePortalAccountCodeAt),
    };
  }

  const code = await mintCode(tenantUserId);
  await userRef.update({
    captivePortalAccountCode: encryptSecret(code, KEY_ENV),
    captivePortalAccountCodeAt: FieldValue.serverTimestamp(),
  });
  console.log('[ADOPTION CODE] Minted for tenant', tenantUserId);
  return { code, formatted: formatAccountCode(code), createdAt: null };
}

/**
 * Replace the tenant's code. The previous one keeps working for `ROTATION_GRACE_MS`.
 *
 * Order matters: mint and publish the new code BEFORE revoking the old one. The reverse
 * would leave a tenant with no working code at all if the second write failed.
 */
export async function rotateAccountCode(tenantUserId: string): Promise<AccountCodeView> {
  if (!tenantUserId) throw new Error('tenantUserId is required.');

  const userRef = db.collection(USERS_COLLECTION).doc(tenantUserId);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('Account not found.');
  const previous = readStoredCode(snap.data());

  const code = await mintCode(tenantUserId);
  await userRef.update({
    captivePortalAccountCode: encryptSecret(code, KEY_ENV),
    captivePortalAccountCodeAt: FieldValue.serverTimestamp(),
  });

  if (previous) {
    try {
      await db
        .collection(CODES_COLLECTION)
        .doc(accountCodeDocId(previous))
        .update({ revokedAt: Timestamp.fromMillis(Date.now() + ROTATION_GRACE_MS) });
    } catch (err) {
      // Best-effort: the new code is already live. A stale old code lingering past its grace
      // window is a smaller problem than failing the rotation the tenant just asked for.
      console.error('[ADOPTION CODE] Could not revoke previous code:', (err as Error).message);
    }
  }

  console.log('[ADOPTION CODE] Rotated for tenant', tenantUserId);
  return { code, formatted: formatAccountCode(code), createdAt: null };
}

/**
 * Resolve a submitted code to its tenant, or null when unknown or past its revocation.
 *
 * Returns null rather than throwing for every "no" so callers cannot accidentally leak which
 * kind of no it was, and so the caller's rate limiter sees one uniform failure.
 */
export async function resolveAccountCode(input: unknown): Promise<{ tenantUserId: string } | null> {
  const code = normalizeAccountCode(input);
  if (!code) return null;

  let docId: string;
  try {
    docId = accountCodeDocId(code);
  } catch {
    return null; // pepper missing — the route guard should have refused to mount
  }

  const snap = await db.collection(CODES_COLLECTION).doc(docId).get();
  if (!snap.exists) return null;

  const rec = snap.data() as AccountCodeRecord;
  if (!rec?.tenantUserId) return null;
  if (rec.revokedAt && rec.revokedAt.toMillis() <= Date.now()) return null;

  // Fire-and-forget: a last-used stamp is for support, and must never fail a live claim.
  snap.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => undefined);

  return { tenantUserId: rec.tenantUserId };
}

function toIso(value: unknown): string | null {
  const ts = value as Timestamp | undefined;
  return ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : null;
}
