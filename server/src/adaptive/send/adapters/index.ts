/**
 * Which adapters send. In the local emulator stack (sandboxEnabled()) the
 * sandbox adapters REPLACE the real ones — the tracked local .env holds real
 * Brevo/Twilio credentials, so they must never sit side by side. Everywhere
 * else: Brevo for email, Twilio for SMS, one memoized instance of each per
 * process (one keep-alive agent, not one per send).
 *
 * This module pulls in Firestore (via sandbox.ts); tests of the provider
 * boundary import brevo.ts / twilio.ts directly instead.
 */

import { sandboxEnabled } from '../../engine/clock';
import { createBrevoEmailAdapter } from './brevo';
import { createSandboxAdapter } from './sandbox';
import { createTwilioSmsAdapter } from './twilio';
import type { ChannelAdapter } from './types';

export type AdapterRegistry = Partial<Record<'email' | 'sms' | 'whatsapp', ChannelAdapter>>;

interface AdapterSet {
  email: ChannelAdapter;
  sms: ChannelAdapter;
}

let real: AdapterSet | null = null;
let sandbox: AdapterSet | null = null;

/** The process-wide Brevo/Twilio adapters (created on first use; diagnostics can call ready() on them). */
export function realAdapters(): AdapterSet {
  if (!real) real = { email: createBrevoEmailAdapter(), sms: createTwilioSmsAdapter() };
  return real;
}

function sandboxAdapters(): AdapterSet {
  if (!sandbox) sandbox = { email: createSandboxAdapter('email'), sms: createSandboxAdapter('sms') };
  return sandbox;
}

/**
 * Fills `registry.email` / `registry.sms`, replacing whatever is there.
 * Idempotent: every call installs the same instances. WhatsApp is untouched.
 */
export function registerAdapters(registry: AdapterRegistry): void {
  const set = sandboxEnabled() ? sandboxAdapters() : realAdapters();
  registry.email = set.email;
  registry.sms = set.sms;
}
