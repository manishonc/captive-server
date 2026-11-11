/**
 * PR image header — a picture at the top of our WhatsApp templates: the pure parts.
 *
 * Run: npx tsx tests/adaptiveWhatsAppImageHeader.test.ts   (from captive-server/server)
 *
 * No Firestore, no network. The load-bearing assertions:
 *  - the picture rules (core/whatsapp/image.ts): only https *.b-cdn.net links; JPEG/PNG only, ≤ 5 MB,
 *    ≤ 4096 px, 8-bit (16-bit PNG, CMYK JPEG, WebP, GIF refused); the venue picture a send may use;
 *  - the template model: an optional header in our text; compile puts HEADER/IMAGE first, the sample
 *    handle goes in at submit (withHeaderHandle); a template without one compiles exactly as before;
 *  - contentKey: unchanged for a template without a header (no drift on today's templates); an image
 *    header counts; Meta's HEADER:IMAGE reads back as IMAGE;
 *  - T25: a create needs a sample (from the media library); a template at Meta doesn't;
 *  - the send: the header parameter first, by link; nothing without a picture;
 *  - the Meta client's sample upload (Resumable Upload API): the session, then the bytes with
 *    `OAuth`, `file_offset: 0`, and the handle back;
 *  - the owner preview: a picture version shows the venue's picture, else the sample.
 */

import { inspectWaImage, usableVenueImage, waImageUrlProblem, WA_IMAGE_MAX_BYTES, WA_MEDIA_ERROR_CODES } from '../src/adaptive/core/whatsapp/image';
import { compileTemplate, compiledContentParts, contentKey, headerOf, metaHeaderKind, parseMetaTemplate, waSourceSchema, withHeaderHandle, type WaSource } from '../src/adaptive/core/whatsapp/template';
import { checkWhatsAppTemplate, type CheckContext, type DraftForCheck } from '../src/adaptive/core/whatsapp/checks';
import { whatsappRequestBody } from '../src/adaptive/send/adapters/whatsapp';
import { createMetaClient, MetaError } from '../src/adaptive/whatsapp/meta';
import { whatsappVersion } from '../src/adaptive/core/owner/previewVersions';
import type { Lang } from '../src/adaptive/core/constants';

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

// ── Picture bytes ────────────────────────────────────────────────────────────

function png(width: number, height: number, depth = 8, colour = 2, pad = 64): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  b[24] = depth;
  b[25] = colour;
  return b;
}

/** SOI, an APP0 segment, then a SOF0 (or `sof`) frame header. */
function jpeg(width: number, height: number, opts: { precision?: number; comps?: number; sof?: number } = {}): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, opts.sof ?? 0xc0, 0x00, 0x11, opts.precision ?? 8, height >> 8, height & 0xff, width >> 8, width & 0xff, opts.comps ?? 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

// ── Template fixtures ────────────────────────────────────────────────────────

const BASE = 'https://visit.example';
const SAMPLE = 'https://heidifi.b-cdn.net/captive-portal/owner1/media/terrace.jpg';
const FOOTERS: Record<Lang, string> = { en: 'Reply STOP to opt out', de: 'Antworte STOP zum Abmelden', fr: 'Répondez STOP pour vous désabonner', it: 'Rispondi STOP per disiscriverti' };
const PLAIN: WaSource = {
  body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Wir freuen uns, dich bald wiederzusehen.',
  footer: FOOTERS.de,
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};
const WITH_IMAGE: WaSource = { header: { type: 'image', sample: SAMPLE }, ...PLAIN };

const ctx: CheckContext = {
  visitorBaseUrl: BASE,
  optOutKeywords: ['STOP'],
  footers: FOOTERS,
  pool: { journeyKey: 'welcome', poolKey: 'welcome_offer', purpose: 'marketing', whatsappCategory: 'marketing', allowedFields: ['contact.firstName', 'venue.name', 'offer.label'], linkField: 'link.offer' },
  siblings: [],
  templateCount: 10,
  templateLimit: 250,
  createsThisHour: 0,
};

function draft(source: WaSource, atMeta = false): DraftForCheck {
  return {
    id: 'hf_welcome_offer_9__de',
    name: 'hf_welcome_offer_9',
    lang: 'de',
    requestedCategory: 'MARKETING',
    use: { kind: 'adaptive', journeyKey: 'welcome', poolKey: 'welcome_offer' },
    source,
    compiled: compileTemplate(source, { lang: 'de', visitorBaseUrl: BASE }),
    atMeta,
    nameLocked: false,
  };
}

const codes = (r: { issues: Array<{ code: string; severity: string }> }, sev = 'error') => r.issues.filter((i) => i.severity === sev).map((i) => i.code);

