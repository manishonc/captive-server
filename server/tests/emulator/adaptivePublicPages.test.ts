/**
 * PR D — the data behind the two guest pages (offer, info) on the emulator, through the real
 * router (spec E12; decision D-D7).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Offer: a live welcome's offer link → valid, then redeemed after the guest comes back;
 *    another guest's → expired after the expiry, gone (410) 7 days later. Never a guest name or
 *    contact detail; `Cache-Control: no-store`; opening it is not a click.
 *  - Info (a live Airbnb stay): the Wi-Fi password, door code and key instructions only inside
 *    the stay window (12 h before check-in … 2 h after checkout), per-field English fallback,
 *    the stay's dates and times; gone after checkout + 7 days, or once the stay is unlinked.
 *  - Info with Guest info in German only, for a French guest: the German Wi-Fi password and door
 *    code inside the stay window (its ends checked), null outside it.
 *  - Unknown code, the wrong kind of link, a test-run send, a legacy link, another venue, no
 *    venue → the SAME 404 (codes can't be probed).
 */

import {
  COL,
  TZ,
  advance,
  assert,
  assertEqual,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
  nextTuesday1240,
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { R, at, day, freshStay, sync, writeGuestInfo } from './stayFixtures';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const P: VenueFixture = { tenant: 'tenant_pub', venueId: 'venue_pub', apId: 'ap_pub', apMac: 'aa:dd:dd:dd:dd:01' };
const T: VenueFixture = { tenant: 'tenant_pubt', venueId: 'venue_pubt', apId: 'ap_pubt', apMac: 'aa:dd:dd:dd:dd:02' };
const A1 = 'welcome_second_visit';
const SHORT_LINKS = 'CaptivePortal_ShortLinks';

async function linkOf(send: AnyDoc, kind: 'offer' | 'hub'): Promise<string> {
  for (const code of send.shortCodes ?? []) {
    const l = (await db.collection(SHORT_LINKS).doc(code).get()).data();
    if (l?.journeyLink === kind) return code;
  }
  throw new Error(`no ${kind} link on ${send.id}`);
}

async function a1Send(guestId: string, tenant: string, venueId: string): Promise<AnyDoc> {
  const contactId = await contactIdFor(tenant, guestId);
  const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1 && i.venueId === venueId)!;
  const key = sendKeyFor(inst.id, 's1');
  return { ...((await db.collection(COL.journeySends).doc(key).get()).data() as Record<string, any>), id: key };
}

