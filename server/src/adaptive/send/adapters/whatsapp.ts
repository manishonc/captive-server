/**
 * WhatsApp adapter for Adaptive Campaigns (see types.ts for the contract): Adaptive's own client for
 * Meta's Cloud API messages endpoint. PR PV: the owner's Send test; PR W3: the engine too (while the
 * launch setting `whatsappSending` is on — else engine/sendPath.ts says `whatsapp_off`).
 *
 * One request per send, never more:
 *  - one POST to `/{WHATSAPP_PHONE_NUMBER_ID}/messages`, `type: template` (outside a conversation the
 *    guest opened, WhatsApp only carries templates Meta approved);
 *  - no retries, a 15 s timeout plus the outer hard deadline, `redirect: 'error'`;
 *  - the token only in the Authorization header; no URL, token or phone number in a log line or an
 *    error text;
 *  - env read at call time; refuses under the Firestore emulator (the local .env holds the real keys —
 *    the sandbox adapter replaces this one there).
 *
 * Meta's answer at send time (delivery problems — not on WhatsApp 131026, the marketing limit 131049,
 * marketing stopped 131050 — usually arrive later, by webhook):
 *   2xx with a message id                                   → accepted (`wamid.…`)
 *   429 and the rate codes                                  → retry (Meta says it didn't send it)
 *   401/403, the token, permission, account or our number's → rejected, config (also 100/33: our
 *     codes, the spam limit on our number (131048)               phone number id is wrong or not ours)
 *   5xx, codes 1, 2, 131000, 131016, no answer, a 2xx without an id → unknown (it may have left)
 *   every other refusal (template, parameter, number)       → rejected, with Meta's words
 *     (131050, the person stopped our marketing in WhatsApp, also `suppress: 'stop'` — PR W3)
 *
 * Its own Graph version constant: whatsapp/meta.ts is the template client, and only
 * whatsapp/source.ts may import it (tests/adaptiveWhatsAppBoundary.test.ts). Keep the two in step.
 */

import { HARD_DEADLINE_GRACE_MS, PRE_SEND_NET_CODES, withHardDeadline } from './brevo';
import { PROVIDER_TIMEOUT_MS, type ChannelAdapter, type Outbound, type OutboundWhatsApp, type ProviderResult } from './types';

