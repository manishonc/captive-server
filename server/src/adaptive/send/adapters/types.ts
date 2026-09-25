/**
 * The provider boundary (plan §2.6, §3.7). An adapter turns one rendered message
 * into exactly one provider request — never more: automatic retries are off, the
 * request times out after 15 s, and the answer is classified so the dispatcher
 * knows whether the message may have left:
 *
 *   accepted → the provider took it (charge, carry on)
 *   rejected → a definite no, e.g. 4xx / Twilio 21610 (not charged, step skipped)
 *   retry    → it provably never left: 429, or the connection failed before the
 *              request was sent (try again later)
 *   unknown  → it may have left: timeout or 5xx after sending, connection reset
 *              mid-request, anything unrecognised (never resent, not charged)
 *
 * Adaptive builds its own clients from the same env vars as services/brevo.ts and
 * services/twilio.ts; those files stay untouched (their clients retry and can
 * schedule at the provider, which would break exactly-once).
 */

export type ProviderName = 'brevo' | 'twilio' | 'sandbox';

export interface OutboundEmail {
  kind: 'email';
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Goes out as the `X-Mailin-custom` header, so Brevo webhooks name the send. */
  sendKey: string;
  /** Marketing email: List-Unsubscribe + List-Unsubscribe-Post (RFC 8058). */
  unsubscribeUrl: string | null;
}

export interface OutboundSms {
  kind: 'sms';
  /** E.164. */
  to: string;
  /** Exactly the priced text, STOP line included. */
  body: string;
  sendKey: string;
}

export type Outbound = OutboundEmail | OutboundSms;

export type ProviderResult =
  | { kind: 'accepted'; provider: ProviderName; providerMessageId: string | null; segments?: number | null }
  | {
      kind: 'rejected';
      provider: ProviderName;
      code: string;
      message: string;
      /** Twilio 21610 ("unsubscribed") → STOP-block the number everywhere. */
      suppress?: 'stop' | null;
      /** An account/credentials problem (401/403, Twilio 20003): not the guest's fault. */
      config?: boolean;
    }
  | { kind: 'retry'; provider: ProviderName; reason: string; retryAfterMs?: number | null }
  | { kind: 'unknown'; provider: ProviderName; reason: string };

export interface ChannelAdapter {
  channel: 'email' | 'sms';
  provider: ProviderName;
  /** Credentials present (and, for the real providers, not in the local emulator stack). */
  ready(): boolean;
  send(message: Outbound): Promise<ProviderResult>;
}

/** Provider requests give up after this long; the task lease (2 min) is well above it. */
export const PROVIDER_TIMEOUT_MS = 15_000;