async function main() {
  console.log('\nWhatsApp image header — pure parts\n');

  await test('picture links: https on *.b-cdn.net only', () => {
    assertEqual(waImageUrlProblem(SAMPLE), null, 'a media-library link');
    assertEqual(waImageUrlProblem('https://askheidi.b-cdn.net/x.png'), null, 'another pull zone');
    assert(waImageUrlProblem('http://heidifi.b-cdn.net/x.jpg'), 'http is refused');
    assert(waImageUrlProblem('https://evil.example/x.jpg'), 'another host is refused');
    assert(waImageUrlProblem('https://b-cdn.net.evil.example/x.jpg'), 'a look-alike host is refused');
    assert(waImageUrlProblem('https://user:pw@heidifi.b-cdn.net/x.jpg'), 'a login in the link is refused');
    assert(waImageUrlProblem('https://heidifi.b-cdn.net:8443/x.jpg'), 'a port is refused');
    assert(waImageUrlProblem(''), 'empty');
    assert(waImageUrlProblem(null), 'not a string');
  });

  await test('pictures WhatsApp takes: 8-bit JPEG / PNG, ≤ 5 MB, ≤ 4096 px', () => {
    const p = inspectWaImage(png(1200, 628));
    assert(p.ok && p.facts.type === 'image/png' && p.facts.width === 1200 && p.facts.height === 628, `png: ${JSON.stringify(p)}`);
    const j = inspectWaImage(jpeg(1600, 900));
    assert(j.ok && j.facts.type === 'image/jpeg' && j.facts.width === 1600 && j.facts.height === 900, `jpeg: ${JSON.stringify(j)}`);
    const progressive = inspectWaImage(jpeg(800, 600, { sof: 0xc2 }));
    assert(progressive.ok && progressive.facts.width === 800, 'a progressive JPEG (SOF2) is fine');
    const rgba = inspectWaImage(png(500, 500, 8, 6));
    assert(rgba.ok, 'RGBA PNG');
  });

  await test('pictures WhatsApp refuses, in words', () => {
    const deep = inspectWaImage(png(100, 100, 16));
    assert(!deep.ok && /16-bit/.test(deep.reason), `16-bit PNG: ${JSON.stringify(deep)}`);
    const cmyk = inspectWaImage(jpeg(100, 100, { comps: 4 }));
    assert(!cmyk.ok && /CMYK/.test(cmyk.reason), 'CMYK JPEG');
    const twelve = inspectWaImage(jpeg(100, 100, { precision: 12 }));
    assert(!twelve.ok && /12-bit/.test(twelve.reason), '12-bit JPEG');
    const huge = inspectWaImage(png(5000, 1000));
    assert(!huge.ok && /4096/.test(huge.reason), 'too wide');
    const big = new Uint8Array(WA_IMAGE_MAX_BYTES + 1);
    big.set(png(10, 10).subarray(0, 33));
    const tooBig = inspectWaImage(big);
    assert(!tooBig.ok && /5 MB/.test(tooBig.reason), 'over 5 MB');
    const webp = inspectWaImage(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '));
    assert(!webp.ok && /JPEG or PNG/.test(webp.reason), 'WebP');
    const gif = inspectWaImage(new TextEncoder().encode('GIF89a......'));
    assert(!gif.ok && /JPEG or PNG/.test(gif.reason), 'GIF');
    assert(!inspectWaImage(new Uint8Array(0)).ok, 'empty');
    const cut = inspectWaImage(jpeg(100, 100).subarray(0, 10));
    assert(!cut.ok, 'a cut JPEG');
  });

  await test('the venue picture a send may use: ok and a media-library link', () => {
    const img = { url: SAMPLE, type: 'image/jpeg', width: 1200, height: 628, bytes: 1000, status: 'ok' };
    assertEqual(usableVenueImage(img)?.url, SAMPLE, 'ok');
    assertEqual(usableVenueImage({ ...img, status: 'broken' }), null, 'broken: none');
    assertEqual(usableVenueImage({ ...img, url: 'https://evil.example/x.jpg' }), null, 'a link we never accept');
    assertEqual(usableVenueImage(null), null, 'none');
    assertEqual(usableVenueImage(undefined), null, 'older docs');
    assert(WA_MEDIA_ERROR_CODES.has('131053') && WA_MEDIA_ERROR_CODES.has('131052'), "Meta's media codes");
  });

  await test('the source: header optional, a sample defaults to null, older sources parse unchanged', () => {
    const old = waSourceSchema.parse(PLAIN);
    assert(!('header' in old) || old.header === undefined, 'no header added to a source without one');
    const img = waSourceSchema.parse({ ...PLAIN, header: { type: 'image' } });
    assertEqual(img.header, { type: 'image', sample: null }, 'sample defaults to null');
    let threw = false;
    try {
      waSourceSchema.parse({ ...PLAIN, header: { type: 'video', sample: null } });
    } catch {
      threw = true;
    }
    assert(threw, 'only image headers');
    assertEqual(headerOf(PLAIN), null, 'headerOf: none');
    assertEqual(headerOf(WITH_IMAGE), { type: 'image', sample: SAMPLE }, 'headerOf: the image');
    assertEqual(headerOf(undefined), null, 'headerOf: nothing');
  });

  await test('compile: HEADER/IMAGE first; a template without one exactly as before', () => {
    const plain = compileTemplate(PLAIN, { lang: 'de', visitorBaseUrl: BASE });
    assertEqual(plain.components.map((c) => c.type), ['BODY', 'FOOTER', 'BUTTONS'], 'plain components');
    assertEqual(plain.header, null, 'plain: no header');
    const img = compileTemplate(WITH_IMAGE, { lang: 'de', visitorBaseUrl: BASE });
    assertEqual(img.components[0], { type: 'HEADER', format: 'IMAGE' }, 'header first, no handle yet');
    assertEqual(img.components.slice(1).map((c) => c.type), ['BODY', 'FOOTER', 'BUTTONS'], 'the rest unchanged');
    assertEqual(img.bodyText, plain.bodyText, 'same body');
    const sent = withHeaderHandle(img.components, '4::aGFuZGxl');
    assertEqual(sent[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aGFuZGxl'] } }, 'the handle in the example');
    assertEqual(withHeaderHandle(plain.components, 'x'), plain.components, 'no header: nothing added');
  });

  await test('contentKey: unchanged without a header; an image header counts', () => {
    const plain = compileTemplate(PLAIN, { lang: 'de', visitorBaseUrl: BASE });
    const legacyKey = contentKey({ bodyText: plain.bodyText, footerText: plain.footerText, buttons: [{ text: plain.button!.text, url: plain.button!.url }] });
    assertEqual(contentKey(compiledContentParts(plain)), legacyKey, 'plain key as before');
    const img = compileTemplate(WITH_IMAGE, { lang: 'de', visitorBaseUrl: BASE });
    assert(contentKey(compiledContentParts(img)) !== legacyKey, 'image header changes the key');
    // An older compiled doc (no `header` field at all) keys as a plain one.
    const { header: _h, ...olderDoc } = plain;
    assertEqual(contentKey(compiledContentParts(olderDoc)), legacyKey, 'older doc');
  });

  await test("Meta's template with an image header reads back as IMAGE", () => {
    const raw = {
      id: '123',
      name: 'hf_welcome_offer_9',
      language: 'de',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.example/x'] } },
        { type: 'BODY', text: 'Hallo {{1}}' },
      ],
    };
    const f = parseMetaTemplate(raw)!;
    assertEqual(f.otherComponents, ['HEADER:IMAGE'], 'kept as a part');
    assertEqual(metaHeaderKind(f), 'IMAGE', 'header kind');
    assertEqual(metaHeaderKind({ headerText: 'Hi', otherComponents: [] }), 'TEXT:Hi', 'a text header');
    assertEqual(metaHeaderKind({ headerText: null, otherComponents: [] }), null, 'none');
  });

  await test('T25: a create needs a sample from the media library; a template at Meta does not', () => {
    assertEqual(codes(checkWhatsAppTemplate(draft(WITH_IMAGE), ctx)), [], 'image draft with a sample passes');
    assertEqual(codes(checkWhatsAppTemplate(draft(PLAIN), ctx)), [], 'plain passes');
    const noSample = checkWhatsAppTemplate(draft({ ...PLAIN, header: { type: 'image', sample: null } }), ctx);
    assertEqual(codes(noSample), ['T25'], 'no sample: T25');
    const atMeta = checkWhatsAppTemplate(draft({ ...PLAIN, header: { type: 'image', sample: null } }, true), ctx);
    assertEqual(codes(atMeta), [], 'at Meta: no T25 (it stays usable)');
    const badHost = checkWhatsAppTemplate(draft({ ...PLAIN, header: { type: 'image', sample: 'https://evil.example/x.jpg' } }), ctx);
    assertEqual(codes(badHost), ['T25'], 'a link from elsewhere: T25');
  });

  await test('the send: the picture first, by link; none without one', () => {
    const base = { kind: 'whatsapp' as const, to: '+41791234567', templateName: 'hf_welcome_offer_9', language: 'de', bodyParams: ['Anna', 'Café Bellevue'], button: { index: 0, param: 's/abcdefgh' }, previewText: 'x', sendKey: 'k' };
    const withPic = whatsappRequestBody({ ...base, headerImage: { link: SAMPLE } }) as { template: { components: Array<Record<string, unknown>> } };
    assertEqual(withPic.template.components[0], { type: 'header', parameters: [{ type: 'image', image: { link: SAMPLE } }] }, 'header parameter');
    assertEqual(withPic.template.components.map((c) => c.type), ['header', 'body', 'button'], 'order');
    const plain = whatsappRequestBody(base) as { template: { components: Array<Record<string, unknown>> } };
    assertEqual(plain.template.components.map((c) => c.type), ['body', 'button'], 'no picture: as before');
    const nullPic = whatsappRequestBody({ ...base, headerImage: null }) as { template: { components: Array<Record<string, unknown>> } };
    assertEqual(nullPic.template.components.map((c) => c.type), ['body', 'button'], 'null picture: as before');
  });

  await test("the sample upload: Meta's Resumable Upload API, two calls, the handle back", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
      if (calls.length === 1) return new Response(JSON.stringify({ id: 'upload:MTphdHRhY2htZW50?sig=ARZx' }), { status: 200 });
      return new Response(JSON.stringify({ h: '4::aGFuZGxl' }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createMetaClient({ fetchImpl, env: () => ({ token: 'EAAtoken', phoneNumberId: '123456', emulator: false }), log: () => undefined });
    const bytes = jpeg(1200, 628);
    const h = await c.uploadSample('987654321', { bytes, type: 'image/jpeg', name: 'hf_welcome_offer_9_de.jpg' });
    assertEqual(h, '4::aGFuZGxl', 'handle');
    const s = new URL(calls[0].url);
    assert(s.pathname.endsWith('/987654321/uploads'), `session path ${s.pathname}`);
    assertEqual([s.searchParams.get('file_name'), s.searchParams.get('file_length'), s.searchParams.get('file_type')], ['hf_welcome_offer_9_de.jpg', String(bytes.length), 'image/jpeg'], 'session query');
    assertEqual(calls[0].headers.Authorization, 'Bearer EAAtoken', 'session: Bearer');
    const u = new URL(calls[1].url);
    assert(u.pathname.endsWith('/upload:MTphdHRhY2htZW50'), `upload path ${u.pathname}`);
    assertEqual(u.searchParams.get('sig'), 'ARZx', 'the sig stays in the URL');
    assertEqual(calls[1].headers.Authorization, 'OAuth EAAtoken', 'upload: OAuth');
    assertEqual(calls[1].headers.file_offset, '0', 'file_offset');
    assert(calls[1].body === bytes, 'the bytes as they are');
  });

  await test('the sample upload: refusals', async () => {
    const answer = (r: Response) => (async () => r) as unknown as typeof fetch;
    const mk = (f: typeof fetch) => createMetaClient({ fetchImpl: f, env: () => ({ token: 'EAAtoken', phoneNumberId: '123456', emulator: false }), log: () => undefined });
    const file = { bytes: jpeg(10, 10), type: 'image/jpeg' as const, name: 'x.jpg' };
    let e: unknown = null;
    await mk(answer(new Response('{}', { status: 200 }))).uploadSample('bad id', file).catch((err) => (e = err));
    assert(e instanceof MetaError && e.kind === 'setup', 'an app id that is not one');
    e = null;
    await mk(answer(new Response(JSON.stringify({ id: 'nope' }), { status: 200 }))).uploadSample('987', file).catch((err) => (e = err));
    assert(e instanceof MetaError && e.kind === 'unknown', 'no upload session');
    e = null;
    await mk(answer(new Response(JSON.stringify({ error: { code: 100, message: 'Invalid parameter' } }), { status: 400 }))).uploadSample('987', file).catch((err) => (e = err));
    assert(e instanceof MetaError && e.kind === 'invalid', 'Meta refuses');
    e = null;
    const emu = createMetaClient({ fetchImpl: answer(new Response('{}')), env: () => ({ token: 'EAAtoken', phoneNumberId: '1', emulator: true }), log: () => undefined });
    await emu.uploadSample('987', file).catch((err) => (e = err));
    assert(e instanceof MetaError && e.kind === 'setup', 'never under the emulator');
  });

  await test("the owner preview: the venue's picture, else the sample; none on a plain template", () => {
    const values = { 'contact.firstName': 'Anna', 'venue.name': 'Café Bellevue' };
    const v1 = whatsappVersion('approved', 'de', 'hf_welcome_offer_9', WITH_IMAGE, values, 'https://venue.b-cdn.net/pic.jpg');
    assertEqual(v1.header, { type: 'image', url: 'https://venue.b-cdn.net/pic.jpg' }, "venue's picture");
    const v2 = whatsappVersion('approved', 'de', 'hf_welcome_offer_9', WITH_IMAGE, values);
    assertEqual(v2.header, { type: 'image', url: SAMPLE }, 'sample');
    const v3 = whatsappVersion('approved', 'de', 'hf_welcome_offer_1', PLAIN, values, 'https://venue.b-cdn.net/pic.jpg');
    assert(!('header' in v3), 'plain: no header key');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

void main();
