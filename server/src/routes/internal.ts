/**
 * Internal, secret-guarded endpoints called server-to-server by the CMS.
 *
 * Currently exposes POST /internal/test-send — sends a single marketing
 * message IMMEDIATELY (no scheduling, no analytics doc) so an admin can preview
 * how a configured message looks in their inbox/phone. WhatsApp tests do mint a
 * real short link, so the button renders the same URL a live send would, but
 * it carries no marketingDocId and so never moves the funnel counters.
 *
 * Auth: the caller must send `x-internal-secret` matching INTERNAL_API_SECRET
 * (same shared-secret pattern as /ap-heartbeat).
 */

import { Router, Request, Response } from 'express';
import { scheduleSms } from '../services/twilio';
import { sendEmail } from '../services/brevo';
import { sendWhatsAppTemplate, WhatsAppTemplateComponent } from '../services/whatsapp';
import { createShortLink, VISITOR_BASE_URL } from '../services/shortlinks';
import { getVenueName } from '../services/venue';
import { applyVenueWifi, detachApFromVenueWifi, getDeviceStatuses, runDiagnostics, resolveAnyController } from '../services/unifiWlan';
import { checkApCredentials } from '../services/unifiCredentialCheck'; // ⚠️ TEMPORARY — remove with its route
import { adoptDevice } from '../services/unifi';
import { canonMac, listPendingDevices, adoptRegisteredPendingDevices } from '../services/unifiAdoption';
import { adoptionCodeStorageReady, ensureAccountCode, rotateAccountCode } from '../services/adoptionCodes';
import { accountCodeSubsystemReady } from '../services/accountCode';
import {
  getPauseState,
  MAX_PAUSE_MINUTES,
  pauseRateLimits,
  resumeRateLimits,
} from '../services/adoptionSettings';
import {
  sendBroadcast,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  estimateCampaignCredits,
  retryHeldSends,
} from '../services/campaigns';
import { getCreditConfig } from '../services/credits';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';

const router = Router();

/**
 * Daily test-send cap (spec §5.3.8): test sends are free, so a per-tenant
 * per-UTC-day counter prevents abuse of the no-analytics path. Fails open on
 * counter errors — a broken counter must not break the preview feature.
 * Returns true when the send is allowed.
 */
async function checkTestSendCap(tenantUserId: string): Promise<{ allowed: boolean; limit: number }> {
  const config = await getCreditConfig();
  const limit = Number(config.testSendDailyLimit) || 0;
  if (limit <= 0) return { allowed: true, limit: 0 }; // 0 = uncapped
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection('CaptivePortal_TestSendCounters').doc(`${tenantUserId}_${day}`);
  try {
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = Number(snap.data()?.count ?? 0);
      if (count >= limit) return false;
      tx.set(ref, { tenantUserId, day, count: FieldValue.increment(1), updatedAt: new Date() }, { merge: true });
      return true;
    });
    return { allowed, limit };
  } catch (err) {
    console.error('[INTERNAL test-send cap]', err);
    return { allowed: true, limit };
  }
}

