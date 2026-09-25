/**
 * The Adaptive provider boundary (plan §2.6, §3.7, §10): Brevo email and
 * Twilio SMS adapters send exactly one request and classify every answer.
 *
 * Run: npx tsx tests/adaptiveProviders.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials, no network: Brevo gets a fake `fetch`, Twilio a
 * fake `httpClient`. Only brevo.ts and twilio.ts are imported — index.ts and
 * sandbox.ts pull in firebase.
 *
 * The load-bearing assertions:
 *  - one provider call per send, even on 429/5xx (a second POST can double-send);
 *  - "retry" only when the request provably never left (429, connect refused);
 *    a timeout, reset or 5xx is "unknown" (never resent, not charged);
 *  - request shape: no provider-side scheduling, the X-Mailin-custom sendKey,
 *    List-Unsubscribe only for marketing, and a StatusCallback byte-identical
 *    to what routes/twilioWebhook.ts validates;
 *  - ready() is false in the local emulator stack (its .env holds real keys).
 */

import { createBrevoEmailAdapter } from '../src/adaptive/send/adapters/brevo';
import { createTwilioSmsAdapter } from '../src/adaptive/send/adapters/twilio';
import type { OutboundEmail, OutboundSms, ProviderResult } from '../src/adaptive/send/adapters/types';

let passed = 0;
let failed = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Deep equality via JSON with object keys sorted, so key order never matters. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Environment

const ENV_KEYS = [
  'BREVO_API_KEY',
  'BREVO_SENDER_EMAIL',
  'BREVO_SENDER_NAME',
  'BREVO_API_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_PHONE_NUMBER',
  'TWILIO_EDGE',
  'TWILIO_REGION',
  'SERVER_PUBLIC_URL',
  'FIRESTORE_EMULATOR_HOST',
];

function setEnv(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

const BREVO_ENV = { BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER_EMAIL: 'hello@venue.test' };
const SID = `AC${'a1'.repeat(16)}`;
const MSS = `MG${'b2'.repeat(16)}`;
const TWILIO_ENV = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'token-test', TWILIO_MESSAGING_SERVICE_SID: MSS };

const SEND_KEY = `js_${'0123456789abcdef'.repeat(2)}`;

const email = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  kind: 'email',
  to: 'guest@example.com',
  subject: 'We miss you',
  html: '<p>Come back</p>',
  text: 'Come back',
  sendKey: SEND_KEY,
  unsubscribeUrl: null,
  ...over,
});

const sms = (over: Partial<OutboundSms> = {}): OutboundSms => ({
  kind: 'sms',
  to: '+41791234567',
  body: 'Come back for a free coffee. Reply STOP to opt out.',
  sendKey: SEND_KEY,
  ...over,
});

// ---------------------------------------------------------------------------
// Brevo fakes

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: any;
}

