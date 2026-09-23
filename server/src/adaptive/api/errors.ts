/**
 * Errors the Adaptive API returns. Every failure has the same JSON shape so the
 * CMS and the MCP tools can show it without special cases:
 *
 *   { ok: false, error: "Human sentence", code: "validation_failed", issues?: Issue[] }
 */

import type { Issue } from '../core/issues';

export type ApiErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'no_changes' | 'validation_failed' | 'internal';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  no_changes: 409,
  validation_failed: 422,
  internal: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly issues?: Issue[],
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function notFound(message: string): ApiError {
  return new ApiError('not_found', message);
}

export function conflict(message: string): ApiError {
  return new ApiError('conflict', message);
}

export function validationFailed(message: string, issues: Issue[]): ApiError {
  return new ApiError('validation_failed', message, issues);
}
