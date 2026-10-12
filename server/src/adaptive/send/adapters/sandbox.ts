/**
 * The fake provider for the local emulator stack (ADAPTIVE_SANDBOX=1 +
 * FIRESTORE_EMULATOR_HOST, see engine/clock.ts). A "send" is a write to
 * `CaptivePortal_AdaptiveSandboxOutbox/{sendKey}` — `set`, so a repeated send
 * of the same key is idempotent — and never leaves the machine.
 *
 * Deterministic failures, for exercising the dispatcher by hand or in tests
 * (a triggered failure writes nothing):
 *
 *   email local part contains   SMS number ends in   →  result
 *   +reject                     —                       rejected  sandbox_reject
 *   —                           0000                    rejected  21610, suppress 'stop'
 *   +timeout                    0001                    unknown   sandbox_timeout
 *   +ratelimit                  0002                    retry     sandbox_rate_limit (60 s)
 *   +authfail                   0003                    rejected  sandbox_auth_fail, config
 *
 * WhatsApp (PR PV: the owner's Send test), by the number's end: 0000 → rejected 131026 (not on
 * WhatsApp), 0001 → unknown, 0002 → retry 130429 (60 s), 0003 → rejected 190, config; 0004 →
 * rejected 132001 (Meta doesn't know the template in that language). The outbox doc keeps the
 * template, its values and the text the guest would read. PR W3: like Meta, a Mexican number
 * (+52…) comes back with WhatsApp's own id (+521…) as `recipientId`.
 */

import { db } from '../../../firebase';
import { smsSegmentCount } from '../../core/runtime/smsParts';
import { sandboxEnabled } from '../../engine/clock';
import { COL } from '../../store/collections';
import type { ChannelAdapter, Outbound, ProviderResult } from './types';

const SANDBOX_RETRY_AFTER_MS = 60_000;

function triggeredFailure(message: Outbound): ProviderResult | null {
  const provider = 'sandbox' as const;
  if (message.kind === 'email') {
    const local = String(message.to ?? '').split('@')[0].toLowerCase();
    if (local.includes('+reject')) {
      return { kind: 'rejected', provider, code: 'sandbox_reject', message: 'sandbox: rejected (+reject)' };
    }
    if (local.includes('+timeout')) return { kind: 'unknown', provider, reason: 'sandbox_timeout' };
    if (local.includes('+ratelimit')) {
      return { kind: 'retry', provider, reason: 'sandbox_rate_limit', retryAfterMs: SANDBOX_RETRY_AFTER_MS };
    }
    if (local.includes('+authfail')) {
      return { kind: 'rejected', provider, code: 'sandbox_auth_fail', message: 'sandbox: credentials refused (+authfail)', config: true };
    }
    return null;
  }
  if (message.kind === 'whatsapp') {
    const end = String(message.to ?? '').replace(/\D/g, '').slice(-4);
    if (end === '0000') return { kind: 'rejected', provider, code: '131026', message: 'sandbox: message undeliverable (not on WhatsApp)' };
    if (end === '0001') return { kind: 'unknown', provider, reason: 'sandbox_timeout' };
    if (end === '0002') return { kind: 'retry', provider, reason: 'sandbox_rate_limit', retryAfterMs: SANDBOX_RETRY_AFTER_MS };
    if (end === '0003') return { kind: 'rejected', provider, code: '190', message: 'sandbox: the access token has expired', config: true };
    if (end === '0004') return { kind: 'rejected', provider, code: '132001', message: 'sandbox: template name does not exist in the translation' };
    return null;
  }
  const digits = String(message.to ?? '').replace(/\D/g, '');
  if (digits.endsWith('0000')) {
    return { kind: 'rejected', provider, code: '21610', message: 'sandbox: number has replied STOP', suppress: 'stop' };
  }
  if (digits.endsWith('0001')) return { kind: 'unknown', provider, reason: 'sandbox_timeout' };
  if (digits.endsWith('0002')) {
    return { kind: 'retry', provider, reason: 'sandbox_rate_limit', retryAfterMs: SANDBOX_RETRY_AFTER_MS };
  }
  if (digits.endsWith('0003')) {
    return { kind: 'rejected', provider, code: 'sandbox_auth_fail', message: 'sandbox: credentials refused', config: true };
  }
  return null;
}

/** Shaped like the real ids: Brevo's `<…>` Message-ID, Twilio's `SM…`, WhatsApp's `wamid.…`. */
function sandboxMessageId(message: Outbound): string {
  if (message.kind === 'whatsapp') return `wamid.sbx.${message.sendKey}`;
  return message.kind === 'email' ? `<sbx.${message.sendKey}@sandbox.local>` : `SMsbx${message.sendKey.slice(3)}`;
}

export function createSandboxAdapter(channel: 'email' | 'sms' | 'whatsapp'): ChannelAdapter {
  return {
    channel,
    provider: 'sandbox',
    ready: () => sandboxEnabled(),
    async send(message: Outbound): Promise<ProviderResult> {
      // Never pretend to send outside the emulator stack.
      if (!sandboxEnabled()) {
        return { kind: 'rejected', provider: 'sandbox', code: 'sandbox_off', message: 'the sandbox provider only runs in the local emulator stack', config: true };
      }
      if (message.kind !== channel) {
        return { kind: 'rejected', provider: 'sandbox', code: 'wrong_channel', message: `sandbox ${channel} adapter got ${message.kind}` };
      }

      const failure = triggeredFailure(message);
      if (failure) return failure;

      const providerMessageId = sandboxMessageId(message);
      const segments = message.kind === 'sms' ? smsSegmentCount(message.body) : null;
      const doc =
        message.kind === 'whatsapp'
          ? {
              channel: 'whatsapp' as const,
              to: message.to,
              templateName: message.templateName,
              language: message.language,
              bodyParams: message.bodyParams,
              button: message.button,
              text: message.previewText,
              sendKey: message.sendKey,
              providerMessageId,
              at: new Date(),
            }
          : message.kind === 'email'
          ? {
              channel: 'email' as const,
              to: message.to,
              subject: message.subject,
              text: message.text,
              html: message.html,
              unsubscribeUrl: message.unsubscribeUrl ?? null,
              sendKey: message.sendKey,
              providerMessageId,
              at: new Date(),
            }
          : {
              channel: 'sms' as const,
              to: message.to,
              body: message.body,
              segments,
              sendKey: message.sendKey,
              providerMessageId,
              at: new Date(),
            };

      try {
        await db.collection(COL.sandboxOutbox).doc(message.sendKey).set(doc);
      } catch (err) {
        // The write may have landed: same answer a real provider gives on a lost reply.
        return { kind: 'unknown', provider: 'sandbox', reason: `sandbox_write_failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 200) };
      }

      if (message.kind === 'whatsapp') {
        const digits = message.to.replace(/\D/g, '');
        const recipientId = digits.startsWith('52') && !digits.startsWith('521') ? `521${digits.slice(2)}` : digits;
        return { kind: 'accepted', provider: 'sandbox', providerMessageId, recipientId };
      }
      return message.kind === 'sms'
        ? { kind: 'accepted', provider: 'sandbox', providerMessageId, segments }
        : { kind: 'accepted', provider: 'sandbox', providerMessageId };
    },
  };
}