function fakeFetch(respond: (call: FetchCall, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const call: FetchCall = {
      url,
      method: String(init?.method ?? 'GET'),
      headers: new Headers(init?.headers as any),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    calls.push(call);
    return respond(call, init);
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

/** Short timeouts so a leaked SDK timer never holds the process. */
const brevo = (f: typeof fetch, over: { timeoutMs?: number; deadlineGraceMs?: number } = {}) =>
  createBrevoEmailAdapter({ fetch: f, timeoutMs: 300, deadlineGraceMs: 300, ...over });

// ---------------------------------------------------------------------------
// Twilio fakes

interface HttpResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

function fakeHttp(respond: (opts: any) => HttpResponse | Promise<HttpResponse>) {
  const calls: any[] = [];
  const client = {
    request: async (opts: any) => {
      calls.push(opts);
      return respond(opts);
    },
  };
  return { client, calls };
}

const twilioMessage = (over: Record<string, unknown> = {}) => ({
  sid: `SM${'c3'.repeat(16)}`,
  account_sid: SID,
  status: 'accepted',
  num_segments: '1',
  body: 'x',
  to: '+41791234567',
  ...over,
});

const twilioError = (statusCode: number, code: number | undefined, message = 'error'): HttpResponse => ({
  statusCode,
  body: { ...(code != null ? { code } : {}), message, more_info: `https://www.twilio.com/docs/errors/${code}`, status: statusCode },
});

const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

const twilioAdapter = (httpClient: unknown, over: { timeoutMs?: number; deadlineGraceMs?: number } = {}) =>
  createTwilioSmsAdapter({ httpClient, timeoutMs: 300, deadlineGraceMs: 300, ...over });

function expectKind<K extends ProviderResult['kind']>(r: ProviderResult, kind: K): Extract<ProviderResult, { kind: K }> {
  if (r.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(r)}`);
  return r as Extract<ProviderResult, { kind: K }>;
}

async function main() {
  // =========================================================================
  console.log('\nBrevo: request shape');

  await test('marketing email: one POST with sendKey + List-Unsubscribe pair, text part, no scheduledAt', async () => {
    setEnv({ ...BREVO_ENV, BREVO_API_URL: 'http://brevo.stub/v3' });
    const { fetch, calls } = fakeFetch(() => json(201, { messageId: '<m1@smtp-relay.mailin.fr>' }));
    const r = await brevo(fetch).send(email({ unsubscribeUrl: 'https://api.heidifi.test/u/abc' }));
    expectKind(r, 'accepted');
    assertEqual(calls.length, 1, 'fetch calls');
    const c = calls[0];
    assertEqual(c.url, 'http://brevo.stub/v3/smtp/email', 'url (BREVO_API_URL honoured)');
    assertEqual(c.method, 'POST', 'method');
    assertEqual(c.headers.get('api-key'), 'xkeysib-test', 'api-key header');
    assertEqual(Object.keys(c.body).sort(), ['headers', 'htmlContent', 'sender', 'subject', 'textContent', 'to'], 'body keys');
    assertEqual(c.body.to, [{ email: 'guest@example.com' }], 'to');
    assertEqual(c.body.sender, { email: 'hello@venue.test', name: 'WiFi Portal' }, 'sender (default name)');
    assertEqual(c.body.subject, 'We miss you', 'subject');
    assertEqual(c.body.htmlContent, '<p>Come back</p>', 'htmlContent');
    assertEqual(c.body.textContent, 'Come back', 'textContent');
    assertEqual(
      c.body.headers,
      {
        'X-Mailin-custom': SEND_KEY,
        'List-Unsubscribe': '<https://api.heidifi.test/u/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      'email headers',
    );
    assert(!('scheduledAt' in c.body), 'no scheduledAt');
  });

  await test('non-marketing email: only X-Mailin-custom, default Brevo URL, sender name from env', async () => {
    setEnv({ ...BREVO_ENV, BREVO_SENDER_NAME: 'Café Zürich' });
    const { fetch, calls } = fakeFetch(() => json(201, { messageId: '<m2@smtp-relay.mailin.fr>' }));
    await brevo(fetch).send(email());
    assertEqual(calls[0].url, 'https://api.brevo.com/v3/smtp/email', 'url');
    assertEqual(calls[0].body.headers, { 'X-Mailin-custom': SEND_KEY }, 'email headers');
    assertEqual(calls[0].body.sender.name, 'Café Zürich', 'sender name');
  });

  await test('env is read at send time, not at import or construction', async () => {
    setEnv({});
    const { fetch, calls } = fakeFetch(() => json(201, { messageId: '<m3@x>' }));
    const adapter = brevo(fetch);
    assertEqual(adapter.ready(), false, 'ready before env');
    setEnv({ ...BREVO_ENV });
    assertEqual(adapter.ready(), true, 'ready after env');
    expectKind(await adapter.send(email()), 'accepted');
    assertEqual(calls.length, 1, 'fetch calls');
  });

  // =========================================================================
  console.log('\nBrevo: outcomes');

  await test('accepted: messageId stored verbatim, angle brackets kept', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch } = fakeFetch(() => json(201, { messageId: '<202609241200.123@smtp-relay.mailin.fr>' }));
    const r = expectKind(await brevo(fetch).send(email()), 'accepted');
    assertEqual(r.provider, 'brevo', 'provider');
    assertEqual(r.providerMessageId, '<202609241200.123@smtp-relay.mailin.fr>', 'providerMessageId');
  });

  await test('accepted with a null id when the 2xx has no messageId (or no body)', async () => {
    setEnv({ ...BREVO_ENV });
    const a = expectKind(await brevo(fakeFetch(() => json(201, {})).fetch).send(email()), 'accepted');
    assertEqual(a.providerMessageId, null, 'no messageId');
    const b = expectKind(await brevo(fakeFetch(() => new Response('', { status: 201 })).fetch).send(email()), 'accepted');
    assertEqual(b.providerMessageId, null, 'empty body');
    const c = expectKind(await brevo(fakeFetch(() => new Response('OK', { status: 201 })).fetch).send(email()), 'accepted');
    assertEqual(c.providerMessageId, null, 'non-JSON body');
  });

  await test('500 → unknown after exactly ONE request (SDK retries off)', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch, calls } = fakeFetch(() => json(500, { code: 'internal_error', message: 'boom' }));
    const r = expectKind(await brevo(fetch).send(email()), 'unknown');
    assertEqual(r.reason, 'brevo_500', 'reason');
    assertEqual(calls.length, 1, 'fetch calls');
  });

  await test('502 / 503 / 408 → unknown, one request each', async () => {
    setEnv({ ...BREVO_ENV });
    for (const status of [502, 503, 408]) {
      const { fetch, calls } = fakeFetch(() => json(status, { message: 'x' }));
      expectKind(await brevo(fetch).send(email()), 'unknown');
      assertEqual(calls.length, 1, `fetch calls for ${status}`);
    }
  });

  await test('400 → rejected with the body code and message', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch, calls } = fakeFetch(() => json(400, { code: 'invalid_parameter', message: 'email is not valid' }));
    const r = expectKind(await brevo(fetch).send(email()), 'rejected');
    assertEqual(r.code, 'invalid_parameter', 'code');
    assertEqual(r.message, 'email is not valid', 'message');
    assert(!r.config, 'not a config problem');
    assertEqual(calls.length, 1, 'fetch calls');
  });

  await test('404 without a JSON body → rejected brevo_404', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch } = fakeFetch(() => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const r = expectKind(await brevo(fetch).send(email()), 'rejected');
    assertEqual(r.code, 'brevo_404', 'code');
  });

  await test('401 / 403 → rejected, config: true', async () => {
    setEnv({ ...BREVO_ENV });
    for (const status of [401, 403]) {
      const { fetch } = fakeFetch(() => json(status, { code: 'unauthorized', message: 'Key not found' }));
      const r = expectKind(await brevo(fetch).send(email()), 'rejected');
      assertEqual(r.config, true, `config for ${status}`);
      assertEqual(r.code, 'unauthorized', `code for ${status}`);
    }
  });

  await test('429 → retry with Retry-After, and NO second request', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch, calls } = fakeFetch(() => json(429, { code: 'too_many_requests', message: 'slow down' }, { 'retry-after': '7' }));
    const r = expectKind(await brevo(fetch).send(email()), 'retry');
    assertEqual(r.retryAfterMs, 7000, 'retryAfterMs');
    assertEqual(calls.length, 1, 'fetch calls');
  });

  await test('429 → retryAfterMs from x-sib-ratelimit-reset; null when absent', async () => {
    setEnv({ ...BREVO_ENV });
    const a = expectKind(
      await brevo(fakeFetch(() => json(429, {}, { 'x-sib-ratelimit-reset': '12' })).fetch).send(email()),
      'retry',
    );
    assertEqual(a.retryAfterMs, 12000, 'from x-sib-ratelimit-reset');
    const b = expectKind(await brevo(fakeFetch(() => json(429, {})).fetch).send(email()), 'retry');
    assertEqual(b.retryAfterMs, null, 'no header');
  });

  await test('fetch that never answers → unknown "timeout" at the provider timeout', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch, calls } = fakeFetch(() => new Promise<Response>(() => {}));
    const t0 = Date.now();
    const r = expectKind(await brevo(fetch, { timeoutMs: 200, deadlineGraceMs: 5000 }).send(email()), 'unknown');
    const took = Date.now() - t0;
    assertEqual(r.reason, 'timeout', 'reason');
    assert(took < 1500, `gave up quickly (${took} ms)`);
    assertEqual(calls.length, 1, 'fetch calls');
  });

  await test('undici-style abort (rejects with the reason string "timeout") → unknown "timeout"', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch } = fakeFetch(
      (_call, init) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const r = expectKind(await brevo(fetch, { timeoutMs: 150 }).send(email()), 'unknown');
    assertEqual(r.reason, 'timeout', 'reason');
  });

  await test('body that never finishes after headers → unknown via the outer hard deadline', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch } = fakeFetch(
      () => new Response(new ReadableStream({ start() {} }), { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const t0 = Date.now();
    const r = expectKind(await brevo(fetch, { timeoutMs: 100, deadlineGraceMs: 150 }).send(email()), 'unknown');
    const took = Date.now() - t0;
    assertEqual(r.reason, 'hard_deadline', 'reason');
    assert(took < 1500, `gave up quickly (${took} ms)`);
  });

  await test('connection refused / DNS failure → retry (never left)', async () => {
    setEnv({ ...BREVO_ENV });
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      const { fetch, calls } = fakeFetch(() => Promise.reject(netError(code)));
      const r = expectKind(await brevo(fetch).send(email()), 'retry');
      assertEqual(r.reason, `net_${code}`, 'reason');
      assertEqual(calls.length, 1, `fetch calls for ${code}`);
    }
  });

  await test('socket closed / reset after sending → unknown (may have left)', async () => {
    setEnv({ ...BREVO_ENV });
    for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']) {
      const { fetch } = fakeFetch(() => Promise.reject(netError(code)));
      const r = expectKind(await brevo(fetch).send(email()), 'unknown');
      assertEqual(r.reason, `net_${code}`, 'reason');
    }
    const r = expectKind(await brevo(fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).fetch).send(email()), 'unknown');
    assertEqual(r.reason, 'net_unknown', 'no cause');
  });

  await test('an SMS handed to the email adapter → rejected wrong_channel, no request', async () => {
    setEnv({ ...BREVO_ENV });
    const { fetch, calls } = fakeFetch(() => json(201, {}));
    const r = expectKind(await brevo(fetch).send(sms()), 'rejected');
    assertEqual(r.code, 'wrong_channel', 'code');
    assertEqual(calls.length, 0, 'fetch calls');
  });

  // =========================================================================
  console.log('\nBrevo: ready()');

  await test('false without env, false with only one of key / sender', async () => {
    const a = createBrevoEmailAdapter({ fetch: fakeFetch(() => json(201, {})).fetch });
    setEnv({});
    assertEqual(a.ready(), false, 'no env');
    setEnv({ BREVO_API_KEY: 'k' });
    assertEqual(a.ready(), false, 'key only');
    setEnv({ BREVO_SENDER_EMAIL: 's@x.test' });
    assertEqual(a.ready(), false, 'sender only');
    setEnv({ ...BREVO_ENV });
    assertEqual(a.ready(), true, 'both');
  });

  await test('false in the emulator stack, and send() refuses without a request', async () => {
    setEnv({ ...BREVO_ENV, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    const { fetch, calls } = fakeFetch(() => json(201, { messageId: '<x@y>' }));
    const a = brevo(fetch);
    assertEqual(a.ready(), false, 'ready');
    const r = expectKind(await a.send(email()), 'rejected');
    assertEqual(r.config, true, 'config');
    assertEqual(calls.length, 0, 'fetch calls');
  });

  // =========================================================================
  console.log('\nTwilio: request shape');

  await test('Messaging Service: To/Body/MessagingServiceSid/StatusCallback exactly, no scheduling', async () => {
    setEnv({ ...TWILIO_ENV, TWILIO_PHONE_NUMBER: '+15550001111', SERVER_PUBLIC_URL: 'https://api.heidifi.test' });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    expectKind(await twilioAdapter(client).send(sms()), 'accepted');
    assertEqual(calls.length, 1, 'requests');
    const c = calls[0];
    assertEqual(c.method, 'post', 'method');
    assert(String(c.uri).endsWith(`/2010-04-01/Accounts/${SID}/Messages.json`), `uri ${c.uri}`);
    assertEqual(
      c.data,
      {
        To: '+41791234567',
        StatusCallback: 'https://api.heidifi.test/webhook/twilio/sms-status',
        MessagingServiceSid: MSS,
        Body: 'Come back for a free coffee. Reply STOP to opt out.',
      },
      'form data',
    );
    for (const k of ['SendAt', 'ScheduleType', 'SmartEncoded', 'From']) assert(!(k in c.data), `no ${k}`);
  });

  await test('no Messaging Service → From = TWILIO_PHONE_NUMBER; no SERVER_PUBLIC_URL → no StatusCallback', async () => {
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'token-test', TWILIO_PHONE_NUMBER: '+15550001111' });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    expectKind(await twilioAdapter(client).send(sms()), 'accepted');
    assertEqual(calls[0].data, { To: '+41791234567', From: '+15550001111', Body: sms().body }, 'form data');
  });

  await test('StatusCallback uses SERVER_PUBLIC_URL raw (trailing slash kept, like services/twilio.ts)', async () => {
    setEnv({ ...TWILIO_ENV, SERVER_PUBLIC_URL: 'https://api.heidifi.test/' });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    await twilioAdapter(client).send(sms());
    assertEqual(calls[0].data.StatusCallback, 'https://api.heidifi.test//webhook/twilio/sms-status', 'StatusCallback');
    assert(!String(calls[0].data.StatusCallback).includes('?'), 'no query string');
  });

  // =========================================================================
  console.log('\nTwilio: outcomes');

  await test('accepted: sid + segments (num_segments is a string)', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage({ sid: 'SM123', num_segments: '3' }) }));
    const r = expectKind(await twilioAdapter(client).send(sms()), 'accepted');
    assertEqual(r.provider, 'twilio', 'provider');
    assertEqual(r.providerMessageId, 'SM123', 'sid');
    assertEqual(r.segments, 3, 'segments');
  });

  await test('accepted with segments null when Twilio omits num_segments; JSON string body parsed', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => ({ statusCode: 201, body: JSON.stringify(twilioMessage({ num_segments: null })) }));
    const r = expectKind(await twilioAdapter(client).send(sms()), 'accepted');
    assertEqual(r.segments, null, 'segments');
    assertEqual(r.providerMessageId, `SM${'c3'.repeat(16)}`, 'sid');
  });

  await test('21610 (unsubscribed) → rejected, suppress: stop', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => twilioError(400, 21610, 'Attempt to send to unsubscribed recipient'));
    const r = expectKind(await twilioAdapter(client).send(sms()), 'rejected');
    assertEqual(r.code, '21610', 'code');
    assertEqual(r.suppress, 'stop', 'suppress');
    assert(!r.config, 'not config');
  });

  await test('21211 (invalid To) → rejected, no suppress, no config', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => twilioError(400, 21211, "The 'To' number is not a valid phone number."));
    const r = expectKind(await twilioAdapter(client).send(sms()), 'rejected');
    assertEqual(r.code, '21211', 'code');
    assertEqual(r.message, "The 'To' number is not a valid phone number.", 'message');
    assert(!r.suppress && !r.config, 'plain rejection');
  });

  await test('20003 / bare 401 → rejected, config: true', async () => {
    setEnv({ ...TWILIO_ENV });
    const a = expectKind(await twilioAdapter(fakeHttp(() => twilioError(401, 20003, 'Authenticate')).client).send(sms()), 'rejected');
    assertEqual(a.config, true, 'config (20003)');
    assertEqual(a.code, '20003', 'code');
    const b = expectKind(
      await twilioAdapter(fakeHttp(() => ({ statusCode: 401, body: 'Unauthorized' })).client).send(sms()),
      'rejected',
    );
    assertEqual(b.config, true, 'config (bare 401)');
    assertEqual(b.code, '401', 'code falls back to status');
  });

  await test('429 → retry, one request', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client, calls } = fakeHttp(() => twilioError(429, 20429, 'Too Many Requests'));
    expectKind(await twilioAdapter(client).send(sms()), 'retry');
    assertEqual(calls.length, 1, 'requests');
  });

  await test('RFC 9457 error body (TwilioServiceException, not exported) is duck-typed too', async () => {
    setEnv({ ...TWILIO_ENV });
    const body = { type: 'https://www.twilio.com/docs/errors/20429', title: 'Too Many Requests', status: 429, code: 20429 };
    expectKind(await twilioAdapter(fakeHttp(() => ({ statusCode: 429, body })).client).send(sms()), 'retry');
    const body2 = { type: 'https://www.twilio.com/docs/errors/21610', title: 'Unsubscribed', status: 400, code: 21610 };
    const r = expectKind(await twilioAdapter(fakeHttp(() => ({ statusCode: 400, body: body2 })).client).send(sms()), 'rejected');
    assertEqual(r.suppress, 'stop', 'suppress');
  });

  await test('500 / 503 → unknown, one request', async () => {
    setEnv({ ...TWILIO_ENV });
    for (const status of [500, 503]) {
      const { client, calls } = fakeHttp(() => twilioError(status, 20500, 'Internal Server Error'));
      const r = expectKind(await twilioAdapter(client).send(sms()), 'unknown');
      assertEqual(r.reason, `twilio_${status}`, 'reason');
      assertEqual(calls.length, 1, 'requests');
    }
  });

  await test('ECONNABORTED (axios timeout) / ETIMEDOUT / ECONNRESET / EPIPE → unknown', async () => {
    setEnv({ ...TWILIO_ENV });
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
      const { client } = fakeHttp(() => Promise.reject(withCode(code, 'timeout of 15000ms exceeded')));
      const r = expectKind(await twilioAdapter(client).send(sms()), 'unknown');
      assertEqual(r.reason, `net_${code}`, 'reason');
    }
  });

  await test('ECONNREFUSED / ENOTFOUND → retry (never left)', async () => {
    setEnv({ ...TWILIO_ENV });
    for (const code of ['ECONNREFUSED', 'ENOTFOUND']) {
      const { client, calls } = fakeHttp(() => Promise.reject(withCode(code)));
      const r = expectKind(await twilioAdapter(client).send(sms()), 'retry');
      assertEqual(r.reason, `net_${code}`, 'reason');
      assertEqual(calls.length, 1, 'requests');
    }
  });

  await test('2xx with an unparseable body → unknown, NOT rejected (it may have been sent)', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => ({ statusCode: 201, body: '<html>proxy</html>' }));
    expectKind(await twilioAdapter(client).send(sms()), 'unknown');
  });

  await test('http client that never answers → unknown via the outer hard deadline', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client } = fakeHttp(() => new Promise<HttpResponse>(() => {}));
    const t0 = Date.now();
    const r = expectKind(await twilioAdapter(client, { timeoutMs: 100, deadlineGraceMs: 150 }).send(sms()), 'unknown');
    const took = Date.now() - t0;
    assertEqual(r.reason, 'hard_deadline', 'reason');
    assert(took < 1500, `gave up quickly (${took} ms)`);
  });

  await test('empty To → rejected invalid_request before any request', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    const r = expectKind(await twilioAdapter(client).send(sms({ to: '' })), 'rejected');
    assertEqual(r.code, 'invalid_request', 'code');
    assertEqual(calls.length, 0, 'requests');
  });

  await test('an email handed to the SMS adapter → rejected wrong_channel, no request', async () => {
    setEnv({ ...TWILIO_ENV });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    const r = expectKind(await twilioAdapter(client).send(email()), 'rejected');
    assertEqual(r.code, 'wrong_channel', 'code');
    assertEqual(calls.length, 0, 'requests');
  });

  // =========================================================================
  console.log('\nTwilio: ready()');

  await test('false without env; false for a non-AC SID; false without a sender; true when complete', async () => {
    const a = createTwilioSmsAdapter({ httpClient: fakeHttp(() => ({ statusCode: 201, body: twilioMessage() })).client });
    setEnv({});
    assertEqual(a.ready(), false, 'no env');
    setEnv({ ...TWILIO_ENV, TWILIO_ACCOUNT_SID: `SK${'a1'.repeat(16)}` });
    assertEqual(a.ready(), false, 'API-key SID');
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'token-test' });
    assertEqual(a.ready(), false, 'no Messaging Service and no phone number');
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_MESSAGING_SERVICE_SID: MSS });
    assertEqual(a.ready(), false, 'no token');
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'token-test', TWILIO_PHONE_NUMBER: '+15550001111' });
    assertEqual(a.ready(), true, 'phone number sender');
    setEnv({ ...TWILIO_ENV });
    assertEqual(a.ready(), true, 'Messaging Service sender');
  });

  await test('false in the emulator stack, and send() refuses without a request', async () => {
    setEnv({ ...TWILIO_ENV, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    const { client, calls } = fakeHttp(() => ({ statusCode: 201, body: twilioMessage() }));
    const a = twilioAdapter(client);
    assertEqual(a.ready(), false, 'ready');
    const r = expectKind(await a.send(sms()), 'rejected');
    assertEqual(r.config, true, 'config');
    assertEqual(calls.length, 0, 'requests');
  });

  // =========================================================================
  console.log('\nHygiene');

  await test('no unhandled rejections escaped any adapter', async () => {
    await new Promise((r) => setTimeout(r, 50));
    assertEqual(unhandled.length, 0, 'unhandled rejections');
  });

  setEnv({});
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
