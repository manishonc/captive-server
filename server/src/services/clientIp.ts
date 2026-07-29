/**
 * The guest's real IP address.
 *
 * Every guest request reaches this server through the portal container's proxy
 * (portal/server.js), so `req.ip` is the PORTAL's address, identical for every
 * guest in the estate. Rate-limiting on it would throttle all venues
 * collectively — which is why the existing connectedForm limiter's IP half is
 * effectively a constant today.
 *
 * The portal therefore forwards the real address in `X-Forwarded-For`. That
 * header is trusted ONLY when the request also carries the shared secret:
 * docker-compose publishes port 4000 on the host, so this server is directly
 * reachable, and an unconditional XFF read would let anyone mint a fresh
 * rate-limit budget per forged header — i.e. no limit at all.
 *
 * With PORTAL_SHARED_SECRET unset the header is ignored entirely and everything
 * collapses back to today's behaviour: safe, just coarse.
 */

import type { Request } from 'express';

export function portalSecretConfigured(): boolean {
  return !!process.env.PORTAL_SHARED_SECRET;
}

function fromTrustedProxy(req: Request): boolean {
  const expected = process.env.PORTAL_SHARED_SECRET || '';
  if (!expected) return false;
  const provided = req.get('x-portal-secret') || '';
  // Not timing-safe on purpose: this gates which IP string we read for rate
  // limiting, not authentication. Guessing it buys an attacker nothing they
  // could not get by sending traffic directly.
  return provided === expected;
}

export function clientIpOf(req: Request): string {
  if (fromTrustedProxy(req)) {
    const xff = req.get('x-forwarded-for') || '';
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || 'unknown';
}

/**
 * True when per-IP limits actually distinguish between guests. When false the
 * caller should skip them rather than apply a limit to a shared constant.
 */
export function clientIpIsMeaningful(req: Request): boolean {
  return fromTrustedProxy(req) && !!(req.get('x-forwarded-for') || '').trim();
}
