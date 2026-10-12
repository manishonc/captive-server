/**
 * PR PV — Adaptive's own WhatsApp adapter (send/adapters/whatsapp.ts) and the template values
 * (core/whatsapp/sendValues.ts): exactly one request per send, every answer classified, and the
 * values Meta gets — one line each, never empty.
 *
 * Run: npx tsx tests/adaptiveWhatsAppSend.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials, no network: the adapter gets a fake `fetch` and a fake env.
 *
 * The load-bearing assertions:
 *  - one POST to `/{phone number id}/messages`, Graph v25.0, the token only in the header, the
 *    template by name + language, body values in order, the URL button's variable;
 *  - "retry" only when Meta says it didn't send (429, rate codes) or the request never left; a
 *    timeout, 5xx or a 2xx without a message id is "unknown"; token/permission/account codes are
 *    "config"; template and number refusals keep Meta's words (scrubbed: no link, token or number);
 *  - ready() is false without a token or a numeric phone number id, and in the local emulator stack.
 */

import { createWhatsAppAdapter, classifyWhatsAppAnswer, scrubWhatsAppText, whatsappRequestBody, WA_SEND_GRAPH_VERSION } from '../src/adaptive/send/adapters/whatsapp';
import type { OutboundWhatsApp, ProviderResult } from '../src/adaptive/send/adapters/types';
import { oneLine, waBodyValues } from '../src/adaptive/core/whatsapp/sendValues';
import { compileTemplate } from '../src/adaptive/core/whatsapp/template';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
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

const TOKEN = 'EAAtesttokentesttokentesttoken123456';
const ENV = () => ({ token: TOKEN, phoneNumberId: '123456789012345', emulator: false });

const MSG: OutboundWhatsApp = {
  kind: 'whatsapp',
  to: '+41 79 123 45 67',
  templateName: 'hf_welcome_offer_1',
  language: 'de',
  bodyParams: ['Anna', 'Café Bellevue', 'ein Gratis-Dessert'],
  button: { index: 0, param: 's/xxxxxxxx' },
  previewText: 'Hallo Anna …',
  sendKey: 'test_abc',
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: { status: number; body?: unknown; headers?: Record<string, string> } | Error | 'hang') {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function adapter(fetchImpl: typeof fetch, opts: { env?: typeof ENV; timeoutMs?: number; deadlineGraceMs?: number; log?: (l: string) => void } = {}) {
  return createWhatsAppAdapter({ fetchImpl, env: opts.env ?? ENV, log: opts.log ?? (() => undefined), timeoutMs: opts.timeoutMs, deadlineGraceMs: opts.deadlineGraceMs });
}

const metaError = (status: number, code: number, message: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'Abc123', ...extra } } });

