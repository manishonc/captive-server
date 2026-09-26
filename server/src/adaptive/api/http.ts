/**
 * Shared plumbing for the PR D routers (owner, public, admin). Copies of the small
 * helpers in router.ts — which keeps them private, and which the new routers must never
 * import from: router.ts imports them, and a circular import would leave `handle`
 * undefined while the module loads, so the whole server (Wi-Fi logins included) would
 * fail to start.
 *
 * Two differences from router.ts:
 *  - `HttpError` carries statuses PR 1's closed `ApiErrorCode` can't (429, 410, 503).
 *  - Unexpected errors are logged by name and code only, never whole: a calendar link,
 *    a Guest info value or an email address must never reach a log line.
 */

import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './errors';
import { zodIssues } from '../core/issues';
import { actorSchema, type Actor } from '../core/schemas';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function tooManyRequests(message: string): HttpError {
  return new HttpError(429, 'rate_limited', message);
}

export function gone(message: string): HttpError {
  return new HttpError(410, 'gone', message);
}

export function unavailable(message: string): HttpError {
  return new HttpError(503, 'unavailable', message);
}

export function actorOf(req: Request): Actor {
  const parsed = actorSchema.safeParse(req.body?.actor);
  if (!parsed.success) throw new ApiError('bad_request', 'Writes must say who is acting (actor.uid, actor.kind)');
  return parsed.data;
}

/** An owner action: a person (the owner, or HeidiFi acting for them). Never the MCP or the seed. */
export function ownerActorOf(req: Request): Actor {
  const actor = actorOf(req);
  if (actor.kind !== 'tenant_user' && actor.kind !== 'super_admin') throw new ApiError('forbidden', 'Only a person can do this');
  return actor;
}

/** A platform action: HeidiFi staff only. */
export function adminActorOf(req: Request): Actor {
  const actor = actorOf(req);
  if (actor.kind !== 'super_admin') throw new ApiError('forbidden', 'Only HeidiFi staff can do this');
  return actor;
}

export function tenantOf(req: Request): string {
  const id = String(req.params.tenantUserId || '');
  if (!id || id.length > 128) throw new ApiError('bad_request', 'tenantUserId is required');
  return id;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A path id (venue, contact, stay, task…): the characters our ids use, nothing else. */
export function idParam(value: unknown, label: string): string {
  const s = String(value ?? '');
  if (!ID.test(s)) throw new ApiError('bad_request', `${label} is not valid`);
  return s;
}

export function sendError(res: Response, err: unknown, tag: string): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.extra ?? {}) });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.issues ? { issues: err.issues } : {}) });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'The request is not in the expected shape', code: 'bad_request', issues: zodIssues(err) });
    return;
  }
  // Name and code only: messages can carry what the caller sent (links, addresses).
  const e = err as { name?: string; code?: unknown };
  console.error(`[${tag}]`, e?.name ?? 'Error', e?.code ?? '');
  res.status(500).json({ ok: false, error: 'Something went wrong', code: 'internal' });
}

type Handler = (req: Request, res: Response) => Promise<Record<string, unknown>>;

export function makeHandle(tag: string) {
  return (fn: Handler) => async (req: Request, res: Response) => {
    try {
      const body = await fn(req, res);
      if (!res.headersSent) res.json({ ok: true, ...body });
    } catch (err) {
      sendError(res, err, tag);
    }
  };
}

/**
 * A tiny in-memory limiter (per API process): at most `max` calls per key in `windowMs`.
 * For actions that make the server do real outbound work (Check link, Sync now).
 */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = Date.now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
