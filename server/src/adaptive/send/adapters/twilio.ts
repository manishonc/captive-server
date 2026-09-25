/**
 * Twilio SMS adapter for Adaptive Campaigns (see types.ts for the contract).
 *
 * One request per send, never more:
 *  - `autoRetry: false` (the SDK default, set explicitly);
 *  - `timeout` is in MILLISECONDS (default 30000; 0 would silently mean 30000)
 *    and is a socket-inactivity timeout, not a total deadline, hence the outer
 *    hard deadline;
 *  - never `scheduleType` / `sendAt` (the queue owns timing) and never
 *    `smartEncoded` (credits are priced from our own text).
 *
 * `statusCallback` must be byte-identical to services/twilio.ts and to what
 * routes/twilioWebhook.ts validates: raw SERVER_PUBLIC_URL, no trim, no query
 * string — anything else makes the webhook's signature check answer 403.
 *
 * services/twilio.ts stays untouched: it builds a client per call and can schedule.
 */

import twilio from 'twilio';
import { HARD_DEADLINE_GRACE_MS, PRE_SEND_NET_CODES, withHardDeadline } from './brevo';
import { PROVIDER_TIMEOUT_MS, type ChannelAdapter, type Outbound, type ProviderResult } from './types';

type TwilioClient = ReturnType<typeof twilio>;

/**
 * Maps a rejected `messages.create()` onto the four outcomes (providers.md §5).
 * Only for errors that surfaced AFTER create() returned its promise: those may
 * come from the network or from parsing a 2xx reply, so a bare Error is `unknown`.
 */
export function classifyTwilioError(err: unknown): ProviderResult {
  const provider = 'twilio' as const;
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  const message = typeof e.message === 'string' ? e.message : String(err);

  // RestException / TwilioServiceException (the latter isn't exported: duck-type).
  if (typeof e.status === 'number') {
    const status = e.status;
    const codeNum = Number(e.code);
    const hasCode = Number.isFinite(codeNum) && codeNum !== 0;
    const code = hasCode ? String(codeNum) : String(status);
    if (status === 429 || codeNum === 20429) return { kind: 'retry', provider, reason: `twilio_${code}`, retryAfterMs: null };
    if (codeNum === 21610) return { kind: 'rejected', provider, code: '21610', message, suppress: 'stop' };
    if (status === 401 || codeNum === 20003) return { kind: 'rejected', provider, code, message, config: true };
    if (status >= 500) return { kind: 'unknown', provider, reason: `twilio_${status}` };
    if (status >= 400) return { kind: 'rejected', provider, code, message };
    return { kind: 'unknown', provider, reason: `twilio_${status}` };
  }

  // axios / Node network errors carry a string code.
  const netCode = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : null;
  if (netCode) {
    return PRE_SEND_NET_CODES.has(netCode)
      ? { kind: 'retry', provider, reason: `net_${netCode}`, retryAfterMs: null }
      : { kind: 'unknown', provider, reason: `net_${netCode}` }; // ECONNABORTED, ETIMEDOUT, ECONNRESET, EPIPE, …
  }

  // e.g. a 2xx whose body isn't JSON (Version.create's JSON.parse) — it may have been sent.
  return { kind: 'unknown', provider, reason: message.slice(0, 200) || 'error' };
}

export interface TwilioAdapterOptions {
  /** Test seam: `{ request: async (opts) => ({ statusCode, body, headers }) }`. Bypasses `timeout`/`autoRetry`. */
  httpClient?: any;
  /** Provider timeout in ms (default PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Extra time past `timeoutMs` before the outer deadline answers `unknown` (default 5 s). */
  deadlineGraceMs?: number;
}

/**
 * Credentials present (the SID must start with AC or `twilio()` throws at
 * construction), a sender configured, and not the local emulator stack.
 */
function twilioReady(): boolean {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
  return (
    sid.startsWith('AC') &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_PHONE_NUMBER) &&
    !process.env.FIRESTORE_EMULATOR_HOST
  );
}

export function createTwilioSmsAdapter(opts: TwilioAdapterOptions = {}): ChannelAdapter {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PROVIDER_TIMEOUT_MS;
  const graceMs = opts.deadlineGraceMs != null && opts.deadlineGraceMs >= 0 ? opts.deadlineGraceMs : HARD_DEADLINE_GRACE_MS;

  // One client (one keep-alive agent) per adapter, built on first send; rebuilt
  // only if the credentials env changes (read at call time, never at import).
  let client: TwilioClient | null = null;
  let clientFor = '';
  const getClient = (): TwilioClient => {
    const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
    const token = process.env.TWILIO_AUTH_TOKEN ?? '';
    const key = `${sid}\n${token}`;
    if (!client || clientFor !== key) {
      client = twilio(sid, token, {
        autoRetry: false,
        timeout: timeoutMs,
        ...(opts.httpClient ? { httpClient: opts.httpClient } : {}),
      });
      clientFor = key;
    }
    return client;
  };

  const attempt = async (sms: Extract<Outbound, { kind: 'sms' }>): Promise<ProviderResult> => {
    let tw: TwilioClient;
    try {
      tw = getClient();
    } catch (err) {
      return { kind: 'rejected', provider: 'twilio', code: 'client_init', message: (err as Error)?.message ?? String(err), config: true };
    }

    const mss = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const publicUrl = process.env.SERVER_PUBLIC_URL;
    const params = {
      to: sms.to,
      body: sms.body,
      ...(mss ? { messagingServiceSid: mss } : { from: process.env.TWILIO_PHONE_NUMBER as string }),
      ...(publicUrl ? { statusCallback: `${publicUrl}/webhook/twilio/sms-status` } : {}),
    };

    // The SDK validates parameters synchronously, before any request exists;
    // everything after the HTTP call surfaces as a rejection of this promise.
    let pending: ReturnType<TwilioClient['messages']['create']>;
    try {
      pending = tw.messages.create(params);
    } catch (err) {
      return { kind: 'rejected', provider: 'twilio', code: 'invalid_request', message: (err as Error)?.message ?? String(err) };
    }

    try {
      const msg = await pending;
      return {
        kind: 'accepted',
        provider: 'twilio',
        providerMessageId: typeof msg?.sid === 'string' && msg.sid ? msg.sid : null,
        segments: Number(msg?.numSegments) || null,
      };
    } catch (err) {
      return classifyTwilioError(err);
    }
  };

  return {
    channel: 'sms',
    provider: 'twilio',
    ready: twilioReady,
    async send(message: Outbound): Promise<ProviderResult> {
      if (message.kind !== 'sms') {
        return { kind: 'rejected', provider: 'twilio', code: 'wrong_channel', message: `twilio sends sms, got ${message.kind}` };
      }
      if (!twilioReady()) {
        return {
          kind: 'rejected',
          provider: 'twilio',
          code: 'not_configured',
          message: 'Twilio is not configured (or this is the local emulator stack)',
          config: true,
        };
      }
      if (!message.to || !message.body) {
        return { kind: 'rejected', provider: 'twilio', code: 'invalid_request', message: 'to and body are required' };
      }
      return withHardDeadline('twilio', attempt(message), timeoutMs + graceMs);
    },
  };
}