async function main() {
  const api = await mountApi();
  const offer = (code: string, venueId: string | null = P.venueId, extra = '') => api.get(`/public/offer/${code}${venueId === null ? '' : `?venueId=${venueId}`}${extra}`);
  const info = (code: string, venueId: string | null = R.venueId, extra = '') => api.get(`/public/info/${code}${venueId === null ? '' : `?venueId=${venueId}`}${extra}`);
  try {
    console.log('\nOffer page (PR D §4)\n');

    let notFoundBody = '';
    await test('offer: valid → redeemed after a return visit; another guest: expired, then 410; no-store, no guest details, not a click', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(P);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(P.tenant, 5000);
      await setLaunch({ [P.tenant]: 'live' }, { paused: false });
      const g1 = await connect({ venue: P, firstName: 'Olga', email: 'olga@test.local', phone: '791119001', phoneCountryCode: '+41', phoneVerified: true, consent: true, guestId: 'g_olga' });
      const g2 = await connect({ venue: P, firstName: 'Omar', email: 'omar@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const s1 = await a1Send(g1, P.tenant, P.venueId);
      const s2 = await a1Send(g2, P.tenant, P.venueId);
      assertEqual([s1.status, s1.mode, s2.status], ['sent', 'live', 'sent'], 'two live welcomes');
      const code1 = await linkOf(s1, 'offer');
      const code2 = await linkOf(s2, 'offer');

      let res = await offer(code1);
      assertEqual(res.status, 200, `GET offer: ${res.text.slice(0, 200)}`);
      assertEqual(res.headers.get('cache-control'), 'no-store', 'never cached');
      const o = res.body.offer;
      assertEqual([res.body.venueId, res.body.venueName, res.body.lang, o.status], [P.venueId, `Venue ${P.venueId}`, 'en', 'valid'], 'valid');
      assert(o.label && o.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(o.expiresOn), `label and expiry: ${JSON.stringify(o)}`);
      for (const s of ['Olga', 'olga@test.local', '791119001', s1.contactId, s1.id, s1.instanceId]) assert(!res.text.includes(s), `no ${s} in the page data`);
      const de = await offer(code1, P.venueId, '&lang=de');
      assertEqual([de.status, de.body.lang], [200, 'de'], 'a language hint');
      const clicks = (await db.collection(COL.journeySends).doc(s1.id).get()).get('engagement.clicks') ?? 0;
      assertEqual(clicks, 0, 'opening the page is not a click');
      assertEqual((await docsWhere(COL.journeyEvents, 'sendKey', s1.id)).filter((e) => e.type === 'message.clicked').length, 0, 'no click event');

      // Olga comes back the next morning: redeemed.
      const p = localParts(new Date(t0), TZ);
      await setClock(zonedTime(p.year, p.month, p.day + 1, 10, 0, TZ).getTime());
      await connect({ venue: P, guestId: 'g_olga', firstName: 'Olga', email: 'olga@test.local', phone: '791119001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      res = await offer(code1);
      assertEqual([res.status, res.body.offer.status], [200, 'redeemed'], 'redeemed');

      // Omar never came back: expired after the expiry, the link gone 7 days after it.
      const expiresAt = Date.parse((await offer(code2)).body.offer.expiresAt);
      await setClock(expiresAt + DAY_MS);
      res = await offer(code2);
      assertEqual([res.status, res.body.offer.status], [200, 'expired'], 'expired (shown)');
      await setClock(expiresAt + 7 * DAY_MS + HOUR_MS);
      res = await offer(code2);
      assertEqual([res.status, res.body.code, res.headers.get('cache-control')], [410, 'gone', 'no-store'], 'gone 7 days after the expiry');

      // Everything that isn't this venue's live journey offer link: one identical 404.
      await setupVenue(T);
      await setLaunch({ [P.tenant]: 'live', [T.tenant]: 'test' }, { paused: false });
      const gt = await connect({ venue: T, email: 'dry.pub@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const dry = await a1Send(gt, T.tenant, T.venueId);
      assertEqual([dry.status, dry.shortCodes ?? []], ['dry_run', []], 'a test run makes no short links');
      await db.collection(SHORT_LINKS).doc('dryrun01').set({ sendKind: 'journey', sendKey: dry.id, marketingDocId: dry.id, journeyLink: 'offer', venueId: T.venueId, targetUrl: 'x' });
      await db.collection(SHORT_LINKS).doc('legacy01').set({ sendKind: 'campaign', marketingDocId: 'camp_1', venueId: P.venueId, targetUrl: 'https://example.com' });
      const code1Info = await info(code1, P.venueId);
      const cases: Array<[string, Promise<{ status: number; text: string; headers: Headers }>]> = [
        ['an unknown code', offer('zzzzzzzz')],
        ['another venue', offer(code1, 'venue_other')],
        ["the venue of another account's link", offer(code1, T.venueId)],
        ['no venue', offer(code1, null)],
        ['a test-run send', offer('dryrun01', T.venueId)],
        ['a legacy link', offer('legacy01')],
        ['a code with odd characters', offer('abc%2Fdef')],
        ['an offer link on the info page', Promise.resolve(code1Info)],
      ];
      const texts: string[] = [];
      for (const [label, pending] of cases) {
        const r = await pending;
        assertEqual(r.status, 404, label);
        assertEqual(r.headers.get('cache-control'), 'no-store', `${label}: no-store`);
        texts.push(r.text);
      }
      assert(texts.every((x) => x === texts[0]), `the same 404 every time: ${[...new Set(texts)].join(' | ')}`);
      notFoundBody = texts[0];
      assertEqual((await offer(code1, P.venueId, '')).status, 410, 'the real one (same expiry) is gone, not a 404');
      const noSecret = await api.get(`/public/offer/${code1}?venueId=${P.venueId}`, { secret: null });
      assertEqual(noSecret.status, 401, 'behind the shared secret');
    });

    console.log('\nInfo page (PR D §4, D-D7)\n');

    await test('info (a live stay): secrets only inside the stay window, English fallback per field, stay dates; gone after checkout + 7 d or once unlinked', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }], { launch: 'live' });
      await seedWallet(R.tenant, 5000);
      await setLaunch({ [R.tenant]: 'live' }, { paused: false });
      await writeGuestInfo(R, { wifiPassword: 'pw-SECRET-9', doorCode: '4711', keyInstructions: 'Key box left of the door', houseRules: 'No parties' });
      await setClock(at(0, '15:10'));
      const tomGuest = await connect({ venue: R, firstName: 'Tom', email: 'tom.pub@test.local', consent: true, language: 'de' });
      await runDue();
      const tom = await contactIdFor(R.tenant, tomGuest);
      await runUntil(at(0, '17:30'));
      const welcome = (await docsWhere(COL.journeySends, 'contactId', tom)).find((s) => s.journeyKey === 'stay_guide' && s.nodeId === 'welcome');
      assert(welcome && welcome.status === 'sent' && welcome.mode === 'live', `the live welcome: ${welcome?.status}`);
      const code = await linkOf(welcome!, 'hub');

      let res = await info(code);
      assertEqual(res.status, 200, `GET info: ${res.text.slice(0, 200)}`);
      assertEqual(res.headers.get('cache-control'), 'no-store', 'never cached');
      assertEqual(res.body.lang, 'de', "the guest's language");
      assertEqual([res.body.secrets.wifiPassword, res.body.secrets.doorCode, res.body.secrets.keyInstructions], ['pw-SECRET-9', '4711', 'Key box left of the door'], 'inside the window: the secrets');
      assertEqual(res.body.info.wifiName, 'Retreat Gast', 'German where German has it');
      assertEqual(res.body.info.houseRules, 'No parties', 'English where German has nothing (per field)');
      assertEqual(res.body.stay, { checkIn: day(0), checkOut: day(5), nights: 5, checkInTime: '15:00', checkOutTime: '10:00' }, 'the stay');
      assert(!('wifiPassword' in res.body.info) && !('doorCode' in res.body.info), 'secrets only under `secrets`');
      for (const s of ['Tom', 'tom.pub@test.local', tom, welcome!.id]) assert(!res.text.includes(s), `no ${s}`);
      assertEqual((await offer(code, R.venueId)).status, 404, 'an info link on the offer page → 404');
      const other = await info(code, P.venueId);
      assertEqual(other.status, 404, 'another venue → 404');
      if (notFoundBody) assertEqual(other.text, notFoundBody, 'the same 404 body');

      await setClock(at(5, '11:30')); // checkout 10:00 + 1.5 h
      res = await info(code);
      assertEqual([res.status, res.body.secrets.doorCode], [200, '4711'], 'until 2 h after checkout');
      await setClock(at(5, '12:30'));
      res = await info(code);
      assertEqual([res.status, res.body.secrets.wifiPassword, res.body.secrets.doorCode, res.body.secrets.keyInstructions], [200, null, null, null], 'after the window: no secrets');
      assertEqual(res.body.stay.checkOut, day(5), 'the page itself still works');
      assert(!res.text.includes('pw-SECRET-9') && !res.text.includes('4711'), 'nowhere in the answer');
      await setClock(at(12, '11:00'));
      res = await info(code);
      assertEqual([res.status, res.body.code], [410, 'gone'], 'gone after checkout + 7 days');

      // Back inside the stay: once the owner unlinks Tom, his link shows nothing.
      await setClock(at(3, '12:00'));
      assertEqual((await info(code)).status, 200, 'still his');
      const stayId = (await docsWhere(COL.stays, 'venueId', R.venueId))[0].id;
      const un = await api.call('POST', `/tenants/${R.tenant}/venues/${R.venueId}/stays/${stayId}/unlink`, { expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual(un.status, 200, 'unlinked');
      res = await info(code);
      assertEqual([res.status, res.body.code], [410, 'gone'], 'no longer his stay → gone');
      assert(!res.text.includes('4711'), 'no door code');
    });

    await test('info: Guest info in German only, a French guest → the German Wi-Fi password and door code inside the stay window (and at its ends), null outside it', async () => {
      await freshStay([{ uid: 'fleur@airbnb.test', checkIn: day(0), checkOut: day(5) }], { launch: 'live', guestInfo: false });
      await seedWallet(R.tenant, 5000);
      await setLaunch({ [R.tenant]: 'live' }, { paused: false });
      await db.collection(COL.venueGuestInfo).doc(`venue_${R.venueId}`).set({
        tenantUserId: R.tenant,
        venueId: R.venueId,
        locales: { de: { wifiName: 'Haus Gast', wifiPassword: 'pw-HAUS-7', doorCode: '0815', houseRules: 'Keine Partys', checkOutTime: '11:00' } },
        version: 1,
      });
      await sync(); // the stay takes the German check-out time
      await setClock(at(0, '15:10'));
      const guest = await connect({ venue: R, firstName: 'Fleur', email: 'fleur.pub@test.local', consent: true, language: 'fr' });
      await runDue();
      const fleur = await contactIdFor(R.tenant, guest);
      await runUntil(at(0, '17:30'));
      const welcome = (await docsWhere(COL.journeySends, 'contactId', fleur)).find((s) => s.journeyKey === 'stay_guide' && s.nodeId === 'welcome');
      assert(welcome && welcome.status === 'sent' && welcome.mode === 'live', `the live welcome: ${welcome?.status}`);
      const code = await linkOf(welcome!, 'hub');

      let res = await info(code);
      assertEqual(res.status, 200, `GET info: ${res.text.slice(0, 200)}`);
      assertEqual(res.body.lang, 'fr', "the guest's language");
      assertEqual([res.body.secrets.wifiPassword, res.body.secrets.doorCode], ['pw-HAUS-7', '0815'], 'inside the window: the German secrets (no French, no English)');
      assertEqual([res.body.info.wifiName, res.body.info.houseRules], ['Haus Gast', 'Keine Partys'], 'German for the other fields too');
      assertEqual([res.body.stay.checkOutTime, res.body.info.checkOutTime], ['11:00', '11:00'], 'the German check-out time');
      const from = Date.parse(res.body.secrets.shownFrom);
      const until = Date.parse(res.body.secrets.shownUntil);
      assertEqual(until, at(5, '11:00') + 2 * HOUR_MS, 'shown until 2 h after the 11:00 checkout');
      assertEqual(from, at(0, '15:00') - 12 * HOUR_MS, 'shown from 12 h before check-in');

      // The window's ends. The engine clock runs on between setClock and the request, so the
      // "inside" checks start a moment after `from` / end a moment before `until`.
      const secretsAt = async (t: number) => {
        await setClock(t);
        const r = await info(code);
        assertEqual(r.status, 200, `the page opens at ${new Date(t).toISOString()}`);
        return [r.body.secrets.wifiPassword, r.body.secrets.doorCode];
      };
      assertEqual(await secretsAt(until - 5_000), ['pw-HAUS-7', '0815'], '5 s before the end: shown');
      assertEqual(await secretsAt(until + 1), [null, null], '1 ms after the end: hidden');
      assertEqual(await secretsAt(at(5, '13:30')), [null, null], 'after the window: hidden');
      assertEqual(await secretsAt(from - 1_000), [null, null], 'before the window: hidden');
      assertEqual(await secretsAt(from), ['pw-HAUS-7', '0815'], 'from the start of the window: shown');
      res = await info(code);
      assert(res.text.includes('Haus Gast'), 'the page itself works throughout');
    });
  } finally {
    await api.close();
  }
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

