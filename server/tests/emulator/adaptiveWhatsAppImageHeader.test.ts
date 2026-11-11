/**
 * PR image header — a picture at the top of WhatsApp messages, on the emulator with the sandbox Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 * The media library (the Bunny CDN) is a stub here (`__setImageFetchForTests`): a link with `.png`
 * answers a PNG, `.webp` a WebP, `/gone` a 404, anything else a JPEG. Guests have only a UK number
 * (+44) and no email, so the welcome can only go by WhatsApp (as in adaptiveWhatsAppSending.test.ts).
 *
 *  - The venue's WhatsApp picture (owner API): saved after one read and check (type, size, px), refused
 *    in words (WebP, 404, a link outside the media library — that one never fetched), removed with
 *    null, another account's venue refused; a super admin (the MCP) may set it too.
 *  - Send to Meta: an image template without a sample is refused (T25, nothing changes); with one the
 *    sample is read, uploaded (sandbox handle) and Meta gets HEADER/IMAGE with `header_handle` first;
 *    after approval it reads back clean (no T23 drift, no T24) and usable.
 *  - Sends: a venue without a picture gets the plain template (no header); with one, the image
 *    template with the venue's picture as the header link.
 *  - Meta can't load the picture (sandbox 131053): the send is refused, the venue's picture is marked
 *    broken, its next guest gets the plain template; saving the picture again clears it.
 *  - "See what guests get": the image version with the venue's picture; without one, the plain one.
 *  - Send test: the image template with the venue's picture; the preview says which picture.
 *  - unhandledParts: Meta's image header is ours to fill only when our text has one.
 */

import {
  COL,
  advance,
  assert,
  assertEqual,
  clearCaches,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
  nextTuesday1240,
  outbox,
  resetEmulator,
  runDue,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  withoutReviewAsk,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, OWNER_ACTOR, mountApi, seedTestRecipients } from './ownerApiHelpers';
import { CONFIG_DOC_ID } from '../../src/adaptive/store/collections';
import { adaptiveVenueId } from '../../src/adaptive/store/collections';
import { runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache, __resetMessagesSeen } from '../../src/adaptive/whatsapp/hints';
import { __clearWaPickCache } from '../../src/adaptive/whatsapp/pick';
import { __setImageFetchForTests } from '../../src/adaptive/whatsapp/imageFetch';
import { unhandledParts } from '../../src/adaptive/whatsapp/context';
import { STOP_LINES } from '../../src/adaptive/send/compose';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const W: VenueFixture = { tenant: 'tenant_img', venueId: 'venue_img', apId: 'ap_img', apMac: 'aa:bb:cc:dd:ee:91' };
const OTHER: VenueFixture = { tenant: 'tenant_img_other', venueId: 'venue_img_other', apId: 'ap_img_o', apMac: 'aa:bb:cc:dd:ee:92' };
const T = `/tenants/${W.tenant}`;
const V = `${T}/venues/${W.venueId}`;
const A1 = 'welcome_second_visit';
const CDN = 'https://heidifi-test.b-cdn.net/captive-portal/tenant_img/media';
const SAMPLE = `${CDN}/sample-terrace.jpg`;
const VENUE_PIC = `${CDN}/venue-front.jpg`;

const EN_OFFER = {
  body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}}! Come back within {{offer.days | default:"14"}} days for {{offer.label | default:"a surprise"}}.',
  footer: STOP_LINES.en,
  button: { text: 'See your offer', field: 'link.offer' },
};
const EN_OFFER_IMG = {
  header: { type: 'image', sample: SAMPLE },
  body: 'Hi {{contact.firstName | default:"there"}}, it was lovely to have you at {{venue.name}}! Come back within {{offer.days | default:"14"}} days for {{offer.label | default:"a surprise"}}.',
  footer: STOP_LINES.en,
  button: { text: 'See your offer', field: 'link.offer' },
};

function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[24] = 8;
  b[25] = 2;
  return b;
}

const fetched: string[] = [];
const cdnStub = (async (input: string | URL) => {
  const url = String(input);
  fetched.push(url);
  if (url.includes('/gone')) return new Response('not found', { status: 404 });
  if (url.endsWith('.webp')) return new Response(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), { status: 200 });
  return new Response(url.endsWith('.png') ? png(1200, 628) : jpeg(1200, 628), { status: 200 });
}) as unknown as typeof fetch;

