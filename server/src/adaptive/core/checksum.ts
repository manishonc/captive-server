/**
 * Canonical JSON + hashes. A published version records the sha256 of its
 * content, so "what exactly was live" can always be proven later, and seeded
 * docs get deterministic, random-looking ids (02-firestore-schema §1).
 */

import { createHash } from 'crypto';

/** JSON with object keys sorted at every level and `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function contentChecksum(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

/** `prefix_` + first 32 hex chars of sha256(key). */
export function hashId(prefix: string, key: string): string {
  return `${prefix}_${sha256Hex(key).slice(0, 32)}`;
}
