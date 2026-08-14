/**
 * secretBox — authenticated symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * Port of the CMS's app/api/captive-portal/_lib/secret-box.ts, with the key env made a
 * parameter instead of hardcoding PMS_ENCRYPTION_KEY — the two apps hold different secrets
 * and should not share a key. The sealed format is byte-identical, so a value written by
 * either app can be read by the other given the same key.
 *
 * Sealed secrets are self-describing ({ ciphertext, iv, authTag, v }) so keys can be rotated
 * later by bumping the version and selecting on decrypt.
 *
 * Why encrypt rather than hash: the adoption account code has to be DISPLAYED back to the
 * tenant in the CMS whenever they add an access point, so a one-way hash would force a
 * show-once-at-generation flow. Encrypting keeps it displayable while a Firestore leak alone
 * yields nothing usable. The lookup path is separately hashed — see services/accountCode.ts.
 *
 * SECURITY: never log plaintext, and never return a decrypted secret to an unauthenticated
 * caller.
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM
const KEY_BYTES = 32; // AES-256
export const KEY_VERSION = 1;

export interface SealedSecret {
  /** base64 ciphertext */
  ciphertext: string;
  /** base64 IV / nonce */
  iv: string;
  /** base64 GCM authentication tag */
  authTag: string;
  /** key version used to seal (for rotation) */
  v: number;
}

const keyCache = new Map<string, Buffer>();

function loadKey(envVar: string): Buffer {
  const cached = keyCache.get(envVar);
  if (cached) return cached;

  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(`${envVar} is not configured — cannot encrypt or decrypt.`);
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envVar} must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  keyCache.set(envVar, key);
  return key;
}

/** True when `envVar` holds a valid key. Boot checks and fail-closed guards rely on this. */
export function isEncryptionConfigured(envVar: string): boolean {
  try {
    loadKey(envVar);
    return true;
  } catch {
    return false;
  }
}

/** Type guard: does the value look like a SealedSecret produced by `encryptSecret`? */
export function isSealedSecret(value: unknown): value is SealedSecret {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SealedSecret).ciphertext === 'string' &&
    typeof (value as SealedSecret).iv === 'string' &&
    typeof (value as SealedSecret).authTag === 'string'
  );
}

/** Encrypt a UTF-8 plaintext string into a self-describing sealed secret. */
export function encryptSecret(plaintext: string, envVar: string): SealedSecret {
  const key = loadKey(envVar);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    v: KEY_VERSION,
  };
}

/** Decrypt a sealed secret back to its UTF-8 plaintext. Throws on tamper / wrong key. */
export function decryptSecret(sealed: SealedSecret, envVar: string): string {
  if (!isSealedSecret(sealed)) {
    throw new Error('decryptSecret: value is not a sealed secret');
  }
  const key = loadKey(envVar); // future: select key by sealed.v during rotation
  const iv = Buffer.from(sealed.iv, 'base64');
  const authTag = Buffer.from(sealed.authTag, 'base64');
  const ciphertext = Buffer.from(sealed.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Test seam — drops cached keys so a test can swap the env between cases. */
export function __resetSecretBoxKeyCache(): void {
  keyCache.clear();
}
