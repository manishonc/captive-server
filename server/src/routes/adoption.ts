/**
 * Public, code-authenticated endpoints for the AP Adoption Helper.
 *
 * The desktop app running on a venue laptop has no Firebase login and no internal secret —
 * shipping either in a binary handed to venue staff would leak it. It authenticates with the
 * tenant's 8-character setup code, and every endpoint here resolves that code first.
 *
 * The code is not the whole story, and by design. `claim` additionally requires the device to
 * be genuinely informing our controller, which means the caller has to be on its LAN with SSH
 * access. A leaked code on its own buys an attacker the venue list and nothing else.
 *
 * Response shape mirrors routes/verify.ts — `{ success: false, code }` plus `Retry-After` on
 * 429 — because that is the house style for a public abuse-sensitive surface and the client
 * already has to handle it.
 *
 * NOT rate-limited per IP. See services/adoptionRateLimit.ts: without `trust proxy` every
 * caller appears to arrive from the Coolify proxy, so a per-IP tier would be a global tier
 * that one attacker could saturate to lock out the whole fleet.
 *
 * CORS is deliberately absent. The Electron renderer cannot make these calls (its CSP has no
 * connect-src); they come from the app's main process, which sends no Origin. If a browser
 * client ever needs this, that is a real decision to make, not a header to add reflexively.
 */

import { Router, Request, Response } from 'express';
import { db } from '../firebase';
import { accountCodeSubsystemReady, checkAccountCode, maskAccountCode } from '../services/accountCode';
import { adoptionCodeStorageReady, resolveAccountCode } from '../services/adoptionCodes';
import { adoptionRateLimited, claimCapExceeded } from '../services/adoptionRateLimit';
import { getPauseState, rateLimitsPaused } from '../services/adoptionSettings';
import {
  adoptionStatus,
  claimAccessPoint,
  ClaimFailure,
  findApDocsByMacs,
} from '../services/apProvisioning';
import { canonMac, getDevices, getPendingDevices } from '../services/unifi';
import { resolveAnyController } from '../services/unifiWlan';
import crypto from 'node:crypto';

const router = Router();

const AP_COLLECTION = 'CaptivePortal_AccessPoints';
const VENUE_COLLECTION = 'CaptivePortal_Venues';

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ success: false, code, ...extra });
}

function limited(res: Response, retryAfterSeconds: number) {
  res.set('Retry-After', String(retryAfterSeconds));
  return fail(res, 429, 'too_many_requests', { retryAfterSeconds });
}

/** Rate-limit key for a submitted code. Never the code itself — these reach log lines. */
function codeKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Enabled unless explicitly switched off, but only when both keys are present. */
function selfServeEnabled(): boolean {
  if (process.env.ADOPTION_SELF_SERVE_ENABLED === 'false') return false;
  return accountCodeSubsystemReady() && adoptionCodeStorageReady();
}

interface Caller {
  tenantUserId: string;
  code: string;
  /** True when an admin has temporarily paused the limits — see services/adoptionSettings. */
  paused: boolean;
}

/**
 * Resolve the submitted code to a tenant, or write the response and return null.
 *
 * Failed resolutions charge `code_fail` and `unknown_code_global`; successful ones charge
 * neither. That separation is what stops the limiter being turned into a denial-of-service
 * against a legitimate tenant by someone spamming wrong codes at their account — see the
 * services/adoptionRateLimit.ts header.
 */
async function authenticate(req: Request, res: Response): Promise<Caller | null> {
  if (!selfServeEnabled()) {
    fail(res, 503, 'adoption_unavailable');
    return null;
  }

  // Resolved once per request and threaded through, rather than re-read per limit check.
  const paused = await rateLimitsPaused();

  const check = checkAccountCode(req.body?.code);
  const key = codeKey(check.value || 'empty');

  // Malformed input is charged too — otherwise it is a free oracle for the alphabet.
  if (!check.ok) {
    if (!paused) chargeFailure(key);
    fail(res, 400, 'invalid_code');
    return null;
  }

  if (!paused) {
    const failLimit = adoptionRateLimited('code_fail', key);
    if (failLimit.limited) {
      limited(res, failLimit.retryAfterSeconds);
      return null;
    }
  }

  const resolved = await resolveAccountCode(check.value);
  if (!resolved) {
    if (!paused) chargeFailure(key);
    console.warn('[ADOPTION] Unknown setup code', maskAccountCode(check.value));
    // Same status, same body, and no branch on WHY — an unknown code and a revoked one must
    // be indistinguishable from outside.
    fail(res, 400, 'invalid_code');
    return null;
  }

  return { tenantUserId: resolved.tenantUserId, code: check.value, paused };
}

