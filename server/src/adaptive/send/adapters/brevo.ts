/**
 * Brevo email adapter for Adaptive Campaigns (see types.ts for the contract).
 *
 * One request per send, never more:
 *  - `maxRetries: 0` (the SDK default re-POSTs twice on 408/429/5xx; the SDK
 *    uses `??`, so 0 is kept);
 *  - `timeoutInSeconds` is in SECONDS (SDK default 60);
 *  - an outer hard deadline, because the SDK clears its timeout once headers
 *    arrive, so a hung body read would otherwise hold the task forever;
 *  - never `scheduledAt`: the queue owns timing.
 *
 * Classifying needs a fetch wrapper: the SDK keeps only `err.message` of a
 * failed fetch ("fetch failed", cause dropped), and in Node its own timeout
 * rejects with the bare string "timeout". `wrapBrevoFetch` rethrows both with
 * stable messages (`adaptive:net:<code>`, `adaptive:timeout`) that survive into
 * `BrevoError.message`.
 *
 * services/brevo.ts stays untouched: its client retries and can schedule.
 */

import { BrevoClient, BrevoError, BrevoTimeoutError } from '@getbrevo/brevo';
import { PROVIDER_TIMEOUT_MS, type ChannelAdapter, type Outbound, type ProviderResult } from './types';

/**
 * Connection failures that prove the request never reached the provider, so a
 * later retry cannot double-send. Shared with twilio.ts. Everything else
 * (resets, socket closes, timeouts) may have been sent and is `unknown`.
 */
export const PRE_SEND_NET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** How long past the provider timeout the outer deadline waits before answering `unknown`. */
export const HARD_DEADLINE_GRACE_MS = 5_000;

/**
 * Resolves to `work`, or to `unknown` once `ms` pass, whichever comes first.
 * `work` must not reject. The timer stays ref'd on purpose: a hung request
 * holds no handle of its own, so an unref'd timer could let a short-lived
 * process exit with the send unresolved.
 */
export function withHardDeadline(
  provider: ProviderResult['provider'],
  work: Promise<ProviderResult>,
  ms: number,
): Promise<ProviderResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProviderResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown', provider, reason: 'hard_deadline' }), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const TIMEOUT_MESSAGE = 'adaptive:timeout';
const NET_PREFIX = 'adaptive:net:';

/** The Node/undici error code of a failed fetch (`TypeError('fetch failed', { cause })`). */
function netErrorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null;
  const code = e?.cause?.code ?? e?.code ?? e?.cause?.errors?.[0]?.code;
  return typeof code === 'string' && code ? code : 'unknown';
}

/**
 * Wraps a fetch so its failures stay classifiable after the SDK strips them
 * down to a message. It also honours the abort signal itself, so a fetch that
 * ignores signals still gives up when the SDK's timeout fires.
 */
export function wrapBrevoFetch(base?: typeof fetch): typeof fetch {
  const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const impl = base ?? globalThis.fetch;
    const signal = args[1]?.signal ?? null;
    if (signal?.aborted) throw new Error(TIMEOUT_MESSAGE);
    let onAbort: (() => void) | null = null;
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(TIMEOUT_MESSAGE));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    try {
      const call = impl(...args);
      return await (aborted ? Promise.race([call, aborted]) : call);
    } catch (err) {
      if (signal?.aborted) throw new Error(TIMEOUT_MESSAGE);
      throw new Error(`${NET_PREFIX}${netErrorCode(err)}`);
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
  return wrapped as typeof fetch;
}

/** Milliseconds from `Retry-After` (seconds or HTTP date) or `x-sib-ratelimit-reset`; null if absent or unparseable. */
function retryAfterMsFrom(headers: unknown): number | null {
  const get = (name: string): string | null => {
    const h = headers as { get?: (n: string) => string | null } | null;
    if (h && typeof h.get === 'function') return h.get(name);
    return null;
  };
  const retryAfter = get('retry-after')?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) return Math.round(Number(retryAfter) * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const reset = get('x-sib-ratelimit-reset')?.trim();
  if (reset && /^\d+(\.\d+)?$/.test(reset)) {
    const n = Number(reset);
    // Brevo documents seconds until the window resets; tolerate an epoch too.
    return n > 1e9 ? Math.max(0, Math.round(n * 1000 - Date.now())) : Math.round(n * 1000);
  }
  return null;
}

