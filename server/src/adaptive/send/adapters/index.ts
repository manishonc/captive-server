/**
 * Which adapters send. In the local emulator stack (sandboxEnabled()) the
 * sandbox adapters REPLACE the real ones — the tracked local .env holds real
 * Brevo/Twilio/Meta credentials, so they must never sit side by side. Everywhere
 * else: Brevo for email, Twilio for SMS, Meta's Cloud API for WhatsApp (PR W3),
 * one memoized instance of each per process (one keep-alive agent, not one per send).
 *
 * This module pulls in Firestore (via sandbox.ts); tests of the provider
 * boundary import brevo.ts / twilio.ts directly instead.
 */

import { sandboxEnabled } from '../../engine/clock';
import { createBrevoEmailAdapter } from './brevo';
import { createSandboxAdapter } from './sandbox';
import { createTwilioSmsAdapter } from './twilio';
import { createWhatsAppAdapter } from './whatsapp';
import type { ChannelAdapter } from './types';

export type AdapterRegistry = Partial<Record<'email' | 'sms' | 'whatsapp', ChannelAdapter>>;

interface AdapterSet {
  email: ChannelAdapter;
  sms: ChannelAdapter;
  whatsapp: ChannelAdapter;
}

let real: AdapterSet | null = null;
let sandbox: AdapterSet | null = null;

/** The process-wide Brevo/Twilio/Meta adapters (created on first use; diagnostics can call ready() on them). */
export function realAdapters(): AdapterSet {
  if (!real) real = { email: createBrevoEmailAdapter(), sms: createTwilioSmsAdapter(), whatsapp: createWhatsAppAdapter() };
  return real;
}

function sandboxAdapters(): AdapterSet {
  if (!sandbox) sandbox = { email: createSandboxAdapter('email'), sms: createSandboxAdapter('sms'), whatsapp: createSandboxAdapter('whatsapp') };
  return sandbox;
}

/**
 * Fills `registry.email` / `registry.sms` / `registry.whatsapp`, replacing whatever is there.
 * Idempotent: every call installs the same instances. WhatsApp is only used while the launch
 * setting `whatsappSending` is on (engine/sendPath.ts; PR W3).
 */
export function registerAdapters(registry: AdapterRegistry): void {
  const set = sandboxEnabled() ? sandboxAdapters() : realAdapters();
  registry.email = set.email;
  registry.sms = set.sms;
  registry.whatsapp = set.whatsapp;
}
