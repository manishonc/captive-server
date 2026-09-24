/**
 * The engine's clock and the local sandbox switch.
 *
 * Production: the real clock, always. The sandbox (fake providers, fake clock,
 * dev routes) needs BOTH `ADAPTIVE_SANDBOX=1` and `FIRESTORE_EMULATOR_HOST`, so it
 * can't switch on against the real database. Only the heidifi-local-test skill's
 * run-service.sh sets it.
 */

import { db } from '../../firebase';
import { COL, DEV_CLOCK_DOC_ID } from '../store/collections';

let warned = false;

export function sandboxEnabled(): boolean {
  if (process.env.ADAPTIVE_SANDBOX !== '1') return false;
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    if (!warned) {
      warned = true;
      console.error('[ADAPTIVE] ADAPTIVE_SANDBOX=1 ignored: it only works against the Firestore emulator');
    }
    return false;
  }
  return true;
}

let offsetMs = 0;
let offsetReadAt = 0;
const OFFSET_TTL_MS = 500;

/** Re-reads the sandbox clock offset (a no-op outside the sandbox). */
export async function refreshClock(force = false): Promise<void> {
  if (!sandboxEnabled()) {
    offsetMs = 0;
    return;
  }
  if (!force && Date.now() - offsetReadAt < OFFSET_TTL_MS) return;
  try {
    const snap = await db.collection(COL.config).doc(DEV_CLOCK_DOC_ID).get();
    offsetMs = Number(snap.get('offsetMs')) || 0;
  } catch {
    // keep the last offset
  }
  offsetReadAt = Date.now();
}

/** Now, in epoch ms (sandbox: plus the fake-clock offset). */
export function now(): number {
  return Date.now() + (sandboxEnabled() ? offsetMs : 0);
}

/** Moves the sandbox clock forward (dev route + skill script). */
export async function advanceSandboxClock(byMs: number): Promise<number> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  await refreshClock(true);
  const next = offsetMs + Math.max(0, byMs);
  await db.collection(COL.config).doc(DEV_CLOCK_DOC_ID).set({ offsetMs: next, updatedAt: new Date() }, { merge: true });
  offsetMs = next;
  offsetReadAt = Date.now();
  return next;
}

/** Jumps the sandbox clock to an absolute time (tests and the local stack only). */
export async function setSandboxClock(targetMs: number): Promise<void> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  const next = targetMs - Date.now();
  await db.collection(COL.config).doc(DEV_CLOCK_DOC_ID).set({ offsetMs: next, updatedAt: new Date() }, { merge: true });
  offsetMs = next;
  offsetReadAt = Date.now();
}

export async function resetSandboxClock(): Promise<void> {
  if (!sandboxEnabled()) throw new Error('sandbox is off');
  await db.collection(COL.config).doc(DEV_CLOCK_DOC_ID).set({ offsetMs: 0, updatedAt: new Date() }, { merge: true });
  offsetMs = 0;
  offsetReadAt = Date.now();
}
