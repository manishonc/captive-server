/**
 * PR B — real sending, on the emulator with the sandbox provider (the same
 * adapter contract as Brevo / Twilio; nothing leaves the machine).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - A live SMS: real short links, the STOP line in the guest's language, priced
 *    on exactly the text sent, charged once (debit_auto_{sendKey}).
 *  - Signals: delivered, clicks (favourite channel), opens, bounces, spam, the
 *    unsubscribe link, STOP / START, replies (one "not monitored" notice) —
 *    replayed and out of order they count once.
 *  - Provider answers: 21610 blocks the number, unknown is never resent or
 *    charged, "try later" gives up after 3 attempts; a worker that died mid-send
 *    never sends twice; an accepted send is charged on repair.
 *  - The ladder skips a channel without a provider; the owner's "verified only".
 *  - Credits: an empty wallet holds the send, quiet hours don't restart the wait.
 *  - Low ratings, the sign-up breaker, the webhook routes' replies unchanged.
 *  - Restart, live: every guest gets exactly one email and one charge.
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
  runUntil,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setSafety,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { AdaptiveWorker } from '../../src/adaptive/worker/worker';
import { claimDue, reclaimExpiredLeases } from '../../src/adaptive/queue/firestoreQueue';
import { sendKeyFor, eventIdFor } from '../../src/adaptive/core/runtime/ids';
import { HOUR_MS, MINUTE_MS, DAY_MS } from '../../src/adaptive/core/runtime/time';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { channelAdapters } from '../../src/adaptive/engine/sendPath';
import { registerAdapters } from '../../src/adaptive/send/adapters';
import { adaptiveOnInboundSms, adaptiveOnTwilioStatus } from '../../src/adaptive/ingest/signals';
import { applyPhoneStart, applyPhoneStop } from '../../src/adaptive/engine/optouts';
import { deliverEvent } from '../../src/adaptive/engine/advance';
import { readEngineSettings } from '../../src/adaptive/store/engineSettings';
import { explainDecision } from '../../src/adaptive/core/runtime/decision';
import { contactPointId } from '../../src/adaptive/identity/key';
import twilioInboundRoutes from '../../src/routes/twilioInbound';
import unsubscribeRoutes from '../../src/routes/unsubscribe';

const A: VenueFixture = { tenant: 'tenant_s', venueId: 'venue_s', apId: 'ap_s', apMac: 'aa:aa:aa:aa:aa:22' };
const LINK = /https:\/\/visit\.askheidi\.app\/s\/[a-z2-9]{8}/;

async function liveVenue(credits: number | null = 5000): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(A);
  const t0 = nextTuesday1240();
  await setClock(t0);
  if (credits !== null) await seedWallet(A.tenant, credits);
  await setLaunch({ [A.tenant]: 'live' }, { paused: false });
  return t0;
}

async function a1For(guestId: string): Promise<AnyDoc> {
  const contactId = await contactIdFor(A.tenant, guestId);
  const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === 'welcome_second_visit');
  if (!inst) throw new Error(`no welcome journey for ${guestId}`);
  return inst;
}

async function sendDoc(instanceId: string, nodeId: string): Promise<AnyDoc | null> {
  const key = sendKeyFor(instanceId, nodeId);
  const snap = await db.collection(COL.journeySends).doc(key).get();
  return snap.exists ? { ...(snap.data() as Record<string, any>), id: key } : null;
}

async function inst(id: string): Promise<AnyDoc> {
  return { ...((await db.collection(COL.journeyInstances).doc(id).get()).data() as Record<string, any>), id };
}

async function contactOf(guestId: string): Promise<AnyDoc> {
  const id = await contactIdFor(A.tenant, guestId);
  return { ...((await db.collection(COL.contacts).doc(id).get()).data() as Record<string, any>), id };
}

async function signal(sendKey: string, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  await devProviderEvent({ sendKey, event, ...extra });
  await runDue();
}

/** Guest connects now, the welcome goes 15 minutes later. */
async function welcomed(c: Parameters<typeof connect>[0]): Promise<{ guestId: string; inst: AnyDoc; s1: AnyDoc | null }> {
  const guestId = await connect(c);
  await runDue();
  await advance(15 * MINUTE_MS);
  await runDue();
  const i = await a1For(guestId);
  return { guestId, inst: i, s1: await sendDoc(i.id, 's1') };
}

