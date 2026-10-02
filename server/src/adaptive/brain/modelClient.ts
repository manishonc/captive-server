/**
 * The model client (PR F2a, F-D2/F-D3) — the ONLY file that loads the Anthropic SDK, and only
 * the worker reaches it (brain/lane.ts → brain/run.ts → here; tests/adaptiveBrainBoundary pins it).
 *
 * The real client is the official `@anthropic-ai/sdk` pointed at the cms relay
 * (`${CMS_INTERNAL_URL}/api/captive-portal/internal/model-relay`, which ends in `/v1/messages`):
 * the relay checks our `x-internal-secret`, adds the AI Gateway credential the cms already has
 * and forwards to the gateway's Anthropic-compatible Messages API. The worker holds no model key.
 *
 *  - The SDK is loaded on the first call (a dynamic import), never at boot: an SDK that fails to
 *    load can only fail AI runs, never the worker that sends messages.
 *  - The SDK never retries on its own (`maxRetries: 0`): the run retries once, on the fallback
 *    model, and only after a 408/429, a 5xx, a dropped connection or a timeout (ours, or a 504 from
 *    the relay or the gateway — a timeout may have been billed, so the run counts its worst case).
 *  - Every call has its own timeout (≤ 210 s; the relay gives up at 200 s, so our answer usually is
 *    its 504 — an output limit of 8,000 tokens fits in that time) and can be aborted by the lane.
 *  - The SDK's environment switches are pinned: no `ANTHROPIC_LOG=debug` body/header logging, no
 *    `ANTHROPIC_AUTH_TOKEN` forwarded (`ANTHROPIC_CUSTOM_HEADERS` can't override ours: they are
 *    merged under our headers).
 *  - It refuses to run against the Firestore emulator, whatever the environment holds, so no local
 *    stack can reach a real model; the sandbox uses the fake model (brain/sandboxModel.ts).
 *  - Typed answers: `output_config.format` from the job's Zod schema (the SDK's helper, built by
 *    the caller before any call) and adaptive thinking at the agent's effort. The answer is parsed
 *    by brain/checks.ts.
 *  - Errors keep the relay's / gateway's own words (type and message, capped), never the request.
 */

import type { ZodType } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelUsage } from './models';
import type { Effort } from './types';

/** The JSON-schema output format (`{ type: 'json_schema', schema }`) the SDK's Zod helper builds. */
export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

export interface ModelRequest {
  agentKey: string;
  /** For the sandbox log and the fake answer only; the real client never sends it separately. */
  runId: string;
  model: string;
  system: string;
  cacheSystem: boolean;
  /** The user turn: the job's instructions, then the package as JSON. */
  user: string;
  /** Built once per run by `outputFormatFor` (outside the call, so a bad schema is its own error). */
  format: OutputFormat;
  effort: Effort;
  maxOutputTokens: number;
  timeoutMs: number;
  /** The package itself — the fake model builds its valid answer from it. */
  pkg: unknown;
  /** Also for the fake: the job's valid answer. */
  sandboxAnswer?: () => unknown;
}

export interface ModelReply {
  stopReason: string | null;
  text: string;
  usage: ModelUsage;
  refusalCategory: string | null;
  /** The model the provider says answered. */
  model: string | null;
}

/**
 *  - retryable: busy, down, dropped or too slow — worth one try on the fallback model;
 *  - setup: this can't work until someone fixes something (relay not configured, secret refused,
 *    no gateway credit, unknown model, the relay's daily limit) — no retry, HeidiFi gets an alert;
 *  - bad_request: the request itself was refused (too big, a parameter the model rejects).
 */