let n = 300;
function ukPhone(): string {
  n += 1;
  return `77009${String(n).padStart(5, '0')}`;
}

async function main() {
  __setImageFetchForTests(cdnStub);
  const api = await mountApi();
  const admin = { ...ADMIN_ACTOR, uid: 'heidifi_admin_img' };
  const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor: admin });
  const putImage = (url: string | null, actor: unknown = OWNER_ACTOR, venue = V) => api.call('PUT', `${venue}/whatsapp-image`, { url, actor });

  async function fresh(): Promise<void> {
    await resetEmulator();
    __clearHintCache();
    __resetMessagesSeen();
    await seedCatalogue();
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test', whatsappSending: { mode: 'on' } });
    await setupVenue(W);
    await setupVenue(OTHER);
    await withoutReviewAsk(W);
    await setClock(nextTuesday1240());
    await seedWallet(W.tenant, 5000);
    await setLaunch({ [W.tenant]: 'live' }, { paused: false });
    clearCaches();
    __clearWaPickCache();
    fetched.length = 0;
  }

  let checks = 0;
  async function connected(): Promise<void> {
    checks += 1;
    const c = await api.call('POST', '/admin/whatsapp/connection/check', { actor: { ...admin, uid: `heidifi_admin_img_${checks}` } });
    assertEqual(c.status, 200, `connection ${c.text}`);
  }

  async function draft(source: unknown): Promise<{ id: string; version: number; body: AnyDoc }> {
    const d = await post('/admin/whatsapp/templates', { use: { journeyKey: A1, poolKey: 'welcome_offer' }, lang: 'en', category: 'MARKETING', source });
    assertEqual(d.status, 200, `draft ${d.text}`);
    return { id: d.body.template.id, version: d.body.template.version, body: d.body };
  }

  async function approve(id: string): Promise<void> {
    const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision: 'APPROVED' });
    assertEqual(r.status, 200, `review ${r.text}`);
    await runWhatsAppTemplateTick();
    clearCaches();
    __clearWaPickCache();
  }

  async function approved(source: unknown): Promise<string> {
    await connected();
    const d = await draft(source);
    const s = await post(`/admin/whatsapp/templates/${d.id}/submit`, { baseVersion: d.version });
    assertEqual([s.status, s.body.outcome], [200, 'submitted'], `submit ${s.text}`);
    await approve(d.id);
    return d.id;
  }

  async function welcomed(phone: string) {
    const guestId = await connect({ venue: W, firstName: 'Anna', phone, phoneCountryCode: '+44', phoneVerified: true, consent: true, language: 'en' });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const contactId = await contactIdFor(W.tenant, guestId);
    const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1);
    assert(inst, `no welcome journey for ${guestId}`);
    const key = sendKeyFor(inst.id, 's1');
    const snap = await db.collection(COL.journeySends).doc(key).get();
    const s1 = snap.exists ? ({ ...(snap.data() as Record<string, any>), id: key } as AnyDoc) : null;
    const ob = s1 ? (await outbox()).find((o) => o.id === key) ?? null : null;
    return { s1, ob };
  }

  const venuePicture = async () => (await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(W.venueId)).get()).get('whatsappImage') as AnyDoc | null | undefined;

  console.log('\nWhatsApp image header (PR image header)\n');

  await test('the venue picture: saved after one check, refused in words, removed with null, only for the account’s own venue', async () => {
    await fresh();
    let r = await api.call('GET', `${V}/whatsapp-image`);
    assertEqual([r.status, r.body.image], [200, null], 'none at first');
    assertEqual(r.body.rules.types, ['image/jpeg', 'image/png'], 'the rules');

    r = await putImage(VENUE_PIC);
    assertEqual(r.status, 200, r.text);
    assertEqual([r.body.image.url, r.body.image.type, r.body.image.width, r.body.image.height, r.body.image.status], [VENUE_PIC, 'image/jpeg', 1200, 628, 'ok'], 'saved with its facts');
    assertEqual(fetched, [VENUE_PIC], 'read once');
    const stored = await venuePicture();
    assertEqual([stored?.url, stored?.status], [VENUE_PIC, 'ok'], 'on the Adaptive venue doc');

    r = await putImage(`${CDN}/menu.webp`);
    assertEqual(r.status, 422, r.text);
    assert(/JPEG or PNG/.test(r.text), `WebP in words: ${r.text}`);
    r = await putImage(`${CDN}/gone.jpg`);
    assertEqual(r.status, 422, r.text);
    assert(/isn’t in the media library/.test(r.text), `404 in words: ${r.text}`);
    fetched.length = 0;
    r = await putImage('https://evil.example/x.jpg');
    assertEqual(r.status, 422, r.text);
    assertEqual(fetched, [], 'a link outside the media library is never fetched');
    assertEqual((await venuePicture())?.url, VENUE_PIC, 'refusals change nothing');

    r = await putImage(`${CDN}/logo.png`, admin);
    assertEqual([r.status, r.body.image?.type], [200, 'image/png'], 'a super admin (the MCP) may set it');
    r = await putImage(null);
    assertEqual([r.status, r.body.image], [200, null], 'removed');
    r = await putImage(VENUE_PIC, OWNER_ACTOR, `/tenants/${W.tenant}/venues/${OTHER.venueId}`);
    assertEqual(r.status, 403, `another account's venue: ${r.text}`);
  });

  await test('Send to Meta: no sample → T25, nothing changes; with one → uploaded, HEADER/IMAGE with its handle first; approved → clean and usable', async () => {
    await fresh();
    await connected();
    const d = await draft({ ...EN_OFFER_IMG, header: { type: 'image', sample: null } });
    assert(d.body.template.checks.issues.some((i: AnyDoc) => i.code === 'T25' && i.severity === 'error'), `T25 on the draft: ${JSON.stringify(d.body.template.checks)}`);
    let s = await post(`/admin/whatsapp/templates/${d.id}/submit`, { baseVersion: d.version });
    assertEqual(s.status, 422, `refused without a sample: ${s.text}`);
    assertEqual((await api.call('GET', `/admin/whatsapp/templates/${d.id}`)).body.template.stage, 'draft', 'still a draft');

    const saved = await api.call('PUT', `/admin/whatsapp/templates/${d.id}`, { change: { source: EN_OFFER_IMG }, baseVersion: d.version, actor: admin });
    assertEqual(saved.status, 200, saved.text);
    assert(saved.body.template.checks.ok, `checks pass with a sample: ${JSON.stringify(saved.body.template.checks.issues)}`);
    fetched.length = 0;
    s = await post(`/admin/whatsapp/templates/${d.id}/submit`, { baseVersion: saved.body.template.version });
    assertEqual([s.status, s.body.outcome], [200, 'submitted'], `submit ${s.text}`);
    assertEqual(fetched, [SAMPLE], 'the sample read once');
    const metaId = s.body.template.meta.id as string;
    const atMeta = (await db.collection(COL.sandboxWhatsAppTemplates).doc(metaId).get()).data() as AnyDoc;
    const components = JSON.parse(atMeta.componentsJson);
    assertEqual(components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: [`4::sandbox-jpeg-${jpeg(1200, 628).length}`] } }, 'the header with its handle, first');
    assertEqual(components.slice(1).map((c: AnyDoc) => c.type), ['BODY', 'FOOTER', 'BUTTONS'], 'then the rest');

    await approve(d.id);
    const t = (await api.call('GET', `/admin/whatsapp/templates/${d.id}`)).body.template;
    assertEqual([t.display, t.usable, t.checks.ok], ['approved', true, true], `approved, usable, clean: ${JSON.stringify(t.checks.issues)}`);
    assert(!t.checks.issues.some((i: AnyDoc) => i.code === 'T23' || i.code === 'T24'), 'no drift, no unhandled part');
    assertEqual(t.meta.otherComponents, ['HEADER:IMAGE'], "Meta's copy has the image header");
    assertEqual(t.unhandled, [], 'nothing unhandled');
    assertEqual(t.preview.header, { type: 'image', sample: SAMPLE }, 'the preview shows the sample');
  });

  await test('sends: no venue picture → the plain template; with one → the image template, the venue’s picture as the header', async () => {
    await fresh();
    await approved(EN_OFFER); // hf_welcome_offer_1
    await approved(EN_OFFER_IMG); // hf_welcome_offer_2
    const a = await welcomed(ukPhone());
    assert(a.s1 && a.ob, 'sent');
    assertEqual([a.s1.whatsapp?.name, a.ob.headerImage], ['hf_welcome_offer_1', null], 'no picture: the plain template');

    assertEqual((await putImage(VENUE_PIC)).status, 200, 'picture saved');
    clearCaches();
    const b = await welcomed(ukPhone());
    assert(b.s1 && b.ob, 'sent');
    assertEqual([b.s1.status, b.s1.whatsapp?.name, b.ob.headerImage], ['sent', 'hf_welcome_offer_2', { link: VENUE_PIC }], 'the image template with the venue’s picture');
  });

  await test('Meta can’t load the picture (131053): refused, the picture marked broken, the next guest gets the plain template; saving it again clears it', async () => {
    await fresh();
    await approved(EN_OFFER);
    await approved(EN_OFFER_IMG);
    const broken = `${CDN}/broken/front.jpg`;
    assertEqual((await putImage(broken)).status, 200, 'saved (the CDN answers)');
    clearCaches();
    const a = await welcomed(ukPhone());
    assertEqual([a.s1?.status, a.s1?.errorCode], ['failed', '131053'], `refused at send: ${JSON.stringify(a.s1 && { status: a.s1.status, code: a.s1.errorCode })}`);
    // The mark is written in the background: give it a moment.
    for (let i = 0; i < 20 && (await venuePicture())?.status !== 'broken'; i += 1) await new Promise((r) => setTimeout(r, 50));
    const pic = await venuePicture();
    assertEqual([pic?.status, /picture/.test(String(pic?.brokenReason))], ['broken', true], `marked broken: ${JSON.stringify(pic)}`);
    const view = await api.call('GET', `${V}/whatsapp-image`);
    assertEqual([view.body.image.status, Boolean(view.body.image.brokenReason)], ['broken', true], 'the owner sees it');

    clearCaches();
    const b = await welcomed(ukPhone());
    assert(b.s1 && b.ob, 'the next guest still gets WhatsApp');
    assertEqual([b.s1.whatsapp?.name, b.ob.headerImage], ['hf_welcome_offer_1', null], 'the plain template');

    const again = await putImage(VENUE_PIC);
    assertEqual([again.status, again.body.image.status], [200, 'ok'], 'saving a picture clears it');
  });

  await test('“See what guests get” and Send test: the image version with the venue’s picture; without one, the plain one', async () => {
    await fresh();
    await approved(EN_OFFER);
    await approved(EN_OFFER_IMG);
    await seedTestRecipients(W.tenant, [{ id: 'phone_me', kind: 'phone', value: '+41791239876' }]);
    const preview = () => api.call('POST', `${T}/setups/preview`, { slots: {}, playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'en', venueId: W.venueId });
    const waOf = (m: AnyDoc) => (m.versions ?? []).find((v: AnyDoc) => v.channel === 'whatsapp');

    let p = await preview();
    assertEqual(p.status, 200, p.text);
    let v = waOf(p.body.messages[0]);
    assertEqual([v.name, v.header ?? null], ['hf_welcome_offer_1', null], 'no picture: the plain version');

    await putImage(VENUE_PIC);
    clearCaches();
    p = await preview();
    v = waOf(p.body.messages[0]);
    assertEqual([v.name, v.header], ['hf_welcome_offer_2', { type: 'image', url: VENUE_PIC }], 'the image version with the venue’s picture');

    const t = await api.call('POST', `${V}/test-send`, { journeyKey: A1, nodeId: 's1', channel: 'whatsapp', recipientId: 'phone_me', actor: OWNER_ACTOR });
    assertEqual([t.status, t.body.sent, t.body.variant], [200, true, 'hf_welcome_offer_2'], `test send: ${t.text}`);
    assertEqual(t.body.preview.header, { type: 'image', url: VENUE_PIC, isSample: false }, 'the test preview says which picture');
    const ob = (await outbox()).find((o) => o.templateName === 'hf_welcome_offer_2' && o.to === '+41791239876');
    assertEqual(ob?.headerImage, { link: VENUE_PIC }, 'the test carried the picture');
  });

  await test("unhandledParts: Meta's image header is ours only when our text has one", async () => {
    const meta = { headerText: null, otherComponents: ['HEADER:IMAGE'], buttons: [] };
    assertEqual(unhandledParts(meta, true), ['a header with image'], 'without ours: unhandled (T24)');
    assertEqual(unhandledParts(meta, true, true), [], 'ours: handled');
    assertEqual(unhandledParts({ ...meta, otherComponents: ['HEADER:VIDEO'] }, true, true), ['a header with video'], 'a video header never is');
  });

  __setImageFetchForTests(null);
  await api.close?.();
  done();
}

void main();