async function main() {
  console.log('\nAdaptive sending (PR B) on the emulator\n');

  await test('live SMS: real links, the STOP line in German, priced on the text sent, charged once', async () => {
    await liveVenue();
    const { guestId, s1 } = await welcomed({ venue: A, firstName: 'Anna', email: 'anna@test.local', phone: '1512345678', phoneCountryCode: '+49', phoneVerified: true, consent: true, language: 'de' });
    assert(s1, 'a send record');
    assertEqual([s1.status, s1.mode, s1.channel, s1.provider], ['sent', 'live', 'sms', 'sandbox'], 'sent live by SMS');
    const ob = (await outbox()).find((o) => o.id === s1.id)!;
    assert(ob && String(ob.text ?? ob.body).includes('Antworte STOP zum Abmelden'), `German STOP line: ${ob?.text ?? ob?.body}`);
    assert(LINK.test(String(ob.text ?? ob.body)) && !String(ob.text ?? ob.body).includes('[offer link]'), 'a real short link');
    assertEqual(s1.credits.amount, 15 * s1.smsSegments, 'priced per segment of the text sent');
    assertEqual(ob.segments, s1.smsSegments, 'the provider saw the priced segments');
    const debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    assertEqual(debits.map((d) => [d.id, d.credits]), [[`debit_auto_${s1.id}`, -s1.credits.amount]], 'one ledger line');
    assertEqual(s1.credits.ledgerId, `debit_auto_${s1.id}`, 'the send points at it');
    const link = (await db.collection('CaptivePortal_ShortLinks').doc(s1.shortCodes[0]).get()).data()!;
    assertEqual([link.sendKind, link.sendKey, link.marketingDocId, link.journeyLink], ['journey', s1.id, s1.id, 'offer'], 'a journey link');
    assert(String(link.targetUrl).endsWith(`/${A.venueId}/offer?s=${s1.shortCodes[0]}`), `offer page target: ${link.targetUrl}`);
    assert(String(s1.content.preview).includes('[offer link]'), 'the stored preview keeps placeholders');
    const contact = await contactOf(guestId);
    const np = (await db.collection(COL.networkPeople).doc(contact.networkId).get()).data()!;
    assertEqual(np.recentMarketingTouches.map((t: any) => t.sendKey), [s1.id], 'one weekly touch');
    const cp = (await db.collection(COL.contactPoints).doc(contact.phonePointId).get()).data()!;
    assertEqual(cp.lastLiveSms.sendKey, s1.id, 'a reply can be matched to it');
    assert((await db.collection(COL.journeyEvents).doc(eventIdFor('engine', `${s1.id}:message.sent`)).get()).exists, 'message.sent recorded');
  });

  await test('delivered + clicks: favourite channel, the journey moves on, replays count once', async () => {
    await liveVenue();
    const { guestId, inst: i, s1 } = await welcomed({ venue: A, email: 'ben@test.local', phone: '791110100', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await signal(s1!.id, 'delivered');
    await signal(s1!.id, 'delivered');
    let s = (await sendDoc(i.id, 's1'))!;
    assertEqual(s.status, 'delivered', 'delivered');
    await signal(s1!.id, 'click');
    await signal(s1!.id, 'click');
    s = (await sendDoc(i.id, 's1'))!;
    const after = await inst(i.id);
    const c = await contactOf(guestId);
    assertEqual([after.counters.clicks, after.cursor.nodeId], [1, 'w_redeem'], 'one click for the journey; it moved on');
    assertEqual([c.engagement.preferredChannel, c.engagement.clicks], ['sms', 1], 'favourite channel from the click');
    assertEqual(s.engagement.clicks, 2, 'both counted clicks on the message');
    assert(s.engagement.firstClickAt && s.engagement.deliveredAt, 'timestamps set');
  });

  await test('email: unsubscribe footer + headers; opens once; a 2nd hard bounce blocks; spam and the unsubscribe link revoke', async () => {
    await liveVenue();
    const g1 = await welcomed({ venue: A, email: 'open@test.local', consent: true });
    const ob = (await outbox()).find((o) => o.id === g1.s1!.id)!;
    assert(ob.unsubscribeUrl && String(ob.unsubscribeUrl).includes('/u/'), 'List-Unsubscribe URL');
    assert(String(ob.html).includes('Unsubscribe') && String(ob.html).includes(ob.unsubscribeUrl), 'footer link');
    assert(String(ob.text).includes(ob.unsubscribeUrl), 'plain-text part too');
    await signal(g1.s1!.id, 'opened');
    await signal(g1.s1!.id, 'opened');
    await signal(g1.s1!.id, 'delivered');
    const s = (await sendDoc(g1.inst.id, 's1'))!;
    const c1 = await contactOf(g1.guestId);
    assertEqual([s.status, c1.engagement.opens], ['delivered', 1], 'opened once, then delivered (out of order is fine)');

    const g2 = await welcomed({ venue: A, email: 'bounce@test.local', consent: true });
    const c2 = await contactOf(g2.guestId);
    await db.collection(COL.contactPoints).doc(c2.emailPointId).update({ hardBounceCount: 1 });
    await signal(g2.s1!.id, 'bounce');
    const cp2 = (await db.collection(COL.contactPoints).doc(c2.emailPointId).get()).data()!;
    assertEqual([cp2.hardBounceCount, cp2.suppression.email?.reason, (await sendDoc(g2.inst.id, 's1'))!.status], [2, 'hard_bounce', 'bounced'], 'blocked after the 2nd hard bounce');

    const g3 = await welcomed({ venue: A, email: 'spam@test.local', consent: true });
    await signal(g3.s1!.id, 'spam');
    const c3 = await contactOf(g3.guestId);
    const cp3 = (await db.collection(COL.contactPoints).doc(c3.emailPointId).get()).data()!;
    assertEqual([cp3.suppression.email?.reason, c3.marketingConsent[`venue:${A.venueId}`].email.state], ['spam_complaint', 'revoked'], 'spam blocks + revokes');

    const g4 = await welcomed({ venue: A, email: 'unsub@test.local', consent: true });
    await signal(g4.s1!.id, 'unsubscribe');
    const c4 = await contactOf(g4.guestId);
    const e = c4.marketingConsent[`venue:${A.venueId}`].email;
    assertEqual([e.state, e.revokedVia, e.source], ['revoked', 'channel', 'unsubscribe_page'], 'the unsubscribe link revokes for good');
  });

  await test('STOP blocks SMS everywhere, START undoes exactly that; a reply gets one "not monitored" notice', async () => {
    await liveVenue();
    const g = await welcomed({ venue: A, email: 'stop@test.local', phone: '791110200', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await signal(g.s1!.id, 'reply', { text: 'danke' });
    await signal(g.s1!.id, 'reply', { text: 'hallo nochmal' });
    const notices = (await outbox()).filter((o) => String(o.text ?? o.body).includes("aren't read"));
    assertEqual(notices.length, 1, 'one notice in 30 days');
    assert((await sendDoc(g.inst.id, 's1'))!.engagement.repliedAt, 'repliedAt on the message');
    await signal(g.s1!.id, 'stop');
    let c = await contactOf(g.guestId);
    let cp = (await db.collection(COL.contactPoints).doc(c.phonePointId).get()).data()!;
    assertEqual([cp.suppression.sms?.reason, c.marketingConsent[`venue:${A.venueId}`].sms.state, c.marketingConsent[`venue:${A.venueId}`].sms.source], ['stop', 'revoked', 'sms_keyword'], 'STOP');
    assertEqual(c.marketingConsent[`venue:${A.venueId}`].email.state, 'granted', 'email is untouched');
    await signal(g.s1!.id, 'start');
    c = await contactOf(g.guestId);
    cp = (await db.collection(COL.contactPoints).doc(c.phonePointId).get()).data()!;
    assertEqual([cp.suppression.sms ?? null, c.marketingConsent[`venue:${A.venueId}`].sms.state], [null, 'granted'], 'START');
  });

  await test('provider answers: 21610 blocks the number; unknown is never resent or charged; "try later" gives up after 3', async () => {
    await liveVenue();
    const stopped = await welcomed({ venue: A, email: 'x1@test.local', phone: '791110000', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    assertEqual([stopped.s1!.status, stopped.s1!.errorCode], ['failed', '21610'], 'rejected');
    const c1 = await contactOf(stopped.guestId);
    const cp1 = (await db.collection(COL.contactPoints).doc(c1.phonePointId).get()).data()!;
    assertEqual([cp1.suppression.sms?.reason, c1.marketingConsent[`venue:${A.venueId}`].sms.state], ['stop', 'revoked'], 'the number is STOP-blocked');
    const np1 = (await db.collection(COL.networkPeople).doc(c1.networkId).get()).data()!;
    assertEqual(np1.recentMarketingTouches.length, 0, 'a failed message is not a weekly touch');

    const unknown = await welcomed({ venue: A, email: 'x2@test.local', phone: '791110001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    assertEqual(unknown.s1!.status, 'unknown', 'unknown');
    assertEqual((await inst(unknown.inst.id)).cursor.nodeId, 'w1', 'the journey carries on as if sent');

    const later = await welcomed({ venue: A, email: 'x3@test.local', phone: '791110002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    assertEqual(later.s1, null, 'nothing recorded while the provider says "later"');
    const waiting = (await inst(later.inst.id)).waiting;
    assertEqual([waiting.kind, waiting.dispatchAttempts, waiting.lastDeferReason], ['send_due', 1, 'provider_retry'], 'retry scheduled');
    await runUntil(now() + 2 * HOUR_MS);
    const gaveUp = await inst(later.inst.id);
    assertEqual(gaveUp.status, 'completed', 'skipped after 3 attempts');
    const blocked = (await docsWhere(COL.journeyEvents, 'instanceId', later.inst.id)).filter((e) => e.type === 'send.blocked');
    assertEqual(blocked.map((e) => e.data.decision.reason), ['provider_unavailable'], 'why');

    const debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    assertEqual(debits.length, 0, 'none of these was charged');
    assertEqual((await outbox()).length, 0, 'none of these reached the outbox');
  });

  await test('a worker that died mid-send: resumed as unknown, never sent twice; an accepted send is charged on repair', async () => {
    await liveVenue();
    const guestId = await connect({ venue: A, email: 'crash@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    const i = await a1For(guestId);
    const key = sendKeyFor(i.id, 's1');
    await db.collection(COL.journeySends).doc(key).set({
      tenantUserId: A.tenant, venueId: A.venueId, contactId: i.contactId, instanceId: i.id, journeyKey: 'welcome_second_visit', nodeId: 's1',
      mode: 'live', purpose: 'marketing', channel: 'email', variantId: 'v', slot: 'now', status: 'dispatching',
      dispatchLease: { owner: 'dead-worker', until: new Date(Date.now() - 1000) }, credits: { amount: 1, ledgerId: null }, sentAt: null,
      createdAt: new Date(now()), engagement: {},
    });
    await runDue();
    assertEqual((await sendDoc(i.id, 's1'))!.status, 'unknown', 'never resent');
    assertEqual((await outbox()).length, 0, 'nothing sent');
    assertEqual((await inst(i.id)).cursor.nodeId, 'w1', 'the journey carried on');

    // Accepted but never charged (the worker died before the debit): the repair task charges it — once.
    const g2 = await welcomed({ venue: A, email: 'repair@test.local', consent: true });
    await db.collection(COL.creditWallets).doc(A.tenant).collection('ledger').doc(`debit_auto_${g2.s1!.id}`).delete();
    await db.collection(COL.journeySends).doc(g2.s1!.id).update({ 'credits.ledgerId': null });
    const balance = async () => Number((await db.collection(COL.creditWallets).doc(A.tenant).get()).get('balance'));
    const before = await balance();
    await advance(6 * MINUTE_MS); // the repair task queued with the send is now due
    await runDue();
    const debits = (await ledger(A.tenant)).filter((l) => l.id === `debit_auto_${g2.s1!.id}`);
    assertEqual([debits.length, before - (await balance())], [1, g2.s1!.credits.amount], 'the repair charged it exactly once');
    assertEqual((await sendDoc(g2.inst.id, 's1'))!.credits.ledgerId, `debit_auto_${g2.s1!.id}`, 'the send points at it');

    // Brevo says "delivered" while the send is still `dispatching` (the worker died after
    // the provider took it): the send is recorded as delivered and charged.
    const g3 = await connect({ venue: A, email: 'midway@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    const i3 = await a1For(g3);
    const key3 = sendKeyFor(i3.id, 's1');
    await db.collection(COL.journeySends).doc(key3).set({
      tenantUserId: A.tenant, venueId: A.venueId, contactId: i3.contactId, instanceId: i3.id, journeyKey: 'welcome_second_visit', nodeId: 's1',
      mode: 'live', purpose: 'marketing', channel: 'email', variantId: 'v', slot: 'now', status: 'dispatching', providerMessageId: null,
      dispatchLease: { owner: 'dying-worker', until: new Date(Date.now() + 60_000) }, credits: { amount: 1, ledgerId: null, rateCardVersion: 0 },
      smsSegments: null, providerCostMinor: 0.2, sentAt: null, createdAt: new Date(now()), engagement: {},
    });
    await devProviderEvent({ sendKey: key3, event: 'delivered' });
    await runDue();
    const s3 = (await sendDoc(i3.id, 's1'))!;
    assertEqual([s3.status, Boolean(s3.sentAt), s3.credits.ledgerId], ['delivered', true, `debit_auto_${key3}`], 'repaired and charged');
  });

  await test('START undoes an imported old STOP; an older START never undoes a newer STOP; a replayed event counts once', async () => {
    await liveVenue();
    await db.collection(COL.guests).doc('legacy_stopped').set({ phone: '791110600', phoneCountryCode: '+41', smsOptOut: true, captivePortalAccessPointId: A.apId });
    const g = await connect({ venue: A, email: 'old-stop@test.local', phone: '791110600', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runDue();
    let c = await contactOf(g);
    assertEqual(c.marketingConsent[`venue:${A.venueId}`].sms.state, 'revoked', 'the old STOP was imported');
    await adaptiveOnInboundSms({ from: '+41791110600', body: 'START', legacyKind: 'start', messageSid: 'SMstart1', optOutType: null, signatureChecked: true });
    await runDue();
    c = await contactOf(g);
    assertEqual(c.marketingConsent[`venue:${A.venueId}`].sms.state, 'granted', 'START re-grants it');

    const pointId = c.phonePointId;
    const t = now();
    await applyPhoneStop(pointId, 'sms_keyword', t + 2000);
    await applyPhoneStart(pointId, t + 1000); // sent before the STOP, processed after it
    c = await contactOf(g);
    const cp = (await db.collection(COL.contactPoints).doc(pointId).get()).data()!;
    assertEqual([cp.suppression.sms?.reason, c.marketingConsent[`venue:${A.venueId}`].sms.state], ['stop', 'revoked'], 'the later STOP wins');

    const w = await welcomed({ venue: A, email: 'dedupe@test.local', phone: '791110601', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    const click = { id: 'ev_replayed_click', type: 'message.clicked', occurredAt: now(), instanceId: w.inst.id, data: {} };
    await deliverEvent(w.inst.id, click, { now: now(), settings: await readEngineSettings(), workerId: 'test' });
    await deliverEvent(w.inst.id, click, { now: now(), settings: await readEngineSettings(), workerId: 'test' });
    const after = await inst(w.inst.id);
    assertEqual([after.counters.clicks, after.seenEventIds.includes('ev_replayed_click')], [1, true], 'counted once');
  });

  await test('no SMS provider → the ladder moves to email; "verified only" rejects an unverified number', async () => {
    await liveVenue();
    const sms = channelAdapters.sms;
    delete channelAdapters.sms;
    try {
      const g1 = await welcomed({ venue: A, email: 'noprov@test.local', phone: '791110300', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      assertEqual(g1.s1!.channel, 'email', 'email instead');
      assert(g1.s1!.decision.channel.rejected.some((r: any) => r.channel === 'sms' && r.reason === 'channel_not_ready'), 'why');
    } finally {
      if (sms) channelAdapters.sms = sms;
      registerAdapters(channelAdapters);
    }
    await new Promise((r) => setTimeout(r, 200)); // alerts are fire-and-forget
    const skipAlerts = (await docsWhere(COL.alerts, 'kind', 'setup_block')).filter((x) => String(x.dedupeKey).startsWith('setup_skip:channel_not_ready:sms'));
    assertEqual(skipAlerts.length, 1, 'HeidiFi is told once that SMS is skipped');
    const g2 = await welcomed({ venue: A, email: 'unver@test.local', phone: '791110301', phoneCountryCode: '+41', phoneVerified: false, consent: true });
    assertEqual(g2.s1!.channel, 'email', 'unverified number → email');
    assert(g2.s1!.decision.channel.rejected.some((r: any) => r.channel === 'sms' && r.reason === 'audience'), 'audience recorded');
    const g3 = await welcomed({ venue: A, phone: '791110302', phoneCountryCode: '+41', phoneVerified: false, consent: true });
    assertEqual(g3.s1, null, 'phone only + unverified → nothing sent');
    const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', g3.inst.id)).find((e) => e.type === 'send.skipped');
    assert(skipped && explainDecision(skipped.data.decision, 'en', 'Europe/Zurich').includes('verified guests only'), 'the owner reads why');
  });

  await test('credits: an empty wallet holds the send; quiet hours do not restart the wait; gives up after 72 h', async () => {
    const t0 = await liveVenue(null);
    const guestId = await connect({ venue: A, email: 'broke@test.local', consent: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const i = await a1For(guestId);
    let w = (await inst(i.id)).waiting;
    assertEqual([w.kind, w.lastDeferReason], ['send_due', 'credits'], 'waiting for credits');
    const started = w.creditsWaitStartedAt;
    await runUntil(t0 + 22 * HOUR_MS); // through the night's quiet hours
    w = (await inst(i.id)).waiting;
    assertEqual(w.creditsWaitStartedAt, started, 'the 72 h wait keeps counting');
    await runUntil(t0 + 80 * HOUR_MS);
    const after = await inst(i.id);
    assertEqual(after.status, 'completed', 'the step was skipped');
    const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', i.id)).filter((e) => e.type === 'send.skipped').map((e) => e.data.decision.reason);
    assert(skipped.includes('credits_expired'), `credits_expired: ${skipped}`);
    assertEqual(await sendDoc(i.id, 's1'), null, 'never sent');
  });

  await test('a 2★ rating stops marketing at the venue and tells the owner (feedback only in the email)', async () => {
    const t0 = await liveVenue();
    const guestId = await connect({ venue: A, email: 'rater@test.local', phone: '791110400', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    await runUntil(t0 + 7 * HOUR_MS); // A1 welcome, then A2 review ask about 6 h after the visit
    const contactId = await contactIdFor(A.tenant, guestId);
    const a2 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((x) => x.journeyKey === 'review_ask')!;
    const ask = (await sendDoc(a2.id, 's1'))!;
    assertEqual(ask.status, 'sent', 'the review ask went out');
    await signal(ask.id, 'rating', { stars: 2, text: 'cold food' });
    const cv = (await db.collection(COL.contactVenues).doc(`${contactId}_${A.venueId}`).get()).data()!;
    assert(cv.lowRatingAt, 'low rating recorded');
    const alerts = await docsWhere(COL.alerts, 'kind', 'low_rating');
    assert(alerts.length === 1 && String(alerts[0].text).includes('cold food'), 'the owner is told, with the feedback');
    const rated = (await docsWhere(COL.journeyEvents, 'type', 'rating.submitted'))[0];
    assert(rated.data.hasFeedback === true && !JSON.stringify(rated.data).includes('cold food'), 'the log keeps no free text');
    assertEqual((await inst(a2.id)).status, 'completed', 'the review ask ends on the rating');
    await runUntil(t0 + 3 * DAY_MS);
    const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((x) => x.journeyKey === 'welcome_second_visit')!;
    const reasons = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((e) => e.type === 'send.skipped').map((e) => e.data.decision?.reason);
    assert(reasons.includes('low_rating'), `the next marketing message is skipped: ${reasons}`);
  });

  await test('sign-up breaker: the 4th new guest at one access point in an hour starts nothing; one alert', async () => {
    await liveVenue();
    await setSafety({ maxNewContactsPerApPerHour: 3 });
    const ids: string[] = [];
    for (let k = 0; k < 5; k += 1) ids.push(await connect({ venue: A, email: `burst${k}@test.local`, consent: true }));
    await runDue();
    const started = (await docsWhere(COL.journeyInstances, 'venueId', A.venueId)).filter((x) => x.journeyKey === 'welcome_second_visit');
    assertEqual(started.length, 3, 'only the first three');
    assertEqual((await docsWhere(COL.alerts, 'kind', 'signup_breaker')).length, 1, 'one alert');
    const contacts = await docsWhere(COL.contacts, 'tenantUserId', A.tenant);
    assertEqual(contacts.length, 5, 'every guest is still recorded');
    // A retried connect task (e.g. the worker died) must not slip past the breaker.
    const routes = (await db.collection(COL.journeyTasks).where('kind', '==', 'event_route').get()).docs;
    await Promise.all(routes.map((d) => d.ref.update({ status: 'queued', leaseOwner: null, leaseUntil: null })));
    await runDue();
    const again = (await docsWhere(COL.journeyInstances, 'venueId', A.venueId)).filter((x) => x.journeyKey === 'welcome_second_visit');
    assertEqual(again.length, 3, 'still only the first three after the retries');
  });

  await test('"try later" attempts survive a quiet-hours hold: 3 in total, then the step is skipped', async () => {
    const t0 = await liveVenue();
    const p0 = new Date(t0);
    await setClock(t0 + 8 * HOUR_MS + 3 * MINUTE_MS); // 20:43 the same day
    const g = await connect({ venue: A, email: 'night-retry@test.local', phone: '791120002', phoneCountryCode: '+41', phoneVerified: true, consent: true }); // …0002 = the sandbox says "try later"
    await runDue();
    await advance(15 * MINUTE_MS); // 20:58: attempt 1, 20:59: attempt 2 (the sandbox asks for 60 s), 21:00: quiet hours
    await runUntil(now() + 10 * MINUTE_MS);
    const i = await a1For(g);
    const night = (await inst(i.id)).waiting ?? {};
    assertEqual([night.lastDeferReason, night.dispatchAttempts], ['quiet_hours', 2], 'held for the night with its 2 attempts');
    await runUntil(now() + 14 * HOUR_MS); // next morning: attempt 3, then give up
    const after = await inst(i.id);
    assertEqual(after.status, 'completed', 'skipped after 3 attempts in total');
    const blocked = (await docsWhere(COL.journeyEvents, 'instanceId', i.id)).filter((e) => e.type === 'send.blocked').map((e) => e.data.decision.reason);
    assertEqual(blocked, ['provider_unavailable'], 'why');
    void p0;
  });

  await test('the webhook routes answer exactly as before and hand the signal to Adaptive', async () => {
    await liveVenue();
    const g = await welcomed({ venue: A, email: 'route@test.local', phone: '791110500', phoneCountryCode: '+41', phoneVerified: true, consent: true });
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/webhook/twilio/inbound', twilioInboundRoutes);
    app.use('/u', unsubscribeRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (path: string, form: Record<string, string>) =>
        fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
      const reply = await post('/webhook/twilio/inbound', { From: '+41791110500', Body: 'Grazie!', MessageSid: 'SMroute1' });
      assertEqual([reply.status, await reply.text()], [200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'], 'plain reply: empty TwiML as before');
      const stop = await post('/webhook/twilio/inbound', { From: '+41791110500', Body: 'STOP', MessageSid: 'SMroute2' });
      assert(stop.status === 200 && (await stop.text()).includes('You have been unsubscribed'), 'STOP confirmation as before');
      await new Promise((r) => setTimeout(r, 300)); // the hooks are fire-and-forget
      await runDue();
      const c = await contactOf(g.guestId);
      assertEqual(c.marketingConsent[`venue:${A.venueId}`].sms.state, 'revoked', 'Adaptive saw the STOP');
      const ob = (await outbox()).find((o) => o.id === g.s1!.id);
      assert(ob, 'the welcome was sent before');
    } finally {
      server.close();
    }
    // Stage 0: while everything is off and paused, a status for an unknown message writes nothing.
    await setLaunch({ [A.tenant]: 'off' }, { paused: true });
    const before = (await db.collection(COL.journeyEvents).get()).size;
    await adaptiveOnTwilioStatus({ messageSid: 'SMnotours', status: 'delivered', errorCode: null });
    assertEqual((await db.collection(COL.journeyEvents).get()).size, before, 'nothing written');
    void contactPointId;
  });

  await test('restart, live: guests × three workers + a crashed worker → exactly one email and one charge each', async () => {
    await liveVenue(1_000_000);
    await setSafety({ maxNewContactsPerApPerHour: 100_000 });
    const n = Number(process.env.ADAPTIVE_RESTART_LIVE_N || 200);
    for (let k = 0; k < n; k += 50) {
      await Promise.all(Array.from({ length: Math.min(50, n - k) }, (_, j) => connect({ venue: A, email: `live${k + j}@test.local`, consent: true })));
    }
    const workers = [new AdaptiveWorker(), new AdaptiveWorker(), new AdaptiveWorker()];
    await Promise.all(workers.map((w) => w.runDue()));
    await advance(15 * MINUTE_MS);
    const stolen = await claimDue('crashed-worker', now(), 50);
    for (const t of stolen) await db.collection(COL.journeyTasks).doc(t.id).update({ leaseUntil: new Date(Date.now() - 1000) });
    await reclaimExpiredLeases(200);
    await Promise.all(workers.map((w) => w.runDue()));
    await Promise.all(workers.map((w) => w.runDue()));
    const sends = (await db.collection(COL.journeySends).where('nodeId', '==', 's1').get()).docs.map((d) => d.data());
    assertEqual([sends.length, sends.filter((s) => s.status === 'sent').length], [n, n], `every guest's welcome sent (${sends.length}/${n})`);
    const emails = (await outbox()).filter((o) => o.channel === 'email');
    assertEqual(emails.length, n, 'one email each, none twice');
    // A burst on one account contends on its wallet: a debit that lost is repaired
    // by its queued `send_sweep` task — late, never lost, never twice.
    let debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    for (let round = 0; round < 6 && debits.length < n; round += 1) {
      await advance(6 * MINUTE_MS);
      await Promise.all(workers.map((w) => w.runDue()));
      debits = (await ledger(A.tenant)).filter((l) => l.id.startsWith('debit_auto_'));
    }
    assertEqual(debits.length, n, 'one charge each');
    const charged = (await db.collection(COL.journeySends).where('nodeId', '==', 's1').get()).docs.filter((d) => d.get('credits.ledgerId'));
    assertEqual(charged.length, n, 'every send points at its ledger line');
    clearCaches();
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
