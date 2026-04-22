/**
 * Meta WhatsApp Cloud API service
 *
 * Env vars required:
 *   WHATSAPP_PHONE_NUMBER_ID  — from Meta App dashboard (API Setup page)
 *   WHATSAPP_ACCESS_TOKEN     — permanent System User token from Meta Business Settings
 */

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const API_VERSION = 'v19.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

export interface WhatsAppTemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters: Array<{ type: 'text'; text: string }>;
}

export interface WhatsAppTemplateMessage {
  /** Approved template name in Meta (e.g. "wifi_welcome") */
  templateName: string;
  /** BCP-47 language code matching your template (e.g. "en_US") */
  languageCode: string;
  /** Variable substitutions for header/body/buttons */
  components?: WhatsAppTemplateComponent[];
  /** Minutes to wait before sending (informational — Meta Cloud API has no native scheduling) */
  delayMinutes?: number;
}

function isConfigured(): boolean {
  return !!(PHONE_NUMBER_ID && ACCESS_TOKEN);
}

/**
 * Sends a WhatsApp template message via Meta Cloud API.
 * Returns the message wamid on success, null if env is not configured.
 */
export async function sendWhatsAppTemplate(
  to: string,
  template: WhatsAppTemplateMessage
): Promise<string | null> {
  if (!isConfigured()) {
    console.warn('[WHATSAPP] Skipping: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set');
    return null;
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.templateName,
      language: { code: template.languageCode },
      ...(template.components?.length ? { components: template.components } : {}),
    },
  };

  const response = await fetch(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const err = data?.error as Record<string, unknown> | undefined;
    throw new Error(
      `[WHATSAPP API ERROR] ${err?.code ?? response.status}: ${err?.message ?? JSON.stringify(data)}`
    );
  }

  // Response shape: { messages: [{ id: "wamid.xxx" }] }
  const messages = data?.messages as Array<{ id: string }> | undefined;
  return messages?.[0]?.id ?? null;
}

/**
 * Converts a phone + country code into E.164 format for WhatsApp.
 * WhatsApp numbers must NOT include the "whatsapp:" prefix — just plain E.164.
 */
export function toE164(phoneCountryCode: string, phone: string): string | null {
  const code = (phoneCountryCode || '').trim().replace(/^\+/, '') || '';
  const num = (phone || '').replace(/\D/g, '');
  if (!num || num.length < 6) return null;
  return `+${code}${num}`;
}
