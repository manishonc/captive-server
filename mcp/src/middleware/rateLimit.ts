import { Request, Response, NextFunction } from 'express';

/**
 * Minimal in-memory sliding-window rate limiter (per-IP, per-route-prefix).
 *
 * Adequate for a single-instance deployment behind a reverse proxy (set
 * `trust proxy` so req.ip reflects X-Forwarded-For). For multi-instance, swap in
 * a Redis-backed limiter (Bun.redis / Upstash) keyed the same way.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - bucket.count)));

    if (bucket.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'slow_down', error_description: 'Too many requests. Please try again shortly.' });
      return;
    }
    next();
  };
}
