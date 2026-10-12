/**
 * Meta's webhook signature (PR W3): `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body
 * with the app secret (`WHATSAPP_APP_SECRET`). Without the secret, or the raw body, nothing is
 * "checked" — the caller then treats the body as unverified (Adaptive applies an inbound WhatsApp
 * START, which gives consent back, only from a checked body).
 */

import { createHmac, timingSafeEqual } from 'crypto';

export function metaSignatureValid(rawBody: Buffer | undefined, header: string | string[] | undefined, secret: string | undefined = process.env.WHATSAPP_APP_SECRET): boolean {
  if (!secret || !rawBody || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const want = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
