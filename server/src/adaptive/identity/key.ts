/**
 * The identity key: turns an email or phone number into a contact-point id
 * (02-firestore-schema §1, "Contact hashing") so STOP, bounces and the
 * cross-venue weekly limit work without raw addresses in shared documents.
 *
 * Manish's rule is "no new env", so the key is DERIVED from the existing
 * `GUEST_OTP_PEPPER` (the guest-data pepper the OTP feature already uses) with a
 * fixed label — a separate key in practice, never stored anywhere. Changing that
 * pepper would change every id, so the worker compares fingerprints — the API's,
 * carried on each connect task, and the one pinned in `engine_status.identity` —
 * and holds connects, warns, or stays idle when they differ (see worker/worker.ts).
 */

import { createHash, createHmac } from 'crypto';

const LABEL = 'adaptive-identity-v1';

let cachedKey: Buffer | null | undefined;

function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const pepper = process.env.GUEST_OTP_PEPPER;
  cachedKey = pepper ? createHmac('sha256', pepper).update(LABEL).digest() : null;
  return cachedKey;
}

export function identityReady(): boolean {
  return key() !== null;
}

/** Short, non-reversible fingerprint of the derived key (safe to store and compare). */
export function keyFingerprint(): string | null {
  const k = key();
  return k ? createHash('sha256').update(k).digest('hex').slice(0, 12) : null;
}

export class IdentityNotConfiguredError extends Error {
  constructor() {
    super('GUEST_OTP_PEPPER is not set — Adaptive cannot recognise guests');
    this.name = 'IdentityNotConfiguredError';
  }
}

/** `cp_` + 32 hex of HMAC(key, "email:anna@x.ch") — the same person always maps to the same id. */
export function contactPointId(kind: 'email' | 'phone', normalized: string): string {
  const k = key();
  if (!k) throw new IdentityNotConfiguredError();
  return `cp_${createHmac('sha256', k).update(`${kind}:${normalized}`).digest('hex').slice(0, 32)}`;
}

/** For tests only. */
export function __resetIdentityKey(): void {
  cachedKey = undefined;
}