async function main() {
  console.log('\nWhatsApp adapter + template values (PR PV)\n');

  await test('one POST to /{phone number id}/messages with the template, its values and the button variable', async () => {
    const f = fakeFetch({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: '41791234567', wa_id: '41791234567' }], messages: [{ id: 'wamid.HBgL123' }] } });
    const lines: string[] = [];
    const r = await adapter(f.impl, { log: (l) => lines.push(l) }).send(MSG);
    // PR W3: Meta's own id of the recipient comes back too (inbound STOPs use it).
    assertEqual(r, { kind: 'accepted', provider: 'meta', providerMessageId: 'wamid.HBgL123', recipientId: '41791234567' }, 'accepted');
    assertEqual(f.calls.length, 1, 'one call');
    assertEqual(f.calls[0].url, `https://graph.facebook.com/${WA_SEND_GRAPH_VERSION}/123456789012345/messages`, 'url');
    assertEqual(WA_SEND_GRAPH_VERSION, 'v25.0', 'the template client’s version');
    const headers = f.calls[0].init.headers as Record<string, string>;
    assertEqual([f.calls[0].init.method, headers.Authorization, headers['Content-Type'], f.calls[0].init.redirect], ['POST', `Bearer ${TOKEN}`, 'application/json', 'error'], 'request');
    assertEqual(
      JSON.parse(String(f.calls[0].init.body)),
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '41791234567',
        type: 'template',
        template: {
          name: 'hf_welcome_offer_1',
          language: { code: 'de' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: 'Anna' }, { type: 'text', text: 'Café Bellevue' }, { type: 'text', text: 'ein Gratis-Dessert' }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 's/xxxxxxxx' }] },
          ],
        },
      },
      'body',
    );
    assert(lines.length === 1 && lines[0].startsWith('[WA SEND] POST messages 200'), `one log line: ${lines.join(' | ')}`);
    assert(!lines.join(' ').includes(TOKEN) && !lines.join(' ').includes('4179'), 'no token or number in the log');
  });

  await test('no values and no button → no components', () => {
    const body = whatsappRequestBody({ ...MSG, bodyParams: [], button: null });
    assertEqual((body.template as Record<string, unknown>).components, undefined, 'no components');
  });

  await test('Meta’s answers → accepted / retry / rejected (config or not) / unknown', () => {
    const cases: Array<[string, ProviderResult['kind'], { status: number; body?: unknown }, Partial<Record<string, unknown>>]> = [
      ['429', 'retry', metaError(429, 4, 'Application request limit reached'), { reason: 'meta_4' }],
      ['throughput 130429', 'retry', metaError(400, 130429, 'Rate limit hit'), { reason: 'meta_130429' }],
      ['pair rate 131056', 'retry', metaError(400, 131056, '(Business Account, Consumer Account) pair rate limit hit'), { reason: 'meta_131056' }],
      ['service unavailable 131016 (may have left)', 'unknown', metaError(503, 131016, 'Service unavailable'), { reason: 'meta_131016' }],
      ['spam limit on our number 131048', 'rejected', metaError(400, 131048, 'Spam rate limit hit'), { code: '131048', config: true }],
      ['our phone number id unknown 100/33', 'rejected', metaError(400, 100, "Unsupported post request. Object with ID '123456789012345' does not exist", { error_subcode: 33 }), { code: '100', config: true }],
      ['our number deleted 33', 'rejected', metaError(400, 33, 'The business phone number has been deleted'), { code: '33', config: true }],
      ['token expired 190', 'rejected', metaError(401, 190, 'Error validating access token: Session has expired'), { code: '190', config: true }],
      ['permission 10', 'rejected', metaError(403, 10, 'Application does not have permission for this action'), { code: '10', config: true }],
      ['API permission 200', 'rejected', metaError(400, 200, 'Permissions error'), { code: '200', config: true }],
      ['number not registered 133010', 'rejected', metaError(400, 133010, 'Account not registered'), { code: '133010', config: true }],
      ['account locked 131031', 'rejected', metaError(400, 131031, 'Business Account locked'), { code: '131031', config: true }],
      ['template missing 132001', 'rejected', metaError(404, 132001, '(#132001) Template name does not exist in the translation', { error_data: { messaging_product: 'whatsapp', details: 'template name (hf_x_1) does not exist in de' } }), { code: '132001' }],
      ['param count 132000', 'rejected', metaError(400, 132000, 'Number of parameters does not match the expected number of params'), { code: '132000' }],
      ['not in the allowed list 131030', 'rejected', metaError(400, 131030, 'Recipient phone number not in allowed list'), { code: '131030' }],
      ['invalid parameter 100', 'rejected', metaError(400, 100, 'Invalid parameter'), { code: '100' }],
      ['5xx', 'unknown', { status: 503, body: 'Service Unavailable' }, { reason: 'meta_http_503' }],
      ['something went wrong 131000', 'unknown', metaError(500, 131000, 'Something went wrong'), { reason: 'meta_131000' }],
      ['2xx without an id', 'unknown', { status: 200, body: { messaging_product: 'whatsapp' } }, { reason: 'meta_no_message_id' }],
      ['2xx not JSON', 'unknown', { status: 200, body: '<html>' }, { reason: 'meta_no_message_id' }],
    ];
    for (const [label, kind, answer, fields] of cases) {
      const json = typeof answer.body === 'string' ? (() => { try { return JSON.parse(answer.body as string); } catch { return null; } })() : answer.body;
      const r = classifyWhatsAppAnswer(answer.status, json, null) as Record<string, unknown>;
      assertEqual(r.kind, kind, `${label}: kind`);
      assertEqual(r.provider, 'meta', `${label}: provider`);
      for (const [k, v] of Object.entries(fields)) assertEqual(r[k], v, `${label}: ${k}`);
      if (kind === 'rejected' && !fields.config) assert(r.config === undefined, `${label}: not a setup problem`);
    if (typeof r.message === 'string') assert(!/\d{7,}/.test(r.message), `${label}: no long number in Meta's words: ${r.message}`);
    }
    const missing = classifyWhatsAppAnswer(404, metaError(404, 132001, 'x', { error_data: { details: 'template name (hf_x_1) does not exist in de' } }).body, null) as { message: string };
    assertEqual(missing.message, 'template name (hf_x_1) does not exist in de', 'Meta’s details win over the generic message');
  });

  await test('PR W3: Meta’s recipient id (wa_id) — kept when it is digits, dropped otherwise or when missing', () => {
    const ok = classifyWhatsAppAnswer(200, { contacts: [{ input: '+525512345678', wa_id: '5215512345678' }], messages: [{ id: 'wamid.mx' }] }, null) as Record<string, unknown>;
    assertEqual(ok.recipientId, '5215512345678', 'Mexico: Meta’s own id');
    const odd = classifyWhatsAppAnswer(200, { contacts: [{ wa_id: '+52 55 1234' }], messages: [{ id: 'wamid.x' }] }, null) as Record<string, unknown>;
    assertEqual(odd.recipientId, null, 'not digits');
    const none = classifyWhatsAppAnswer(200, { messages: [{ id: 'wamid.y' }] }, null) as Record<string, unknown>;
    assertEqual(none.recipientId, null, 'no contacts');
  });

  await test('the rate answer carries Retry-After', () => {
    const r = classifyWhatsAppAnswer(429, metaError(429, 4, 'limit').body, new Headers({ 'retry-after': '30' }));
    assertEqual(r, { kind: 'retry', provider: 'meta', reason: 'meta_4', retryAfterMs: 30_000 }, 'retry after 30 s');
  });

  await test('Meta’s words are scrubbed: no link, token or phone number, capped', () => {
    const s = scrubWhatsAppText(`See https://developers.facebook.com/docs?access_token=${TOKEN} for +41 79 123 45 67 and ${TOKEN} ${'x'.repeat(400)}`);
    assert(!s.includes('facebook.com') && !s.includes(TOKEN) && !s.includes('123 45 67'), s);
    assert(s.includes('[link]') && s.includes('•••') && s.length <= 300, s);
    assertEqual(scrubWhatsAppText('(#132001) Template name does not exist'), '(#132001) Template name does not exist', 'error codes stay');
  });

  await test('network: refused before sending → retry; reset → unknown; timeout → unknown (one call each)', async () => {
    const refused = fakeFetch(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    assertEqual(await adapter(refused.impl).send(MSG), { kind: 'retry', provider: 'meta', reason: 'net_ECONNREFUSED', retryAfterMs: null }, 'refused');
    const reset = fakeFetch(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    assertEqual(await adapter(reset.impl).send(MSG), { kind: 'unknown', provider: 'meta', reason: 'net_ECONNRESET' }, 'reset');
    const hang = fakeFetch('hang');
    const r = await adapter(hang.impl, { timeoutMs: 30, deadlineGraceMs: 1000 }).send(MSG);
    assertEqual(r, { kind: 'unknown', provider: 'meta', reason: 'timeout' }, 'timeout');
    assertEqual([refused.calls.length, reset.calls.length, hang.calls.length], [1, 1, 1], 'never a second call');
  });

  await test('ready(): token + numeric phone number id, never under the emulator; send refuses without calling', async () => {
    const f = fakeFetch({ status: 200, body: { messages: [{ id: 'wamid.x' }] } });
    assert(adapter(f.impl).ready(), 'ready');
    const emulator = adapter(f.impl, { env: () => ({ ...ENV(), emulator: true }) });
    assert(!emulator.ready(), 'not under the emulator');
    assertEqual(await emulator.send(MSG), { kind: 'rejected', provider: 'meta', code: 'not_configured', message: 'WhatsApp is not configured (or this is the local emulator stack)', config: true }, 'refused');
    assert(!adapter(f.impl, { env: () => ({ ...ENV(), token: undefined }) }).ready(), 'no token');
    assert(!adapter(f.impl, { env: () => ({ ...ENV(), phoneNumberId: '12/../me' }) }).ready(), 'a phone number id that isn’t a number');
    const wrong = await adapter(f.impl).send({ kind: 'sms', to: '+41791234567', body: 'x', sendKey: 'k' });
    assertEqual((wrong as { code?: string }).code, 'wrong_channel', 'an SMS is refused');
    assertEqual(f.calls.length, 0, 'no call');
  });

  await test('template values: in {{n}} order, with each field’s default and date format, on one line; empty → missing', () => {
    const source = {
      body: 'Hallo {{contact.firstName | default:"du"}}, bei {{venue.name}} wartet {{offer.label}} – bis {{offer.expiryDate | date:"d.M."}}. Bis bald, {{venue.name}}!',
      footer: 'Antworte STOP zum Abmelden',
      button: { text: 'Angebot ansehen', field: 'link.offer' as const },
    };
    const compiled = compileTemplate(source, { lang: 'de', visitorBaseUrl: 'https://visit.example' });
    assertEqual(compiled.params.map((p) => p.field), ['contact.firstName', 'venue.name', 'offer.label', 'offer.expiryDate'], 'params');
    const values = { 'contact.firstName': '', 'venue.name': 'Café\nBellevue', 'offer.label': 'ein  Gratis-Dessert\t', 'offer.expiryDate': '2026-10-20T12:00:00.000Z' };
    const v = waBodyValues(source, compiled, values);
    assertEqual(v.params, ['du', 'Café Bellevue', 'ein  Gratis-Dessert', '20.10.'], 'values');
    assertEqual(v.missing, [], 'nothing missing');
    assert(v.text.startsWith('Hallo du, bei Café\nBellevue wartet'), `the text as the guest reads it: ${v.text}`);
    const without = waBodyValues(source, compiled, { ...values, 'offer.label': '   ' });
    assertEqual(without.missing, ['offer.label'], 'a blank value is missing');
    const unknown = waBodyValues(source, compiled, { 'venue.name': 'X' });
    assertEqual(unknown.missing, ['offer.label', 'offer.expiryDate'], 'no value and no default');
    assertEqual(oneLine(' a\r\nb\t c      d '), 'a b  c   d', 'one line, at most three spaces');
    assertEqual(oneLine('11:30\u2028–\u202922:00\u0085x\vy\fz'), '11:30 – 22:00 x y z', 'Unicode line breaks too');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