/** Shared `x-internal-secret` guard. Writes 401 and returns false when unauthorized. */
function requireInternalSecret(req: Request, res: Response): boolean {
  const secret = req.header('x-internal-secret');
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

interface TestSendBody {
  venueId?: string;
  tenantUserId?: string;
  channel?: 'email' | 'sms' | 'whatsapp';
  recipient?: string;
  message?: {
    subject?: string;
    body?: string;
    content?: string;
    templateName?: string;
    languageCode?: string;
    variableValues?: Record<string, string>;
  };
}

/** Normalize a free-text phone number into E.164 (strip everything but digits, re-add +). */
function normalizePhone(recipient: string): string | null {
  const digits = (recipient || '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `+${digits}`;
}

router.post('/test-send', async (req: Request<{}, {}, TestSendBody>, res: Response) => {
  if (!requireInternalSecret(req, res)) return;

  const { venueId, tenantUserId, channel, recipient, message } = req.body;

  if (!channel || !['email', 'sms', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing channel' });
  }
  if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing recipient' });
  }
  if (!message || typeof message !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  // Daily cap on free test sends (spec §5.3.8). Only enforceable when the CMS
  // forwards the tenant; older callers without it stay uncapped.
  if (tenantUserId && typeof tenantUserId === 'string') {
    const cap = await checkTestSendCap(tenantUserId);
    if (!cap.allowed) {
      return res.status(429).json({
        ok: false,
        error: `Daily test-send limit reached (${cap.limit}/day). Try again tomorrow.`,
        code: 'test_send_limit',
      });
    }
  }

  try {
    if (channel === 'sms') {
      const content = String(message.content ?? '').trim();
      if (!content) return res.status(400).json({ ok: false, error: 'Missing message content' });
      const to = normalizePhone(recipient);
      if (!to) return res.status(400).json({ ok: false, error: 'Invalid phone number' });
      // delay 0 => Twilio sends immediately
      const id = await scheduleSms(to, content, 0);
      if (!id) return res.status(503).json({ ok: false, error: 'SMS service is not configured' });
      return res.status(200).json({ ok: true, id });
    }

    if (channel === 'email') {
      const subject = String(message.subject ?? '').trim();
      const body = String(message.body ?? '');
      if (!body.trim()) return res.status(400).json({ ok: false, error: 'Missing message body' });
      // delay 0 => Brevo sends immediately
      const id = await sendEmail(recipient.trim(), subject || '(test)', body, 0);
      if (!id) return res.status(503).json({ ok: false, error: 'Email service is not configured' });
      return res.status(200).json({ ok: true, id });
    }

    // whatsapp
    const templateName = String(message.templateName ?? '').trim();
    const languageCode = String(message.languageCode ?? '').trim();
    if (!templateName || !languageCode) {
      return res.status(400).json({ ok: false, error: 'WhatsApp test requires templateName and languageCode' });
    }
    const to = normalizePhone(recipient);
    if (!to) return res.status(400).json({ ok: false, error: 'Invalid phone number' });

    // Resolve venueName from the venue record (same as the live dispatch).
    const venueName = await getVenueName(venueId || '');

    // Build components exactly like the live path, including the `s/<code>`
    // button suffix. Passing a different suffix here (this used to send
    // `<venueId>/rate`) means the test never exercises the real button shape —
    // which is how a malformed rendered URL survived testing before.
    //
    // The short link is real so the button resolves, but it is minted with an
    // empty marketingDocId and isTest: true, so recordSendClick's
    // `if (data.marketingDocId)` guard keeps test clicks out of the funnel.
    const components: WhatsAppTemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Test' },
          { type: 'text', text: venueName || 'our venue' },
        ],
      },
    ];
    if (venueId) {
      const code = await createShortLink({
        targetType: 'venue-rate',
        targetUrl: `${VISITOR_BASE_URL}/${encodeURIComponent(venueId)}/rate`,
        venueId,
        marketingDocId: '',
        wifiGuestId: '',
        channel: 'whatsapp',
        isTest: true,
      });
      components.push({
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: [{ type: 'text', text: `s/${code}` }],
      });
    }

    const id = await sendWhatsAppTemplate(to, { templateName, languageCode, components });
    if (!id) return res.status(503).json({ ok: false, error: 'WhatsApp service is not configured' });
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[INTERNAL TEST-SEND ERROR]', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to send test message',
    });
  }
});

// ── UniFi controller operations (called server-to-server by the CMS proxy routes) ──
// The CMS performs Firebase auth + venue/tenant authorization, then calls these.

router.post('/unifi/device-status', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const apIds: string[] = Array.isArray(req.body?.apIds) ? req.body.apIds : [];
  try {
    const statuses = await getDeviceStatuses(apIds);
    return res.json({ ok: true, statuses });
  } catch (err) {
    console.error('[INTERNAL UNIFI device-status]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'device-status failed' });
  }
});

