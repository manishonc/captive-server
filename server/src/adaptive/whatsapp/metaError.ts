/**
 * The one error the Meta template client throws (PR W1), in its own file so the flows can tell
 * Meta's answers apart (`instanceof MetaError`, `kind`) without importing the client itself —
 * only `source.ts` does (tests/adaptiveWhatsAppBoundary.test.ts).
 */

export type MetaErrorKind =
  | 'setup'
  | 'permission'
  | 'rate_limited'
  | 'invalid'
  | 'already_exists'
  | 'locked'
  | 'not_found'
  | 'unavailable'
  | 'unknown';

export interface MetaErrorInfo {
  status?: number | null;
  code?: number | null;
  subcode?: number | null;
  type?: string | null;
  fbtraceId?: string | null;
  retryAfterMs?: number | null;
}

export class MetaError extends Error {
  constructor(
    readonly kind: MetaErrorKind,
    /** Meta's own words (or ours), capped, with any token or link removed. */
    readonly userMsg: string,
    readonly info: MetaErrorInfo = {},
  ) {
    super(`${kind}: ${userMsg}`);
    this.name = 'MetaError';
  }
}
