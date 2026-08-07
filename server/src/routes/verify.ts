/**
 * Public guest-verification endpoints.
 *
 *   POST /verify/send   — issue and deliver a code
 *   POST /verify/check  — validate a code, mint a proof token
 *
 * Reached from the portal via its /api/verify/* proxy. Unauthenticated by
 * necessity (the guest has no session yet and no internet), so every guard here
 * is doing real work — see otpRateLimit.ts for the abuse model.
 *
 * Kept out of routes/captive.ts, which is already past 1200 lines.
 */

import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import {
  consumeOtp,
  issueOtp,
  revokeOtp,
  scopeKeyFor,
  type OtpScope,
  type VerifyChannel,
  OTP_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from '../services/guestOtp';
import {
  activeChannels,
  VERIFICATION_CHANNEL_TARGET,
  type VerificationPageConfig,
} from '../services/verificationConfig';
// Same resolver the grant paths use — the portal and the gate must never
// disagree about which channels are in play.
import { loadVerificationConfig } from '../services/verificationGate';
import { mintVerificationToken, normalizeMac } from '../services/verificationToken';
import { maskDestination, normalizeE164, normalizeEmail } from '../services/phone';
import {
  otpRateLimited,
  recordVenueOtpSend,
  venueOtpCapExceeded,
} from '../services/otpRateLimit';
import { clientIpIsMeaningful, clientIpOf } from '../services/clientIp';
import { noteWhatsappResult, sendOtp, whatsappBreakerOpen } from '../services/otpMessages';
import { getVenueName } from '../services/venue';
import { recordOtpSends } from '../services/usage';

const router = Router();

interface ApContext {
  accessPointId: string;
  venueId: string | null;
  tenantUserId: string | null;
  scope: OtpScope;
  scopeKey: string;
}

/** Mirrors the apmac/ap and mac/id aliasing the portal's form-logic.js emits. */
function readIdentifiers(req: Request): { apmac: string; mac: string | null } {
  const body = req.body || {};
  const apmac = String(body.apmac || body.ap || '').toLowerCase().trim();
  return { apmac, mac: normalizeMac(body.mac || body.id) };
}

async function resolveApContext(apmac: string): Promise<ApContext | null> {
  if (!apmac) return null;
  const snap = await db
    .collection('CaptivePortal_AccessPoints')
    .where('mac', '==', apmac)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  const scope: OtpScope = { venueId: data.venueId || null, accessPointId: doc.id };
  const scopeKey = scopeKeyFor(scope);
  if (!scopeKey) return null;

  return {
    accessPointId: doc.id,
    venueId: data.venueId || null,
    tenantUserId: data.tenantUserId || null,
    scope,
    scopeKey,
  };
}

export function destinationFor(channel: VerifyChannel, body: Record<string, any>): string | null {
  if (channel === 'email') return normalizeEmail(body?.email);
  return normalizeE164(String(body?.phoneCountryCode || ''), String(body?.phone || ''));
}

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ success: false, code, ...extra });
}

function readChannel(body: Record<string, any>, config: VerificationPageConfig): VerifyChannel | null {
  const raw = String(body?.channel || '').trim() as VerifyChannel;
  if (raw === 'email' || raw === 'sms' || raw === 'whatsapp') return raw;
  return config.defaultChannel || null;
}

/** The preview iframe must never spend money or hit a provider. */
function isPreview(req: Request): boolean {
  const body = req.body || {};
  return body.preview === true || body.preview === '1' || String(req.query.preview || '') === '1';
}

/**
 * A guest who already verified this contact on this device at this AP, recently
 * enough, skips straight through. Matching on the MAC as well as the contact is
 * what makes this a device-remember rather than "anyone who knows a regular's
 * email address".
 */
