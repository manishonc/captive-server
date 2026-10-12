/**
 * PR W3 — journeys send WhatsApp (their approved templates), on the emulator with the sandbox Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 * The guests here have only a UK number (+44 — not an SMS country) and no email, so the welcome
 * (ladder SMS → email → WhatsApp) can only go by WhatsApp.
 *
 *  - Off (the default): WhatsApp is never used — `whatsapp_off` in the "why"; the stored switch reads
 *    missing / bad as off.
 *  - On: the approved template goes out — name, language, the values in {{n}} order, the offer
 *    button's own short link (`s/<code>`, channel whatsapp) — charged 12 credits once; the record
 *    names the template; a German guest gets the German template, else the English one.
 *  - Meta's statuses: delivered, read (= opened), repeats count once; failed → the credits come back
 *    (one `adjustment`, the daily numbers too) and 131049 / 131026 / 131050 hold or STOP the number;
 *    a refusal at send time (sandbox 0000 = 131026) is never charged and holds the number.
 *  - An SMS STOP ends WhatsApp marketing (W3-D1); an inbound WhatsApp STOP blocks WhatsApp (START
 *    lifts it — sandbox only, no signature); an unverified number never gets WhatsApp.
 *  - A test run names the template and sends nothing.
 *  - The webhook route: statuses and STOPs reach Adaptive; a message notice stamps `messagesSeenAt`.
 *  - The launch switch: refused until the worker has the keys, Meta's notices arrive and a template is
 *    approved; then only with WHATSAPP ON; off is one click; the owner screens see `sendingChannels`.
 *  - Review round: a refund doesn't need the debit's id on the send (a charge that died half-way); a
 *    "failed" is never charged afterwards; after an SMS STOP the owner's WhatsApp chip reads "no"; a
 *    read WhatsApp welcome's "same channel" follow-up never repeats the only template.
 *  - Verification round: any later charge call finishes an interrupted refund; a failed send never
 *    charged still comes off the daily numbers; the owner's timeline has no bookkeeping line; a STOP
 *    from Meta's WhatsApp id reaches the number we sent to (Mexico's +521…).
 *  - Delta round: a STOP from that id before the first send is carried to the number after it; WhatsApp's
 *    own rule (unverified) wins over "no template"; the owner's stop keeps the guest's WhatsApp yes for
 *    info messages.
 */

import express from 'express';
import type { AddressInfo } from 'net';
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
  ledger,
  nextTuesday1240,
  now,
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
import { ADMIN_ACTOR, clearEngineStatus, mountApi, seedWorkerHeartbeat, type Api } from './ownerApiHelpers';
import { CONFIG_DOC_ID, WHATSAPP_DOC_ID } from '../../src/adaptive/store/collections';
import { runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache, __resetMessagesSeen } from '../../src/adaptive/whatsapp/hints';
import { STOP_LINES } from '../../src/adaptive/send/compose';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { adaptiveOnInboundWhatsApp, adaptiveOnWhatsAppStatus } from '../../src/adaptive/ingest/signals';
import { chargeSend } from '../../src/adaptive/send/dispatch';
import { guestSaidYes } from '../../src/adaptive/identity/resolve';
import { applyPhoneStart, applyPhoneStop } from '../../src/adaptive/engine/optouts';
import { contactPointId } from '../../src/adaptive/identity/key';
import { parseEngineSettings, whatsappSendingOn } from '../../src/adaptive/store/engineSettings';
import whatsappWebhookRoutes from '../../src/routes/whatsappWebhook';

const W: VenueFixture = { tenant: 'tenant_w3', venueId: 'venue_w3', apId: 'ap_w3', apMac: 'aa:bb:cc:dd:ee:83' };
const A1 = 'welcome_second_visit';
const CODE = /^s\/[a-z2-9]{8}$/;

const EN_OFFER = {
  body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}}! Come back within {{offer.days | default:"14"}} days for {{offer.label | default:"a surprise"}}.',
  footer: STOP_LINES.en,
  button: { text: 'See your offer', field: 'link.offer' },
};
const DE_OFFER = {
  body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days | default:"14"}} Tagen wieder – dann wartet {{offer.label | default:"eine Überraschung"}} auf dich.',
  footer: STOP_LINES.de,
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};

