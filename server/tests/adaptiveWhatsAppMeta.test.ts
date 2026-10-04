/**
 * PR W1 — the Meta template client (adaptive/whatsapp/meta.ts) against a fake `fetch`. No
 * Firestore, no network, no real token.
 *
 * Run: npx tsx tests/adaptiveWhatsAppMeta.test.ts   (from captive-server/server)
 *
 *  - the token only in the Authorization header (debug_token also names it in input_token);
 *  - exactly one POST per create, even on a timeout or a 5xx (which are "unknown": it may exist);
 *  - a GET that fails is "unavailable"; Meta's error codes map to kinds (190 setup, 200 permission,
 *    80008/429 rate limited with retry-after, 2388024 already exists / being deleted = locked,
 *    100/33 not found, 100 invalid);
 *  - paging by cursor only (never the `paging.next` URL, which carries the token); a page limit or
 *    the time budget returns `complete: false`; an unknown field falls back to the basic fields once;
 *  - no token, query or URL in any log line or error message;
 *  - under the Firestore emulator every call is refused and ready() is false.
 */

import { classifyMetaError, createMetaClient, MetaError, scrubMetaText, GRAPH_VERSION } from '../src/adaptive/whatsapp/meta';

let passed = 0;
let failed = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (r) => unhandled.push(r));

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEqual(a: unknown, e: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${msg}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

const TOKEN = 'EAAtestTOKEN1234567890abcdefXYZ';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (call: Call, n: number) => Response | Promise<Response> | 'hang' | 'network';

function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: String(init?.method ?? 'GET'), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(call);
    const r = await responder(call, calls.length);
    if (r === 'network') throw new TypeError('fetch failed');
    if (r === 'hang') {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const metaErr = (status: number, code: number, subcode?: number, message = 'err', extra: Record<string, unknown> = {}) =>
  json(status, { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'TRACE123', ...extra } });

function client(responder: Responder, opts: { emulator?: boolean; timeoutMs?: number } = {}) {
  const f = fakeFetch(responder);
  const logs: string[] = [];
  const c = createMetaClient({
    fetchImpl: f.impl,
    env: () => ({ token: TOKEN, phoneNumberId: 'PHONE1', emulator: Boolean(opts.emulator) }),
    log: (l) => logs.push(l),
    timeoutMs: opts.timeoutMs ?? 200,
  });
  return { c, calls: f.calls, logs };
}

async function rejects(p: Promise<unknown>): Promise<MetaError> {
  try {
    await p;
  } catch (e) {
    assert(e instanceof MetaError, `not a MetaError: ${(e as Error)?.name}`);
    return e;
  }
  throw new Error('expected a rejection');
}

const CREATE = { name: 'hf_welcome_offer_1', language: 'de', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hallo {{1}}' }] };

(async () => {
  console.log('\nWhatsApp templates — the Meta client (PR W1)\n');

  await test('pinned Graph version; the token only in the Authorization header', async () => {
    const { c, calls } = client(() => json(200, { data: [], paging: {} }));
    await c.listTemplates('WABA1');
    assert(calls[0].url.startsWith(`https://graph.facebook.com/${GRAPH_VERSION}/WABA1/message_templates?`), calls[0].url);
    assertEqual(calls[0].headers.Authorization, `Bearer ${TOKEN}`, 'auth header');
    assert(!calls[0].url.includes(TOKEN), 'token not in the URL');
  });

  await test('debug_token: scopes and the WhatsApp accounts it may manage', async () => {
    const { c, calls } = client(() =>
      json(200, { data: { is_valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['111', '222'] }, { scope: 'whatsapp_business_messaging', target_ids: ['111'] }], expires_at: 0 } }),
    );
    const t = await c.debugToken();
    assertEqual(t, { valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], wabaIds: ['111', '222'], expiresAt: null }, 'token');
    assert(calls[0].url.includes('/debug_token?input_token='), 'input_token is how debug_token works');
  });

  await test('create: exactly one POST with the JSON body; the id, status and category come back', async () => {
    const { c, calls } = client(() => json(200, { id: '987', status: 'PENDING', category: 'MARKETING' }));
    const r = await c.createTemplate('WABA1', CREATE);
    assertEqual(r, { id: '987', status: 'PENDING', category: 'MARKETING' }, 'result');
    assertEqual(calls.length, 1, 'one call');
    assertEqual([calls[0].method, JSON.parse(calls[0].body!)], ['POST', CREATE], 'request');
    assertEqual(calls[0].headers['Content-Type'], 'application/json', 'content type');
  });

  await test('create that times out or hits a network error or a 5xx: "unknown", one POST, never retried', async () => {
    for (const r of ['hang', 'network', 'five'] as const) {
      const { c, calls } = client(() => (r === 'five' ? metaErr(500, 2, undefined, 'An unexpected error has occurred') : r), { timeoutMs: 50 });
      const e = await rejects(c.createTemplate('WABA1', CREATE));
      assertEqual(e.kind, 'unknown', r);
      assertEqual(calls.length, 1, `${r}: one POST`);
    }
  });

  await test('a GET that times out or fails is "unavailable"', async () => {
    const { c } = client(() => 'hang', { timeoutMs: 50 });
    assertEqual((await rejects(c.phoneNumbers('WABA1'))).kind, 'unavailable', 'timeout');
    const { c: c2 } = client(() => metaErr(503, 1));
    assertEqual((await rejects(c2.listTemplates('WABA1'))).kind, 'unavailable', '5xx');
  });

  await test('error codes → kinds (with fbtrace id and retry-after)', async () => {
    const cases: Array<[Response, string]> = [
      [metaErr(401, 190, 463, 'Error validating access token: Session has expired'), 'setup'],
      [metaErr(403, 200, undefined, '(#200) Requires whatsapp_business_management permission'), 'permission'],
      [metaErr(400, 10, undefined, 'Application does not have permission'), 'permission'],
      [metaErr(400, 80008, undefined, 'Too many calls', {}), 'rate_limited'],
      [json(429, { error: { message: 'slow down', code: 4 } }, { 'retry-after': '30' }), 'rate_limited'],
      [metaErr(400, 100, 2388024, 'Content in this language already exists'), 'already_exists'],
      [metaErr(400, 100, 2388024, "New English content can't be added while the existing English content is being deleted"), 'locked'],
      [metaErr(400, 100, 33, 'Unsupported get request. Object with ID does not exist'), 'not_found'],
      [metaErr(400, 100, 2388043, 'Invalid parameter'), 'invalid'],
    ];
    for (const [res, kind] of cases) {
      const { c } = client(() => res.clone());
      const e = await rejects(c.createTemplate('WABA1', CREATE));
      assertEqual(e.kind, kind, `${kind}: ${e.userMsg}`);
    }
    const rl = classifyMetaError('GET', 429, { error: { code: 80008, message: 'x' } }, new Headers({ 'x-business-use-case-usage': JSON.stringify({ '1': [{ type: 'whatsapp_business_management', estimated_time_to_regain_access: 5 }] }) }));
    assertEqual([rl.kind, rl.info.retryAfterMs], ['rate_limited', 300000], 'retry-after from the usage header');
    const withTrace = classifyMetaError('POST', 400, { error: { code: 100, message: 'bad', fbtrace_id: 'AbC' } }, null);
    assertEqual(withTrace.info.fbtraceId, 'AbC', 'trace id kept');
  });

  await test('Meta’s own words for the person (error_user_msg first), scrubbed of tokens and links', async () => {
    const e = classifyMetaError('POST', 400, { error: { code: 100, message: 'raw', error_user_msg: 'Variables can’t be at the start' } }, null);
    assertEqual(e.userMsg, 'Variables can’t be at the start', 'user msg');
    assertEqual(scrubMetaText(`see https://graph.facebook.com/v25.0/x?access_token=${TOKEN} and ${TOKEN}`), 'see [link] and [token]', 'scrub');
  });

  await test('paging by cursor, never the next URL; complete at the end', async () => {
    const { c, calls } = client((call) => {
      const u = new URL(call.url);
      if (!u.searchParams.get('after')) return json(200, { data: [{ id: '1', name: 'a', language: 'en' }], paging: { cursors: { after: 'CUR1' }, next: `https://graph.facebook.com/x?access_token=${TOKEN}&after=CUR1` } });
      return json(200, { data: [{ id: '2', name: 'b', language: 'de' }], paging: { cursors: { after: 'CUR2' } } });
    });
    const r = await c.listTemplates('WABA1');
    assertEqual([r.templates.length, r.complete, r.pages], [2, true, 2], 'two pages');
    assert(calls.every((x) => !x.url.includes('access_token')), 'never the next URL');
    assertEqual(new URL(calls[1].url).searchParams.get('after'), 'CUR1', 'cursor');
  });

  await test('a time budget stops the list early: complete = false', async () => {
    const { c } = client(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return json(200, { data: [{ id: 'x', name: 'x', language: 'en' }], paging: { cursors: { after: 'C' }, next: 'n' } });
    });
    const r = await c.listTemplates('WABA1', { budgetMs: 20 });
    assertEqual(r.complete, false, 'incomplete');
    assert(r.pages >= 1 && r.pages < 5, `pages ${r.pages}`);
  });

  await test('an unknown field on the first page: one retry with the basic fields', async () => {
    const { c, calls } = client((call) => {
      const fields = new URL(call.url).searchParams.get('fields') ?? '';
      if (fields.includes('previous_category')) return metaErr(400, 100, undefined, '(#100) Tried accessing nonexisting field (previous_category)');
      return json(200, { data: [], paging: {} });
    });
    const r = await c.listTemplates('WABA1');
    assertEqual([r.complete, calls.length], [true, 2], 'fallback');
  });

  await test('getTemplate: null when Meta says it doesn’t exist', async () => {
    const { c } = client(() => metaErr(400, 100, 33, 'Object with ID does not exist'));
    assertEqual(await c.getTemplate('999'), null, 'gone');
  });

  await test('findByName: exact name only (Meta’s name filter can be loose)', async () => {
    const { c } = client(() => json(200, { data: [{ id: '1', name: 'hf_a_1', language: 'en' }, { id: '2', name: 'hf_a_10', language: 'en' }] }));
    const r = (await c.findByName('WABA1', 'hf_a_1')) as Array<{ id: string }>;
    assertEqual(r.map((t) => t.id), ['1'], 'exact');
  });

  await test('review fixes: a 2xx that is not a template or not a list is "unavailable", never "gone" or "empty"', async () => {
    const { c } = client(() => json(200, {}));
    assertEqual((await rejects(c.getTemplate('1'))).kind, 'unavailable', 'get');
    assertEqual((await rejects(c.listTemplates('WABA1'))).kind, 'unavailable', 'list');
    const { c: c2 } = client(() => new Response('<html>oops</html>', { status: 200 }));
    assertEqual((await rejects(c2.getTemplate('1'))).kind, 'unavailable', 'html');
  });

  await test('review fixes: an edit Meta answers {success:false} is refused; a fallback list says it is minimal', async () => {
    const { c } = client(() => json(200, { success: false }));
    assertEqual((await rejects(c.editTemplate('1', { components: [] }))).kind, 'invalid', 'edit');
    const { c: c2 } = client((call) => {
      const fields = new URL(call.url).searchParams.get('fields') ?? '';
      if (fields.includes('quality_score')) return metaErr(400, 100, undefined, 'Tried accessing nonexisting field');
      return json(200, { data: [], paging: {} });
    });
    assertEqual((await c2.listTemplates('WABA1')).minimal, true, 'minimal');
  });

  await test('one log line per call: method, label, status, time — no token, no query, no URL', async () => {
    const { c, logs } = client(() => json(200, { data: [], paging: {} }));
    await c.listTemplates('WABA1');
    await c.debugToken().catch(() => undefined);
    assert(logs.length === 2, `logs ${logs.length}`);
    assert(/^\[WA META\] GET message_templates 200 \d+ms$/.test(logs[0]), logs[0]);
    assert(logs.every((l) => !l.includes(TOKEN) && !l.includes('?') && !l.includes('graph.facebook')), logs.join(' | '));
  });

  await test('under the Firestore emulator: not ready, and every call is refused before any request', async () => {
    const { c, calls } = client(() => json(200, {}), { emulator: true });
    assertEqual(c.ready(), false, 'ready');
    assertEqual((await rejects(c.listTemplates('WABA1'))).kind, 'setup', 'refused');
    assertEqual(calls.length, 0, 'no request');
  });

  await test('no token: setup error, no request', async () => {
    const f = fakeFetch(() => json(200, {}));
    const c = createMetaClient({ fetchImpl: f.impl, env: () => ({ token: undefined, phoneNumberId: undefined, emulator: false }), log: () => undefined });
    assertEqual(c.ready(), false, 'ready');
    assertEqual((await rejects(c.getTemplate('1'))).kind, 'setup', 'setup');
    assertEqual(f.calls.length, 0, 'no request');
  });

  assert(unhandled.length === 0, `unhandled rejections: ${unhandled.length}`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 && unhandled.length === 0 ? 0 : 1);
})();