async function rememberedVerification(
  ctx: ApContext,
  channel: VerifyChannel,
  destination: string,
  rawEmail: string,
  mac: string | null,
  rememberDays: number,
): Promise<boolean> {
  if (!rememberDays || !mac) return false;
  const target = VERIFICATION_CHANNEL_TARGET[channel];
  const field = target === 'email' ? 'email' : 'phoneE164';
  const verifiedFlag = target === 'email' ? 'emailVerified' : 'phoneVerified';
  const verifiedAt = target === 'email' ? 'emailVerifiedAt' : 'phoneVerifiedAt';
  const cutoff = Date.now() - rememberDays * 24 * 60 * 60 * 1000;
  // Guest docs store `email` exactly as typed, so the lookup has to use the raw
  // value — querying the lowercased one would miss every guest who typed a
  // capital. `phoneE164` is normalized on write, so that side is exact.
  // A guest who changes the casing between visits simply re-verifies.
  const lookup = target === 'email' ? rawEmail.trim() : destination;
  if (!lookup) return false;

  try {
    const snap = await db
      .collection('CaptivePortal_Users')
      .where(field, '==', lookup)
      .where('captivePortalAccessPointId', '==', ctx.accessPointId)
      .limit(3)
      .get();
    return snap.docs.some((doc) => {
      const d = doc.data();
      if (d[verifiedFlag] !== true) return false;
      if (normalizeMac(d.mac) !== mac) return false;
      const at = d[verifiedAt];
      const ms = typeof at === 'number' ? at : at?.toMillis?.();
      return typeof ms === 'number' && ms >= cutoff;
    });
  } catch (err) {
    // A missing composite index must not block verification.
    console.error('[VERIFY REMEMBER LOOKUP ERROR]', err);
    return false;
  }
}

router.post('/send', async (req: Request, res: Response) => {
  if (isPreview(req)) return fail(res, 400, 'preview_not_allowed');

  const { apmac, mac } = readIdentifiers(req);
  const ctx = await resolveApContext(apmac);
  if (!ctx) return fail(res, 403, 'ap_not_registered');

  const { effective } = await loadVerificationConfig(ctx.venueId);
  if (!effective.enabled) return fail(res, 409, 'verification_not_required');

  const channel = readChannel(req.body, effective);
  const available = activeChannels(effective);
  if (!channel || !available.includes(channel)) {
    return fail(res, 400, 'channel_not_enabled', { availableChannels: available });
  }
  if (channel === 'whatsapp' && whatsappBreakerOpen()) {
    return fail(res, 503, 'channel_unavailable', {
      availableChannels: available.filter((c) => c !== 'whatsapp'),
    });
  }

  const destination = destinationFor(channel, req.body || {});
  if (!destination) return fail(res, 400, 'invalid_destination', { channel });

  const ip = clientIpOf(req);
  const destLimit = otpRateLimited('dest_send', `${channel}:${destination}`);
  if (destLimit.limited) {
    res.set('Retry-After', String(destLimit.retryAfterSeconds));
    return fail(res, 429, 'too_many_requests', { retryAfterSeconds: destLimit.retryAfterSeconds });
  }
  // Skipped when the portal isn't forwarding a real address — applying a limit
  // to one shared constant would throttle every guest at every venue together.
  if (clientIpIsMeaningful(req)) {
    const ipLimit = otpRateLimited('ip_send', ip);
    if (ipLimit.limited) {
      res.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return fail(res, 429, 'too_many_requests', { retryAfterSeconds: ipLimit.retryAfterSeconds });
    }
  }
  const apLimit = otpRateLimited('ap_send', apmac);
  if (apLimit.limited) {
    res.set('Retry-After', String(apLimit.retryAfterSeconds));
    return fail(res, 429, 'too_many_requests', { retryAfterSeconds: apLimit.retryAfterSeconds });
  }

  const rawEmail = String(req.body?.email || '');
  if (await rememberedVerification(ctx, channel, destination, rawEmail, mac, effective.rememberDays)) {
    const token = mintVerificationToken({ channel, destination, scopeKey: ctx.scopeKey, mac });
    if (!token) return fail(res, 503, 'verification_unavailable');
    return res.json({
      success: true,
      alreadyVerified: true,
      channel,
      scopeKey: ctx.scopeKey,
      verificationToken: token,
    });
  }

  // Daily budget spent: waive verification rather than strand every remaining
  // guest at this venue for the rest of the day. The token records the waiver
  // so the guest doc is never marked verified.
  if (await venueOtpCapExceeded(ctx.scopeKey)) {
    console.error(`[VERIFY] Daily OTP cap reached for ${ctx.scopeKey} — waiving verification.`);
    const token = mintVerificationToken({
      channel,
      destination,
      scopeKey: ctx.scopeKey,
      mac,
      bypass: true,
    });
    if (!token) return fail(res, 503, 'verification_unavailable');
    return res.json({ success: true, bypassed: true, channel, scopeKey: ctx.scopeKey, verificationToken: token });
  }

  const issued = await issueOtp({
    channel,
    destination,
    scope: ctx.scope,
    scopeKey: ctx.scopeKey,
    ip,
    mac,
  }).catch((err) => {
    console.error('[VERIFY ISSUE ERROR]', err);
    return null;
  });
  if (!issued) return fail(res, 503, 'verification_unavailable');

  if (!issued.ok) {
    res.set('Retry-After', String(issued.retryAfterSeconds));
    // Not an error state for the UI: the portal renders the code-entry step with
    // a countdown, which is exactly what a guest who reopened the captive
    // browser needs to see.
    return fail(res, 429, issued.reason === 'cooldown' ? 'resend_too_soon' : 'too_many_requests', {
      retryAfterSeconds: issued.retryAfterSeconds,
      destinationMasked: maskDestination(channel, destination),
    });
  }

  const venueName = ctx.venueId ? await getVenueName(ctx.venueId) : '';
  // The portal sends the language the guest is reading the splash screen in.
  // Unrecognised or absent falls back to English inside sendOtp.
  const result = await sendOtp(channel, destination, issued.code, venueName, req.body?.language);
  if (channel === 'whatsapp') noteWhatsappResult(result);

  if (!result.ok) {
    await revokeOtp(channel, destination, ctx.scopeKey);
    const alternatives = available.filter((c) => c !== channel);
    if (result.kind === 'undeliverable') {
      return fail(res, 422, 'undeliverable', { channel, fallbackChannels: alternatives });
    }
    if (result.kind === 'unconfigured' || result.kind === 'template') {
      return fail(res, 503, 'channel_unavailable', { channel, fallbackChannels: alternatives });
    }
    return fail(res, 502, 'provider_error', { channel, fallbackChannels: alternatives });
  }

  await recordVenueOtpSend(ctx.scopeKey);
  if (ctx.tenantUserId) {
    recordOtpSends(ctx.tenantUserId, channel, 1).catch(() => {});
  }

  return res.json({
    success: true,
    channel,
    scopeKey: ctx.scopeKey,
    destinationMasked: maskDestination(channel, destination),
    expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
    resendInSeconds: Math.round(RESEND_COOLDOWN_MS / 1000),
    attemptsAllowed: MAX_ATTEMPTS,
    resent: issued.resent,
  });
});

