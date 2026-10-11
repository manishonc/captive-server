/**
 * PR PV — "See what guests get" on every channel, and Send test on WhatsApp, on the emulator through
 * the real router and the sandbox Meta.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - The preview answers `versions` per message: the journey's channel order (SMS first for Welcome,
 *    email first for the Stay guide), only the channels the message has (no WhatsApp on Review after
 *    checkout, no SMS on Local tips), none on the rating page; the old fields stay as they were.
 *  - WhatsApp: an example from the SMS text while there is no template (button, STOP footer on
 *    marketing), "nothing" without SMS text (Local tips), the approved template once Meta approves
 *    it (asked language), waiting for Meta, another language's template not shown for English,
 *    a paused one not used.
 *  - Send test on WhatsApp: only the approved template, to a saved phone, in the sandbox outbox with
 *    the template's name, language, values in order and the button's placeholder; the shared daily
 *    counter; no send record; a log row on the template's timeline; refusals (no approved template,
 *    a message that doesn't go by WhatsApp, an email recipient, Meta refusing → `sent: false`).
 */

import { COL, assert, assertEqual, clearCaches, db, done, nextTuesday1240, outbox, resetEmulator, seedCatalogue, setClock, setLaunch, setupVenue, test, type VenueFixture } from './helpers';
import { ADMIN_ACTOR, OWNER_ACTOR, countDocs, mountApi, seedTestRecipients } from './ownerApiHelpers';
import { CONFIG_DOC_ID } from '../../src/adaptive/store/collections';
import { runWhatsAppTemplateTick } from '../../src/adaptive/whatsapp/sync';
import { __clearHintCache } from '../../src/adaptive/whatsapp/hints';
import { STOP_LINES } from '../../src/adaptive/send/compose';

const PV: VenueFixture = { tenant: 'tenant_pv', venueId: 'venue_pv', apId: 'ap_pv', apMac: 'aa:bb:cc:dd:ee:71' };
const T = `/tenants/${PV.tenant}`;
const V = `${T}/venues/${PV.venueId}`;
const A1 = 'welcome_second_visit';

const DE_OFFER = {
  body: 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days | default:"14"}} Tagen wieder – dann wartet {{offer.label | default:"eine Überraschung"}} auf dich.',
  footer: STOP_LINES.de,
  button: { text: 'Angebot ansehen', field: 'link.offer' },
};
const EN_LAST = {
  body: 'Hi {{contact.firstName | default:"there"}}! There is still {{offer.label | default:"a surprise"}} waiting for you at {{venue.name}}. See you soon!',
  footer: STOP_LINES.en,
  button: { text: 'See your offer', field: 'link.offer' },
};