/** The Graph version of whatsapp/meta.ts (v19.0/v20.0 have expired; v25.0 is available until July 2028). */
export const WA_SEND_GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${WA_SEND_GRAPH_VERSION}`;

/** Meta throttled us for a while: nothing was sent (pair rate 131056, throughput 130429, …). */
const RATE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
/**
 * The token, the app, the account or our number — never the guest's or the template's fault: 33 (our
 * number was deleted), 131048 (our number is held back for spam: it won't clear in a minute).
 */
const SETUP_CODES: ReadonlySet<number> = new Set([
  0, 3, 10, 33, 102, 190, 368, 463, 467, 131005, 131031, 131037, 131042, 131045, 131048, 133000, 133004, 133005, 133006, 133008, 133009, 133010, 133015, 133016,
]);
/** "Something went wrong" / "service unavailable" at Meta: the message may or may not have left. */
const UNKNOWN_CODES: ReadonlySet<number> = new Set([1, 2, 131000, 131016]);

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null;

/** No token, no link, no long digit run (a phone number), capped: safe for the log and the owner. */
export function scrubWhatsAppText(s: string): string {
  return s
    .replace(/(access|input)_token=[^&\s"']+/gi, '$1_token=…')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bEAA[A-Za-z0-9]{20,}\b/g, '[token]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '•••')
    .trim()
    .slice(0, 300);
}

function retryAfterMs(headers: Headers | null): number | null {
  const s = Number(headers?.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 60 * 60_000) : null;
}

/** The request body for one template message (exported for the tests). */
export function whatsappRequestBody(m: OutboundWhatsApp): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  if (m.bodyParams.length) components.push({ type: 'body', parameters: m.bodyParams.map((text) => ({ type: 'text', text })) });
  if (m.button) components.push({ type: 'button', sub_type: 'url', index: String(m.button.index), parameters: [{ type: 'text', text: m.button.param }] });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Meta takes the number in international format without the "+".
    to: m.to.replace(/\D/g, ''),
    type: 'template',
    template: { name: m.templateName, language: { code: m.language }, ...(components.length ? { components } : {}) },
  };
}

/** Meta's answer → one of the four outcomes (see the table at the top). */
export function classifyWhatsAppAnswer(status: number, json: unknown, headers: Headers | null): ProviderResult {
  const provider = 'meta' as const;
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const e = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  if (status >= 200 && status < 300 && !e) {
    const first = Array.isArray(root.messages) ? (root.messages[0] as { id?: unknown } | undefined) : undefined;
    const id = typeof first?.id === 'string' && first.id ? first.id.slice(0, 200) : null;
    return id ? { kind: 'accepted', provider, providerMessageId: id } : { kind: 'unknown', provider, reason: 'meta_no_message_id' };
  }
  const code = numOrNull(e?.code);
  const subcode = numOrNull(e?.error_subcode);
  const data = e?.error_data && typeof e.error_data === 'object' ? (e.error_data as Record<string, unknown>) : null;
  const raw = [e?.error_user_msg, data?.details, e?.message].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? `HTTP ${status}`;
  const message = scrubWhatsAppText(raw);
  const codeText = code !== null ? String(code) : `http_${status}`;
  if (status === 429 || (code !== null && RATE_CODES.has(code))) return { kind: 'retry', provider, reason: `meta_${codeText}`, retryAfterMs: retryAfterMs(headers) };
  // 100/33: "Object with ID … does not exist" — the phone number id in our env, not the guest.
  const ourNumber = code === 100 && subcode === 33;
  if (status === 401 || status === 403 || ourNumber || (code !== null && (SETUP_CODES.has(code) || (code >= 200 && code <= 299)))) {
    return { kind: 'rejected', provider, code: codeText, message, config: true };
  }
  if (status >= 500 || (code !== null && UNKNOWN_CODES.has(code))) return { kind: 'unknown', provider, reason: `meta_${codeText}` };
  // PR W3: 131050 = the person stopped our marketing in WhatsApp → a WhatsApp STOP for the number.
  if (status >= 400 || e) return { kind: 'rejected', provider, code: codeText, message, ...(code === 131050 ? { suppress: 'stop' as const } : {}) };
  return { kind: 'unknown', provider, reason: `meta_http_${status}` };
}

/** A fetch that threw: before the request left (connection refused, no DNS) it can be tried again; else it may have left. */
function networkResult(err: unknown, timedOut: boolean): ProviderResult {
  if (timedOut) return { kind: 'unknown', provider: 'meta', reason: 'timeout' };
  const e = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof e.cause?.code === 'string' ? e.cause.code : typeof e.code === 'string' ? e.code : null;
  if (code && PRE_SEND_NET_CODES.has(code)) return { kind: 'retry', provider: 'meta', reason: `net_${code}`, retryAfterMs: null };
  return { kind: 'unknown', provider: 'meta', reason: code ? `net_${code}` : 'network' };
}

export interface WhatsAppAdapterOptions {
  /** Test seam. */
  fetchImpl?: typeof fetch;
  env?: () => { token: string | undefined; phoneNumberId: string | undefined; emulator: boolean };
  log?: (line: string) => void;
  /** Provider timeout in ms (default PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Extra time past `timeoutMs` before the outer deadline answers `unknown` (default 5 s). */
  deadlineGraceMs?: number;
}

const defaultEnv = () => ({
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
});

export function createWhatsAppAdapter(opts: WhatsAppAdapterOptions = {}): ChannelAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? defaultEnv;
  const log = opts.log ?? ((line: string) => console.log(line));
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PROVIDER_TIMEOUT_MS;
  const graceMs = opts.deadlineGraceMs != null && opts.deadlineGraceMs >= 0 ? opts.deadlineGraceMs : HARD_DEADLINE_GRACE_MS;

  const phoneNumberId = () => String(env().phoneNumberId ?? '').trim();
  const ready = () => {
    const e = env();
    return Boolean(e.token) && /^\d{5,30}$/.test(phoneNumberId()) && !e.emulator;
  };

  const attempt = async (m: OutboundWhatsApp): Promise<ProviderResult> => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const started = Date.now();
    let status = 0;
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${GRAPH_BASE}/${phoneNumberId()}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env().token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(whatsappRequestBody(m)),
          signal: ctrl.signal,
          redirect: 'error',
        });
      } catch (err) {
        return networkResult(err, timedOut);
      }
      status = res.status;
      let text: string;
      try {
        text = await res.text();
      } catch {
        return { kind: 'unknown', provider: 'meta', reason: timedOut ? 'timeout' : 'unreadable_answer' };
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return classifyWhatsAppAnswer(res.status, json, res.headers);
    } finally {
      clearTimeout(timer);
      log(`[WA SEND] POST messages ${status || 'no-answer'} ${Date.now() - started}ms`);
    }
  };

  return {
    channel: 'whatsapp',
    provider: 'meta',
    ready,
    async send(message: Outbound): Promise<ProviderResult> {
      if (message.kind !== 'whatsapp') {
        return { kind: 'rejected', provider: 'meta', code: 'wrong_channel', message: `the WhatsApp adapter sends whatsapp, got ${message.kind}` };
      }
      if (!ready()) {
        return { kind: 'rejected', provider: 'meta', code: 'not_configured', message: 'WhatsApp is not configured (or this is the local emulator stack)', config: true };
      }
      if (!message.to.replace(/\D/g, '') || !message.templateName || !message.language) {
        return { kind: 'rejected', provider: 'meta', code: 'invalid_request', message: 'a number, a template name and a language are required' };
      }
      return withHardDeadline('meta', attempt(message), timeoutMs + graceMs);
    },
  };
}