router.post('/check', async (req: Request, res: Response) => {
  if (isPreview(req)) return fail(res, 400, 'preview_not_allowed');

  const { apmac, mac } = readIdentifiers(req);
  const ctx = await resolveApContext(apmac);
  if (!ctx) return fail(res, 403, 'ap_not_registered');

  const { effective } = await loadVerificationConfig(ctx.venueId);
  if (!effective.enabled) return fail(res, 409, 'verification_not_required');

  const channel = readChannel(req.body, effective);
  const available = activeChannels(effective);
  if (!channel || !available.includes(channel)) {
    return fail(res, 400, 'channel_not_enabled', { availableChannels: available });
  }

  const destination = destinationFor(channel, req.body || {});
  if (!destination) return fail(res, 400, 'invalid_destination', { channel });

  const code = String(req.body?.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return fail(res, 400, 'invalid_code');

  const destLimit = otpRateLimited('dest_check', `${channel}:${destination}`);
  if (destLimit.limited) {
    res.set('Retry-After', String(destLimit.retryAfterSeconds));
    return fail(res, 429, 'too_many_attempts', { retryAfterSeconds: destLimit.retryAfterSeconds });
  }
  if (clientIpIsMeaningful(req)) {
    const ipLimit = otpRateLimited('ip_check', clientIpOf(req));
    if (ipLimit.limited) {
      res.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return fail(res, 429, 'too_many_attempts', { retryAfterSeconds: ipLimit.retryAfterSeconds });
    }
  }

  const verdict = await consumeOtp({ channel, destination, scopeKey: ctx.scopeKey, code }).catch(
    (err) => {
      console.error('[VERIFY CONSUME ERROR]', err);
      return null;
    },
  );
  if (!verdict) return fail(res, 503, 'verification_unavailable');

  if (!verdict.ok) {
    if (verdict.reason === 'expired') return fail(res, 410, 'code_expired');
    if (verdict.reason === 'too_many') return fail(res, 429, 'too_many_attempts');
    // attemptsLeft is omitted when there was no live code, so the response does
    // not reveal whether a code is currently outstanding for this destination.
    return fail(res, 400, 'invalid_code', {
      ...(verdict.attemptsLeft > 0 ? { attemptsLeft: verdict.attemptsLeft } : {}),
    });
  }

  const token = mintVerificationToken({ channel, destination, scopeKey: ctx.scopeKey, mac });
  if (!token) return fail(res, 503, 'verification_unavailable');

  return res.json({
    success: true,
    channel,
    scopeKey: ctx.scopeKey,
    verificationToken: token,
  });
});

export default router;
