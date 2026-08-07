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
import { languageOrDefault, type SupportedLanguage } from './guestLanguage';

/**
 * Registered in Meta WhatsApp Manager. Mirrored for review in
 * docs/whatsapp-templates/heidifi_verification_code.md — update both together.
 *
 * Language is `en`, matching restaurant_feedback_request. NOT `en_US`: a
 * mismatch is Meta error 132001 "template does not exist", which reads as a
 * total channel outage.
 */
export const OTP_WHATSAPP_TEMPLATE = { name: 'heidifi_verification_code', language: 'en' };

/**
 * Meta locales this template is APPROVED in — not the languages the portal
 * offers.
 *
 * An AUTHENTICATION template is approved per locale, and sending a locale Meta
 * has not approved is error 132001 "template does not exist", which the guest
 * experiences as WhatsApp verification being entirely broken. So the list is an
 * ops fact, not a product setting: a German guest gets an English WhatsApp code
 * until `de` is approved and added here. Email and SMS are free text and are
 * translated from day one.
 *
 * To add a locale: submit the template translation via the add-whatsapp-template
 * flow, wait for Meta approval, THEN append the code here. Appending first
 * breaks the channel.
 */
export const OTP_WHATSAPP_APPROVED_LOCALES: readonly string[] = ['en'];

function whatsappOtpLocale(language: SupportedLanguage): string {
  return OTP_WHATSAPP_APPROVED_LOCALES.includes(language)
    ? language
    : OTP_WHATSAPP_TEMPLATE.language;
}

/**
 * Free-text OTP copy per language. WhatsApp is absent by design — Meta owns
 * that body.
 *
 * `smsBody` and `emailSubject` take the code and an already-escaped venue name;
 * both handle the no-venue-name case, which happens when the AP is not yet
 * linked to a venue.
 */
const OTP_COPY: Record<SupportedLanguage, {
  smsBody: (code: string, venue: string) => string;
  emailSubject: (code: string, venue: string) => string;
  emailIntro: (venue: string) => string;
  emailExpiry: string;
  emailSecurity: string;
}> = {
  en: {
    smsBody: (code, venue) =>
      `${code} is your${venue ? ` ${venue}` : ''} WiFi verification code. It expires in 10 minutes. Do not share it.`,
    emailSubject: (code, venue) =>
      venue ? `${code} is your ${venue} WiFi code` : `${code} is your WiFi verification code`,
    emailIntro: (venue) => `Here is your WiFi verification code${venue ? ` for ${venue}` : ''}:`,
    emailExpiry: 'This code expires in 10 minutes.',
    emailSecurity: 'For your security, do not share this code with anyone.',
  },
  de: {
    smsBody: (code, venue) =>
      `${code} ist Ihr${venue ? ` ${venue}` : ''} WLAN-Bestätigungscode. Er läuft in 10 Minuten ab. Geben Sie ihn nicht weiter.`,
    emailSubject: (code, venue) =>
      venue ? `${code} ist Ihr WLAN-Code für ${venue}` : `${code} ist Ihr WLAN-Bestätigungscode`,
    emailIntro: (venue) => `Hier ist Ihr WLAN-Bestätigungscode${venue ? ` für ${venue}` : ''}:`,
    emailExpiry: 'Dieser Code läuft in 10 Minuten ab.',
    emailSecurity: 'Geben Sie diesen Code zu Ihrer Sicherheit an niemanden weiter.',
  },
  it: {
    smsBody: (code, venue) =>
      `${code} è il tuo codice di verifica WiFi${venue ? ` di ${venue}` : ''}. Scade tra 10 minuti. Non condividerlo.`,
    emailSubject: (code, venue) =>
      venue ? `${code} è il tuo codice WiFi di ${venue}` : `${code} è il tuo codice di verifica WiFi`,
    emailIntro: (venue) => `Ecco il tuo codice di verifica WiFi${venue ? ` per ${venue}` : ''}:`,
    emailExpiry: 'Questo codice scade tra 10 minuti.',
    emailSecurity: 'Per la tua sicurezza, non condividere questo codice con nessuno.',
  },
  fr: {
    smsBody: (code, venue) =>
      `${code} est votre code de vérification WiFi${venue ? ` ${venue}` : ''}. Il expire dans 10 minutes. Ne le partagez pas.`,
    emailSubject: (code, venue) =>
      venue ? `${code} est votre code WiFi ${venue}` : `${code} est votre code de vérification WiFi`,
    emailIntro: (venue) => `Voici votre code de vérification WiFi${venue ? ` pour ${venue}` : ''} :`,
    emailExpiry: 'Ce code expire dans 10 minutes.',
    emailSecurity: 'Pour votre sécurité, ne partagez ce code avec personne.',
  },
};

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

function otpEmailHtml(code: string, venueName: string, language: SupportedLanguage): string {
  const copy = OTP_COPY[language];
  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
  <p style="font-size:15px;margin:0 0 16px">${escapeHtml(copy.emailIntro(venueName))}</p>
  <p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:0 0 16px;color:#1c2b4a">${code}</p>
  <p style="font-size:14px;color:#717171;margin:0 0 8px">${escapeHtml(copy.emailExpiry)}</p>
  <p style="font-size:14px;color:#717171;margin:0">${escapeHtml(copy.emailSecurity)}</p>
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
  language?: unknown,
): Promise<OtpSendResult> {
  const lang = languageOrDefault(language);
  const copy = OTP_COPY[lang];
  try {
    if (channel === 'whatsapp') {
      const wamid = await sendWhatsAppTemplate(destination, {
        templateName: OTP_WHATSAPP_TEMPLATE.name,
        // Falls back to English unless Meta has approved the guest's locale.
        languageCode: whatsappOtpLocale(lang),
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
      // No link: link-bearing OTP SMS trips carrier spam filtering. No "Reply
      // STOP" either — this is transactional, and the marketing dispatcher's
      // suffix logic lives in campaigns.ts and does not run here.
      const body = copy.smsBody(code, venueName);
      const sid = await scheduleSms(destination, body, 0);
      if (sid === null) return { ok: false, kind: 'unconfigured', detail: 'twilio env unset' };
      return { ok: true, providerMessageId: sid };
    }

    const subject = copy.emailSubject(code, venueName);
    // Deliberately no unsubscribeUrl: a List-Unsubscribe header on a verification
    // code would let a guest unsubscribe from their own login.
    const messageId = await sendEmail(destination, subject, otpEmailHtml(code, venueName, lang), 0);
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