let n = 100;
/** A fresh UK mobile number, 10 digits (not an SMS country here); `end` picks a sandbox answer (0000 = 131026). */
function ukPhone(end?: string): string {
  n += 1;
  return end ? `77009${n % 10}${end}` : `77009${String(n).padStart(5, '0')}`;
}

async function main() {
  const api = await mountApi();
  const admin = { ...ADMIN_ACTOR, uid: 'heidifi_admin_w3' };
  const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor: admin });

  async function fresh(opts: { mode?: 'live' | 'test'; whatsapp?: 'on' | 'off' } = {}): Promise<void> {
    await resetEmulator();
    __clearHintCache();
    __resetMessagesSeen();
    await seedCatalogue();
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test' });
    await setupVenue(W);
    await withoutReviewAsk(W);
    await setClock(nextTuesday1240());
    await seedWallet(W.tenant, 5000);
    await setLaunch({ [W.tenant]: opts.mode ?? 'live' }, { paused: false });
    if (opts.whatsapp) await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ whatsappSending: { mode: opts.whatsapp } });
    clearCaches();
  }

  let checks = 0;
  /** Connect the sandbox Meta, write a template and have Meta approve it. */
  async function approved(poolKey: string, lang: string, source: unknown, name?: string): Promise<string> {
    // The check is rate-limited per admin: a new admin each time.
    checks += 1;
    const c = await api.call('POST', '/admin/whatsapp/connection/check', { actor: { ...admin, uid: `heidifi_admin_w3_${checks}` } });
    assertEqual(c.status, 200, `connection ${c.text}`);
    const d = await post('/admin/whatsapp/templates', { use: { journeyKey: A1, poolKey }, lang, category: 'MARKETING', source, ...(name ? { name } : {}) });
    assertEqual(d.status, 200, `draft ${d.text}`);
    const id = d.body.template.id as string;
    const s = await post(`/admin/whatsapp/templates/${id}/submit`, { baseVersion: d.body.template.version });
    assertEqual([s.status, s.body.outcome], [200, 'submitted'], `submit ${s.text}`);
    const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision: 'APPROVED' });
    assertEqual(r.status, 200, `review ${r.text}`);
    await runWhatsAppTemplateTick();
    clearCaches();
    return id;
  }

  /** A guest with only a UK number connects; the welcome's first step runs 15 minutes later. */
  async function welcomed(c: { phone: string; language?: string; verified?: boolean; firstName?: string; beforeSend?: (guestId: string) => Promise<void> }) {
    const guestId = await connect({ venue: W, firstName: c.firstName ?? 'Anna', phone: c.phone, phoneCountryCode: '+44', phoneVerified: c.verified ?? true, consent: true, language: c.language ?? 'en' });
    await runDue();
    if (c.beforeSend) await c.beforeSend(guestId);
    await advance(15 * MINUTE_MS);
    await runDue();
    const contactId = await contactIdFor(W.tenant, guestId);
    const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1);
    assert(inst, `no welcome journey for ${guestId}`);
    const key = sendKeyFor(inst.id, 's1');
    const snap = await db.collection(COL.journeySends).doc(key).get();
    const s1 = snap.exists ? ({ ...(snap.data() as Record<string, any>), id: key } as AnyDoc) : null;
    const events = (await docsWhere(COL.journeyEvents, 'instanceId', inst.id)).filter((e) => e.nodeId === 's1');
    return { guestId, contactId, inst, s1, events, pointId: contactPointId('phone', `+44${c.phone.replace(/^0/, '')}`) };
  }

  /** Why WhatsApp wasn't used for s1 (the skipped send's decision). */
  function waReason(events: AnyDoc[]): string | null {
    const skipped = events.find((e) => e.type === 'send.skipped' || e.type === 'send.blocked');
    const rejected = (skipped?.data?.decision?.channel?.rejected ?? []) as Array<{ channel: string; reason: string }>;
    return rejected.find((r) => r.channel === 'whatsapp')?.reason ?? null;
  }

  async function status(wamid: string, value: string, errorCode: string | null = null): Promise<void> {
    await adaptiveOnWhatsAppStatus({ wamid, status: value, errorCode });
    await runDue();
  }

  const point = async (id: string) => (await db.collection(COL.contactPoints).doc(id).get()).data() as Record<string, any>;
  const sendOf = async (id: string) => (await db.collection(COL.journeySends).doc(id).get()).data() as Record<string, any>;

  console.log('\nWhatsApp sending (PR W3)\n');

  await test('off (the default): WhatsApp is never used — `whatsapp_off` in the why; the stored switch reads missing or bad as off', async () => {
    await fresh();
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    assertEqual(g.s1, null, 'nothing sent');
    assertEqual(waReason(g.events), 'whatsapp_off', 'the switch is the reason');
    assertEqual((await outbox()).length, 0, 'empty outbox');
    assertEqual(
      [undefined, {}, { whatsappSending: { mode: 'ON' } }, { whatsappSending: true }, { whatsappSending: { mode: 'on' } }].map((d) => whatsappSendingOn(parseEngineSettings(d as Record<string, unknown> | undefined))),
      [false, false, false, false, true],
      'only a stored "on" is on',
    );
  });

  await test('on: the approved template goes by WhatsApp — values in order, the offer button’s short link, 12 credits once, the record names it', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const phone = ukPhone();
    const g = await welcomed({ phone });
    const s1 = g.s1;
    assert(s1, `a send record (why: ${waReason(g.events)})`);
    assertEqual([s1.status, s1.mode, s1.channel, s1.provider], ['sent', 'live', 'whatsapp', 'sandbox'], 'sent live by WhatsApp');
    assertEqual([s1.variantId, s1.whatsapp?.name, s1.whatsapp?.language, s1.locale], ['wa:hf_welcome_offer_1:en', 'hf_welcome_offer_1', 'en', 'en'], 'the template');
    assertEqual([s1.credits?.amount, s1.credits?.ledgerId, s1.smsSegments], [12, `debit_auto_${s1.id}`, null], 'priced flat, charged');
    const ob = (await outbox()).find((o) => o.id === s1.id);
    assert(ob, 'in the sandbox outbox');
    assertEqual([ob.channel, ob.templateName, ob.language, ob.to], ['whatsapp', 'hf_welcome_offer_1', 'en', `+44${phone}`], 'the template message');
    assertEqual(ob.bodyParams, ['Anna', `Venue ${W.venueId}`, '14', 'a free dessert'], 'values in {{n}} order');
    assert(ob.button && ob.button.index === 0 && CODE.test(ob.button.param), `the button’s variable: ${JSON.stringify(ob.button)}`);
    assert(String(ob.text).startsWith('Hi Anna, thanks for visiting Venue venue_w3!') && String(ob.text).endsWith(STOP_LINES.en), `the text: ${ob.text}`);
    const code = String(ob.button.param).slice(2);
    assertEqual(s1.shortCodes, [code], 'the record keeps the code');
    const link = (await db.collection('CaptivePortal_ShortLinks').doc(code).get()).data() as Record<string, any>;
    assert(link && link.channel === 'whatsapp' && link.sendKey === s1.id && String(link.targetUrl).includes(`/${W.venueId}/offer?s=${code}`), `the offer link: ${JSON.stringify(link)}`);
    const debits = (await ledger(W.tenant)).filter((e) => e.type === 'debit');
    assertEqual(debits.map((e) => [e.id, e.credits, e.channel]), [[`debit_auto_${s1.id}`, -12, 'whatsapp']], 'one debit');
  });

  await test('languages: a German guest gets the German template when it is approved, else the English one', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const a = await welcomed({ phone: ukPhone(), language: 'de', firstName: 'Jonas' });
    assert(a.s1, 'sent');
    assertEqual([a.s1.whatsapp?.name, a.s1.whatsapp?.language, a.s1.locale], ['hf_welcome_offer_1', 'en', 'en'], 'only English approved → English');
    assert(String(a.s1.decision?.variant?.method).includes('en_fallback'), `the decision says so: ${a.s1.decision?.variant?.method}`);
    await approved('welcome_offer', 'de', DE_OFFER);
    const b = await welcomed({ phone: ukPhone(), language: 'de', firstName: 'Lea' });
    assert(b.s1, 'sent');
    assertEqual([b.s1.whatsapp?.language, b.s1.locale], ['de', 'de'], 'the German template');
    const ob = (await outbox()).find((o) => o.id === b.s1!.id)!;
    assertEqual(ob.bodyParams.slice(0, 2), ['Lea', `Venue ${W.venueId}`], 'German values');
  });

  await test('Meta’s statuses: delivered, read (= opened); a repeat counts once', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const wamid = g.s1!.providerMessageId as string;
    assert(wamid.startsWith('wamid.'), `a wamid: ${wamid}`);
    await status(wamid, 'delivered');
    let s = await sendOf(g.s1!.id);
    assert(s.status === 'delivered' && s.engagement?.deliveredAt, `delivered: ${s.status}`);
    await status(wamid, 'read');
    await status(wamid, 'read');
    s = await sendOf(g.s1!.id);
    assert(s.engagement?.openedAt, 'opened');
    const contact = (await db.collection(COL.contacts).doc(g.contactId).get()).data() as Record<string, any>;
    assertEqual(contact.engagement?.opens, 1, 'one open for the guest');
    await status('wamid.someone-else', 'delivered'); // a Marketing-tab message: not ours, nothing happens
  });

  await test('failed 131049: the credits come back once (an adjustment; the daily numbers too) and WhatsApp marketing waits 24 h for the number', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const before = Number((await db.collection(COL.creditWallets).doc(W.tenant).get()).get('balance'));
    await status(g.s1!.providerMessageId, 'failed', '131049');
    await status(g.s1!.providerMessageId, 'failed', '131049');
    const s = await sendOf(g.s1!.id);
    assertEqual([s.status, s.errorCode, s.credits?.refundLedgerId], ['failed', '131049', `refund_auto_${g.s1!.id}`], 'failed, refunded');
    const refunds = (await ledger(W.tenant)).filter((e) => e.id.startsWith('refund_auto_'));
    assertEqual(refunds.map((e) => [e.type, e.credits, e.sendId]), [['adjustment', 12, g.s1!.id]], 'one refund entry');
    assertEqual(Number((await db.collection(COL.creditWallets).doc(W.tenant).get()).get('balance')), before + 12, 'the wallet got them back');
    const refunded = await db.collection(COL.journeyEvents).where('sendKey', '==', g.s1!.id).where('type', '==', 'credits.refunded').get();
    assertEqual(refunded.size, 1, 'one credits.refunded event (the daily numbers subtract it)');
    const p = await point(g.pointId);
    const until = p.whatsappLimitedUntil?.toMillis?.() ?? 0;
    assert(Math.abs(until - (now() + 24 * HOUR_MS)) < 5 * MINUTE_MS, `held 24 h: ${new Date(until).toISOString()}`);
  });

  await test('failed 131026 → no WhatsApp for 30 days; 131050 → a WhatsApp STOP (block + consent taken back)', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const a = await welcomed({ phone: ukPhone() });
    await status(a.s1!.providerMessageId, 'failed', '131026');
    const until = (await point(a.pointId)).whatsappUnreachableUntil?.toMillis?.() ?? 0;
    assert(Math.abs(until - (now() + 30 * DAY_MS)) < 5 * MINUTE_MS, `held 30 days: ${new Date(until).toISOString()}`);
    const b = await welcomed({ phone: ukPhone() });
    await status(b.s1!.providerMessageId, 'failed', '131050');
    const p = await point(b.pointId);
    assertEqual([p.suppression?.whatsapp?.reason, p.suppression?.whatsapp?.source], ['stop', 'meta_stop'], 'WhatsApp STOP');
    const c = (await db.collection(COL.contacts).doc(b.contactId).get()).data() as Record<string, any>;
    assertEqual(c.marketingConsent?.[`venue:${W.venueId}`]?.whatsapp?.state, 'revoked', 'WhatsApp consent taken back');
    assertEqual(c.marketingConsent?.[`venue:${W.venueId}`]?.sms?.state, 'granted', 'SMS untouched');
  });

  await test('refused at send time (sandbox 0000 = 131026): failed, never charged, the number held 30 days', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone('0000') });
    assertEqual([g.s1?.status, g.s1?.errorCode, g.s1?.credits?.ledgerId], ['failed', '131026', null], 'failed, not charged');
    assertEqual((await ledger(W.tenant)).filter((e) => e.type === 'debit').length, 0, 'no debit');
    assert((await point(g.pointId)).whatsappUnreachableUntil, 'held');
  });

  await test('an SMS STOP ends WhatsApp marketing (W3-D1); an inbound WhatsApp STOP blocks WhatsApp, START (sandbox) lifts it; an unverified number never gets WhatsApp', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    // The STOPs reach us between the connect and the welcome.
    const phone2 = ukPhone();
    const smsStop = await welcomed({ phone: phone2, beforeSend: async () => void (await applyPhoneStop(contactPointId('phone', `+44${phone2}`), 'sms_keyword', now())) });
    assertEqual([smsStop.s1, waReason(smsStop.events)], [null, 'blocked:sms_stop'], 'an SMS STOP blocks WhatsApp marketing');

    const phone3 = ukPhone();
    const waStop = await welcomed({
      phone: phone3,
      beforeSend: async () => {
        await adaptiveOnInboundWhatsApp({ from: `44${phone3}`, kind: 'stop', messageId: 'wamid.in.stop.1' });
        await runDue();
      },
    });
    assertEqual([waStop.s1, waReason(waStop.events)], [null, 'consent_revoked'], 'a WhatsApp STOP takes the consent back');
    assertEqual((await point(waStop.pointId)).suppression?.whatsapp?.source, 'whatsapp_keyword', 'and blocks the number');
    await advance(MINUTE_MS);
    await adaptiveOnInboundWhatsApp({ from: `44${phone3}`, kind: 'start', messageId: 'wamid.in.start.1' });
    await runDue();
    assertEqual((await point(waStop.pointId)).suppression?.whatsapp, undefined, 'START lifts the block (sandbox)');

    const unverified = await welcomed({ phone: ukPhone(), verified: false });
    assertEqual([unverified.s1, waReason(unverified.events)], [null, 'whatsapp_unverified'], 'a verified number only (WhatsApp’s rule, not the owner’s audience)');
  });

  await test('a test run names the template and sends nothing (no outbox, no credits)', async () => {
    await fresh({ mode: 'test', whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    assertEqual([g.s1?.status, g.s1?.channel, g.s1?.whatsapp?.name, g.s1?.provider], ['dry_run', 'whatsapp', 'hf_welcome_offer_1', null], 'a dry run by WhatsApp');
    assert(String(g.s1?.content?.preview).includes('Anna'), 'the preview');
    assertEqual([(await outbox()).length, (await ledger(W.tenant)).length], [0, 0], 'nothing sent or charged');
  });

  await test('the webhook route: statuses and STOPs reach Adaptive; any message notice stamps messagesSeenAt', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const app = express();
    app.use(express.json());
    app.use('/webhook/whatsapp', whatsappWebhookRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/whatsapp`;
    try {
      const body = {
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba', changes: [{ field: 'messages', value: { statuses: [{ id: g.s1!.providerMessageId, status: 'failed', errors: [{ code: 131049, title: 'held back' }] }] } }] }],
      };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assertEqual(res.status, 200, 'acknowledged');
      // The hooks run after the reply.
      for (let i = 0; i < 50; i += 1) {
        const ev = await db.collection(COL.journeyEvents).where('sendKey', '==', g.s1!.id).where('type', '==', 'message.failed').get();
        if (!ev.empty) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await runDue();
      assertEqual((await sendOf(g.s1!.id)).status, 'failed', 'the status reached the send');
      const seen = (await db.collection(COL.config).doc(WHATSAPP_DOC_ID).get()).get('messagesSeenAt');
      assert(seen, 'messagesSeenAt stamped');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  await test('the launch switch: refused until the worker has the keys, Meta’s notices arrive and a template is approved; then WHATSAPP ON; off in one click', async () => {
    await fresh();
    await clearEngineStatus();
    const launch = async () => (await api.get('/admin/launch')).body;
    const put = (change: Record<string, unknown>, confirm?: string, version?: number) => api.call('PUT', '/admin/launch', { change, baseVersion: version, ...(confirm ? { confirm } : {}), actor: admin });

    let l = await launch();
    assertEqual(l.whatsappSending.mode, 'off', 'off');
    assertEqual(l.whatsappSending.checks.map((c: any) => [c.key, c.ok]), [['worker_keys', false], ['meta_notices', false], ['approved_template', false]], 'nothing ready');
    let r = await put({ whatsappSending: { mode: 'on' } }, 'WHATSAPP ON', l.version);
    assertEqual([r.status, r.body?.code], [409, 'whatsapp_not_ready'], `refused: ${r.text}`);
    assert(JSON.stringify(r.body).includes('No adaptive-worker is running'), 'says why');

    await seedWorkerHeartbeat({ channels: { email: true, sms: true, whatsapp: false } });
    l = await launch();
    assert(l.whatsappSending.checks[0].text.includes('no WhatsApp keys'), `the worker without keys: ${l.whatsappSending.checks[0].text}`);
    await seedWorkerHeartbeat({ channels: { email: true, sms: true, whatsapp: true } });
    await db.collection(COL.config).doc(WHATSAPP_DOC_ID).set({ messagesSeenAt: new Date() }, { merge: true });
    await approved('welcome_offer', 'en', EN_OFFER);
    l = await launch();
    assertEqual(l.whatsappSending.checks.map((c: any) => c.ok), [true, true, true], `all ready: ${JSON.stringify(l.whatsappSending.checks)}`);

    const check = await api.call('POST', '/admin/launch/check', { change: { whatsappSending: { mode: 'on' } }, actor: admin });
    assertEqual([check.status, check.body.summary.confirmPhrase, check.body.blockers], [200, 'WHATSAPP ON', []], `check: ${check.text}`);
    r = await put({ whatsappSending: { mode: 'on' } }, undefined, l.version);
    assertEqual(r.status, 400, `the phrase is needed: ${r.text}`);
    r = await put({ whatsappSending: { mode: 'on' } }, 'whatsapp on', l.version);
    assertEqual(r.status, 200, `on: ${r.text}`);
    l = await launch();
    assertEqual([l.whatsappSending.mode, l.whatsappSending.changedBy], ['on', admin.uid], 'on, by the admin');
    const logRows = await docsWhere('CaptivePortal_WhatsAppLog', 'kind', 'settings.sending_changed');
    assertEqual(logRows.length, 1, 'the WhatsApp log says so');
    const owner = await api.get(`/tenants/${W.tenant}/overview`);
    assertEqual(owner.body.sendingChannels, ['sms', 'email', 'whatsapp'], `the owner screens see it: ${owner.text.slice(0, 200)}`);

    r = await put({ whatsappSending: { mode: 'off' } }, undefined, l.version);
    assertEqual(r.status, 200, `off without a phrase: ${r.text}`);
    clearCaches();
    assertEqual((await api.get(`/tenants/${W.tenant}/overview`)).body.sendingChannels, ['sms', 'email'], 'off again');
  });

  console.log('\nReview round (PR W3)\n');

  await test('refund without the debit’s id on the send (the charge died half-way); a failed send is never charged afterwards', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const key = g.s1!.id;
    // The debit committed, its id never reached the send (the worker died in between).
    await db.collection(COL.journeySends).doc(key).update({ 'credits.ledgerId': null });
    const before = Number((await db.collection(COL.creditWallets).doc(W.tenant).get()).get('balance'));
    await status(g.s1!.providerMessageId, 'failed', '131026');
    const s = await sendOf(key);
    assertEqual([s.status, s.credits?.refundLedgerId], ['failed', `refund_auto_${key}`], 'refunded from the debit itself');
    assertEqual(Number((await db.collection(COL.creditWallets).doc(W.tenant).get()).get('balance')), before + 12, 'given back');
    // The charge repair comes later: nothing (the send failed), no second debit.
    assertEqual(await chargeSend(key), 'nothing', 'never charged again');
    assertEqual((await ledger(W.tenant)).filter((e) => e.type === 'debit').length, 1, 'one debit, one refund');
  });

  await test('after an SMS STOP the owner sees WhatsApp as "no" too (the engine won’t send it marketing); a START gives it back', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const phone = ukPhone();
    const g = await welcomed({ phone });
    const chips = async () => {
      const r = await api.get(`/tenants/${W.tenant}/venues/${W.venueId}/guests`);
      assertEqual(r.status, 200, r.text);
      return (r.body.guests as any[]).find((x) => x.contactId === g.contactId)?.consent;
    };
    assertEqual([(await chips()).sms.state, (await chips()).whatsapp.state], ['yes', 'yes'], 'both yes');
    await applyPhoneStop(g.pointId, 'sms_keyword', now());
    const after = await chips();
    assertEqual([after.sms.state, after.whatsapp.state], ['no', 'no'], 'SMS STOP: WhatsApp reads no');
    await applyPhoneStart(g.pointId, now() + MINUTE_MS);
    const back = await chips();
    assertEqual([back.sms.state, back.whatsapp.state], ['yes', 'yes'], 'START: both yes again');
  });

  await test('a read WhatsApp welcome: the "same channel" follow-up never repeats the only template (WhatsApp has no other wording, the step is skipped)', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    await status(g.s1!.providerMessageId, 'read');
    // s2_same waits for the evening slot.
    for (let i = 0; i < 6; i += 1) {
      await advance(2 * HOUR_MS);
      await runDue();
    }
    const key = sendKeyFor(g.inst.id, 's2_same');
    assertEqual((await db.collection(COL.journeySends).doc(key).get()).exists, false, 'no second send of the same template');
    const evs = (await docsWhere(COL.journeyEvents, 'instanceId', g.inst.id)).filter((e) => e.nodeId === 's2_same');
    const rejected = (evs.find((e) => e.type === 'send.skipped')?.data?.decision?.channel?.rejected ?? []) as Array<{ channel: string; reason: string }>;
    assertEqual(rejected.find((r) => r.channel === 'whatsapp')?.reason, 'no_wording', `WhatsApp had nothing new to say: ${JSON.stringify(evs.map((e) => e.type))}`);
    assertEqual((await outbox()).filter((o) => o.channel === 'whatsapp').length, 1, 'one WhatsApp message in all');
  });

  await test('a "failed" for a message we can’t find is looked up once more, then dropped quietly', async () => {
    await fresh({ whatsapp: 'on' });
    await adaptiveOnWhatsAppStatus({ wamid: 'wamid.not-ours', status: 'failed', errorCode: '131049' }, { retryMs: 20 });
    assertEqual((await db.collection(COL.journeyEvents).where('type', '==', 'message.failed').get()).size, 0, 'nothing written');
  });

  console.log('\nVerification round (PR W3)\n');

  await test('an interrupted refund is finished by the next charge call (repair, resume, delivery): once', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const key = g.s1!.id;
    // Meta's "failed" was recorded, but its refund never ran (the worker died right after).
    await db.collection(COL.journeySends).doc(key).update({ status: 'failed', errorCode: '131026' });
    assertEqual(await chargeSend(key), 'nothing', 'the repair charges nothing…');
    assertEqual(await chargeSend(key), 'nothing', '…twice');
    const entries = await ledger(W.tenant);
    assertEqual([entries.filter((e) => e.type === 'debit').length, entries.filter((e) => e.id === `refund_auto_${key}`).length], [1, 1], '…and refunds once');
    assertEqual((await sendOf(key)).credits?.refundLedgerId, `refund_auto_${key}`, 'marked');
  });

  await test('a failed send that was never charged still comes off the daily numbers (credits.refunded, notCharged)', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    const key = g.s1!.id;
    // As if the charge never happened (it threw, the repair is still queued).
    await db.collection(COL.creditWallets).doc(W.tenant).collection('ledger').doc(`debit_auto_${key}`).delete();
    await db.collection(COL.journeySends).doc(key).update({ 'credits.ledgerId': null });
    await status(g.s1!.providerMessageId, 'failed', '131049');
    const ev = await db.collection(COL.journeyEvents).where('sendKey', '==', key).where('type', '==', 'credits.refunded').get();
    assertEqual([ev.size, ev.docs[0]?.get('data.notCharged'), ev.docs[0]?.get('data.credits')], [1, true, 12], 'taken off once');
    assertEqual((await ledger(W.tenant)).filter((e) => e.id.startsWith('refund_auto_')).length, 0, 'nothing to give back');
    assertEqual(await chargeSend(key), 'nothing', 'never charged afterwards');
    assertEqual((await ledger(W.tenant)).length, 0, 'the ledger stays empty');
  });

  await test('the owner’s guest timeline: the failed WhatsApp line, no bookkeeping line for the refund', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone() });
    await status(g.s1!.providerMessageId, 'failed', '131026');
    const r = await api.get(`/tenants/${W.tenant}/venues/${W.venueId}/guests/${g.contactId}`);
    assertEqual(r.status, 200, r.text);
    const sentences = (r.body.timeline as Array<{ sentence: string }>).map((i) => i.sentence);
    assert(sentences.some((x) => x.includes("this number can't get WhatsApp messages") && x.includes('No credits are charged')), `the failed line: ${sentences.join(' | ')}`);
    assert(!sentences.includes('Something else happened.'), `no unknown line: ${sentences.join(' | ')}`);
  });

  await test('the "same channel" follow-up never repeats the last template in another language either (de approved after an en welcome)', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const g = await welcomed({ phone: ukPhone(), language: 'de', firstName: 'Jonas' });
    assertEqual(g.s1?.whatsapp?.language, 'en', 'the welcome went in English');
    // The German translation of the same template (same name).
    await approved('welcome_offer', 'de', DE_OFFER, 'hf_welcome_offer_1');
    await status(g.s1!.providerMessageId, 'read');
    for (let i = 0; i < 6; i += 1) {
      await advance(2 * HOUR_MS);
      await runDue();
    }
    const s2 = await db.collection(COL.journeySends).doc(sendKeyFor(g.inst.id, 's2_same')).get();
    assertEqual(s2.exists, false, `no German copy of the same message: ${JSON.stringify(s2.exists ? { ch: s2.get('channel'), v: s2.get('variantId'), st: s2.get('status'), last: (await db.collection(COL.journeyInstances).doc(g.inst.id).get()).get('lastTouch') } : null)}`);
    assertEqual((await outbox()).filter((o) => o.channel === 'whatsapp').length, 1, 'one WhatsApp message in all');
  });

  await test('a STOP from Meta’s WhatsApp id reaches the number we sent to (Mexico: sent to +52…, Meta’s id +521…)', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    const guestId = await connect({ venue: W, firstName: 'Lucía', phone: '5512345678', phoneCountryCode: '+52', phoneVerified: true, consent: true, language: 'en' });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const pointId = contactPointId('phone', '+525512345678');
    const sent = (await outbox()).filter((o) => o.channel === 'whatsapp');
    assertEqual(sent.length, 1, `sent by WhatsApp (guest ${guestId})`);
    assertEqual((await point(pointId)).whatsappWaIdOf, contactPointId('phone', '+5215512345678'), 'the WhatsApp id is remembered (hashed)');
    await adaptiveOnInboundWhatsApp({ from: '5215512345678', kind: 'stop', messageId: 'wamid.in.mx.1' });
    await runDue();
    assertEqual((await point(pointId)).suppression?.whatsapp?.reason, 'stop', 'the number we send to is blocked');
  });

  console.log('\nDelta round (PR W3)\n');

  await test('a STOP from Meta’s WhatsApp id before our first send is carried to the number once the id is known', async () => {
    await fresh({ whatsapp: 'on' });
    await approved('welcome_offer', 'en', EN_OFFER);
    await adaptiveOnInboundWhatsApp({ from: '5215598765432', kind: 'stop', messageId: 'wamid.in.mx.early' });
    await runDue();
    await connect({ venue: W, firstName: 'Diego', phone: '5598765432', phoneCountryCode: '+52', phoneVerified: true, consent: true, language: 'en' });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const p = await point(contactPointId('phone', '+525598765432'));
    assertEqual([p.whatsappWaIdOf, p.suppression?.whatsapp?.reason], [contactPointId('phone', '+5215598765432'), 'stop'], 'linked, and the earlier STOP now blocks the number');
  });

  await test('WhatsApp’s own rule wins over "no template": an unverified number reads whatsapp_unverified, not no_wording', async () => {
    await fresh({ whatsapp: 'on' });
    const g = await welcomed({ phone: ukPhone(), verified: false });
    assertEqual([g.s1, waReason(g.events)], [null, 'whatsapp_unverified'], 'its own reason');
    const v = await welcomed({ phone: ukPhone() });
    assertEqual([v.s1, waReason(v.events)], [null, 'no_wording'], 'a verified guest: there is no template');
  });

  await test('the owner’s stop keeps the guest’s WhatsApp yes for info messages (marketing stays stopped)', async () => {
    const t = new Date();
    assertEqual(guestSaidYes({ state: 'granted', at: t, eventId: 'e' }), true, 'yes');
    assertEqual(guestSaidYes({ state: 'revoked', at: t, eventId: 'e', revokedVia: 'owner', ownerStopped: true, ownerPrior: 'granted' }), true, 'owner stop after a yes');
    assertEqual(guestSaidYes({ state: 'revoked', at: t, eventId: 'e', revokedVia: 'owner', ownerStopped: true, ownerPrior: 'none' }), false, 'owner stop without a yes');
    assertEqual(guestSaidYes({ state: 'revoked', at: t, eventId: 'e', revokedVia: 'channel', source: 'whatsapp_keyword' }), false, 'the guest’s STOP');
    assertEqual(guestSaidYes(undefined), false, 'no answer');
  });

  await api.close();
  done();
}

void main();