export type ModelErrorKind = 'retryable' | 'setup' | 'bad_request';

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    /** Did the request reach the relay (and so count toward the agent's runs per day)? */
    readonly reachedRelay = false,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ModelClient {
  readonly name: 'relay' | 'sandbox' | 'stub';
  call(req: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}

export const RELAY_PATH = '/api/captive-portal/internal/model-relay';
export const MAX_CALL_MS = 210_000;
const MAX_ERROR_TEXT = 300;

type Sdk = typeof import('@anthropic-ai/sdk');
type ZodHelper = typeof import('@anthropic-ai/sdk/helpers/zod');

let sdkLoad: Promise<{ sdk: Sdk; zod: ZodHelper }> | null = null;

/** The SDK, loaded once, on first use (never at boot). */
function loadSdk(): Promise<{ sdk: Sdk; zod: ZodHelper }> {
  if (!sdkLoad) {
    sdkLoad = Promise.all([import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/helpers/zod')]).then(([sdk, zod]) => ({ sdk, zod }));
    sdkLoad.catch(() => {
      sdkLoad = null; // a failed load is tried again next run
    });
  }
  return sdkLoad;
}

/** The structured-output format for a job's schema (the SDK's own helper; the fake logs it too). */
export async function outputFormatFor(schema: ZodType<unknown>): Promise<OutputFormat> {
  let zod: ZodHelper;
  try {
    ({ zod } = await loadSdk());
  } catch (err) {
    throw new ModelError('setup', 'sdk_unavailable', `The Anthropic SDK could not be loaded: ${cap(String((err as Error)?.message ?? err))}`);
  }
  const f = zod.zodOutputFormat(schema as ZodType<any>);
  return { type: 'json_schema', schema: f.schema as Record<string, unknown> };
}

/** Is the worker set up to reach the relay? Booleans only — values are never read out. */
export function relayConfigured(): { url: boolean; secret: boolean } {
  return { url: Boolean(String(process.env.CMS_INTERNAL_URL ?? '').trim()), secret: Boolean(process.env.INTERNAL_API_SECRET) };
}

let cached: { key: string; client: Anthropic } | null = null;

function sdkClient(sdk: Sdk, baseUrl: string, secret: string): Anthropic {
  const key = `${baseUrl}\u0000${secret}`;
  if (cached?.key === key) return cached.client;
  const client = new sdk.default({
    // Not a key: the relay drops it and adds the gateway credential. Set, so the SDK never picks
    // up an ANTHROPIC_API_KEY from the environment; `authToken: null` likewise for the bearer.
    apiKey: 'heidifi-relay',
    authToken: null,
    baseURL: `${baseUrl}${RELAY_PATH}`,
    defaultHeaders: { 'x-internal-secret': secret },
    maxRetries: 0,
    timeout: MAX_CALL_MS,
    // ANTHROPIC_LOG=debug would log bodies and our secret header.
    logLevel: 'warn',
    // Our secret header never follows a redirect to another host.
    fetchOptions: { redirect: 'error' },
  });
  cached = { key, client };
  return client;
}

/** The relay's own refusals that only a person (or the next day) can fix (cms model-relay route). */
const RELAY_SETUP_TYPES = new Set(['relay_not_configured', 'relay_unauthorized', 'relay_emulator', 'relay_daily_limit']);

/** Connection errors that mean the request never left (the call can't have been billed). */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // The SDK reports this one as a timeout before it gets here (counted: the safe side).
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const cap = (s: string) => (s.length > MAX_ERROR_TEXT ? `${s.slice(0, MAX_ERROR_TEXT)}…` : s);

/** The first `code` along an error's `cause` chain (fetch wraps the system error). */
function causeCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Did the relay URL answer with a redirect (refused by `redirect: 'error'`: fetch's "unexpected redirect")? */
function redirected(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    if (/unexpected redirect/i.test(String((e as { message?: unknown }).message ?? ''))) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The error body's `{ type, message }` (Anthropic-shaped, from the relay or the gateway). */
function errorBody(err: unknown, redact: (s: string) => string): { type: string | null; message: string | null } {
  const body = (err as { error?: unknown })?.error as { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown } | undefined;
  const type = body?.error?.type ?? body?.type;
  const message = body?.error?.message ?? body?.message;
  return { type: typeof type === 'string' ? type : null, message: typeof message === 'string' ? cap(redact(message)) : null };
}

/**
 * Maps an error from a call to a ModelError (never carries the request or the answer). `redact`
 * runs on any upstream text before it is cut to length (a secret cut in half can't be found).
 */
export function classifyModelError(err: unknown, sdk?: Sdk, redact: (s: string) => string = (t) => t): ModelError {
  if (err instanceof ModelError) return err;
  const A = sdk?.default;
  const name = (err as { name?: string })?.name ?? '';
  // Stopped mid-call (the lane's deadline, a lost lease, a shutdown): the request may already be at
  // the model, so it counts as reached (the run adds the worst-case cost).
  if (A && err instanceof A.APIUserAbortError) return new ModelError('retryable', 'aborted', 'The call was stopped', null, true);
  if (A && err instanceof A.APIConnectionTimeoutError) return new ModelError('retryable', 'timeout', 'The model took too long to answer', null, true);
  if (A && err instanceof A.APIConnectionError) {
    // CMS_INTERNAL_URL on a host that forwards (e.g. apex → www): the relay never ran, and the
    // second model would meet the same redirect — a setup error, not counted.
    if (redirected(err)) {
      return new ModelError('setup', 'relay_not_configured', 'CMS_INTERNAL_URL answered with a redirect: set it to the final address (e.g. https://portal.heidifi.ai)');
    }
    // Refused, unknown host, no route, a bad certificate: never sent. Anything else (the connection
    // broke while waiting for the answer) may have reached the relay, and the model: count it.
    const code = causeCode(err);
    const sent = !(code && NEVER_SENT.has(code));
    return new ModelError('retryable', 'connection', `Could not reach the relay${code ? ` (${code})` : ''}`, null, sent);
  }
  if (A && err instanceof A.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const { type, message } = errorBody(err, redact);
    const said = [type, message].filter(Boolean).join(': ');
    const words = (base: string) => (said ? `${base} — ${said}` : base);
    if (type && RELAY_SETUP_TYPES.has(type)) return new ModelError('setup', type, words('The relay refused'), status, true);
    // The model answered (and billed) but the answer broke off on the way back: no second call.
    if (type === 'relay_answer_lost') return new ModelError('setup', 'answer_lost', words('The answer was lost on the way back'), status, true);
    if (status === 408) return new ModelError('retryable', 'timeout', words('Request timeout (408)'), status, true);
    if (status === 429) return new ModelError('retryable', 'rate_limited', words('Rate limited (429)'), status, true);
    if (status === 401) return new ModelError('setup', 'unauthorized', words('Credentials refused (401)'), status, true);
    if (status === 403) return new ModelError('setup', 'forbidden', words('Not allowed (403; a free-tier gateway key can’t use Claude models)'), status, true);
    if (status === 404) return new ModelError('setup', 'not_found', words('Not found (404): an unknown model, or CMS_INTERNAL_URL points at the wrong host'), status, true);
    if (status === 400 || status === 413 || status === 422) return new ModelError('bad_request', 'bad_request', words(`Refused (${status})`), status, true);
    // The relay's own give-up (200 s) or the gateway's: the model may have run (and billed) meanwhile,
    // so it is a timeout — costed at its worst case like ours.
    if (status === 504) return new ModelError('retryable', 'timeout', words('The gateway took too long (504)'), status, true);
    if (status !== null && status >= 500) return new ModelError('retryable', 'server_error', words(`The relay or the model failed (${status})`), status, true);
    return new ModelError('setup', 'api_error', words(`Unexpected answer (${status ?? 'no status'})`), status, true);
  }
  if (name === 'AbortError') return new ModelError('retryable', 'aborted', 'The call was stopped', null, true);
  // Anything else is a bug or a broken setup here, not a busy model: no fallback, keep the words.
  return new ModelError('setup', 'unknown', `The call failed: ${cap(redact(`${name || 'Error'}: ${String((err as Error)?.message ?? err)}`))}`);
}

/** The real client: the SDK through the cms relay. */
export function relayClient(): ModelClient {
  return {
    name: 'relay',
    async call(req, signal) {
      // Never a real model against the emulator: the local stacks hold real-looking env files.
      if (process.env.FIRESTORE_EMULATOR_HOST) throw new ModelError('setup', 'emulator', 'The real model is never called against the Firestore emulator');
      const base = String(process.env.CMS_INTERNAL_URL ?? '').trim().replace(/\/+$/, '');
      const secret = process.env.INTERNAL_API_SECRET ?? '';
      if (!base || !secret) throw new ModelError('setup', 'relay_not_configured', 'CMS_INTERNAL_URL or INTERNAL_API_SECRET is not set on the worker');
      // Not a web address (e.g. no "https://"): the SDK would fail before sending anything — and
      // that must not read as a call that reached the relay.
      let scheme = '';
      try {
        scheme = new URL(base).protocol;
      } catch {
        scheme = '';
      }
      // https only (the secret travels in a header); plain http only to this machine.
      const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(base);
      if (scheme !== 'https:' && !local) {
        throw new ModelError('setup', 'relay_not_configured', 'CMS_INTERNAL_URL on the worker must be an https:// address (e.g. https://portal.heidifi.ai)');
      }
      // A header can't carry it (a line break, a space…): the SDK's error would quote the value.
      if (!/^[\x21-\x7e]+$/.test(secret)) {
        throw new ModelError('setup', 'relay_not_configured', 'INTERNAL_API_SECRET on the worker has characters a header can’t carry (a space or a line break?)');
      }
      let sdk: Sdk;
      try {
        ({ sdk } = await loadSdk());
      } catch (err) {
        throw new ModelError('setup', 'sdk_unavailable', `The Anthropic SDK could not be loaded: ${cap(String((err as Error)?.message ?? err))}`);
      }
      const client = sdkClient(sdk, base, secret);
      let msg: unknown;
      try {
        msg = await client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxOutputTokens,
            system: [{ type: 'text', text: req.system, ...(req.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}) }],
            messages: [{ role: 'user', content: req.user }],
            thinking: { type: 'adaptive' },
            output_config: { effort: req.effort, format: req.format },
          },
          { timeout: Math.min(req.timeoutMs, MAX_CALL_MS), maxRetries: 0, signal },
        );
      } catch (err) {
        // Never the secret in the run log or an alert, whatever an error quotes.
        const redact = (t: string) => t.split(secret).join('[secret]');
        const e = classifyModelError(err, sdk, redact);
        const message = redact(e.message);
        // Not an SDK error: thrown while the relay's answer was read (the connection dropped, a body
        // that isn't JSON) — the relay had the request, and the model may have billed it.
        throw new ModelError(e.kind, e.code, message, e.status, e.code === 'unknown' ? true : e.reachedRelay);
      }
      return toReply(msg);
    },
  };
}

/** A reply read defensively: a 200 that isn't a model message (an HTML login page…) is a setup error. */
export function toReply(raw: unknown): ModelReply {
  const msg = raw as Partial<Anthropic.Message> | null;
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
    throw new ModelError('setup', 'bad_response', 'The relay answered with something that isn’t a model reply (is CMS_INTERNAL_URL the cms?)', null, true);
  }
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => Boolean(b) && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
  const u = (msg.usage ?? {}) as Partial<Anthropic.Usage>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
    text,
    usage: {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens),
      cacheWriteTokens: n(u.cache_creation_input_tokens),
    },
    refusalCategory: msg.stop_reason === 'refusal' ? ((msg.stop_details as { category?: string | null } | null | undefined)?.category ?? null) : null,
    model: typeof msg.model === 'string' ? msg.model : null,
  };
}
