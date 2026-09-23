/**
 * Firestore ↔ JSON helpers: Timestamps go out as ISO strings, and `undefined`
 * never goes in (the Admin SDK rejects it unless ignoreUndefinedProperties is set,
 * and this module must not change the shared Firestore settings).
 */

import { Timestamp } from 'firebase-admin/firestore';

export function toIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Deep copy with every Timestamp/Date turned into an ISO string. */
export function toJson<T>(value: T): T {
  return convert(value) as T;
}

function convert(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = convert(v);
    return out;
  }
  return value;
}

/** Deep copy without `undefined` values (arrays keep their order; undefined items become null). */
export function stripUndefined<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (value instanceof Date || value instanceof Timestamp) return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : strip(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = strip(v);
    }
    return out;
  }
  return value;
}
