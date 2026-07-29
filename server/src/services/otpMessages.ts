/**
 * Delivery of verification codes, per channel.
 *
 * Every provider service in this repo returns `null` when its env is unset
 * rather than throwing, so a naive caller reads "not configured" as success.
 * That is the exact failure this module exists to prevent: `sendOtp` converts
 * `null` into an explicit `unconfigured` result so `/verify/send` can refuse
 * instead of leaving a guest waiting for a message nobody ever sent.
 *
 * Only WhatsApp is constrained in what it can say — Meta locks the body of
 * AUTHENTICATION templates to "<code> is your verification code." with exactly
 * one variable, so the venue name CANNOT appear there. SMS and email are free
 * text and do carry it.
 */

import { sendWhatsAppTemplate } from './whatsapp';
import { scheduleSms } from './twilio';
import { sendEmail } from './brevo';
import type { VerifyChannel } from './guestOtp';

/**
 * Registered in Meta WhatsApp Manager. Mirrored for review in
 * docs/whatsapp-templates/heidifi_verification_code.md — update both together.
 *
 * Language is `en`, matching restaurant_feedback_request. NOT `en_US`: a
 * mismatch is Meta error 132001 "template does not exist", which reads as a
 * total channel outage.
 */
export const OTP_WHATSAPP_TEMPLATE = { name: 'heidifi_verification_code', language: 'en' };

export type OtpSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; kind: 'unconfigured' | 'undeliverable' | 'template' | 'error'; detail: string };

/**
 * Meta error codes that mean "this number cannot receive this message", as
 * opposed to a transient fault. These are worth telling the guest about,
 * because the fix is theirs: use a different channel.
 */
const META_UNDELIVERABLE = new Set([131026, 131047, 131051, 131052]);
/** Meta codes meaning the template itself is wrong or not yet approved. */
const META_TEMPLATE = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

/** Twilio codes meaning the destination is invalid or unreachable. */
const TWILIO_UNDELIVERABLE = new Set([21211, 21214, 21401, 21408, 21610, 21612, 21614]);

function metaErrorCode(message: string): number | null {
  // whatsapp.ts throws `[WHATSAPP API ERROR] <code>: <message>`.
  const match = /\[WHATSAPP API ERROR\]\s*(\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

function twilioErrorCode(err: unknown): number | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' ? code : null;
}

function otpEmailHtml(code: string, venueName: string): string {
  const where = venueName ? ` for ${escapeHtml(venueName)}` : '';
  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
  <p style="font-size:15px;margin:0 0 16px">Here is your WiFi verification code${where}:</p>
  <p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:0 0 16px;color:#1c2b4a">${code}</p>
  <p style="font-size:14px;color:#717171;margin:0 0 8px">This code expires in 10 minutes.</p>
  <p style="font-size:14px;color:#717171;margin:0">For your security, do not share this code with anyone.</p>
</div>`.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendOtp(
  channel: VerifyChannel,
  destination: string,
  code: string,
  venueName: string,
): Promise<OtpSendResult> {
  try {
    if (channel === 'whatsapp') {
      const wamid = await sendWhatsAppTemplate(destination, {
        templateName: OTP_WHATSAPP_TEMPLATE.name,
        languageCode: OTP_WHATSAPP_TEMPLATE.language,
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // The Copy-code button carries the SAME code as the body. Meta declares
          // the button as OTP at creation but converts it to a URL button, hence
          // sub_type 'url'. Omitting this component entirely is error 132000 —
          // a silent, total failure of the channel.
          { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] },
        ],
      });
      if (wamid === null) return { ok: false, kind: 'unconfigured', detail: 'whatsapp env unset' };
      return { ok: true, providerMessageId: wamid };
    }

    if (channel === 'sms') {
      const where = venueName ? ` ${venueName}` : '';
      // No link: link-bearing OTP SMS trips carrier spam filtering. No "Reply
      // STOP" either — this is transactional, and the marketing dispatcher's
      // suffix logic lives in campaigns.ts and does not run here.
      const body = `${code} is your${where} WiFi verification code. It expires in 10 minutes. Do not share it.`;
      const sid = await scheduleSms(destination, body, 0);
      if (sid === null) return { ok: false, kind: 'unconfigured', detail: 'twilio env unset' };
      return { ok: true, providerMessageId: sid };
    }

    const subject = venueName
      ? `${code} is your ${venueName} WiFi code`
      : `${code} is your WiFi verification code`;
    // Deliberately no unsubscribeUrl: a List-Unsubscribe header on a verification
    // code would let a guest unsubscribe from their own login.
    const messageId = await sendEmail(destination, subject, otpEmailHtml(code, venueName), 0);
    if (messageId === null) return { ok: false, kind: 'unconfigured', detail: 'brevo env unset' };
    return { ok: true, providerMessageId: messageId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    if (channel === 'whatsapp') {
      const code = metaErrorCode(detail);
      if (code && META_UNDELIVERABLE.has(code)) return { ok: false, kind: 'undeliverable', detail };
      if (code && META_TEMPLATE.has(code)) return { ok: false, kind: 'template', detail };
    }
    if (channel === 'sms') {
      const code = twilioErrorCode(err);
      if (code && TWILIO_UNDELIVERABLE.has(code)) return { ok: false, kind: 'undeliverable', detail };
    }

    console.error(`[OTP SEND ERROR] channel=${channel}`, detail);
    return { ok: false, kind: 'error', detail };
  }
}

/**
 * Trips after repeated template-level WhatsApp failures so every guest at every
 * venue is not queued behind an API call that cannot succeed — the state during
 * the window between enabling the channel and Meta approving the template.
 */
const TEMPLATE_FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let templateFailures = 0;
let breakerOpenedAt = 0;

export function whatsappBreakerOpen(): boolean {
  if (!breakerOpenedAt) return false;
  if (Date.now() - breakerOpenedAt > BREAKER_COOLDOWN_MS) {
    breakerOpenedAt = 0;
    templateFailures = 0;
    return false;
  }
  return true;
}

export function noteWhatsappResult(result: OtpSendResult): void {
  if (result.ok) {
    templateFailures = 0;
    return;
  }
  if (result.kind !== 'template' && result.kind !== 'unconfigured') return;
  templateFailures += 1;
  if (templateFailures >= TEMPLATE_FAILURE_THRESHOLD && !breakerOpenedAt) {
    breakerOpenedAt = Date.now();
    console.error(
      `[OTP] WhatsApp disabled for ${BREAKER_COOLDOWN_MS / 60000}min after `
      + `${templateFailures} template failures — is ${OTP_WHATSAPP_TEMPLATE.name} approved?`,
    );
  }
}