router.post('/unifi/apply-wifi', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { venueId, ssid } = req.body || {};
  if (!venueId || !ssid) return res.status(400).json({ ok: false, error: 'venueId and ssid are required' });
  try {
    const wifi = await applyVenueWifi(String(venueId), String(ssid));
    return res.json({ ok: true, wifi });
  } catch (err) {
    console.error('[INTERNAL UNIFI apply-wifi]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'apply-wifi failed' });
  }
});

router.post('/unifi/detach', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { venueId, mac } = req.body || {};
  if (!venueId || !mac) return res.status(400).json({ ok: false, error: 'venueId and mac are required' });
  try {
    await detachApFromVenueWifi(String(venueId), String(mac));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[INTERNAL UNIFI detach]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'detach failed' });
  }
});

// Temporary (plan B5): read-only controller schema dump to confirm apgroup vs wlangroup.
router.get('/unifi/diagnostics', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  try {
    const result = await runDiagnostics();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[INTERNAL UNIFI diagnostics]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'diagnostics failed' });
  }
});

/**
 * ⚠️ TEMPORARY — per-AP credential sweep. Reports which access points still hold
 * controller credentials the controller accepts. Read-only: it opens logins and
 * discards them, never writing to Firestore or the controller. Passwords are never
 * returned, only `passwordSet`. Remove with services/unifiCredentialCheck.ts.
 */
router.get('/unifi/credential-check', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  try {
    const report = await checkApCredentials();
    console.log(
      '[INTERNAL UNIFI credential-check]',
      `${report.failed} failed / ${report.notConfigured} unconfigured / ${report.total} APs`,
      `(${report.credentialSetsProbed} credential sets probed)`,
    );
    return res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[INTERNAL UNIFI credential-check]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'credential-check failed' });
  }
});

// Devices waiting for adoption on the shared controller, annotated with the
// registered AP each one matches (if any) — feeds the super-admin pending panel.
router.get('/unifi/pending-devices', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  try {
    const report = await listPendingDevices();
    return res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[INTERNAL UNIFI pending-devices]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'pending-devices failed' });
  }
});

/**
 * Explicit manual adopt (super-admin action via the CMS). UNREGISTERED pending
 * devices ARE adoptable here — the auto-adopt registered-only invariant covers the
 * unattended paths, and the returned `registered` flag lets the UI warn. Re-checks
 * the live pending list so an already-adopted device (or a race with the cron) gets
 * a 404 instead of a redundant adopt command.
 */
router.post('/unifi/adopt', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { mac } = req.body || {};
  if (!mac || typeof mac !== 'string' || !mac.trim()) {
    return res.status(400).json({ ok: false, error: 'mac is required' });
  }
  try {
    const report = await listPendingDevices();
    const device = report.devices.find((d) => canonMac(d.mac) === canonMac(mac));
    if (!device) {
      return res.status(404).json({ ok: false, error: 'Device is not currently pending adoption' });
    }
    const config = await resolveAnyController();
    await adoptDevice(config, device.mac);
    return res.json({ ok: true, adopted: device.mac, registered: device.registered });
  } catch (err) {
    console.error('[INTERNAL UNIFI adopt]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'adopt failed' });
  }
});

// On-create hook (fire-and-forget from the CMS after an AP doc is saved). The
// reconciler never throws and enforces the registered-only invariant itself, so
// this always answers 200 with the sweep result.
router.post('/unifi/adopt-if-pending', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { mac } = req.body || {};
  if (!mac || typeof mac !== 'string' || !mac.trim()) {
    return res.status(400).json({ ok: false, error: 'mac is required' });
  }
  const result = await adoptRegisteredPendingDevices({ onlyMacs: [mac] });
  return res.json({ ok: true, result });
});

