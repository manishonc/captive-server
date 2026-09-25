/** Firestore time helpers for the engine store. */

import { Timestamp } from 'firebase-admin/firestore';
import { DAY_MS } from '../core/runtime/time';

/** Timestamp / Date / number → epoch ms, or null. */
export function tsMs(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis(): number }).toMillis();
  }
  return null;
}

export function dateOrNull(ms: number | null | undefined): Date | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms) : null;
}

/** Events, sends, visits and ended journeys are kept 25 months (02 §9) — TTL on `expireAt`. */
export const RETENTION_MS = Math.round(25 * 30.44 * DAY_MS);

export function retentionFrom(ms: number): Date {
  return new Date(ms + RETENTION_MS);
}
