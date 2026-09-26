/**
 * PR D — the owner routes on the emulator, through the real router (spec E5–E9, E13).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Calendar link: GET / PUT / DELETE / Check link / Sync now through the routes; the linked
 *    guest shown masked with the stay id; 403 for another account's venue, 400 for a venue that
 *    isn't an Airbnb; the link masked everywhere; LEAKCHECK through PUT and Check link (no
 *    response, log line, feed field or task holds a malformed link); Check link rate-limited.
 *  - Unlink (D-C11) and link by hand (D-D8): `expectContactId` required (409 on a mismatch);
 *    the unlinked guest's stay messages stop (`stay_unlinked`), he is never relinked, and the
 *    next guest in the window is linked and gets the remaining moments (new link-generation
 *    ids); the owner's pick replaces a wrong link and gets the remaining moments; a guest never
 *    seen at the venue → 400.
 *  - Link back after an unlink (D-D8, the worker resumes): a quick undo answers `resuming` and the
 *    Stay guide runs on from its kept wait (next step on time, no second welcome or instance, no
 *    Checkout reminder beside it); new dates during the gap move the resumed wait; a step due long
 *    before the re-link is skipped as stale; a journey unlinked before its first step starts; a
 *    second unlink before the worker ran → nothing resumed; a reconnect or a date change before
 *    the re-link handler ran schedules no moment (one checkout message after); a kept send wait
 *    with no time of its own is re-armed at the step's own time → skipped as stale.
 *  - Guest info content: validation (422 with issues), `baseVersion` 409, the Wi-Fi card then
 *    sends, per-field English fallback, a changed check-out time queues a calendar sync.
 *  - Who gets messages: counts from the guest docs, PUT → the gate follows it (SMS to an
 *    unverified number skipped as `audience`, email goes), the estimate prices the choice.
 *  - Send test: only a saved recipient, the sandbox outbox gets it, no records, the shared daily
 *    counter (+1, 429 at the cap), refused while the account is off; a saved `0041…` number is
 *    sent to `+41…`, a national one → 400 (nothing sent or counted); per-field fallback for the
 *    booking link; no Guest info → 422 `guest_info_missing`, no booking link → 422; a language the
 *    wording lacks (fr) → the English wording and STOP line (`wordingLang: 'en'`); the email's
 *    "Powered by HeidiFi" tag follows the plan's `hidePoweredBy`.
 *  - Guest info resync: two check-out changes in one engine minute → two `stay_poll` tasks
 *    (dedupe keys `…:gi1`, `…:gi2`), even when the first has already run.
 */