/** Maps anything `sendTransacEmail` threw onto the four outcomes (providers.md §5). */
export function classifyBrevoError(err: unknown): ProviderResult {
  const provider = 'brevo' as const;
  if (err instanceof BrevoError && typeof err.statusCode === 'number') {
    const status = err.statusCode;
    const body = err.body;
    const obj = body && typeof body === 'object' ? (body as { code?: unknown; message?: unknown }) : null;
    const code = typeof obj?.code === 'string' && obj.code ? obj.code : `brevo_${status}`;
    const message =
      typeof obj?.message === 'string'
        ? obj.message
        : typeof body === 'string' && body
          ? body.slice(0, 500)
          : `Brevo HTTP ${status}`;
    if (status === 429) {
      return { kind: 'retry', provider, reason: 'brevo_429', retryAfterMs: retryAfterMsFrom(err.rawResponse?.headers) };
    }
    if (status === 401 || status === 403) return { kind: 'rejected', provider, code, message, config: true };
    if (status === 408 || status >= 500) return { kind: 'unknown', provider, reason: `brevo_${status}` };
    if (status >= 400) return { kind: 'rejected', provider, code, message };
    return { kind: 'unknown', provider, reason: `brevo_${status}` };
  }
  if (err instanceof BrevoTimeoutError) return { kind: 'unknown', provider, reason: 'timeout' };

  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith(TIMEOUT_MESSAGE)) return { kind: 'unknown', provider, reason: 'timeout' };
  if (message.startsWith(NET_PREFIX)) {
    const code = message.slice(NET_PREFIX.length).split(/\s/)[0] || 'unknown';
    return PRE_SEND_NET_CODES.has(code)
      ? { kind: 'retry', provider, reason: `net_${code}`, retryAfterMs: null }
      : { kind: 'unknown', provider, reason: `net_${code}` };
  }
  // Socket closed while reading the body ("terminated"), non-HTTP SDK errors, anything new.
  return { kind: 'unknown', provider, reason: message.slice(0, 200) || 'error' };
}

export interface BrevoAdapterOptions {
  /** Test seam; always wrapped by `wrapBrevoFetch`. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Provider timeout in ms (default PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Extra time past `timeoutMs` before the outer deadline answers `unknown` (default 5 s). */
  deadlineGraceMs?: number;
}

/** Credentials present, and not the local emulator stack (whose .env holds real keys). */
function brevoReady(): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) && !process.env.FIRESTORE_EMULATOR_HOST;
}

export function createBrevoEmailAdapter(opts: BrevoAdapterOptions = {}): ChannelAdapter {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PROVIDER_TIMEOUT_MS;
  const graceMs = opts.deadlineGraceMs != null && opts.deadlineGraceMs >= 0 ? opts.deadlineGraceMs : HARD_DEADLINE_GRACE_MS;
  const fetchImpl = wrapBrevoFetch(opts.fetch);

  // One client per adapter, built on first send; rebuilt only if the key or
  // base URL env changes (env is read at call time, never at import).
  let client: BrevoClient | null = null;
  let clientFor = '';
  const getClient = (): BrevoClient => {
    const apiKey = process.env.BREVO_API_KEY ?? '';
    const baseUrl = process.env.BREVO_API_URL || undefined;
    const key = `${apiKey}\n${baseUrl ?? ''}`;
    if (!client || clientFor !== key) {
      client = new BrevoClient({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        maxRetries: 0,
        timeoutInSeconds: timeoutMs / 1000,
        fetch: fetchImpl,
      });
      clientFor = key;
    }
    return client;
  };

  const attempt = async (email: Extract<Outbound, { kind: 'email' }>): Promise<ProviderResult> => {
    try {
      const res = await getClient().transactionalEmails.sendTransacEmail({
        to: [{ email: email.to }],
        sender: {
          email: process.env.BREVO_SENDER_EMAIL as string,
          name: process.env.BREVO_SENDER_NAME || 'WiFi Portal',
        },
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
        // EMAIL headers (request body), not HTTP headers to the API.
        headers: {
          'X-Mailin-custom': email.sendKey,
          ...(email.unsubscribeUrl
            ? {
                'List-Unsubscribe': `<${email.unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              }
            : {}),
        },
      });
      // An empty 2xx body resolves to undefined, a non-JSON one to an object
      // without messageId: accepted either way (X-Mailin-custom still names the send).
      const messageId = (res as { messageId?: unknown } | undefined)?.messageId;
      return {
        kind: 'accepted',
        provider: 'brevo',
        providerMessageId: typeof messageId === 'string' && messageId ? messageId : null, // verbatim, <brackets> kept
      };
    } catch (err) {
      return classifyBrevoError(err);
    }
  };

  return {
    channel: 'email',
    provider: 'brevo',
    ready: brevoReady,
    async send(message: Outbound): Promise<ProviderResult> {
      if (message.kind !== 'email') {
        return { kind: 'rejected', provider: 'brevo', code: 'wrong_channel', message: `brevo sends email, got ${message.kind}` };
      }
      if (!brevoReady()) {
        return {
          kind: 'rejected',
          provider: 'brevo',
          code: 'not_configured',
          message: 'Brevo is not configured (or this is the local emulator stack)',
          config: true,
        };
      }
      return withHardDeadline('brevo', attempt(message), timeoutMs + graceMs);
    },
  };
}