async function main() {
  const api = await mountApi();
  const admin = { ...ADMIN_ACTOR, uid: 'heidifi_admin_pv' };
  const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', path, { ...body, actor: admin });
  const preview = (body: Record<string, unknown>) => api.call('POST', `${T}/setups/preview`, { slots: {}, ...body });
  const sendTest = (body: Record<string, unknown>) => api.call('POST', `${V}/test-send`, { journeyKey: A1, nodeId: 's1', channel: 'whatsapp', recipientId: 'phone_me', ...body, actor: OWNER_ACTOR });

  async function fresh(): Promise<void> {
    await resetEmulator();
    __clearHintCache();
    await seedCatalogue();
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update({ 'alerts.email': 'alerts@heidifi.test' });
    await setupVenue(PV);
    await setLaunch({ [PV.tenant]: 'test' });
    await setClock(nextTuesday1240());
    await seedTestRecipients(PV.tenant, [
      { id: 'phone_me', kind: 'phone', value: '+41791239876' },
      { id: 'mail_me', kind: 'email', value: 'owner.pv@test.local' },
      { id: 'phone_refused', kind: 'phone', value: '+41791230004' },
    ]);
    clearCaches();
  }

  /** Connect the sandbox Meta, write a template and (optionally) have Meta approve it. */
  async function template(use: { journeyKey: string; poolKey: string }, lang: string, source: unknown, decision: 'APPROVED' | null): Promise<string> {
    const c = await post('/admin/whatsapp/connection/check');
    assertEqual(c.status, 200, `connection ${c.text}`);
    const d = await post('/admin/whatsapp/templates', { use, lang, category: 'MARKETING', source });
    assertEqual(d.status, 200, `draft ${d.text}`);
    const id = d.body.template.id as string;
    const s = await post(`/admin/whatsapp/templates/${id}/submit`, { baseVersion: d.body.template.version });
    assertEqual([s.status, s.body.outcome], [200, 'submitted'], `submit ${s.text}`);
    if (decision) {
      const r = await api.call('POST', '/dev/whatsapp/review', { templateId: id, decision });
      assertEqual(r.status, 200, `review ${r.text}`);
      await runWhatsAppTemplateTick();
    }
    return id;
  }

  const channels = (m: { versions?: Array<{ channel: string }> }) => (m.versions ?? []).map((v) => v.channel);
  const wa = (m: { versions?: Array<Record<string, any>> }) => (m.versions ?? []).find((v) => v.channel === 'whatsapp');

  console.log('\n"See what guests get" on every channel (PR PV)\n');

  await test('versions: the journey’s order, only the channels a message has, none on the rating page; the old fields unchanged', async () => {
    await fresh();
    const welcome = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'en', venueId: PV.venueId });
    assertEqual(welcome.status, 200, welcome.text);
    const [s1, s2] = welcome.body.messages;
    assertEqual([s1.channel, channels(s1)], ['sms', ['sms', 'email', 'whatsapp']], 'SMS first, then email and WhatsApp');
    assertEqual([s2.channel, channels(s2)], ['email', ['sms', 'email', 'whatsapp']], 'the 2nd message shows email first, same versions');
    const sms = s1.versions[0];
    assert(sms.text === s1.text && sms.lang === 'en' && sms.name === s1.variantName, `the SMS version is today’s message: ${JSON.stringify(sms)}`);
    const email = s1.versions[1];
    assert(email.subject && email.text.includes('Anna') && email.text.includes(`Venue ${PV.venueId}`), `an email for Anna at the venue: ${JSON.stringify(email).slice(0, 300)}`);

    const stay = await preview({ playbookKey: 'str_stay', journeyKey: 'stay_review', lang: 'en' });
    assertEqual(stay.status, 200, stay.text);
    assertEqual(stay.body.messages.map((m: any) => [m.channel, channels(m)]), [['sms', ['sms', 'email']], ['page', []]], 'Review after checkout: no WhatsApp; the rating page has no versions');
    assertEqual(stay.body.messages[1].versions, undefined, 'no versions field on the page');
    const tips = await preview({ playbookKey: 'str_stay', journeyKey: 'stay_local_tips', lang: 'de' });
    const tip = tips.body.messages[0];
    assertEqual(channels(tip), ['email', 'whatsapp'], 'Local tips: email and WhatsApp (no SMS wording)');
    assertEqual([wa(tip)!.status, wa(tip)!.text], ['missing', ''], 'no template and no SMS text → nothing to show');
    const guide = await preview({ playbookKey: 'str_stay', journeyKey: 'stay_guide', lang: 'en' });
    assertEqual(channels(guide.body.messages[0]), ['email', 'whatsapp', 'sms'], 'Stay guide: its ladder order');
  });

  await test('WhatsApp: an example from the SMS text, then the approved template (asked language); English never gets the German one', async () => {
    await fresh();
    let res = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'de', venueId: PV.venueId });
    let v = wa(res.body.messages[0])!;
    assertEqual([v.status, v.lang, v.name, v.footer, v.button], ['example', 'de', null, STOP_LINES.de, { text: 'Angebot ansehen' }], 'the example (German SMS, marketing)');
    assert(v.text.includes('Anna') && !v.text.includes('hdf.to'), `the SMS text without its link: ${v.text}`);
    const thanks = wa(res.body.messages[3])!;
    assertEqual([thanks.status, thanks.footer], ['example', null], 'the thank-you is a utility message: no STOP footer');

    await template({ journeyKey: A1, poolKey: 'welcome_offer' }, 'de', DE_OFFER, 'APPROVED');
    clearCaches();
    res = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'de', venueId: PV.venueId });
    v = wa(res.body.messages[0])!;
    assertEqual([v.status, v.lang, v.name, v.footer, v.button], ['approved', 'de', 'hf_welcome_offer_1', STOP_LINES.de, { text: 'Angebot ansehen' }], 'the approved template');
    assert(v.text.startsWith('Hallo Anna, danke für deinen Besuch bei Venue venue_pv!'), `with Anna and the venue: ${v.text}`);
    const en = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'en', venueId: PV.venueId });
    assertEqual(wa(en.body.messages[0])!.status, 'example', 'English: the German template is not shown');

    await template({ journeyKey: A1, poolKey: 'last_chance' }, 'en', EN_LAST, null);
    clearCaches();
    const de = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'de', venueId: PV.venueId });
    const last = wa(de.body.messages[2])!;
    assertEqual([last.status, last.lang, last.name], ['in_review', 'en', 'hf_last_chance_1'], 'waiting for Meta; no German one → the English one');
  });

  console.log('\nSend test on WhatsApp (PR PV, D2)\n');

  await test('send test: the approved template to a saved phone — outbox, values in order, button placeholder, counter, log row, no record', async () => {
    await fresh();
    let res = await sendTest({ lang: 'de' });
    assertEqual([res.status, res.body.reason], [422, 'whatsapp_template_missing'], `no approved template yet: ${res.text}`);
    const id = await template({ journeyKey: A1, poolKey: 'welcome_offer' }, 'de', DE_OFFER, 'APPROVED');
    clearCaches();

    const records = async () => [await countDocs(COL.journeySends), await countDocs(COL.journeyEvents), await countDocs('CaptivePortal_ShortLinks')];
    const before = await records();
    res = await sendTest({ lang: 'de' });
    assertEqual([res.status, res.body.sent, res.body.channel, res.body.variant, res.body.wordingLang], [200, true, 'whatsapp', 'hf_welcome_offer_1', 'de'], `sent: ${res.text.slice(0, 400)}`);
    assert(!res.text.includes('791239876'), `the number is masked: ${res.body.to}`);
    assert(res.body.preview.text.startsWith('Hallo Anna, danke für deinen Besuch bei Venue venue_pv!'), `the preview: ${res.body.preview.text}`);
    assertEqual([res.body.preview.footer, res.body.preview.button], [STOP_LINES.de, { text: 'Angebot ansehen' }], 'footer + button');
    const ob = (await outbox()).filter((o) => String(o.id).startsWith('test_') && o.channel === 'whatsapp');
    assertEqual(ob.length, 1, 'one WhatsApp message in the sandbox outbox');
    assertEqual([ob[0].to, ob[0].templateName, ob[0].language], ['+41791239876', 'hf_welcome_offer_1', 'de'], 'the saved number, the template');
    assertEqual(ob[0].button, { index: 0, param: 's/xxxxxxxx' }, 'the button carries the tests’ placeholder');
    assertEqual(ob[0].bodyParams.length, 4, 'four values');
    assertEqual([ob[0].bodyParams[0], ob[0].bodyParams[1]], ['Anna', 'Venue venue_pv'], 'in {{n}} order');
    assert(ob[0].bodyParams.every((p: string) => p.trim() && !/[\n\t]/.test(p)), `never empty, one line: ${JSON.stringify(ob[0].bodyParams)}`);
    assertEqual(await records(), before, 'no send record, event or short link');
    const day = new Date().toISOString().slice(0, 10);
    const counter = await db.collection('CaptivePortal_TestSendCounters').doc(`${PV.tenant}_${day}`).get();
    assertEqual([counter.get('count'), counter.get('whatsapp')], [1, 1], 'the shared daily counter and the WhatsApp one');
    const rows = (await db.collection(COL.whatsappLog).get()).docs.map((d) => d.data()).filter((r) => r.kind === 'test.sent');
    assertEqual(rows.length, 1, 'one log row');
    assertEqual([rows[0].templateId, rows[0].level, rows[0].actor.label, rows[0].detail.outcome], [id, 'info', 'Owner test send', 'accepted'], 'on the template, accepted');
    assert(!JSON.stringify(rows[0]).includes('791239876'), 'no number in the log');
    const timeline = await db.collection(COL.whatsappTemplates).doc(id).collection('history').get();
    assert(timeline.docs.some((d) => d.get('kind') === 'test.sent'), 'on the template’s timeline');
  });

  await test('send test refusals: English has no approved template, a message that isn’t WhatsApp, an email recipient, a paused template; Meta refusing → sent false + log', async () => {
    await fresh();
    const id = await template({ journeyKey: A1, poolKey: 'welcome_offer' }, 'de', DE_OFFER, 'APPROVED');
    clearCaches();
    assertEqual((await sendTest({ lang: 'en' })).body.reason, 'whatsapp_template_missing', 'English: no approved English template');
    let res = await sendTest({ journeyKey: 'friend_reward', nodeId: 's', lang: 'de' });
    assertEqual([res.status, res.body.error], [400, 'This message doesn’t go by WhatsApp'], `friend reward: ${res.text}`);
    res = await sendTest({ lang: 'de', recipientId: 'mail_me' });
    assertEqual([res.status, res.body.error], [400, 'Pick a saved phone number for a WhatsApp test'], 'an email recipient');
    res = await sendTest({ lang: 'de', recipientId: 'phone_refused' });
    assertEqual([res.status, res.body.sent, res.body.problem], [200, false, 'WhatsApp doesn’t know this template in this language (any more). HeidiFi needs to check it.'], `Meta refused: ${res.text}`);
    const rows = (await db.collection(COL.whatsappLog).get()).docs.map((d) => d.data()).filter((r) => r.kind === 'test.not_sent');
    assertEqual([rows.length, rows[0]?.level, rows[0]?.detail?.code], [1, 'warn', '132001'], 'logged as not sent');
    const paused = await post(`/admin/whatsapp/templates/${id}/use`, { enabled: false });
    assertEqual(paused.status, 200, paused.text);
    clearCaches();
    assertEqual((await sendTest({ lang: 'de' })).body.reason, 'whatsapp_template_missing', 'a paused template is not used');
    const res2 = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'de', venueId: PV.venueId });
    assertEqual(wa(res2.body.messages[0])!.status, 'example', 'the preview falls back to the example too');
  });

  await test('the WhatsApp test cap (10 a day per account, whatever the shared cap); a broken template doc never breaks the preview or the test', async () => {
    await fresh();
    await template({ journeyKey: A1, poolKey: 'welcome_offer' }, 'de', DE_OFFER, 'APPROVED');
    clearCaches();
    const day = new Date().toISOString().slice(0, 10);
    await db.collection('CaptivePortal_TestSendCounters').doc(`${PV.tenant}_${day}`).set({ tenantUserId: PV.tenant, day, count: 3, whatsapp: 10 }, { merge: true });
    let res = await sendTest({ lang: 'de' });
    assertEqual([res.status, res.body.error], [429, 'Daily WhatsApp test limit reached (10/day). Try again tomorrow.'], `WhatsApp cap: ${res.text}`);
    res = await api.call('POST', `${V}/test-send`, { journeyKey: A1, nodeId: 's1', channel: 'sms', recipientId: 'phone_me', actor: OWNER_ACTOR });
    assertEqual([res.status, res.body.sent], [200, true], 'an SMS test still goes (the shared cap isn’t reached)');
    assertEqual((await outbox()).filter((o) => String(o.id).startsWith('test_') && o.channel === 'whatsapp').length, 0, 'no WhatsApp test went');

    // A damaged template doc for the same message (a body that isn't text).
    await db.collection(COL.whatsappTemplates).doc('wt_broken').set({
      name: 'hf_welcome_offer_9', language: 'de', lang: 'de', use: { kind: 'adaptive', journeyKey: A1, poolKey: 'welcome_offer' }, origin: 'manual',
      source: { body: 42, footer: null, button: null }, compiled: { bodyText: 'x', footerText: null, button: null, params: [], componentsJson: '[]' },
      meta: null, stage: 'draft', dismissed: false, useEnabled: true, version: 1, seq: 1, pendingAlerts: [],
    });
    clearCaches();
    const pv = await preview({ playbookKey: 'restaurant_growth', journeyKey: A1, lang: 'de', venueId: PV.venueId });
    assertEqual(pv.status, 200, `the preview still answers: ${pv.text.slice(0, 300)}`);
    assertEqual(channels(pv.body.messages[0]).slice(0, 2), ['sms', 'email'], 'SMS and email still show');
    const v = wa(pv.body.messages[0]);
    assert(!v || v.status === 'approved', `WhatsApp: the approved template or no tab, never the broken one: ${JSON.stringify(v)?.slice(0, 200)}`);
    await db.collection('CaptivePortal_TestSendCounters').doc(`${PV.tenant}_${day}`).set({ whatsapp: 0 }, { merge: true });
    res = await sendTest({ lang: 'de' });
    assertEqual([res.status, res.body.sent, res.body.variant], [200, true, 'hf_welcome_offer_1'], `the test still sends the approved one: ${res.text.slice(0, 300)}`);
  });

  await api.close();
  done();
}

main();