function chargeFailure(key: string): void {
  adoptionRateLimited('code_fail', key);
  adoptionRateLimited('unknown_code_global', 'global');
}

/** Per-endpoint limit on the success path, keyed by the caller's own code. */
function throttle(
  res: Response,
  kind: Parameters<typeof adoptionRateLimited>[0],
  key: string,
  paused = false,
): boolean {
  if (paused) return false;
  const verdict = adoptionRateLimited(kind, key);
  if (verdict.limited) {
    limited(res, verdict.retryAfterSeconds);
    return true;
  }
  return false;
}

// ── Health ────────────────────────────────────────────────────────────────────

/** Unauthenticated. Lets the helper tell "wrong code" from "feature is off here". */
router.get('/health', async (_req: Request, res: Response) => {
  const pause = await getPauseState().catch(() => null);
  res.json({
    success: true,
    enabled: selfServeEnabled(),
    rateLimits: pause?.paused
      ? { paused: true, until: pause.pausedUntil, secondsRemaining: pause.secondsRemaining }
      : { paused: false },
  });
});

// ── Session ───────────────────────────────────────────────────────────────────

/**
 * Exchange a code for the tenant's locations.
 *
 * Returns id and name only. Deliberately not the account name, the WiFi names, or the access
 * point counts: this is the endpoint a leaked code reaches first, and every extra field is
 * something an attacker learns for free. The per-venue detail comes from /venue, one venue at
 * a time.
 */
router.post('/session', async (req: Request, res: Response) => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  if (throttle(res, 'session', codeKey(caller.code), caller.paused)) return;

  try {
    const snap = await db
      .collection(VENUE_COLLECTION)
      .where('tenantUserId', '==', caller.tenantUserId)
      .get();

    const venues = snap.docs
      .map((d) => ({ id: d.id, name: String(d.data().venue_name || 'Unnamed location') }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ success: true, venues });
  } catch (error) {
    console.error('[ADOPTION session]', error);
    return fail(res, 502, 'lookup_failed');
  }
});

// ── Venue detail ──────────────────────────────────────────────────────────────

/** One venue's WiFi name and access point count, for the setup screen. */
router.post('/venue', async (req: Request, res: Response) => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  if (throttle(res, 'session', codeKey(caller.code), caller.paused)) return;

  const venueId = String(req.body?.venueId || '').trim();
  if (!venueId) return fail(res, 400, 'venue_required');

  try {
    const snap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
    if (!snap.exists) return fail(res, 404, 'venue_not_found');
    const venue = snap.data() as { tenantUserId?: string; venue_name?: string; wifiSsid?: string };
    if (venue.tenantUserId !== caller.tenantUserId) return fail(res, 403, 'venue_forbidden');

    const count = await db.collection(AP_COLLECTION).where('venueId', '==', venueId).count().get();

    return res.json({
      success: true,
      id: venueId,
      name: String(venue.venue_name || 'Unnamed location'),
      wifiSsid: venue.wifiSsid || null,
      apCount: count.data().count,
    });
  } catch (error) {
    console.error('[ADOPTION venue]', error);
    return fail(res, 502, 'lookup_failed');
  }
});

// ── Precheck ──────────────────────────────────────────────────────────────────

type PrecheckState =
  | 'unknown'
  | 'pending'
  | 'adopted_unregistered'
  | 'already_registered_here'
  | 'registered_elsewhere';

/**
 * What we already know about each scanned device, before the installer commits to anything.
 *
 * Takes an ARRAY because a scan finds every access point in the room. Checking them in one
 * call lets the app grey out the ones already set up, instead of letting someone pick an
 * adopted device and bounce off an error — which, in a four-AP install, they will do
 * repeatedly.
 *
 * `registered_elsewhere` carries no venue or account name. Otherwise this endpoint is a
 * MAC-to-business-name oracle for anyone holding any valid code.
 */