// ── AP Adoption account codes (called server-to-server by the CMS) ──
// The CMS authenticates the tenant and checks `accesspoint.create` (and, for rotate,
// owner/admin) before calling these. Both return the code IN PLAINTEXT, which is the
// point — the tenant has to read it off their dashboard and type it into the Adoption
// Helper. That is also why these live behind the internal secret and not on /adoption.

/** Guard both endpoints on the two keys the subsystem cannot work without. */
function requireAdoptionCodeConfig(res: Response): boolean {
  if (!accountCodeSubsystemReady()) {
    res.status(503).json({ ok: false, error: 'ADOPTION_CODE_PEPPER is not configured on the server.' });
    return false;
  }
  if (!adoptionCodeStorageReady()) {
    res.status(503).json({ ok: false, error: 'ADOPTION_CODE_ENCRYPTION_KEY is not configured on the server.' });
    return false;
  }
  return true;
}

/** The tenant's setup code, minting one on first request. Idempotent. */
router.post('/adoption/code', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  if (!requireAdoptionCodeConfig(res)) return;
  const { tenantUserId } = req.body || {};
  if (!tenantUserId || typeof tenantUserId !== 'string') {
    return res.status(400).json({ ok: false, error: 'tenantUserId is required' });
  }
  try {
    const view = await ensureAccountCode(tenantUserId);
    return res.json({ ok: true, ...view });
  } catch (err) {
    console.error('[INTERNAL adoption/code]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'code lookup failed' });
  }
});

/** Replace the tenant's code. The old one keeps working for a 24h grace window. */
router.post('/adoption/code/rotate', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  if (!requireAdoptionCodeConfig(res)) return;
  const { tenantUserId } = req.body || {};
  if (!tenantUserId || typeof tenantUserId !== 'string') {
    return res.status(400).json({ ok: false, error: 'tenantUserId is required' });
  }
  try {
    const view = await rotateAccountCode(tenantUserId);
    return res.json({ ok: true, ...view });
  } catch (err) {
    console.error('[INTERNAL adoption/code/rotate]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'rotate failed' });
  }
});

/**
 * Temporarily pause the /adoption rate limits — for testing, and for walking a customer
 * through setup on a call without a mistyped code locking them out for ten minutes.
 *
 * A DEADLINE, not an on/off switch. There is no state to forget about: the pause expires by
 * itself, is capped server-side at MAX_PAUSE_MINUTES however long the caller asks for, and is
 * reported by the public GET /adoption/health so "are the limits on" is answerable without
 * database access. The daily per-tenant claim cap is never paused.
 */
router.get('/adoption/rate-limit', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  try {
    return res.json({ ok: true, maxMinutes: MAX_PAUSE_MINUTES, ...(await getPauseState()) });
  } catch (err) {
    console.error('[INTERNAL adoption/rate-limit]', err);
    return res.status(502).json({ ok: false, error: 'could not read pause state' });
  }
});

router.post('/adoption/rate-limit', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { action, minutes } = req.body || {};
  if (action !== 'pause' && action !== 'resume') {
    return res.status(400).json({ ok: false, error: "action must be 'pause' or 'resume'" });
  }
  try {
    const state = action === 'pause' ? await pauseRateLimits(minutes) : await resumeRateLimits();
    return res.json({ ok: true, maxMinutes: MAX_PAUSE_MINUTES, ...state });
  } catch (err) {
    console.error('[INTERNAL adoption/rate-limit]', err);
    return res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'failed' });
  }
});

// ── Campaign Manager (called server-to-server by the CMS) ──
// The CMS performs Firebase auth + tenant authorization, then calls these.
// The campaign itself is read from Firestore here (source of truth); tenantUserId
// is re-checked against the stored owner as defense-in-depth.

interface CampaignActionBody {
  campaignId?: string;
  tenantUserId?: string;
}