import {
  COL,
  TZ,
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
  now,
  outbox,
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  test,
  worker,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { MCP_ACTOR, OWNER_ACTOR, captureLogs, countDocs, mountApi, seedTestRecipients, type Api } from './ownerApiHelpers';
import { R, at, day, freshStay, label, staysAt, sync, tasksOfKind, writeCalendar } from './stayFixtures';
import { stayFeedId } from '../../src/adaptive/store/collections';
import { taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { STOP_LINES } from '../../src/adaptive/send/compose';
import { eventRef } from '../../src/adaptive/engine/events';
import { linkMarkId, relinkedEventId } from '../../src/adaptive/stays/link';
import { invalidateEntitlements } from '../../src/services/entitlements';

const REST: VenueFixture = { tenant: R.tenant, venueId: 'venue_rest', apId: 'ap_rest', apMac: 'aa:bb:cc:dd:ee:21' };
const G: VenueFixture = { tenant: 'tenant_gi', venueId: 'venue_gi', apId: 'ap_gi', apMac: 'aa:bb:cc:dd:ee:31', guestInfo: true };
const AU: VenueFixture = { tenant: 'tenant_au', venueId: 'venue_au', apId: 'ap_au', apMac: 'aa:bb:cc:dd:ee:41' };
const TS: VenueFixture = { tenant: 'tenant_ts', venueId: 'venue_ts', apId: 'ap_ts', apMac: 'aa:bb:cc:dd:ee:51' };
const A1 = 'welcome_second_visit';
const RV = `/tenants/${R.tenant}/venues/${R.venueId}`;
const FEED = stayFeedId(R.venueId);

/** Every send of a contact as "journey/node @ D+n HH:MM". */
async function sendLogOf(contactId: string): Promise<string[]> {
  const sends = await docsWhere(COL.journeySends, 'contactId', contactId);
  return sends
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis() || String(a.journeyKey).localeCompare(String(b.journeyKey)))
    .map((s) => `${s.journeyKey}/${s.nodeId} @ ${label(s.createdAt.toMillis())}`);
}

async function stayDoc(id: string): Promise<AnyDoc> {
  return { ...((await db.collection(COL.stays).doc(id).get()).data() as Record<string, any>), id };
}

/** A guest connects; the worker handles it; their contact id. */
async function joined(tenant: string, c: Parameters<typeof connect>[0]): Promise<string> {
  const guestId = await connect(c);
  await runDue();
  return contactIdFor(tenant, guestId);
}

const STAY_MOMENTS = ['stay_guide/welcome', 'stay_local_tips/s', 'stay_guide/mid', 'stay_guide/co', 'stay_review/s1', 'stay_book_direct/s'];

async function instanceDoc(id: string): Promise<AnyDoc> {
  return { ...((await db.collection(COL.journeyInstances).doc(id).get()).data() as Record<string, any>), id };
}

/** A contact's Stay guide instances for one stay. */
async function guideOf(contactId: string, stayId: string): Promise<AnyDoc[]> {
  return (await docsWhere(COL.journeyInstances, 'contactId', contactId)).filter((i) => i.journeyKey === 'stay_guide' && i.context?.stayId === stayId);
}

/** When a wait is due (stored as ms; a Timestamp read the same). */
function untilOf(i: AnyDoc): number {
  const u = i.waiting?.untilAt;
  return typeof u === 'number' ? u : Number(u?.toMillis?.());
}

/** Tom (5 nights, D+0 → D+5) connects at D+0 15:10 and is linked; everything runs up to `until`. */
async function tomLinkedUntil(until: number): Promise<{ tom: string; stayId: string }> {
  await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
  await setClock(at(0, '15:10'));
  const tom = await joined(R.tenant, { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true, guestId: 'g_tom' });
  await runUntil(until);
  const stayId = (await staysAt())[0].id;
  assertEqual((await stayDoc(stayId)).contactId, tom, 'Tom linked');
  return { tom, stayId };
}

const unlinkBy = (api: Api, stayId: string, contactId: string) => api.call('POST', `${RV}/stays/${stayId}/unlink`, { expectContactId: contactId, actor: OWNER_ACTOR });
const linkBackBy = (api: Api, stayId: string, contactId: string) => api.call('POST', `${RV}/stays/${stayId}/link`, { contactId, actor: OWNER_ACTOR });

async function main() {
  const api = await mountApi();
  try {
    console.log('\nCalendar link routes (PR D §1)\n');

    await test('stay-feed: GET / Check link / Sync now / PUT (masked) / DELETE; the linked guest masked with the stay id; 403 / 400', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
      await setupVenue(REST);
      let res = await api.get(`${RV}/stay-feed`);
      assertEqual(res.status, 200, 'GET');
      assertEqual([res.body.feed.url, res.body.feed.status, res.body.stays.length], ['sandbox:calendar/r', 'active', 1], 'the feed and its stay');
      const stayId = res.body.stays[0].stayId;
      assert(typeof stayId === 'string' && res.body.stays[0].linkedContactId === null && res.body.stays[0].linkedGuest === null, 'stay id; nobody linked yet');

      await setClock(at(0, '15:10'));
      const tomGuest = await connect({ venue: R, firstName: 'Tom', email: 'tom.owner@test.local', consent: true });
      await runDue();
      const tom = await contactIdFor(R.tenant, tomGuest);
      await db.collection(COL.contacts).doc(tom).update({ lastName: 'Keller' });
      res = await api.get(`${RV}/stay-feed`);
      const s = res.body.stays[0];
      assertEqual([s.stayId, s.linked, s.linkedContactId, s.linkedGuest.name, s.linkedBy, s.linkMode], [stayId, true, tom, 'Tom K.', 'guest', 'test'], 'linked, masked');
      assert(s.linkedGuest.email && !s.linkedGuest.email.includes('tom.owner@test.local'), `masked email: ${s.linkedGuest.email}`);

      res = await api.call('POST', `${RV}/stay-feed/check`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.ok, res.body.check.ok, res.body.check.upcoming], [200, true, true, 1], `Check link: ${res.text.slice(0, 200)}`);
      res = await api.call('POST', `${RV}/stay-feed/sync`, { actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.queued], [200, true], 'Sync now');
      assert((await tasksOfKind('stay_poll')).some((t) => t.status === 'queued' && t.payload?.manual === true), 'a manual poll is queued');

      // A real-looking link with its secret token: stored, but only ever shown masked. (Not synced: no network.)
      const secret = 'https://www.airbnb.com/calendar/ical/12345.ics?s=TOKENabcdef123';
      res = await api.call('PUT', `${RV}/stay-feed`, { url: secret, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.feed.url], [200, 'https://www.airbnb.com/….ics'], 'masked in the answer');
      assert(!res.text.includes('TOKENabcdef123'), 'no token in the PUT answer');
      assert(!(await api.get(`${RV}/stay-feed`)).text.includes('TOKENabcdef123'), 'no token in the GET answer');
      res = await api.call('PUT', `${RV}/stay-feed`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'the sandbox link back');

      // Ownership and venue type.
      assertEqual((await api.get(`/tenants/tenant_other/venues/${R.venueId}/stay-feed`)).status, 403, 'GET: another account → 403');
      assertEqual((await api.call('PUT', `/tenants/tenant_other/venues/${R.venueId}/stay-feed`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR })).status, 403, 'PUT: another account → 403');
      assertEqual((await api.call('POST', `/tenants/tenant_other/venues/${R.venueId}/stays/${stayId}/unlink`, { expectContactId: tom, actor: OWNER_ACTOR })).status, 403, 'unlink: another account → 403');
      const rest = await api.call('PUT', `/tenants/${R.tenant}/venues/${REST.venueId}/stay-feed`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
      assertEqual([rest.status, rest.body.code], [400, 'bad_request'], 'a restaurant → 400');
      assertEqual((await api.call('PUT', `${RV}/stay-feed`, { url: 'sandbox:calendar/r', actor: MCP_ACTOR })).status, 403, 'the MCP may not save a link');
      assertEqual((await api.call('POST', `${RV}/stays/stay_nope/unlink`, { expectContactId: tom, actor: OWNER_ACTOR })).status, 404, 'an unknown stay → 404');

      // While the account is off: the link is kept, but nothing is fetched.
      await setLaunch({ [R.tenant]: 'off' });
      res = await api.call('PUT', `${RV}/stay-feed`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.syncQueued], [200, false], 'saved while off: no sync queued');
      res = await api.call('POST', `${RV}/stay-feed/sync`, { actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.queued], [200, false], 'Sync now while off: nothing queued');
      await setLaunch({ [R.tenant]: 'test' });

      // Delete: polling stops; the linked stay keeps running.
      res = await api.call('DELETE', `${RV}/stay-feed`, { actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.deleted, res.body.cancelled], [200, true, 0], 'deleted (the linked stay is kept)');
      res = await api.get(`${RV}/stay-feed`);
      assertEqual([res.body.feed, res.body.stays], [null, []], 'no feed');
      assertEqual((await stayDoc(stayId)).status, 'confirmed', 'Tom\'s stay still runs');
    });

    await test('LEAKCHECK through the routes: a malformed link reaches no response, log line, feed field or task', async () => {
      await freshStay([]);
      const bad = 'https://www.airbnb.com:99999/x.ics?s=LEAKCHECK';
      const { result: bodies, logs } = await captureLogs(async () => {
        const out: string[] = [];
        for (const [method, path] of [
          ['PUT', `${RV}/stay-feed`],
          ['POST', `${RV}/stay-feed/check`],
        ]) {
          const res = await api.call(method, path, { url: bad, actor: OWNER_ACTOR });
          out.push(`${res.status} ${res.text}`);
        }
        // A link that isn't a string, and a far too long one.
        out.push(`${(await api.call('PUT', `${RV}/stay-feed`, { url: { href: bad }, actor: OWNER_ACTOR })).status}`);
        out.push(`${(await api.call('POST', `${RV}/stay-feed/check`, { url: `${bad}${'x'.repeat(3000)}`, actor: OWNER_ACTOR })).status}`);
        out.push((await api.get(`${RV}/stay-feed`)).text);
        return out;
      });
      assert(bodies.slice(0, 2).every((b) => b.startsWith('400 ')), `refused: ${bodies.slice(0, 2).join(' | ')}`);
      assertEqual(bodies.slice(2, 4), ['400', '400'], 'a non-string and a too-long link → 400');
      assert(!bodies.some((b) => b.includes('LEAKCHECK')), `a response leaks it: ${bodies.find((b) => b.includes('LEAKCHECK'))}`);
      assert(!logs.some((l) => l.includes('LEAKCHECK')), `a log line leaks it: ${logs.find((l) => l.includes('LEAKCHECK'))}`);
      const feed = (await db.collection(COL.stayFeeds).doc(FEED).get()).data()!;
      assert(!JSON.stringify(feed).includes('LEAKCHECK'), 'the feed was not changed');
      assert(!JSON.stringify(await tasksOfKind('stay_poll')).includes('LEAKCHECK'), 'no task has it');
    });

    console.log('\nUnlink and link by hand (D-C11, D-D8)\n');

    await test('unlink Tom: expectContactId required; his stay messages stop; never relinked; the next guest in the window gets the rest', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
      await setClock(at(0, '15:10'));
      const tom = await joined(R.tenant, { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true, guestId: 'g_tom' });
      await runUntil(at(0, '18:00'));
      const stayId = (await staysAt())[0].id;
      assertEqual((await stayDoc(stayId)).contactId, tom, 'Tom linked');
      assert((await sendLogOf(tom)).includes('stay_guide/welcome @ D+0 17:00'), 'Tom got the welcome');

      const path = `${RV}/stays/${stayId}/unlink`;
      assertEqual((await api.call('POST', path, { actor: OWNER_ACTOR })).status, 400, 'expectContactId is required');
      const wrong = await api.call('POST', path, { expectContactId: `${R.tenant}_${'f'.repeat(24)}`, actor: OWNER_ACTOR });
      assertEqual([wrong.status, wrong.body.code], [409, 'conflict'], 'a different expected guest → 409');
      assertEqual((await stayDoc(stayId)).contactId, tom, 'nothing changed');
      const res = await api.call('POST', path, { expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.unlinked], [200, true], `unlinked: ${res.text.slice(0, 200)}`);
      assertEqual([res.body.stays[0].linked, res.body.stays[0].linkedContactId], [false, null], 'the answer shows it unlinked');
      const again = await api.call('POST', path, { expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual([again.status, again.body.unlinked], [200, false], 'a repeated click changes nothing');
      let st = await stayDoc(stayId);
      assertEqual([st.contactId, st.linkSeq, st.unlinkedContactIds, st.unlinkedBy], [null, 1, [tom], OWNER_ACTOR.uid], 'the stay after the unlink');
      await runDue();
      const tomStays = (await docsWhere(COL.journeyInstances, 'contactId', tom)).filter((i) => i.context?.stayId === stayId);
      assert(tomStays.length > 0 && tomStays.every((i) => i.status !== 'active'), `Tom's stay journeys ended: ${tomStays.map((i) => `${i.journeyKey}:${i.status}`)}`);
      const exits = (await docsWhere(COL.journeyEvents, 'contactId', tom)).filter((e) => e.type === 'journey.exited' && e.data?.reason === 'stay_unlinked');
      assert(exits.length > 0, 'ended as stay_unlinked');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'stay.unlinked')).length, 1, 'one stay.unlinked event');

      // Tom reconnects: not relinked. Lisa connects in the window: linked, gets the remaining moments.
      await setClock(at(0, '19:00'));
      await connect({ venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true, guestId: 'g_tom' });
      await runDue();
      assertEqual((await stayDoc(stayId)).contactId, null, 'Tom is never linked again automatically');
      await setClock(at(0, '20:00'));
      const lisa = await joined(R.tenant, { venue: R, firstName: 'Lisa', email: 'lisa@test.local', consent: true });
      await runDue();
      st = await stayDoc(stayId);
      assertEqual([st.contactId, st.linkSeq, st.linkedBy], [lisa, 1, 'guest'], 'Lisa linked (link generation 1)');
      const lisaTriggers = (await tasksOfKind('stay_trigger')).filter((t) => t.payload?.contactId === lisa);
      assert(lisaTriggers.length > 0 && lisaTriggers.every((t) => t.payload.linkSeq === 1), 'her moment tasks carry the link generation');
      const tomTriggers = (await tasksOfKind('stay_trigger')).filter((t) => t.payload?.contactId === tom);
      assert(!lisaTriggers.some((t) => tomTriggers.some((x) => x.id === t.id)), 'new task ids, not the first link\'s');

      const unlinkedAt = at(0, '18:00');
      await runUntil(at(9, '12:00'));
      const tomLog = await sendLogOf(tom);
      assert(
        (await docsWhere(COL.journeySends, 'contactId', tom)).filter((x) => String(x.journeyKey).startsWith('stay_')).every((x) => x.createdAt.toMillis() < unlinkedAt),
        `Tom gets no stay message after the unlink: ${tomLog.join(', ')}`,
      );
      const lisaLog = (await sendLogOf(lisa)).map((l) => l.split(' @ ')[0]);
      for (const m of STAY_MOMENTS) assert(lisaLog.includes(m), `Lisa gets ${m}: ${lisaLog.join(', ')}`);
      const moments = (await docsWhere(COL.journeyEvents, 'type', 'stay.moment')).filter((e) => e.contactId === lisa);
      assert(moments.length >= 4, `her stay.moment events (${moments.length})`);
      const tl = await api.get(`${RV}/guests/${tom}?lang=en`);
      assert(tl.body.timeline.some((i: any) => i.kind === 'journey.exited' && /unlinked from this guest/.test(i.sentence)), 'Tom\'s timeline says why his stay messages ended');
    });

    await test('link by hand: the owner replaces a wrong link (expectContactId), the picked guest gets the remaining moments; guards', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }], { start: at(-1, '19:00') });
      await setClock(at(-1, '20:00')); // before the window opens (12 h before check-in): not linked
      const max = await joined(R.tenant, { venue: R, firstName: 'Max', email: 'max@test.local', consent: true });
      await runDue();
      const stayId = (await staysAt())[0].id;
      assertEqual((await stayDoc(stayId)).contactId, null, 'Max was too early to be linked');
      await setClock(at(0, '15:10'));
      const tom = await joined(R.tenant, { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true });
      await runDue();
      assertEqual((await stayDoc(stayId)).contactId, tom, 'Tom (the cleaner) linked first');

      const path = `${RV}/stays/${stayId}/link`;
      let res = await api.call('POST', path, { contactId: max, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.code], [409, 'conflict'], 'replacing someone needs expectContactId');
      res = await api.call('POST', path, { contactId: `${R.tenant}_${'a'.repeat(24)}`, expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual(res.status, 404, 'an unknown guest → 404');
      const stranger = `${R.tenant}_${'b'.repeat(24)}`;
      await db.collection(COL.contacts).doc(stranger).set({ tenantUserId: R.tenant, firstName: 'Nobody', guestIds: [] });
      res = await api.call('POST', path, { contactId: stranger, expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.code], [400, 'bad_request'], 'a guest never seen at this venue → 400');
      res = await api.call('POST', path, { contactId: max, expectContactId: tom, actor: MCP_ACTOR });
      assertEqual(res.status, 403, 'the MCP may not');

      res = await api.call('POST', path, { contactId: max, expectContactId: tom, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.linked], [200, true], `linked by hand: ${res.text.slice(0, 200)}`);
      const s = res.body.stays[0];
      assertEqual([s.linkedContactId, s.linkedBy, s.linkedGuest.name], [max, 'owner', 'Max'], 'the answer shows Max, linked by the owner');
      const st = await stayDoc(stayId);
      assertEqual([st.contactId, st.linkedBy, st.linkSeq, st.unlinkedContactIds, st.linkMode], [max, 'owner', 1, [tom], 'test'], 'the stay');
      const linkedEv = (await docsWhere(COL.journeyEvents, 'type', 'stay.linked')).filter((e) => e.contactId === max);
      assertEqual(linkedEv.map((e) => [e.data.linkedBy, e.data.linkSeq]), [['owner', 1]], 'stay.linked (by the owner, generation 1)');
      const same = await api.call('POST', path, { contactId: max, actor: OWNER_ACTOR });
      assertEqual([same.status, same.body.linked], [200, false], 'the same pick again changes nothing');

      await runUntil(at(9, '12:00'));
      const maxLog = (await sendLogOf(max)).map((l) => l.split(' @ ')[0]);
      for (const m of STAY_MOMENTS) assert(maxLog.includes(m), `Max gets ${m}: ${maxLog.join(', ')}`);
      const tomLog = (await sendLogOf(tom)).map((l) => l.split(' @ ')[0]);
      assert(!tomLog.some((l) => l.startsWith('stay_')), `Tom gets no stay message: ${tomLog.join(', ')}`);
      assertEqual((await stayDoc(stayId)).contactId, max, 'still Max');
    });

    console.log('\nLink back after an unlink (D-D8: the worker resumes)\n');

    await test('quick undo: unlink Tom, link him back → resuming; the Stay guide runs on from its wait (the next step on time, no second welcome or instance, no Checkout reminder beside it)', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(0, '18:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual([guide.status, guide.waiting?.nodeId, label(untilOf(guide))], ['active', 'mid_w', 'D+2 11:00'], 'the Stay guide waits for the mid-stay step');
      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked');
      await runDue();
      let g = await instanceDoc(guide.id);
      assertEqual([g.status, g.exitReason, g.waiting?.nodeId], ['cancelled', 'stay_unlinked', 'mid_w'], 'ended by the unlink, its wait kept');

      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.linked, res.body.resuming], [200, true, true], `linked back: ${res.text.slice(0, 200)}`);
      const st = await stayDoc(stayId);
      assertEqual([st.contactId, st.linkedBy, st.linkSeq, st.unlinkedContactIds], [tom, 'owner', 1, []], 'the stay is his again (link generation 1)');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'stay.relinked')).map((e) => [e.contactId, e.data?.linkSeq]), [[tom, 1]], 'one stay.relinked event');
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'nothing resumed in the API: the worker does it');

      await runDue();
      g = await instanceDoc(guide.id);
      assertEqual([g.status, g.exitReason ?? null, g.endedAt ?? null, g.waiting?.nodeId, label(untilOf(g))], ['active', null, null, 'mid_w', 'D+2 11:00'], 'active again, the same wait');
      assert(String(g.waiting?.token).endsWith(':relink1'), `the resumed wait's token: ${g.waiting?.token}`);
      const resumed = (await docsWhere(COL.journeyEvents, 'instanceId', guide.id)).filter((e) => e.type === 'journey.resumed');
      assertEqual(resumed.map((e) => [e.data?.reason, e.data?.linkSeq]), [['stay_relinked', 1]], 'a journey.resumed event');

      // The next step at its planned time.
      await runUntil(at(2, '12:00'));
      assert((await sendLogOf(tom)).includes('stay_guide/mid @ D+2 11:00'), `the mid-stay step on time: ${(await sendLogOf(tom)).join(', ')}`);
      await runUntil(at(9, '12:00'));
      const log = await sendLogOf(tom);
      assertEqual(log.filter((l) => l.startsWith('stay_guide/welcome')), ['stay_guide/welcome @ D+0 17:00'], 'the welcome once');
      assertEqual((await guideOf(tom, stayId)).length, 1, 'one Stay guide instance');
      assertEqual(
        log.filter((l) => l.startsWith('stay_guide/co') || l.startsWith('checkout_reminder/')),
        ['stay_guide/co @ D+4 17:00'],
        `one checkout message, from the Stay guide: ${log.join(', ')}`,
      );
      assert(!(await docsWhere(COL.journeyInstances, 'contactId', tom)).some((i) => i.journeyKey === 'checkout_reminder'), 'the Checkout reminder never started');
      assertEqual((await instanceDoc(guide.id)).status, 'completed', 'the Stay guide finished');
      const tl = await api.get(`${RV}/guests/${tom}?lang=en`);
      assert(
        tl.body.timeline.some((i: any) => i.kind === 'stay.relinked' && /linked this guest back to the booking/.test(i.sentence)),
        `the timeline says so: ${tl.body.timeline.map((i: any) => i.sentence).join(' | ')}`,
      );
    });

    await test('link back after the booking dates changed while unlinked: the resumed wait moves to the new checkout (the checkout message at the new time, not the old one)', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(2, '12:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual([guide.status, guide.waiting?.nodeId, label(untilOf(guide))], ['active', 'co_w', 'D+4 17:00'], 'waits for the checkout message (day before checkout)');
      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked');
      await runDue();
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'ended by the unlink');

      // While nobody is linked, the checkout moves a day later.
      await writeCalendar('r', [{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(6) }]);
      const r = await sync();
      assertEqual([r.outcome, r.changed], ['synced', 1], 'a date change during the gap');
      await runDue();
      assertEqual([(await stayDoc(stayId)).checkOut, (await instanceDoc(guide.id)).status], [day(6), 'cancelled'], 'the new dates; the journey still ended');

      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.resuming], [200, true], `linked back: ${res.text.slice(0, 200)}`);
      await runDue();
      const g = await instanceDoc(guide.id);
      assertEqual([g.status, g.waiting?.nodeId, label(untilOf(g))], ['active', 'co_w', 'D+5 17:00'], 'the resumed wait moved to the new checkout');
      await runUntil(at(10, '12:00'));
      const log = await sendLogOf(tom);
      assert(log.includes('stay_guide/co @ D+5 17:00'), `the checkout message at the new time: ${log.join(', ')}`);
      assert(!log.some((l) => l.startsWith('stay_guide/co @ D+4')), `not at the old time: ${log.join(', ')}`);
      assertEqual(log.filter((l) => l.startsWith('stay_guide/co') || l.startsWith('checkout_reminder/')).length, 1, 'one checkout message');
      assert(log.includes('stay_review/s1 @ D+6 15:00'), `the review ask on the new checkout day: ${log.join(', ')}`);
    });

    await test('link back long after: the step due while unlinked is skipped as stale (nothing sent late); the later steps still run', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(0, '18:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual([guide.waiting?.nodeId, label(untilOf(guide))], ['mid_w', 'D+2 11:00'], 'the mid-stay step is due on D+2 at 11:00');
      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked');
      await runDue();
      // Seven hours past the mid-stay step (the stale limit is 6 h by default).
      await setClock(at(2, '18:00'));
      await runDue();
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'still ended while unlinked');

      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.resuming], [200, true], `linked back: ${res.text.slice(0, 200)}`);
      await runDue();
      const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', guide.id)).filter((e) => e.type === 'send.skipped');
      assertEqual(skipped.map((e) => [e.nodeId, e.data?.decision?.reason]), [['mid', 'stale']], 'the mid-stay step skipped as stale');
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', guide.id)).map((s) => s.nodeId), ['welcome'], 'nothing sent late');
      const g = await instanceDoc(guide.id);
      assertEqual([g.status, g.waiting?.nodeId], ['active', 'co_w'], 'on to the checkout wait');

      await runUntil(at(9, '12:00'));
      const log = await sendLogOf(tom);
      assert(log.includes('stay_guide/co @ D+4 17:00'), `the checkout message still goes: ${log.join(', ')}`);
      assert(!log.some((l) => l.startsWith('stay_guide/mid')), `no mid-stay message: ${log.join(', ')}`);
      assert(log.includes('stay_review/s1 @ D+5 15:00'), `the review ask still goes: ${log.join(', ')}`);
    });

    await test('unlinked before the first step: link back → the Stay guide starts (past its first step, not stuck)', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(0), checkOut: day(5) }]);
      await setClock(at(0, '15:10'));
      const tom = await joined(R.tenant, { venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true, guestId: 'g_tom' });
      const stayId = (await staysAt())[0].id;
      await setClock(at(0, '17:00'));
      // One worker round at a time: the moment task creates the journey; its start task runs in the next round.
      let guide: AnyDoc | undefined;
      for (let i = 0; i < 5 && !guide; i += 1) {
        await worker.runDue(1);
        guide = (await guideOf(tom, stayId))[0];
      }
      assert(guide, 'the Stay guide was created');
      assertEqual([guide.status, guide.waiting?.nodeId], ['active', '__start'], 'created, its first step not run yet');

      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked before the start task ran');
      await runDue();
      let g = await instanceDoc(guide.id);
      assertEqual([g.status, g.exitReason, g.waiting?.nodeId], ['cancelled', 'stay_unlinked', '__start'], 'ended before its first step (the wait kept)');
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', guide.id)).length, 0, 'no welcome');

      await setClock(at(0, '17:05'));
      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.resuming], [200, true], `linked back: ${res.text.slice(0, 200)}`);
      await runDue();
      g = await instanceDoc(guide.id);
      assertEqual([g.status, g.waiting?.nodeId], ['active', 'mid_w'], `it started: past the welcome (${g.status} at ${g.waiting?.nodeId})`);
      assertEqual((await sendLogOf(tom)).filter((l) => l.startsWith('stay_guide/')), ['stay_guide/welcome @ D+0 17:05'], 'the welcome, once, on the re-link');
    });

    await test('unlink, link back, unlink again before the worker ran (a newer link generation): nothing is resumed, the journey stays ended', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(0, '18:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual([(await unlinkBy(api, stayId, tom)).body.unlinked, (await linkBackBy(api, stayId, tom)).body.resuming], [true, true], 'unlinked, linked back');
      const again = await unlinkBy(api, stayId, tom);
      assertEqual([again.status, again.body.unlinked], [200, true], 'unlinked again');
      const st = await stayDoc(stayId);
      assertEqual([st.contactId, st.linkSeq, st.unlinkedContactIds], [null, 2, [tom]], 'link generation 2, nobody linked');

      await runDue();
      const g = await instanceDoc(guide.id);
      assertEqual([g.status, g.exitReason], ['cancelled', 'stay_unlinked'], 'still ended as unlinked');
      assert(!String(g.waiting?.token ?? '').includes(':relink'), `its wait was not resumed: ${g.waiting?.token}`);
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'journey.resumed')).length, 0, 'no journey.resumed');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'stay.relinked')).length, 1, 'the re-link event was written (and found the newer generation)');

      await runUntil(at(9, '12:00'));
      const stayMsgs = (await docsWhere(COL.journeySends, 'contactId', tom)).filter((x) => String(x.journeyKey).startsWith('stay_') || x.journeyKey === 'checkout_reminder');
      assertEqual(stayMsgs.map((x) => x.nodeId), ['welcome'], `no stay message after the unlinks: ${(await sendLogOf(tom)).join(', ')}`);
      assertEqual((await stayDoc(stayId)).contactId, null, 'nobody linked');
    });

    await test('re-link pending: Tom reconnects and a calendar change arrives before the re-link handler ran → no stay moment is scheduled until it has; then the Stay guide resumes and one checkout message goes (no Checkout reminder beside it)', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(2, '12:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual([guide.waiting?.nodeId, label(untilOf(guide))], ['co_w', 'D+4 17:00'], 'waits for the checkout message');
      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked');
      await runDue();
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'ended by the unlink');

      // The owner links Tom back just after the checkout moment (D+4 17:00: the Stay guide's step and the Checkout reminder's).
      await setClock(at(4, '17:20'));
      await runDue();
      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.resuming], [200, true], `linked back: ${res.text.slice(0, 200)}`);
      const retry = await linkBackBy(api, stayId, tom);
      assertEqual([retry.status, retry.body.linked, retry.body.resuming], [200, false, true], 'a repeated click: still resuming (the worker does the follow-up)');
      // The worker picks up Tom's reconnect and a calendar change before the re-link (its task held back an hour).
      const relinkTask = db.collection(COL.journeyTasks).doc(taskIdFor(`event:${relinkedEventId(stayId, 1)}`));
      assertEqual((await relinkTask.get()).get('status'), 'queued', 'the re-link task is queued');
      await relinkTask.update({ dueAt: new Date(now() + HOUR_MS) });
      await writeCalendar('r', [{ uid: 'tom@airbnb.test', checkIn: day(-1), checkOut: day(5) }]);
      const r = await sync();
      assertEqual([r.outcome, r.changed], ['synced', 1], 'a date change (an earlier check-in): stay.changed');
      await connect({ venue: R, firstName: 'Tom', email: 'tom@test.local', consent: true, guestId: 'g_tom' });
      await runDue();
      assertEqual((await relinkTask.get()).get('status'), 'queued', 'the re-link handler has not run yet');
      const gen1Triggers = async () => (await tasksOfKind('stay_trigger')).filter((t) => t.payload?.contactId === tom && t.payload?.linkSeq === 1);
      assertEqual((await gen1Triggers()).map((t) => t.payload.journeyKey), [], 'no stay moment scheduled by the connect or the date change');
      assertEqual((await eventRef(linkMarkId(stayId, 1)).get()).exists, false, 'no link mark for generation 1 yet');
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'the Stay guide not resumed yet');
      assert(!(await docsWhere(COL.journeyInstances, 'contactId', tom)).some((i) => i.journeyKey === 'checkout_reminder'), 'no Checkout reminder started');

      // The re-link handler runs: the Stay guide first, then the moments.
      await relinkTask.update({ dueAt: new Date(now()) });
      await runDue();
      assertEqual((await relinkTask.get()).get('status'), 'done', 'the re-link handler ran');
      const resumed = (await docsWhere(COL.journeyEvents, 'instanceId', guide.id)).filter((e) => e.type === 'journey.resumed');
      assertEqual(resumed.map((e) => e.data?.reason), ['stay_relinked'], 'the Stay guide resumed');
      assert((await sendLogOf(tom)).includes('stay_guide/co @ D+4 17:20'), `its checkout message, at once: ${(await sendLogOf(tom)).join(', ')}`);
      const triggers = await gen1Triggers();
      assert(triggers.some((t) => t.payload.journeyKey === 'checkout_reminder'), `the moments scheduled after the resume: ${triggers.map((t) => t.payload.journeyKey)}`);
      assertEqual((await eventRef(linkMarkId(stayId, 1)).get()).exists, true, 'the link mark for generation 1');

      await runUntil(at(9, '12:00'));
      const log = await sendLogOf(tom);
      assertEqual(
        log.filter((l) => l.startsWith('stay_guide/co') || l.startsWith('checkout_reminder/')),
        ['stay_guide/co @ D+4 17:20'],
        `one checkout message, from the Stay guide: ${log.join(', ')}`,
      );
      assert(!(await docsWhere(COL.journeyInstances, 'contactId', tom)).some((i) => i.journeyKey === 'checkout_reminder'), 'the Checkout reminder never started');
      assertEqual((await guideOf(tom, stayId)).length, 1, 'one Stay guide instance');
    });

    await test('link back when the kept wait is a send with no time of its own (stopped at its live claim): re-armed at the step\'s own time → skipped as stale, nothing sent late', async () => {
      const { tom, stayId } = await tomLinkedUntil(at(0, '18:00'));
      const guide = (await guideOf(tom, stayId))[0];
      assertEqual((await unlinkBy(api, stayId, tom)).status, 200, 'unlinked');
      await runDue();
      assertEqual((await instanceDoc(guide.id)).status, 'cancelled', 'ended by the unlink');
      await setClock(at(2, '12:00'));
      await runDue();

      // Written directly: what a live claim that found the stay unlinked leaves — the mid-stay send's
      // temporary wait (no time of its own), entered two days ago.
      const enteredAt = now() - 2 * DAY_MS;
      const token = `mid@${enteredAt}:send`;
      await db
        .collection(COL.journeyInstances)
        .doc(guide.id)
        .update({ cursor: { nodeId: 'mid', enteredAt: new Date(enteredAt) }, waiting: { kind: 'send_due', nodeId: 'mid', token, untilAt: null } });
      const g0 = await instanceDoc(guide.id);
      assertEqual([g0.status, g0.exitReason, g0.waiting?.kind, g0.waiting?.untilAt], ['cancelled', 'stay_unlinked', 'send_due', null], 'the kept wait has no time');

      const res = await linkBackBy(api, stayId, tom);
      assertEqual([res.status, res.body.resuming], [200, true], `linked back: ${res.text.slice(0, 200)}`);
      await runDue();
      const task = (await db.collection(COL.journeyTasks).doc(taskIdFor(`node:${guide.id}:${token}:relink1`)).get()).data();
      assert(task, 'the resumed send got its task back');
      assertEqual([task.payload?.input, task.payload?.nodeId, task.dueAt.toMillis()], ['send_due', 'mid', enteredAt], "armed at the step's own time, not at the re-link");
      const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', guide.id)).filter((e) => e.type === 'send.skipped');
      assertEqual(skipped.map((e) => [e.nodeId, e.data?.decision?.reason]), [['mid', 'stale']], 'the mid-stay send skipped as stale');
      assert(/too late/.test(String(skipped[0].data?.decision?.checks?.[0]?.fact)), `says how late: ${JSON.stringify(skipped[0].data?.decision?.checks)}`);
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', guide.id)).map((s) => s.nodeId), ['welcome'], 'nothing sent late');
      const g = await instanceDoc(guide.id);
      assertEqual([g.status, g.waiting?.nodeId], ['active', 'co_w'], 'on to the checkout wait');
    });

    console.log('\nGuest info content (PR D §2)\n');

    await test('guest info: 422 with issues, baseVersion 409, the Wi-Fi card then sends, per-field English fallback', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(G);
      await setClock(nextTuesday1240());
      await setLaunch({ [G.tenant]: 'test' });
      const V = `/tenants/${G.tenant}/venues/${G.venueId}`;
      let res = await api.get(`${V}/guest-info`);
      assertEqual([res.status, res.body.guestInfo, res.body.enabled], [200, null, true], 'nothing saved yet; Guest info on');
      assert(res.body.warnings.some((w: any) => w.code === 'GI10'), 'warns: no Wi-Fi name');

      const put = (body: Record<string, unknown>, actor: unknown = OWNER_ACTOR) => api.call('PUT', `${V}/guest-info`, { ...body, actor });
      res = await put({ locales: { en: { checkInTime: '10 Uhr', wifiName: 'Cafe' } }, baseVersion: 0 });
      assertEqual([res.status, res.body.code], [422, 'validation_failed'], '"10 Uhr" → 422');
      assert(res.body.issues.some((i: any) => i.code === 'GI02' && i.path === 'locales.en.checkInTime'), `with the issue: ${JSON.stringify(res.body.issues)}`);
      res = await put({ locales: { en: { checkOutTime: '23:30' } }, baseVersion: 0 });
      assert(res.status === 422 && res.body.issues.some((i: any) => i.code === 'GI02'), 'outside 06:00–22:00 → 422');
      res = await put({ locales: { en: { menuUrl: 'javascript:alert(1)', hostContactUrl: 'data:text/html,x' } }, baseVersion: 0 });
      assertEqual([res.status, res.body.issues.filter((i: any) => i.code === 'GI03').length], [422, 2], 'javascript: / data: links → 422');
      res = await put({ locales: { xx: { wifiName: 'Cafe' } }, baseVersion: 0 });
      assert(res.status === 422 && res.body.issues.some((i: any) => i.code === 'GI01'), 'an unknown language → 422');
      assertEqual((await put({ locales: { en: { wifiNme: 'typo' } }, baseVersion: 0 })).status, 400, 'an unknown field → 400');
      assertEqual((await put({ locales: { en: { wifiName: 'x'.repeat(101) } }, baseVersion: 0 })).status, 400, 'too long → 400');
      assertEqual((await put({ locales: { en: { wifiName: 'Cafe' } } })).status, 400, 'baseVersion is required');
      assertEqual((await put({ locales: { en: { wifiName: 'Cafe' } }, baseVersion: 0 }, MCP_ACTOR)).status, 403, 'the MCP may not');
      assertEqual((await api.get(`/tenants/tenant_other/venues/${G.venueId}/guest-info`)).status, 403, 'another account → 403');
      assertEqual((await api.get(`${V}/guest-info`)).body.guestInfo, null, 'nothing was saved by the refused writes');

      // English has the Wi-Fi name; German has only its own house rules (no Wi-Fi name).
      res = await put({
        locales: {
          en: { wifiName: 'Cafe Guest', wifiPassword: 'pw-CAFE-1', houseRules: 'No smoking', menuUrl: 'https://cafe.example/menu', hostContactUrl: 'tel:+41790000000' },
          de: { houseRules: 'Nicht rauchen', wifiName: '   ' },
        },
        baseVersion: 0,
      });
      assertEqual([res.status, res.body.guestInfo.version, res.body.guestInfo.updatedBy], [200, 1, OWNER_ACTOR.uid], `saved: ${res.text.slice(0, 200)}`);
      assertEqual(res.body.guestInfo.locales.de, { houseRules: 'Nicht rauchen' }, 'empty values dropped');
      assertEqual(res.body.guestInfo.locales.en.wifiPassword, 'pw-CAFE-1', 'the owner sees the password');
      res = await put({ locales: { en: { wifiName: 'Overwrite' } }, baseVersion: 0 });
      assertEqual([res.status, res.body.code], [409, 'conflict'], 'a stale baseVersion → 409');
      assertEqual((await api.get(`${V}/guest-info`)).body.guestInfo.locales.en.wifiName, 'Cafe Guest', 'not overwritten');

      // A German guest: the Wi-Fi card goes (with the English Wi-Fi name), not `guest_info_missing`.
      await connect({ venue: G, firstName: 'Jonas', email: 'jonas@test.local', consent: false, language: 'de' });
      await runDue();
      const skips = (await docsWhere(COL.journeyEvents, 'type', 'send.skipped')).filter((e) => e.data?.decision?.reason === 'guest_info_missing');
      assertEqual(skips.length, 0, 'not guest_info_missing');
      const card = (await docsWhere(COL.journeySends, 'venueId', G.venueId)).find((x) => x.journeyKey === 'wifi_info_card');
      assert(card, 'a Wi-Fi card went out (test run)');
      assert(String(card.content.preview).includes('Cafe Guest'), `German card with the English Wi-Fi name: ${card.content.preview}`);
      assert(!String(card.content.preview).includes('pw-CAFE-1'), 'the stored preview masks the password');
      res = await put({ locales: { de: null }, baseVersion: 1 });
      assertEqual([res.status, res.body.guestInfo.version, Object.keys(res.body.guestInfo.locales)], [200, 2, ['en']], 'null removes a language');
      assertEqual(res.body.resynced, false, 'no calendar here: nothing to sync');
    });

    await test('guest info: a changed check-out time queues a calendar sync; an unchanged one does not', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(2), checkOut: day(5) }]);
      await runDue();
      const V = RV;
      const before = (await tasksOfKind('stay_poll')).filter((t) => t.status === 'queued' && t.payload?.manual === true).length;
      let res = await api.call('PUT', `${V}/guest-info`, { locales: { en: { wifiName: 'Retreat Guest', checkInTime: '15:00', checkOutTime: '10:00', localTips: 'Bakery', directBookingUrl: 'https://retreat.example/book' } }, baseVersion: 0, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.resynced], [200, false], 'the same times: no sync');
      res = await api.call('PUT', `${V}/guest-info`, { locales: { en: { wifiName: 'Retreat Guest', checkInTime: '15:00', checkOutTime: '11:00' }, de: { checkOutTime: '11:00' } }, baseVersion: 1, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.resynced, res.body.resolvedTimes.checkOut], [200, true, '11:00'], 'a new check-out time: a sync is queued');
      const after = (await tasksOfKind('stay_poll')).filter((t) => t.status === 'queued' && t.payload?.manual === true).length;
      assert(after > before, 'a manual stay_poll task');
      await runDue();
      const stay = (await staysAt())[0];
      assertEqual(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(stay.checkOutAt.toDate()), '11:00', 'the stay moved to the new time at once');
      void sync;
    });

    await test('guest info: two check-out changes in one engine minute, the first sync already run → two stay_poll tasks (…:gi1, …:gi2); both answered resynced', async () => {
      await freshStay([{ uid: 'tom@airbnb.test', checkIn: day(2), checkOut: day(5) }]);
      await runDue();
      const t = at(0, '09:30') + 500; // just after a minute starts: both saves fall in it
      await setClock(t);
      const minute = Math.floor(t / 60_000);
      const taskOf = (version: number) => db.collection(COL.journeyTasks).doc(taskIdFor(`stay_sync:${FEED}:${minute}:gi${version}`));
      const put = (checkOut: string, baseVersion: number) =>
        api.call('PUT', `${RV}/guest-info`, { locales: { en: { wifiName: 'Retreat Guest', checkInTime: '15:00', checkOutTime: checkOut } }, baseVersion, actor: OWNER_ACTOR });
      const checkOutOfStay = async () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format((await staysAt())[0].checkOutAt.toDate());

      let res = await put('11:00', 0);
      assertEqual([res.status, res.body.resynced, res.body.guestInfo.version], [200, true, 1], `first change: ${res.text.slice(0, 200)}`);
      const first = (await taskOf(1).get()).data();
      assert(first && first.kind === 'stay_poll' && first.payload?.manual === true && first.status === 'queued', 'a manual stay_poll task for version 1');
      await runDue();
      assertEqual((await taskOf(1).get()).get('status'), 'done', 'the first sync ran');
      assertEqual(await checkOutOfStay(), '11:00', 'the stay moved to 11:00');

      assertEqual(Math.floor(now() / 60_000), minute, 'still the same engine minute');
      res = await put('12:00', 1);
      assertEqual([res.status, res.body.resynced, res.body.guestInfo.version], [200, true, 2], `second change: ${res.text.slice(0, 200)}`);
      const second = (await taskOf(2).get()).data();
      assert(second && second.kind === 'stay_poll' && second.payload?.manual === true && second.status === 'queued', 'a second task for version 2 (not the done one again)');
      const manual = (await tasksOfKind('stay_poll')).filter((x) => x.payload?.manual === true && (x.id === taskOf(1).id || x.id === taskOf(2).id));
      assertEqual(manual.length, 2, 'two separate stay_poll docs');
      await runDue();
      assertEqual([(await taskOf(2).get()).get('status'), await checkOutOfStay()], ['done', '12:00'], 'the second sync ran: the stay moved to 12:00');

      // The same times again (a wording change only): no sync, no task for version 3.
      res = await api.call('PUT', `${RV}/guest-info`, { locales: { en: { wifiName: 'Retreat Guest 2', checkInTime: '15:00', checkOutTime: '12:00' } }, baseVersion: 2, actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.resynced], [200, false], 'unchanged times: no sync');
      assertEqual((await taskOf(3).get()).exists, false, 'no task for version 3');
    });

    console.log('\nWho gets messages + the estimate (PR D §3)\n');

    await test('audience: counts from the guest docs; PUT → the gate follows it (SMS to an unverified number skipped, email goes); the estimate prices it', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(AU);
      await setClock(nextTuesday1240());
      await setLaunch({ [AU.tenant]: 'test' });
      const V = `/tenants/${AU.tenant}/venues/${AU.venueId}`;
      // The guests of the last 30 days, as the portal saves them (flags from the verification gate).
      // `phoneE164` as the verification gate writes it for every parseable number (services/verificationGate.ts).
      const g = (id: string, d: Record<string, unknown>) =>
        db
          .collection(COL.guests)
          .doc(id)
          .set({ captivePortalAccessPointId: AU.apId, marketingOptIn: true, createdAt: new Date(), email: '', phone: '', ...(d.phone ? { phoneE164: `+41${d.phone}` } : {}), ...d });
      await g('v1', { phone: '791110101', phoneVerified: true, email: 'v1@test.local' });
      await g('v2', { phone: '791110102', phoneVerified: true });
      for (let i = 0; i < 5; i += 1) await g(`u1_${i}`, { phone: `79111020${i}`, email: `u1_${i}@test.local`, emailVerified: true });
      for (let i = 0; i < 5; i += 1) await g(`u2_${i}`, { phone: `79111030${i}` });
      await g('e1', { email: 'e1@test.local', emailVerified: true });
      await g('e2', { email: 'e2@test.local' });
      // A UK number: the engine doesn't text it (not in the SMS countries), so it counts by email only.
      await g('uk', { phone: '7700900123', phoneE164: '+447700900123', phoneVerified: true, email: 'uk@test.local' });
      await g('n1', { phone: '791110401', marketingOptIn: false });
      await g('old', { phone: '791110402', phoneVerified: true, createdAt: new Date(Date.now() - 40 * 86_400_000) });

      let res = await api.get(`${V}/audience`);
      assertEqual(res.status, 200, 'GET audience');
      assertEqual([res.body.audience, res.body.isDefault], [{ sms: 'verified', email: 'all' }, true], 'the default');
      assertEqual(res.body.counts.sms, { verified: 2, unverified: 10 }, 'SMS counts');
      assertEqual(res.body.counts.email, { verified: 6, unverified: 3 }, 'email counts');
      assertEqual(res.body.counts.smsOtherCountries, 1, 'a number SMS does not go to');
      assert(typeof res.body.counts.basis === 'string', 'the basis');

      // The estimate prices reachable guests only: fewer credits with "verified only".
      const est = async (sms: 'verified' | 'all') => {
        const r = await api.call('POST', `/tenants/${AU.tenant}/setups/estimate`, { playbookKey: 'restaurant_growth', venueIds: [AU.venueId], journeys: {}, audience: { [AU.venueId]: { sms, email: 'all' } } });
        assertEqual(r.status, 200, `estimate (${sms}): ${r.text.slice(0, 200)}`);
        return r.body.estimate;
      };
      const verified = await est('verified');
      const all = await est('all');
      assert(verified.creditsPerMonth < all.creditsPerMonth, `verified only costs less: ${verified.creditsPerMonth} vs ${all.creditsPerMonth}`);
      assertEqual(verified.audience[AU.venueId].counts.sms, { verified: 2, unverified: 10 }, 'the counts come with the estimate');
      assertEqual(verified.audience[AU.venueId].audience, { sms: 'verified', email: 'all' }, 'the choice priced');
      assert(verified.perVenue[0].optedInPerMonth < all.perVenue[0].optedInPerMonth, 'unreachable guests are not counted');

      // Guards.
      assertEqual((await api.call('PUT', `${V}/audience`, { sms: 'some', email: 'all', actor: OWNER_ACTOR })).status, 400, 'a bad choice → 400');
      assertEqual((await api.call('PUT', `${V}/audience`, { sms: 'all', email: 'all' })).status, 400, 'no actor → 400');
      assertEqual((await api.call('PUT', `${V}/audience`, { sms: 'all', email: 'all', actor: MCP_ACTOR })).status, 403, 'the MCP → 403');
      assertEqual((await api.call('PUT', `/tenants/tenant_other/venues/${AU.venueId}/audience`, { sms: 'all', email: 'all', actor: OWNER_ACTOR })).status, 403, 'another account → 403');
      await db.collection(COL.venues).doc('venue_au_new').set({ tenantUserId: AU.tenant, venue_name: 'New', venue_type: 'restaurant', timezone: TZ, isActive: true });
      const notSetUp = await api.call('PUT', `/tenants/${AU.tenant}/venues/venue_au_new/audience`, { sms: 'all', email: 'all', actor: OWNER_ACTOR });
      assertEqual([notSetUp.status, notSetUp.body.code], [409, 'conflict'], 'not set up yet → 409');
      assert(!(await db.collection(COL.adaptiveVenues).doc('venue_venue_au_new').get()).exists, 'no partial AdaptiveVenues doc');

      // Saved: verified only → an unverified number with an email gets the email.
      const updatedAt = (await db.collection(COL.adaptiveVenues).doc(`venue_${AU.venueId}`).get()).get('updatedAt').toMillis();
      res = await api.call('PUT', `${V}/audience`, { sms: 'verified', email: 'all', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.audience, res.body.isDefault], [200, { sms: 'verified', email: 'all' }, false], 'saved');
      const av = (await db.collection(COL.adaptiveVenues).doc(`venue_${AU.venueId}`).get()).data()!;
      assertEqual([av.audience, av.audienceUpdatedBy, av.updatedAt.toMillis(), av.status], [{ sms: 'verified', email: 'all' }, OWNER_ACTOR.uid, updatedAt, 'on'], 'named fields only');
      clearCaches();
      const unv = await joined(AU.tenant, { venue: AU, email: 'unverified@test.local', phone: '791110501', phoneCountryCode: '+41', phoneVerified: false, consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const s1 = (await docsWhere(COL.journeySends, 'contactId', unv)).find((x) => x.nodeId === 's1')!;
      assertEqual(s1.channel, 'email', 'email goes');
      assert(s1.decision.channel.rejected.some((r: any) => r.channel === 'sms' && r.reason === 'audience'), 'SMS skipped as audience');

      // Everyone who said yes → the same kind of guest gets the SMS.
      res = await api.call('PUT', `${V}/audience`, { sms: 'all', email: 'all', actor: OWNER_ACTOR });
      assertEqual(res.body.audience, { sms: 'all', email: 'all' }, 'saved: all');
      clearCaches();
      const unv2 = await joined(AU.tenant, { venue: AU, email: 'unverified2@test.local', phone: '791110502', phoneCountryCode: '+41', phoneVerified: false, consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const s2 = (await docsWhere(COL.journeySends, 'contactId', unv2)).find((x) => x.nodeId === 's1')!;
      assertEqual(s2.channel, 'sms', 'SMS to everyone who said yes');
    });

    await test('audience saved with the setup (PUT /setups audience) is kept by later setup saves', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(AU);
      const body = (extra: Record<string, unknown>) => ({
        playbookKey: 'restaurant_growth',
        venueIds: [AU.venueId],
        journeys: {},
        timezones: { [AU.venueId]: TZ },
        overlapAck: { [AU.venueId]: true },
        activate: true,
        actor: OWNER_ACTOR,
        ...extra,
      });
      let res = await api.call('PUT', `/tenants/${AU.tenant}/setups`, body({ audience: { [AU.venueId]: { sms: 'all', email: 'verified' } } }));
      assertEqual(res.status, 200, `PUT /setups with audience: ${res.text.slice(0, 200)}`);
      assertEqual((await api.get(`/tenants/${AU.tenant}/venues/${AU.venueId}/audience`)).body.audience, { sms: 'all', email: 'verified' }, 'saved with the setup');
      res = await api.call('PUT', `/tenants/${AU.tenant}/setups`, body({}));
      assertEqual(res.status, 200, 'a later save without it');
      assertEqual((await api.get(`/tenants/${AU.tenant}/venues/${AU.venueId}/audience`)).body.audience, { sms: 'all', email: 'verified' }, 'kept');
    });

    console.log('\nSend test (PR D §7)\n');

    await test('test send: only a saved recipient; the sandbox outbox gets it; no send record, event or short link; counter +1; 429 at the cap; refused while off', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(TS);
      await setClock(nextTuesday1240());
      const V = `/tenants/${TS.tenant}/venues/${TS.venueId}`;
      await seedTestRecipients(TS.tenant, [
        { id: 'phone_me', kind: 'phone', value: '+41791239999' },
        { id: 'mail_me', kind: 'email', value: 'owner.test@test.local' },
        { id: 'phone_us', kind: 'phone', value: '+12025550123' },
      ]);
      const send = (body: Record<string, unknown>, actor: unknown = OWNER_ACTOR) => api.call('POST', `${V}/test-send`, { journeyKey: A1, ...body, actor });

      // Launch off: refused (stage 0 does nothing).
      let res = await send({ channel: 'sms', recipientId: 'phone_me' });
      assertEqual([res.status, res.body.code], [409, 'conflict'], 'refused while off');
      await setLaunch({ [TS.tenant]: 'test' });

      const counts = async () => [await countDocs(COL.journeySends), await countDocs(COL.journeyEvents), await countDocs('CaptivePortal_ShortLinks')];
      const before = await counts();
      res = await send({ channel: 'sms', recipientId: 'phone_me' });
      assertEqual([res.status, res.body.sent, res.body.channel], [200, true, 'sms'], `sent: ${res.text.slice(0, 300)}`);
      assert(!res.text.includes('+41791239999') && !res.text.includes('791239999'), `the answer masks the number: ${res.body.to}`);
      assert(typeof res.body.preview.text === 'string' && res.body.preview.text.length > 0, 'a preview');
      const ob = (await outbox()).filter((o) => String(o.id).startsWith('test_'));
      assertEqual(ob.length, 1, 'one message in the sandbox outbox');
      assertEqual([ob[0].channel, ob[0].to], ['sms', '+41791239999'], 'to the saved number');
      assert(String(ob[0].text ?? ob[0].body).includes('Anna'), 'rendered for the sample guest Anna');
      res = await send({ channel: 'email', recipientId: 'mail_me', lang: 'de' });
      assertEqual([res.status, res.body.sent], [200, true], 'an email test');
      const mail = (await outbox()).find((o) => String(o.id).startsWith('test_') && o.channel === 'email')!;
      assert(mail && String(mail.subject).startsWith('[Test]') && !mail.unsubscribeUrl, 'a [Test] email without an unsubscribe link');
      assertEqual(await counts(), before, 'no send record, no event, no short link');
      const day = new Date().toISOString().slice(0, 10);
      const counter = db.collection('CaptivePortal_TestSendCounters').doc(`${TS.tenant}_${day}`);
      assertEqual((await counter.get()).get('count'), 2, 'the shared daily counter, +1 each');

      // Only saved recipients, of the right kind; allowed countries only.
      assertEqual((await send({ channel: 'sms', recipientId: 'nobody' })).status, 400, 'an unknown recipient → 400');
      assertEqual((await send({ channel: 'sms', recipientId: 'mail_me' })).status, 400, 'an email recipient for an SMS → 400');
      assertEqual((await send({ channel: 'sms', recipientId: 'phone_us' })).status, 400, 'a country SMS is not allowed to → 400');
      assertEqual((await send({ channel: 'sms', recipientId: 'phone_me', to: '+41790000001' } as any)).status, 200, 'an address in the body is ignored');
      assertEqual((await outbox()).filter((o) => o.to === '+41790000001').length, 0, '…nothing went to it');
      assertEqual((await send({ channel: 'sms', recipientId: 'phone_me' }, MCP_ACTOR)).status, 403, 'the MCP may not');
      assertEqual((await api.call('POST', `/tenants/tenant_other/venues/${TS.venueId}/test-send`, { journeyKey: A1, channel: 'sms', recipientId: 'phone_me', actor: OWNER_ACTOR })).status, 403, 'another account → 403');
      assertEqual((await send({ journeyKey: 'stay_guide', channel: 'email', recipientId: 'mail_me' })).status, 404, 'a journey not set up here → 404');

      // The cap (the rate card's testSendDailyLimit, 20): 429, nothing sent.
      await counter.set({ count: 20 }, { merge: true });
      const sentBefore = (await outbox()).length;
      res = await send({ channel: 'sms', recipientId: 'phone_me' });
      assertEqual([res.status, res.body.code], [429, 'rate_limited'], 'at the cap → 429');
      assertEqual((await outbox()).length, sentBefore, 'nothing sent at the cap');
    });

    await test('test send: a saved 0041… number goes to +41…; a national number → 400 (nothing sent, counter unchanged); per-field fallback for the booking link; no Guest info → 422 guest_info_missing', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(R); // the Airbnb setup (stay journeys + Guest info on), no Guest info content yet
      await setClock(nextTuesday1240());
      await setLaunch({ [R.tenant]: 'test' });
      await seedTestRecipients(R.tenant, [
        { id: 'phone_00', kind: 'phone', value: '0041791239999' },
        { id: 'phone_nat', kind: 'phone', value: '0791239999' },
      ]);
      const send = (body: Record<string, unknown>) => api.call('POST', `${RV}/test-send`, { ...body, actor: OWNER_ACTOR });
      const counter = db.collection('CaptivePortal_TestSendCounters').doc(`${R.tenant}_${new Date().toISOString().slice(0, 10)}`);
      const count = async () => Number((await counter.get()).get('count') ?? 0);
      const sentTests = async () => (await outbox()).filter((o) => String(o.id).startsWith('test_'));
      const textOf = (o: AnyDoc) => String(o.text ?? o.body ?? '');

      // Empty Guest info: the welcome's info-page link is withheld → 422, nothing sent, nothing counted.
      let res = await send({ journeyKey: 'stay_guide', nodeId: 'welcome', channel: 'sms', recipientId: 'phone_00' });
      assertEqual([res.status, res.body.code, res.body.reason], [422, 'validation_failed', 'guest_info_missing'], `empty Guest info: ${res.text.slice(0, 300)}`);
      assert(Array.isArray(res.body.missing) && res.body.missing.includes('link.hub'), `names the missing link: ${JSON.stringify(res.body.missing)}`);
      assertEqual([await count(), (await sentTests()).length], [0, 0], 'nothing sent, nothing counted');

      // Guest info: the booking link in English only; German has only a Wi-Fi name.
      res = await api.call('PUT', `${RV}/guest-info`, { locales: { en: { directBookingUrl: 'https://x.ch/book' }, de: { wifiName: 'Haus' } }, baseVersion: 0, actor: OWNER_ACTOR });
      assertEqual(res.status, 200, `Guest info saved: ${res.text.slice(0, 200)}`);

      // A saved '0041…' number: normalised to +41….
      res = await send({ journeyKey: 'stay_guide', nodeId: 'welcome', channel: 'sms', recipientId: 'phone_00' });
      assertEqual([res.status, res.body.sent], [200, true], `0041…: ${res.text.slice(0, 300)}`);
      assertEqual((await sentTests()).map((o) => [o.channel, o.to]), [['sms', '+41791239999']], 'sent to +41791239999');
      assertEqual(await count(), 1, 'counted once');

      // A national number (no country code): 400 before anything is sent or counted.
      res = await send({ journeyKey: 'stay_guide', nodeId: 'welcome', channel: 'sms', recipientId: 'phone_nat' });
      assertEqual([res.status, res.body.code], [400, 'bad_request'], 'a national number → 400');
      assert(/international format/.test(String(res.body.error)), `says why: ${res.body.error}`);
      assertEqual([await count(), (await sentTests()).length], [1, 1], 'nothing sent, the counter unchanged');

      // Book direct in German: German has no booking link, so the English one is used (per field).
      res = await send({ journeyKey: 'stay_book_direct', nodeId: 's', channel: 'sms', recipientId: 'phone_00', lang: 'de' });
      assertEqual([res.status, res.body.sent], [200, true], `book direct (de): ${res.text.slice(0, 300)}`);
      const bd = (await sentTests()).find((o) => textOf(o).includes('https://x.ch/book'));
      assert(bd && /direkt bei uns/.test(textOf(bd)), `German wording with the English booking link: ${bd ? textOf(bd) : 'none'}`);
      assertEqual(await count(), 2, 'counted');

      // No booking link in any language: 422 booking_link_missing, nothing sent or counted.
      res = await api.call('PUT', `${RV}/guest-info`, { locales: { en: null }, baseVersion: 1, actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'English removed');
      res = await send({ journeyKey: 'stay_book_direct', nodeId: 's', channel: 'sms', recipientId: 'phone_00', lang: 'de' });
      assertEqual([res.status, res.body.reason], [422, 'booking_link_missing'], `no booking link: ${res.text.slice(0, 300)}`);
      assertEqual([await count(), (await sentTests()).length], [2, 2], 'nothing sent, the counter unchanged');
    });

    await test('test send in a language the wording lacks (fr): 200, the English wording with the English STOP line (wordingLang en); German keeps its own', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(TS);
      await setClock(nextTuesday1240());
      await setLaunch({ [TS.tenant]: 'test' });
      await seedTestRecipients(TS.tenant, [{ id: 'phone_me', kind: 'phone', value: '+41791239999' }]);
      const send = (lang: string) => api.call('POST', `/tenants/${TS.tenant}/venues/${TS.venueId}/test-send`, { journeyKey: A1, channel: 'sms', recipientId: 'phone_me', lang, actor: OWNER_ACTOR });
      const bodyOf = (o: AnyDoc) => String(o.text ?? o.body ?? '');

      let res = await send('fr');
      assertEqual([res.status, res.body.sent, res.body.wordingLang], [200, true, 'en'], `French asked, no French wording: ${res.text.slice(0, 300)}`);
      const fr = (await outbox()).filter((o) => String(o.id).startsWith('test_'));
      assertEqual(fr.length, 1, 'one test SMS');
      assert(bodyOf(fr[0]).endsWith(`\n${STOP_LINES.en}`), `ends with the English STOP line: ${JSON.stringify(bodyOf(fr[0]))}`);
      assert(!bodyOf(fr[0]).includes(STOP_LINES.fr), 'not the French one');
      assert(/thanks for visiting/.test(bodyOf(fr[0])), `the English wording: ${bodyOf(fr[0])}`);

      res = await send('de');
      assertEqual([res.status, res.body.wordingLang], [200, 'de'], `German: ${res.text.slice(0, 300)}`);
      const de = (await outbox()).find((o) => String(o.id).startsWith('test_') && o.id !== fr[0].id)!;
      assert(de && bodyOf(de).endsWith(`\n${STOP_LINES.de}`), `the German STOP line: ${de ? JSON.stringify(bodyOf(de)) : 'none'}`);
    });

    await test('test send email: the "Powered by HeidiFi" tag as guests get it — there by default, gone for a plan with hidePoweredBy', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(TS);
      await setClock(nextTuesday1240());
      await setLaunch({ [TS.tenant]: 'test' });
      await seedTestRecipients(TS.tenant, [{ id: 'mail_me', kind: 'email', value: 'owner.test@test.local' }]);
      const send = () => api.call('POST', `/tenants/${TS.tenant}/venues/${TS.venueId}/test-send`, { journeyKey: A1, channel: 'email', recipientId: 'mail_me', actor: OWNER_ACTOR });
      const mails = async () => (await outbox()).filter((o) => String(o.id).startsWith('test_') && o.channel === 'email');
      const tagged = (o: AnyDoc) => /Powered by HeidiFi/i.test(String(o.html ?? '')) || String(o.html ?? '').includes('<!--hf-pb-->');

      // No plan (pre-billing defaults): the tag is there.
      invalidateEntitlements(TS.tenant);
      let res = await send();
      assertEqual([res.status, res.body.sent], [200, true], `first test email: ${res.text.slice(0, 200)}`);
      const first = await mails();
      assertEqual(first.length, 1, 'one test email');
      assert(tagged(first[0]), 'the tag is in the email');

      // A plan that hides the tag.
      await db.collection('CaptivePortal_Plans').doc('plan_ts_nobrand').set({ name: 'No branding', flags: { hidePoweredBy: true } });
      await db.collection('CaptivePortal_Subscriptions').doc('sub_ts').set({ tenantUserId: TS.tenant, status: 'active', planId: 'plan_ts_nobrand', createdAt: new Date() });
      invalidateEntitlements(TS.tenant);
      res = await send();
      assertEqual([res.status, res.body.sent], [200, true], `second test email: ${res.text.slice(0, 200)}`);
      const second = (await mails()).filter((o) => o.id !== first[0].id);
      assertEqual(second.length, 1, 'a second test email');
      assert(!tagged(second[0]), `no tag for a plan that hides it: ${String(second[0].html).slice(-300)}`);
      invalidateEntitlements(TS.tenant);
    });

    console.log('\nCheck link rate limit\n');

    await test('Check link: at most 20 an hour per account → 429', async () => {
      await freshStay([{ checkIn: day(2), checkOut: day(5) }]);
      let first429 = -1;
      for (let i = 0; i < 25 && first429 < 0; i += 1) {
        const res = await api.call('POST', `${RV}/stay-feed/check`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
        if (res.status === 429) first429 = i;
        else assertEqual(res.status, 200, `check ${i}`);
      }
      // Earlier tests in this file used a few checks of the same account's hour.
      assert(first429 > 0 && first429 <= 20, `a 429 by the 21st check of the hour (at ${first429})`);
      const other = await api.call('POST', `/tenants/${AU.tenant}/venues/${AU.venueId}/stay-feed/check`, { url: 'sandbox:calendar/r', actor: OWNER_ACTOR });
      assert(other.status !== 429, 'another account has its own budget');
    });
  } finally {
    await api.close();
  }
  void now;
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