router.post('/precheck', async (req: Request, res: Response) => {
  const caller = await authenticate(req, res);
  if (!caller) return;
  if (throttle(res, 'precheck', codeKey(caller.code), caller.paused)) return;

  const raw: unknown[] = Array.isArray(req.body?.macs) ? req.body.macs : [req.body?.mac];
  const macs: string[] = [...new Set(raw.map((m) => canonMac(String(m ?? ''))))].filter(
    (m) => m.length === 12,
  );
  if (macs.length === 0) return fail(res, 400, 'mac_required');
  if (macs.length > 32) return fail(res, 400, 'too_many_macs');

  try {
    const registered = new Map<string, { state: PrecheckState; venueName?: string; apName?: string }>();

    // Registration is authoritative and cheaper than the controller; check it first.
    for (const [key, ap] of await findApDocsByMacs(macs)) {
      registered.set(
        key,
        ap.tenantUserId === caller.tenantUserId
          ? { state: 'already_registered_here', venueName: ap.venueName, apName: ap.name }
          : { state: 'registered_elsewhere' },
      );
    }

    // Controller state only matters for the ones we do not already own.
    const unregistered = macs.filter((m: string) => !registered.has(m));
    const live = new Map<string, PrecheckState>();
    if (unregistered.length > 0) {
      try {
        const config = await resolveAnyController();
        const [pending, devices] = await Promise.all([getPendingDevices(config), getDevices(config)]);
        for (const d of pending) live.set(canonMac(d.mac), 'pending');
        for (const d of devices) {
          const key = canonMac(d.mac);
          if (!live.has(key)) live.set(key, 'adopted_unregistered');
        }
      } catch (error) {
        // Non-fatal: precheck is an optimisation, and the claim re-checks server-side. A
        // controller blip must not stop someone starting an install.
        console.error('[ADOPTION precheck] Controller unreachable:', error);
      }
    }

    const devices = macs.map((mac: string) => ({
      mac,
      ...(registered.get(mac) || { state: live.get(mac) || 'unknown' }),
    }));

    return res.json({ success: true, devices });
  } catch (error) {
    console.error('[ADOPTION precheck]', error);
    return fail(res, 502, 'lookup_failed');
  }
});

// ── Claim ─────────────────────────────────────────────────────────────────────

/** Service-layer failures to HTTP. Anything unmapped is a 409 the client can retry. */
const CLAIM_STATUS: Record<ClaimFailure, number> = {
  venue_not_found: 404,
  venue_forbidden: 403,
  invalid_ssid: 400,
  ssid_conflict_existing: 409,
  device_not_pending: 409,
  mac_registered_elsewhere: 409,
  plan_limit_access_points: 403,
  subscription_lapsed: 402,
  controller_unreachable: 502,
};

router.post('/claim', async (req: Request, res: Response) => {
  const caller = await authenticate(req, res);
  if (!caller) return;

  const key = codeKey(caller.code);
  if (throttle(res, 'claim', key, caller.paused)) return;

  const mac = String(req.body?.mac || '').trim();
  const canon = canonMac(mac);
  if (canon.length !== 12) return fail(res, 400, 'mac_required');
  if (throttle(res, 'claim_mac', canon, caller.paused)) return;

  // NOT pausable, deliberately, unlike the in-memory windows above. This is the durable
  // bound on what a compromised code can actually do — it survives a restart, and no amount
  // of testing convenience justifies switching it off.
  if (await claimCapExceeded(caller.tenantUserId)) {
    return fail(res, 429, 'daily_limit_reached');
  }

  try {
    const result = await claimAccessPoint({
      tenantUserId: caller.tenantUserId,
      venueId: String(req.body?.venueId || '').trim(),
      mac,
      ssid: String(req.body?.ssid || ''),
      apName: req.body?.apName ? String(req.body.apName) : undefined,
      model: req.body?.model ? String(req.body.model) : undefined,
      firmware: req.body?.firmware ? String(req.body.firmware) : undefined,
      confirmRename: req.body?.confirmRename === true,
    });

    if (!result.ok) {
      const status = CLAIM_STATUS[result.failure as ClaimFailure] ?? 409;
      return fail(res, status, result.failure || 'claim_failed', {
        message: result.message,
        ssid: result.ssid,
      });
    }

    console.log('[ADOPTION] Claimed', mac, 'for tenant', caller.tenantUserId, 'as', result.apId);
    const { ok: _ok, failure: _failure, ...payload } = result;
    return res.json({ success: true, ...payload });
  } catch (error) {
    console.error('[ADOPTION claim]', error);
    return fail(res, 502, 'claim_failed');
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

/** Polled while the device provisions. Also where the venue's WiFi gets applied. */
router.post('/status', async (req: Request, res: Response) => {
  const caller = await authenticate(req, res);
  if (!caller) return;

  const mac = String(req.body?.mac || '').trim();
  const canon = canonMac(mac);
  if (canon.length !== 12) return fail(res, 400, 'mac_required');
  if (throttle(res, 'status', `${codeKey(caller.code)}:${canon}`, caller.paused)) return;

  try {
    const status = await adoptionStatus({ tenantUserId: caller.tenantUserId, mac });
    return res.json({ success: true, ...status });
  } catch (error) {
    console.error('[ADOPTION status]', error);
    return fail(res, 502, 'status_failed');
  }
});

export default router;