/** Map a service-layer reason to an HTTP status. */
function campaignErrorStatus(reason?: string): number {
  if (reason === 'not_found') return 404;
  if (reason === 'forbidden') return 403;
  return 409; // state/validation conflicts (wrong type/status)
}

router.post('/campaigns/send', async (req: Request<{}, {}, CampaignActionBody>, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { campaignId, tenantUserId } = req.body || {};
  if (!campaignId || !tenantUserId) {
    return res.status(400).json({ ok: false, error: 'campaignId and tenantUserId are required' });
  }
  try {
    const result = await sendBroadcast(String(campaignId), String(tenantUserId));
    if (!result.ok) {
      const status = result.error === 'insufficient_credits' ? 402 : campaignErrorStatus(result.error);
      return res.status(status).json({
        ok: false,
        error: result.error,
        ...(result.needed !== undefined ? { needed: result.needed, spendable: result.spendable } : {}),
        // Which channels are short, and whether the fix is "move credits"
        // rather than "top up" — the CMS turns these into the right CTA.
        ...(result.shortfalls ? { shortfalls: result.shortfalls } : {}),
        ...(result.sharedContended !== undefined ? { sharedContended: result.sharedContended } : {}),
      });
    }
    return res.json({ ok: true, status: result.status, scheduledFor: result.scheduledFor });
  } catch (err) {
    console.error('[INTERNAL campaigns/send]', err);
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'send failed' });
  }
});

// Launch-preview credit estimate for the CMS Review step (spec §5.3.1).
router.post('/campaigns/estimate', async (req: Request<{}, {}, CampaignActionBody>, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { campaignId, tenantUserId } = req.body || {};
  if (!campaignId || !tenantUserId) {
    return res.status(400).json({ ok: false, error: 'campaignId and tenantUserId are required' });
  }
  try {
    const result = await estimateCampaignCredits(String(campaignId), String(tenantUserId));
    if (!result.ok) return res.status(campaignErrorStatus(result.error)).json({ ok: false, error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[INTERNAL campaigns/estimate]', err);
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'estimate failed' });
  }
});

// Re-dispatch held sends after a top-up (spec §5.3.4).
router.post('/campaigns/retry-held', async (req: Request<{}, {}, CampaignActionBody>, res: Response) => {
  if (!requireInternalSecret(req, res)) return;
  const { campaignId, tenantUserId } = req.body || {};
  if (!campaignId || !tenantUserId) {
    return res.status(400).json({ ok: false, error: 'campaignId and tenantUserId are required' });
  }
  try {
    const result = await retryHeldSends(String(campaignId), String(tenantUserId));
    if (!result.ok) {
      const status = result.error === 'insufficient_credits' ? 402 : campaignErrorStatus(result.error);
      return res.status(status).json({ ...result, ok: false });
    }
    return res.json(result);
  } catch (err) {
    console.error('[INTERNAL campaigns/retry-held]', err);
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'retry-held failed' });
  }
});

const CAMPAIGN_TRANSITIONS = {
  pause: pauseCampaign,
  resume: resumeCampaign,
  cancel: cancelCampaign,
} as const;

for (const [action, handler] of Object.entries(CAMPAIGN_TRANSITIONS)) {
  router.post(`/campaigns/${action}`, async (req: Request<{}, {}, CampaignActionBody>, res: Response) => {
    if (!requireInternalSecret(req, res)) return;
    const { campaignId, tenantUserId } = req.body || {};
    if (!campaignId || !tenantUserId) {
      return res.status(400).json({ ok: false, error: 'campaignId and tenantUserId are required' });
    }
    try {
      const result = await handler(String(campaignId), String(tenantUserId));
      if (!result.ok) return res.status(campaignErrorStatus(result.error)).json({ ok: false, error: result.error });
      return res.json({ ok: true, status: result.status });
    } catch (err) {
      console.error(`[INTERNAL campaigns/${action}]`, err);
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : `${action} failed` });
    }
  });
}

export default router;
