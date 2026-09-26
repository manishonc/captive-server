/**
 * PR D — results, guests and "Stop marketing" on the emulator, through the real router
 * (spec E10, E11; decisions D-D2, D-D6).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Results: the running-card numbers equal the JourneyStats docs after a rollup; credits
 *    equal the ledger; revenue = came back × the venue's average spend; the test run apart;
 *    every venue at once without `venueId`; waiting for credits; 400 / 403.
 *  - Guests: a masked list with a cursor, newest first; a foreign contact id names nothing.
 *  - A STOP through another account's message shows as "another place" and none of its ids.
 *  - Stop marketing (scope venue / all): the next marketing step is skipped, service messages
 *    go on, a reconnect with the box ticked (even with a new phone) doesn't re-grant, idempotent;
 *    resume restores only the channels the guest had said yes to and never undoes the guest's
 *    own unsubscribe. A START while the owner's stop stands is kept (a ledger grant marked
 *    `heldByOwnerStop`), SMS stays stopped until the owner resumes, and the timeline says so.
 *  - Results: the date check (Feb 30, 92/93 days), venues in two time zones (each its own
 *    window, `rangesDiffer`), messages waiting for credits (still counted while quiet hours hold
 *    them; deferrals on two days = one message; a top-up during a pause drops it at the pause's
 *    re-check); crafted page cursors → 400; `limit=2.5` → 200.
 *  - Owner stop and the splash / old opt-outs: a legacy STOP imported at a venue opened after
 *    "stop all" keeps the owner's mark (START held there); a splash yes while the owner's stop
 *    stands (no yes before) is held and given back by the resume; at a venue opened after "stop
 *    all" the ledger has the owner's stop and the held yes; an old opt-out ticked in under an
 *    owner's stop with no yes behind it keeps the owner's mark (START held); the owner's lift
 *    reads as "no answer" at the send.
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
  ledger,
  nextTuesday1240,
  now,
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
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { ADMIN_ACTOR, MCP_ACTOR, OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { saveSetups } from '../../src/adaptive/service/tenant';
import { adaptiveOnInboundSms } from '../../src/adaptive/ingest/signals';
import { adaptiveVenueId } from '../../src/adaptive/store/collections';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS, localDateKey, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const RS: VenueFixture = { tenant: 'tenant_res', venueId: 'venue_res', apId: 'ap_res', apMac: 'aa:cc:cc:cc:cc:01' };
const RS2: VenueFixture = { tenant: 'tenant_res', venueId: 'venue_res2', apId: 'ap_res2', apMac: 'aa:cc:cc:cc:cc:02' };
const S1: VenueFixture = { tenant: 'tenant_st', venueId: 'venue_st1', apId: 'ap_st1', apMac: 'aa:cc:cc:cc:cc:11' };
const S2: VenueFixture = { tenant: 'tenant_st', venueId: 'venue_st2', apId: 'ap_st2', apMac: 'aa:cc:cc:cc:cc:12' };
const NY: VenueFixture = { tenant: 'tenant_res', venueId: 'venue_res_ny', apId: 'ap_res_ny', apMac: 'aa:cc:cc:cc:cc:03' };
const X: VenueFixture = { tenant: 'tenant_xx', venueId: 'venue_xx', apId: 'ap_xx', apMac: 'aa:cc:cc:cc:cc:21' };
const Y: VenueFixture = { tenant: 'tenant_yy', venueId: 'venue_yy', apId: 'ap_yy', apMac: 'aa:cc:cc:cc:cc:22' };
/** A venue the tenant_st owner opens later (after a "stop all"). */
const S3: VenueFixture = { tenant: 'tenant_st', venueId: 'venue_st3', apId: 'ap_st3', apMac: 'aa:cc:cc:cc:cc:13' };
const A1 = 'welcome_second_visit';

async function joined(tenant: string, c: Parameters<typeof connect>[0]): Promise<string> {
  const guestId = await connect(c);
  await runDue();
  return contactIdFor(tenant, guestId);
}

async function a1Of(contactId: string, venueId: string): Promise<AnyDoc> {
  const i = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((x) => x.journeyKey === A1 && x.venueId === venueId);
  if (!i) throw new Error(`no welcome journey for ${contactId} at ${venueId}`);
  return i;
}

/** `setupVenue`, but in another time zone (helpers.ts puts every venue in Zurich). */
async function setupVenueIn(f: VenueFixture, tz: string): Promise<void> {
  await db.collection(COL.venues).doc(f.venueId).set({ tenantUserId: f.tenant, venue_name: `Venue ${f.venueId}`, venue_type: 'restaurant', timezone: tz, isActive: true });
  await db.collection(COL.accessPoints).doc(f.apId).set({ mac: f.apMac, venueId: f.venueId, tenantUserId: f.tenant, vendor: 'aruba' });
  await db.collection(COL.tenantUsers).doc(f.tenant).set({ email: `${f.tenant}@test.local`, active: true }, { merge: true });
  await saveSetups(
    f.tenant,
    { playbookKey: 'restaurant_growth', venueIds: [f.venueId], journeys: {}, timezones: { [f.venueId]: tz }, overlapAck: { [f.venueId]: true }, activate: true },
    { uid: `${f.tenant}_owner`, kind: 'tenant_user', role: 'ADMIN' },
  );
  clearCaches();
}

/** Numeric maps summed (the stats docs' counters). */
function add(into: Record<string, any>, from: any): Record<string, any> {
  for (const [k, v] of Object.entries(from ?? {})) {
    if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
    else if (v && typeof v === 'object' && typeof (v as any).toMillis !== 'function') into[k] = add(into[k] ?? {}, v);
  }
  return into;
}

const sumLeaf = (o: Record<string, any> | undefined, leaf: string) => Object.values(o ?? {}).reduce((n: number, c: any) => n + Number(c?.[leaf] ?? 0), 0);
const sumAll = (o: Record<string, any> | undefined) => Object.values(o ?? {}).reduce((n: number, c: any) => n + Number(c ?? 0), 0);

async function main() {
  const api = await mountApi();
  try {
    console.log('\nResults (PR D §8, D-D2)\n');

    await test('results equal the rollup docs; credits = the ledger; revenue = came back × average spend; the test run apart', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(RS);
      await setupVenue(RS2);
      const t0 = nextTuesday1240();
      await setClock(t0);
      // A test run first…
      await setLaunch({ [RS.tenant]: 'test' });
      await joined(RS.tenant, { venue: RS, email: 'dry@test.local', phone: '791115001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      // …then live.
      await seedWallet(RS.tenant, 5000);
      await setLaunch({ [RS.tenant]: 'live' }, { paused: false });
      const g1 = await connect({ venue: RS, firstName: 'Ben', email: 'ben.res@test.local', phone: '791115002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await joined(RS.tenant, { venue: RS, email: 'cara.res@test.local', consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      // Ben comes back the next morning: offer redeemed → converted → thank-you (a service message).
      const p = localParts(new Date(t0), TZ);
      await setClock(zonedTime(p.year, p.month, p.day + 1, 10, 0, TZ).getTime());
      await connect({ venue: RS, guestId: g1, firstName: 'Ben', email: 'ben.res@test.local', phone: '791115002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const ben = await contactIdFor(RS.tenant, g1);
      assertEqual((await a1Of(ben, RS.venueId)).status, 'converted', 'Ben converted');
      await rollupVenue(RS.venueId, { cutoffMs: Date.now() + 1000 });

      const stats = (await docsWhere(COL.journeyStats, 'venueId', RS.venueId)).filter((d) => d.tenantUserId === RS.tenant);
      const venueDocs = stats.filter((d) => d.journeyKey === '_venue');
      const a1Docs = stats.filter((d) => d.journeyKey === A1);
      const v = venueDocs.reduce((acc, d) => add(acc, { entered: d.entered, sends: d.sends, credits: d.credits, utility: d.utility, visits: d.visits, dryRun: d.dryRun }), {} as Record<string, any>);
      const conv = a1Docs.reduce((n, d) => n + Number(d.converted ?? 0), 0);
      const from = localDateKey(new Date(t0 - DAY_MS), TZ);
      const to = localDateKey(new Date(t0 + 2 * DAY_MS), TZ);
      const res = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=${from}&to=${to}&journeys=1`);
      assertEqual(res.status, 200, `GET results: ${res.text.slice(0, 200)}`);
      assertEqual(res.body.range, { from, to }, 'the range');
      const r = res.body.venues[0];
      assertEqual(r.venueId, RS.venueId, 'the venue');
      assertEqual(r.card.guestsStarted, v.entered ?? 0, 'guests started = _venue.entered');
      assertEqual(r.card.messages.total, sumLeaf(v.sends, 'sent'), 'messages = sends.*.sent');
      assertEqual(r.card.messages.service, v.utility?.sends ?? 0, 'service messages = utility.sends');
      assertEqual(r.card.creditsUsed.total, sumAll(v.credits), 'credits = _venue.credits');
      const debits = (await ledger(RS.tenant)).filter((l) => l.id.startsWith('debit_auto_')).reduce((n, l) => n - Number(l.credits), 0);
      assertEqual(r.card.creditsUsed.total, debits, 'credits = the ledger');
      assertEqual([r.card.cameBack, conv], [1, 1], 'came back = the return-visit conversions');
      const avg = (await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(RS.venueId)).get()).get('avgSpendPerVisit');
      assert(avg && avg.amountMinor > 0, 'the venue has an average spend');
      assertEqual([r.card.estimatedRevenue.amountMinor, r.card.estimatedRevenue.currency], [avg.amountMinor, avg.currency], 'revenue = 1 × average spend');
      assertEqual(r.card.visits.total, v.visits?.total ?? 0, 'visits');
      assert(r.card.guestsStarted >= 2 && r.card.messages.total >= 3 && r.card.creditsUsed.total > 0, `live numbers: ${JSON.stringify(r.card)}`);
      assertEqual(r.testRun.guestsStarted, v.dryRun?.entered ?? 0, 'the test run apart');
      assert(r.testRun.guestsStarted >= 1 && r.card.guestsStarted === (v.entered ?? 0), 'never added into the live numbers');
      const j = r.journeys.find((x: any) => x.journeyKey === A1);
      assertEqual([j.returnVisit, j.live.converted], [true, 1], 'per journey');
      assertEqual([r.waitingForCredits.waiting, r.waitingForCredits.lowBalance], [false, false], 'credits enough');

      // Every Adaptive venue of the account in one call; an empty wallet shows up as waiting.
      await seedWallet(RS.tenant, 0);
      const all = await api.get(`/tenants/${RS.tenant}/results?from=${from}&to=${to}`);
      assertEqual(all.body.venues.map((x: any) => x.venueId).sort(), [RS.venueId, RS2.venueId].sort(), 'both venues');
      assert(all.body.venues.every((x: any) => x.journeys === undefined), 'journeys only on request');
      assertEqual(all.body.venues.find((x: any) => x.venueId === RS.venueId).waitingForCredits.lowBalance, true, 'an empty wallet: waiting for credits');

      // Guards.
      assertEqual((await api.get(`/tenants/tenant_other/results?venueId=${RS.venueId}`)).status, 403, 'another account → 403');
      // The date check itself: well-formed, in order and short, but a day that doesn't exist.
      const feb30 = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-02-30&to=2026-03-03`);
      assertEqual([feb30.status, feb30.body.code, feb30.body.error], [400, 'bad_request', 'Use real calendar dates, like 2026-09-25'], 'Feb 30 → 400 (the date check)');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-02-27&to=2026-02-29`)).status, 400, 'Feb 29 in a common year → 400');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2028-02-28&to=2028-02-29`)).status, 200, 'Feb 29 in a leap year → 200');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-1-01&to=2026-01-02`)).status, 400, 'a one-digit month → 400');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-01-01&to=2026-04-02`)).status, 200, 'exactly 92 days → 200');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-01-01&to=2026-04-03`)).status, 400, '93 days → 400');
      const oneDay = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=${to}&to=${to}`);
      assertEqual([oneDay.status, oneDay.body.range], [200, { from: to, to }], 'from = to: one day');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=2026-01-01&to=2026-06-01`)).status, 400, 'more than 92 days → 400');
      assertEqual((await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}&from=${to}&to=${from}`)).status, 400, 'from after to → 400');
      const dflt = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}`);
      assertEqual([dflt.status, dflt.body.range.to, dflt.body.venues[0].card.guestsStarted], [200, localDateKey(new Date(now()), TZ), r.card.guestsStarted], 'default: the last 30 days to today (engine clock)');
    });

    await test('results: venues in two time zones at 00:30 UTC → each its own local window, no shared range (rangesDiffer); from/to given → one range', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(RS); // Europe/Zurich
      await setupVenueIn(NY, 'America/New_York');
      const d = new Date(nextTuesday1240() + DAY_MS);
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30);
      await setClock(t);
      const zurichDay = localDateKey(new Date(t), TZ);
      const nyDay = localDateKey(new Date(t), 'America/New_York');
      assert(zurichDay !== nyDay, `the two venues are on different days (${zurichDay} / ${nyDay})`);
      let res = await api.get(`/tenants/${RS.tenant}/results`);
      assertEqual(res.status, 200, `GET results: ${res.text.slice(0, 200)}`);
      const byVenue = (b: any) => Object.fromEntries((b.venues as any[]).map((v) => [v.venueId, [v.timezone, v.range.to]]));
      assertEqual(byVenue(res.body), { [RS.venueId]: [TZ, zurichDay], [NY.venueId]: ['America/New_York', nyDay] }, "each venue's own today");
      for (const v of res.body.venues as any[]) {
        const days = Math.round((Date.parse(v.range.to) - Date.parse(v.range.from)) / DAY_MS) + 1;
        assertEqual(days, 30, `${v.venueId}: the last 30 days`);
      }
      assertEqual([res.body.range, res.body.rangesDiffer], [null, true], 'no shared range');

      // Given dates: the same window for both.
      res = await api.get(`/tenants/${RS.tenant}/results?from=${nyDay}&to=${zurichDay}`);
      assertEqual([res.status, res.body.range, res.body.rangesDiffer], [200, { from: nyDay, to: zurichDay }, undefined], 'one shared range');

      // Just before / just after midnight in New York (both venues then on the same day).
      const [y, m, dd] = zurichDay.split('-').map(Number);
      const nyMidnight = zonedTime(y, m, dd, 0, 0, 'America/New_York').getTime();
      await setClock(nyMidnight - 10_000);
      res = await api.get(`/tenants/${RS.tenant}/results`);
      assertEqual([res.body.range, res.body.rangesDiffer], [null, true], '10 s before midnight in New York: still apart');
      await setClock(nyMidnight + 1_000);
      res = await api.get(`/tenants/${RS.tenant}/results`);
      assertEqual([res.body.range?.to, res.body.rangesDiffer], [zurichDay, undefined], 'just after it: one shared range');
    });

    await test('results: a message waiting for credits → messagesWaiting 1 and waiting; not once the journey ended; not once the wallet can pay it', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(RS);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await setLaunch({ [RS.tenant]: 'live' }, { paused: false }); // no wallet: the welcome waits for credits
      const c = await joined(RS.tenant, { venue: RS, email: 'broke.res@test.local', consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      const inst = await a1Of(c, RS.venueId);
      assertEqual([inst.status, inst.waiting?.lastDeferReason], ['active', 'credits'], 'a real wait for credits (the engine wrote it)');
      const waiting = async () => {
        const res = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}`);
        assertEqual(res.status, 200, 'GET results');
        return res.body.venues[0].waitingForCredits;
      };
      let w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting, w.lowBalance], [1, true, true], `an empty wallet: ${JSON.stringify(w)}`);
      assert(w.startedWaitingLast72h >= 1, `counted in the last 72 h: ${w.startedWaitingLast72h}`);
      // Written directly: the journey ended (only active journeys count) — and running again.
      await db.collection(COL.journeyInstances).doc(inst.id).update({ status: 'exhausted' });
      w = await waiting();
      assertEqual([w.messagesWaiting, w.lowBalance], [0, true], 'an ended journey waits for nothing (the empty wallet still shows)');
      await db.collection(COL.journeyInstances).doc(inst.id).update({ status: 'active' });
      assertEqual((await waiting()).messagesWaiting, 1, 'running again: counted');
      // A top-up: measured against the wallet now, it no longer waits (it goes at its next look).
      await seedWallet(RS.tenant, 5000);
      w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting, w.lowBalance], [0, false, false], `the wallet can pay it now: ${JSON.stringify(w)}`);
      assertEqual((await a1Of(c, RS.venueId)).waiting?.creditsShort, true, 'the flag itself stays until its next look');
    });

    await test('results: a message waiting for credits stays counted while quiet hours hold it (creditsShort); its credits deferrals on two days count as one message', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(RS);
      // The welcome only: the review ask (a second marketing message) switched off.
      await saveSetups(RS.tenant, { playbookKey: 'restaurant_growth', venueIds: [RS.venueId], journeys: { review_ask: { enabled: false, slots: {} } } }, { uid: `${RS.tenant}_owner`, kind: 'tenant_user', role: 'ADMIN' });
      clearCaches();
      const t0 = nextTuesday1240() + 7 * HOUR_MS; // 19:40 in Zurich; quiet hours are 21:00–09:00
      await setClock(t0);
      await setLaunch({ [RS.tenant]: 'live' }, { paused: false }); // no wallet
      const c = await joined(RS.tenant, { venue: RS, email: 'night.res@test.local', consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      const inst = await a1Of(c, RS.venueId);
      assertEqual([inst.status, inst.waiting?.lastDeferReason, inst.waiting?.creditsShort], ['active', 'credits', true], 'waiting for credits (the engine wrote it)');
      const waiting = async () => {
        const res = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}`);
        assertEqual(res.status, 200, 'GET results');
        return res.body.venues[0].waitingForCredits;
      };
      let w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting], [1, true], `one message waiting: ${JSON.stringify(w)}`);

      // The hourly re-checks run into quiet hours: the 21:55 look is held by quiet hours, the credits rule still says short.
      await runUntil(t0 + 2 * HOUR_MS + 30 * MINUTE_MS);
      const held = (await db.collection(COL.journeyInstances).doc(inst.id).get()).data()!;
      assertEqual([held.status, held.waiting?.lastDeferReason, held.waiting?.creditsShort], ['active', 'quiet_hours', true], 'quiet hours won the gate; the shortage is kept');
      w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting], [1, true], `still one message waiting in quiet hours: ${JSON.stringify(w)}`);

      // The next morning the re-check defers for credits again: a second credits deferral of the same message.
      const p = localParts(new Date(t0), TZ);
      await runUntil(zonedTime(p.year, p.month, p.day + 1, 10, 0, TZ).getTime());
      const deferrals = (await docsWhere(COL.journeyEvents, 'instanceId', inst.id))
        .filter((e) => e.type === 'send.deferred')
        .sort((a, b) => a.occurredAt.toMillis() - b.occurredAt.toMillis());
      assertEqual(deferrals.map((e) => e.data?.decision?.reason), ['credits', 'quiet_hours', 'credits'], 'credits, quiet hours, credits');
      const creditDays = new Set(deferrals.filter((e) => e.data?.decision?.reason === 'credits').map((e) => localDateKey(e.occurredAt.toDate(), TZ)));
      assertEqual(creditDays.size, 2, 'the credits deferrals on two days');
      assertEqual(new Set(deferrals.map((e) => e.sendKey)).size, 1, 'all for one message');
      w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting, w.startedWaitingLast72h], [1, true, 1], `one message, counted once: ${JSON.stringify(w)}`);
    });

    await test('results: a message waiting for credits, then all sending paused: still counted while the wallet is empty; a top-up during the pause → the pause re-check drops it (messagesWaiting 0), the pause still holds the send', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(RS);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await setLaunch({ [RS.tenant]: 'live' }, { paused: false }); // no wallet: the welcome waits for credits
      const c = await joined(RS.tenant, { venue: RS, email: 'paused.res@test.local', consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      let inst = await a1Of(c, RS.venueId);
      assertEqual([inst.status, inst.waiting?.lastDeferReason, inst.waiting?.creditsShort, inst.waiting?.creditsShortFor?.channel], ['active', 'credits', true, 'email'], `waiting for credits: ${JSON.stringify(inst.waiting)}`);
      assert(Number(inst.waiting?.creditsShortFor?.price) > 0, `the shortage names the price: ${JSON.stringify(inst.waiting?.creditsShortFor)}`);
      const waiting = async () => {
        const res = await api.get(`/tenants/${RS.tenant}/results?venueId=${RS.venueId}`);
        assertEqual(res.status, 200, 'GET results');
        return res.body.venues[0].waitingForCredits;
      };
      let w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting], [1, true], `one message waiting: ${JSON.stringify(w)}`);

      // HeidiFi pauses all sending; the hourly credits re-check is held by the pause, the wallet still empty.
      await setLaunch({ [RS.tenant]: 'live' }, { paused: true });
      await advance(HOUR_MS);
      await runDue();
      inst = await a1Of(c, RS.venueId);
      assertEqual([inst.status, inst.waiting?.lastDeferReason, inst.waiting?.creditsShort], ['active', 'paused', true], `the pause holds it, still short: ${JSON.stringify(inst.waiting)}`);
      w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting], [1, true], `still one message waiting during the pause: ${JSON.stringify(w)}`);

      // The owner tops up during the pause: the next pause re-check reads the wallet, which can pay now.
      await seedWallet(RS.tenant, 5000);
      await advance(15 * MINUTE_MS);
      await runDue();
      inst = await a1Of(c, RS.venueId);
      assertEqual([inst.status, inst.waiting?.lastDeferReason, inst.waiting?.creditsShort ?? null], ['active', 'paused', null], `the pause holds it, no longer short: ${JSON.stringify(inst.waiting)}`);
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', inst.id)).length, 0, 'nothing sent during the pause');
      w = await waiting();
      assertEqual([w.messagesWaiting, w.waiting, w.lowBalance], [0, false, false], `no message waiting for credits after the top-up: ${JSON.stringify(w)}`);

      // The pause is lifted: the welcome goes.
      await setLaunch({ [RS.tenant]: 'live' }, { paused: false });
      await advance(15 * MINUTE_MS);
      await runDue();
      const s1 = (await db.collection(COL.journeySends).doc(sendKeyFor(inst.id, 's1')).get()).data();
      assertEqual([s1?.status, s1?.mode], ['sent', 'live'], 'the welcome went out');
    });

    console.log('\nGuests (PR D §9)\n');

    await test('guests: a masked list, newest first, with a cursor; a contact of another account names nothing', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setupVenue(Y);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test', [Y.tenant]: 'test' });
      const ids: string[] = [];
      for (const [i, name] of ['Anna', 'Bert', 'Cleo'].entries()) {
        ids.push(await joined(S1.tenant, { venue: S1, firstName: name, email: `${name.toLowerCase()}.list@test.local`, phone: `79111600${i + 3}`, phoneCountryCode: '+41', phoneVerified: true, consent: true }));
        await advance(MINUTE_MS);
      }
      await db.collection(COL.contacts).doc(ids[0]).update({ lastName: 'Muster' });
      const foreign = await joined(Y.tenant, { venue: Y, firstName: 'Yann', email: 'yann@test.local', consent: true });
      const V = `/tenants/${S1.tenant}/venues/${S1.venueId}`;
      const p1 = await api.get(`${V}/guests?limit=2`);
      assertEqual(p1.status, 200, 'GET guests');
      assertEqual(p1.body.guests.map((g: any) => g.contactId), [ids[2], ids[1]], 'newest visit first');
      assert(typeof p1.body.nextCursor === 'string', 'a cursor');
      const p2 = await api.get(`${V}/guests?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
      assertEqual([p2.body.guests.map((g: any) => g.contactId), p2.body.nextCursor], [[ids[0]], null], 'the last page');
      const anna = p2.body.guests[0];
      assertEqual(anna.name, 'Anna M.', 'first name + initial');
      assert(anna.email && anna.email !== 'anna.list@test.local' && anna.phone && !anna.phone.includes('791116003'), `masked: ${anna.email} ${anna.phone}`);
      assertEqual([anna.consent.email.state, anna.journeys.some((j: any) => j.journeyKey === A1 && j.mode === 'test')], ['yes', true], 'consent chips and journeys');
      const everything = p1.text + p2.text;
      assert(!/(anna|bert|cleo)\.list@/.test(everything) && !/79111600\d/.test(everything), 'no raw address anywhere in the list');
      assertEqual((await api.get(`${V}/guests?cursor=nonsense`)).status, 400, 'a bad cursor → 400');
      // Crafted cursors (well-formed base64url JSON): a path as the id, a time Firestore can't hold → 400, never 500.
      const crafted = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const MAX_TS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
      const MIN_TS = -62_135_596_800_000; // 0001-01-01T00:00:00.000Z
      for (const [label, path, status] of [
        ['guests: an id with a slash', `${V}/guests?cursor=${crafted([0, 'a/b'])}`, 400],
        ['messages: 1e20 ms', `${V}/messages?cursor=${crafted([1e20, 'x'])}`, 400],
        ['guests: the last ms Firestore holds', `${V}/guests?cursor=${crafted([MAX_TS, 'x'])}`, 200],
        ['guests: 1 ms after it', `${V}/guests?cursor=${crafted([MAX_TS + 1, 'x'])}`, 400],
        ['messages: the first ms Firestore holds', `${V}/messages?cursor=${crafted([MIN_TS, 'x'])}`, 200],
        ['messages: 1 ms before it', `${V}/messages?cursor=${crafted([MIN_TS - 1, 'x'])}`, 400],
        ['guests: a time as a string', `${V}/guests?cursor=${crafted(['0', 'x'])}`, 400],
        ['guests: an empty id', `${V}/guests?cursor=${crafted([0, ''])}`, 400],
        ['messages: an id with a slash', `${V}/messages?cursor=${crafted([0, 'a/b'])}`, 400],
      ] as const) {
        const r = await api.get(path);
        assertEqual(r.status, status, `${label}: ${r.text.slice(0, 120)}`);
      }
      assertEqual((await api.get(`/tenants/${Y.tenant}/venues/${S1.venueId}/guests`)).status, 403, 'another account → 403');
      const g = await api.get(`${V}/guests/${foreign}`);
      assertEqual([g.status, g.body.code], [404, 'not_found'], "another account's guest → 404");
      assert(!g.text.includes('Yann') && !g.text.includes(Y.tenant), 'names nothing of it');
      const m = await api.call('POST', `${V}/guests/${foreign}/marketing`, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual(m.status, 404, "stopping another account's guest → 404");
      const find = await api.call('POST', `/tenants/${S1.tenant}/guests/find`, { contactId: foreign });
      assertEqual(find.status, 404, 'find: not this account → 404');
      const mine = await api.call('POST', `/tenants/${S1.tenant}/guests/find`, { email: 'bert.list@test.local' });
      assertEqual([mine.status, mine.body.contactId, mine.body.guest.name, mine.body.venues.map((x: any) => x.venueId)], [200, ids[1], 'Bert', [S1.venueId]], 'find by email');
      const byGuest = await api.call('POST', `/tenants/${S1.tenant}/guests/find`, { guestId: (await db.collection(COL.contacts).doc(ids[2]).get()).get('guestIds')[0] });
      assertEqual(byGuest.body.contactId, ids[2], 'find by guest id');
      assert(!mine.text.includes('bert.list@test.local'), 'the answer masks the address');
    });

    await test('guests and messages with a fractional limit (limit=2.5): 200, a page of 2 with a cursor (never a 500)', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      for (const name of ['Ada', 'Bo', 'Cy']) {
        await joined(S1.tenant, { venue: S1, firstName: name, email: `${name.toLowerCase()}.limit@test.local`, consent: true });
        await advance(MINUTE_MS);
      }
      await advance(15 * MINUTE_MS);
      await runDue(); // three welcome dry runs: three messages
      const V = `/tenants/${S1.tenant}/venues/${S1.venueId}`;
      const guests = await api.get(`${V}/guests?limit=2.5`);
      assertEqual([guests.status, guests.body.guests?.length, typeof guests.body.nextCursor], [200, 2, 'string'], `guests?limit=2.5: ${guests.text.slice(0, 200)}`);
      const messages = await api.get(`${V}/messages?limit=2.5`);
      assertEqual([messages.status, messages.body.messages?.length, typeof messages.body.nextCursor], [200, 2, 'string'], `messages?limit=2.5: ${messages.text.slice(0, 200)}`);
      const rest = await api.get(`${V}/messages?limit=2.5&cursor=${encodeURIComponent(messages.body.nextCursor)}`);
      assert(rest.status === 200 && rest.body.messages?.length >= 1, `the next page: ${rest.status} ${rest.text.slice(0, 200)}`);
    });

    await test("a STOP caused by another account's message: none of its ids (send key, venue, account, contact) in the owner's answers", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(X);
      await setupVenue(Y);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(X.tenant, 5000);
      await seedWallet(Y.tenant, 5000);
      await setLaunch({ [X.tenant]: 'live', [Y.tenant]: 'live' }, { paused: false });
      // A number the sandbox provider answers with 21610 ("replied STOP"): X's welcome, sent first, blocks it everywhere.
      const person = { firstName: 'Pia', email: 'pia@test.local', phone: '791170000', phoneCountryCode: '+41', phoneVerified: true, consent: true };
      const px = await joined(X.tenant, { venue: X, ...person });
      await advance(MINUTE_MS);
      const py = await joined(Y.tenant, { venue: Y, ...person });
      await advance(14 * MINUTE_MS); // X's welcome is due, Y's not yet
      await runDue();
      const kx = sendKeyFor((await a1Of(px, X.venueId)).id, 's1');
      const sx = (await db.collection(COL.journeySends).doc(kx).get()).data()!;
      assertEqual([sx.status, sx.errorCode], ['failed', '21610'], "X's welcome was refused: the number said STOP");
      const yLedger = (await docsWhere(COL.consentEvents, 'contactId', py)).filter((d) => d.action === 'revoke' && d.channel === 'sms');
      assertEqual(yLedger.map((d) => [d.source, d.sourceRef?.sendKey]), [['provider_stop', kx]], "Y's consent ledger carries X's send key (the data the scrub is for)");
      await runUntil(now() + 30 * MINUTE_MS);

      const Vy = `/tenants/${Y.tenant}/venues/${Y.venueId}`;
      for (const lang of ['en', 'de']) {
        const res = await api.get(`${Vy}/guests/${py}?lang=${lang}`);
        assertEqual(res.status, 200, `Y's owner opens Pia (${lang})`);
        assertEqual(res.body.venue.consent.sms.state, 'no', 'SMS is off at Y too');
        assert(res.body.timeline.some((i: any) => i.kind === 'consent.revoked' && i.channel === 'sms'), `the STOP shows: ${res.body.timeline.map((i: any) => i.sentence).join(' | ')}`);
        for (const id of [X.tenant, X.venueId, kx, px, `Venue ${X.venueId}`]) assert(!res.text.includes(id), `Y's owner never sees ${id} (${lang})`);
      }
      const msgs = await api.get(`${Vy}/messages?days=3`);
      const list = await api.get(`${Vy}/guests`);
      const find = await api.call('POST', `/tenants/${Y.tenant}/guests/find`, { email: 'pia@test.local' });
      for (const [label, r] of [['messages', msgs], ['guests', list], ['find', find]] as const) {
        assertEqual(r.status, 200, label);
        for (const id of [X.tenant, X.venueId, kx, px]) assert(!r.text.includes(id), `${label}: never ${id}`);
      }
      assertEqual(find.body.contactId, py, "find answers Y's own contact");
    });

    console.log('\nStop / resume marketing (D-D6)\n');

    await test('stop (venue / all): next marketing step skipped, service goes on, no re-grant on reconnect; resume gives back only what the guest said yes to', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setupVenue(S2);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(S1.tenant, 5000);
      await setLaunch({ [S1.tenant]: 'live' }, { paused: false });
      // G1: phone + email at S1. G2: email only, at S1 and S2.
      const g1 = await joined(S1.tenant, { venue: S1, firstName: 'Gil', email: 'gil@test.local', phone: '791118001', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      const g2Guest = await connect({ venue: S1, firstName: 'Gia', email: 'gia@test.local', consent: true, guestId: 'g_gia' });
      await connect({ venue: S2, firstName: 'Gia', email: 'gia@test.local', consent: true, guestId: 'g_gia_s2' });
      await runDue();
      const g2 = await contactIdFor(S1.tenant, g2Guest);
      await advance(15 * MINUTE_MS);
      await runDue();
      const g2s1Welcome = sendKeyFor((await a1Of(g2, S1.venueId)).id, 's1');
      assertEqual((await db.collection(COL.journeySends).doc(g2s1Welcome).get()).get('channel'), 'email', "Gia's welcome email at S1");

      const path = (venue: VenueFixture, c: string) => `/tenants/${S1.tenant}/venues/${venue.venueId}/guests/${c}/marketing`;
      const chips = async (venue: VenueFixture, c: string) => (await api.get(`/tenants/${S1.tenant}/venues/${venue.venueId}/guests/${c}`)).body.venue.consent;
      // Guards: the MCP may not; a bad action → 400.
      assertEqual((await api.call('POST', path(S1, g1), { action: 'stop', scope: 'venue', actor: MCP_ACTOR })).status, 403, 'the MCP may not');
      assertEqual((await api.call('POST', path(S1, g1), { action: 'pause', scope: 'venue', actor: OWNER_ACTOR })).status, 400, 'a bad action → 400');

      // Gil: this venue only.
      let res = await api.call('POST', path(S1, g1), { action: 'stop', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 3], `stopped: ${res.text.slice(0, 200)}`);
      assertEqual(['email', 'sms', 'whatsapp'].map((ch) => [res.body.consent[ch].state, res.body.consent[ch].ownerStopped]), [['no', true], ['no', true], ['no', true]], 'every channel at S1');
      assert(/Marketing tab/.test(res.body.note), 'says it is Adaptive only');
      // Gia: every venue of this owner (asked from S1).
      res = await api.call('POST', path(S1, g2), { action: 'stop', scope: 'all', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 6], 'three channels at each of the two venues');
      assertEqual((await chips(S2, g2)).email.ownerStopped, true, 'S2 too');
      res = await api.call('POST', path(S1, g2), { action: 'stop', scope: 'all', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 0], 'idempotent');
      const ledgerDocs = (await docsWhere(COL.consentEvents, 'contactId', g2)).filter((d) => d.source === 'owner');
      assertEqual(ledgerDocs.length, 6, 'one ledger doc per real change (source owner)');
      const list = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests`);
      assertEqual(list.body.guests.find((g: any) => g.contactId === g2).consent.email.ownerStopped, true, 'the guest row shows the owner stop');

      // The next morning Gia comes back to S1 (box ticked, and now with a phone): offer used → thank-you (service) goes; nothing re-granted.
      const p = localParts(new Date(t0), TZ);
      await setClock(zonedTime(p.year, p.month, p.day + 1, 10, 0, TZ).getTime());
      await connect({ venue: S1, guestId: 'g_gia', firstName: 'Gia', email: 'gia@test.local', phone: '791118002', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const giaS1 = await a1Of(g2, S1.venueId);
      assertEqual(giaS1.status, 'converted', 'Gia converted at S1');
      const thanks = (await db.collection(COL.journeySends).doc(sendKeyFor(giaS1.id, 'thanks')).get()).data();
      assertEqual([thanks?.purpose, thanks?.status, thanks?.mode], ['service', 'sent', 'live'], 'the thank-you (a service message) went out');
      const afterReconnect = await chips(S1, g2);
      assertEqual(['email', 'sms'].map((ch) => [afterReconnect[ch].state, afterReconnect[ch].ownerStopped]), [['no', true], ['no', true]], 'the ticked box re-granted nothing (not even SMS for the new phone)');

      // Their next marketing steps are skipped: Gil's follow-up at S1, Gia's at S2.
      await runUntil(t0 + 4 * DAY_MS);
      for (const [who, venue] of [
        [g1, S1],
        [g2, S2],
      ] as const) {
        const inst = await a1Of(who, venue.venueId);
        const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', inst.id)).filter((e) => e.type === 'send.skipped');
        assert(skipped.length === 1, `${who} at ${venue.venueId}: the next marketing step skipped (${skipped.length})`);
        const d = skipped[0].data.decision;
        assertEqual([d.rule, d.reason], ['consent', 'no_consent'], `said as consent, not "no channel": ${d.rule}/${d.reason}`);
        assert(d.channel.rejected.some((r: any) => r.channel === 'email' && r.reason === 'consent_revoked'), `email rejected for consent: ${JSON.stringify(d.channel.rejected)}`);
        const sent = (await docsWhere(COL.journeySends, 'instanceId', inst.id)).filter((x) => x.nodeId !== 's1');
        assertEqual(sent.map((x) => x.nodeId), [], 'nothing else sent');
        // The channel pick's decision (no gate ran) replays too.
        const rp = await api.call('POST', '/admin/decisions/replay', { eventId: skipped[0].id, actor: ADMIN_ACTOR });
        assertEqual([rp.status, rp.body.replay?.replayable, rp.body.replay?.same, rp.body.replay?.stage], [200, true, true, 'channel'], `replay of the channel-stage skip: ${rp.text.slice(0, 300)}`);
      }

      // Gia unsubscribes from S1's welcome email herself; then the owner resumes everything.
      await devProviderEvent({ sendKey: g2s1Welcome, event: 'unsubscribe' });
      await runDue();
      res = await api.call('POST', path(S1, g2), { action: 'resume', scope: 'all', actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'resumed');
      const s1Chips = await chips(S1, g2);
      const s2Chips = await chips(S2, g2);
      assertEqual([s1Chips.email.state, s1Chips.email.ownerStopped], ['no', false], "S1 email: her own unsubscribe stays");
      assertEqual([s2Chips.email.state, s2Chips.email.ownerStopped], ['yes', false], 'S2 email: her yes is back');
      // At S1 she ticked the box with her new phone while the stop stood: that yes was held (a
      // `heldByOwnerStop` grant) and the resume gives it back. At S2 she never said yes to SMS / WhatsApp.
      assertEqual([s1Chips.sms.state, s1Chips.whatsapp.state], ['yes', 'yes'], 'S1 SMS / WhatsApp: her yes from the ticked box (held during the stop) is back');
      assertEqual([s2Chips.sms.state, s2Chips.whatsapp.state], ['none', 'none'], 'S2: channels she never said yes to: no answer (not a yes)');
      const giaTl = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g2}?lang=en`);
      const giaSentences = (giaTl.body.timeline as any[]).map((i) => i.sentence as string);
      assert(
        giaSentences.some((s) => /You lifted your stop on marketing by email; the guest had said no themselves, so it stays off\./i.test(s)),
        `S1 email: the resume over her own unsubscribe is explained: ${giaSentences.join(' | ')}`,
      );
      res = await api.call('POST', path(S1, g1), { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual(['email', 'sms', 'whatsapp'].map((ch) => res.body.consent[ch].state), ['yes', 'yes', 'yes'], "Gil's three yeses are back");
      const tl = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g1}?lang=en`);
      const sentences = tl.body.timeline.map((i: any) => i.sentence);
      assert(sentences.some((s: string) => /You stopped marketing by SMS/.test(s)) && sentences.some((s: string) => /back on/.test(s)), `the timeline shows stop and resume: ${sentences.join(' | ')}`);
    });

    await test("the guest's own STOP stands through the owner's resume; START then gives the yes back (D-D6)", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(S1.tenant, 5000);
      await setLaunch({ [S1.tenant]: 'live' }, { paused: false });
      const g = await joined(S1.tenant, { venue: S1, firstName: 'Sam', email: 'sam@test.local', phone: '791118011', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      const welcome = sendKeyFor((await a1Of(g, S1.venueId)).id, 's1');
      assertEqual((await db.collection(COL.journeySends).doc(welcome).get()).get('channel'), 'sms', "Sam's welcome went by SMS");
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      const smsEntry = async () => (await db.collection(COL.contacts).doc(g).get()).get(`marketingConsent`)?.[`venue:${S1.venueId}`]?.sms;

      assertEqual((await api.call('POST', path, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR })).status, 200, 'owner stop');
      assertEqual([(await smsEntry())?.revokedVia, (await smsEntry())?.ownerStopped], ['owner', true], 'revoked by the owner');
      // Sam texts STOP: his own revoke replaces the owner's, and keeps the owner's mark.
      await devProviderEvent({ sendKey: welcome, event: 'stop' });
      await runDue();
      let e = await smsEntry();
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped], ['revoked', 'channel', true], `his STOP is recorded over the owner's stop: ${JSON.stringify(e)}`);
      // The owner resumes: his STOP stays.
      const res = await api.call('POST', path, { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.consent.sms.state, res.body.consent.sms.ownerStopped], [200, 'no', false], 'resume never undoes his STOP');
      assertEqual(res.body.consent.email.state, 'yes', 'email (only the owner stopped it) is back');
      // Sam texts START: his yes comes back (he gave it at the splash).
      await devProviderEvent({ sendKey: welcome, event: 'start' });
      await runDue();
      e = await smsEntry();
      assertEqual(e?.state, 'granted', `START gives his yes back: ${JSON.stringify(e)}`);
    });

    await test("START while the owner's stop stands: kept for the owner's resume (a held ledger grant), SMS stays stopped, the next SMS step is skipped; resume gives the yes back", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(S1.tenant, 5000);
      await setLaunch({ [S1.tenant]: 'live' }, { paused: false });
      // Phone only: SMS is her one channel.
      const g = await joined(S1.tenant, { venue: S1, firstName: 'Hedi', phone: '791118021', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      const a1 = await a1Of(g, S1.venueId);
      const welcome = (await db.collection(COL.journeySends).doc(sendKeyFor(a1.id, 's1')).get()).data();
      assertEqual([welcome?.channel, welcome?.status], ['sms', 'sent'], 'her welcome went by SMS');
      const scope = `venue:${S1.venueId}`;
      const smsEntry = async () => (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[scope]?.sms;
      assertEqual((await smsEntry())?.state, 'granted', 'she said yes to SMS');
      const text = (body: 'STOP' | 'START', sid: string) =>
        adaptiveOnInboundSms({ from: '+41791118021', body, legacyKind: body === 'STOP' ? 'stop' : 'start', messageSid: sid, optOutType: null, signatureChecked: true });

      // She texts STOP; then the owner stops marketing to her here.
      await advance(MINUTE_MS);
      await text('STOP', 'SMheldstop1');
      await runDue();
      let e = await smsEntry();
      assertEqual([e?.state, e?.revokedVia, e?.source], ['revoked', 'channel', 'sms_keyword'], 'her STOP');
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      let res = await api.call('POST', path, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'the owner stops marketing');
      e = await smsEntry();
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped], ['revoked', 'channel', true], 'her STOP stays, with the owner\'s mark');

      // She texts START: her yes is kept for the owner's resume; SMS stays stopped.
      await advance(MINUTE_MS);
      await text('START', 'SMheldstart1');
      await runDue();
      e = await smsEntry();
      assertEqual([e?.state, e?.revokedVia, e?.source, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', 'owner', true, 'granted'], `held by the owner's stop: ${JSON.stringify(e)}`);
      const keywordGrants = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.channel === 'sms' && d.action === 'grant' && d.source === 'sms_keyword');
      assertEqual(keywordGrants.map((d) => [d.scope, d.sourceRef?.heldByOwnerStop]), [[scope, true]], 'one ledger grant for the START, marked held');
      assertEqual(e?.eventId, keywordGrants[0].id, 'the projection points at it');
      const point = (await db.collection(COL.contactPoints).doc((await db.collection(COL.contacts).doc(g).get()).get('phonePointId')).get()).data()!;
      assertEqual(point.suppression?.sms, undefined, 'the STOP block on the number is lifted (her own START)');
      const chip = async () => (await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}`)).body.venue.consent.sms;
      assertEqual([(await chip()).state, (await chip()).ownerStopped], ['no', true], 'the owner sees SMS stopped');
      // The owner's timeline says so.
      for (const [lang, re] of [
        ['en', /Texted START, but marketing stays stopped here until you resume it\./],
        ['de', /Hat START geschickt, aber Werbung bleibt hier gestoppt, bis du sie wieder einschaltest\./],
      ] as const) {
        const tl = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}?lang=${lang}`);
        const sentences = (tl.body.timeline as any[]).map((i) => i.sentence as string);
        assert(sentences.some((x) => re.test(x)), `${lang}: the held START is explained: ${sentences.join(' | ')}`);
      }

      // Her next marketing step (by SMS, her only channel) is skipped.
      await runUntil(t0 + 4 * DAY_MS);
      const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((x) => x.type === 'send.skipped');
      assert(skipped.length >= 1, `the next marketing step is skipped (${skipped.length})`);
      const d = skipped[0].data.decision;
      assertEqual([d.rule, d.reason], ['consent', 'no_consent'], `skipped for consent: ${d.rule}/${d.reason}`);
      assert(d.channel.rejected.some((r: any) => r.channel === 'sms' && r.reason === 'consent_revoked'), `SMS rejected for consent: ${JSON.stringify(d.channel.rejected)}`);
      assertEqual((await docsWhere(COL.journeySends, 'contactId', g)).map((x) => x.nodeId), ['s1'], 'nothing sent after the welcome');

      // The owner resumes: her START's yes comes back.
      res = await api.call('POST', path, { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.consent.sms.state, res.body.consent.sms.ownerStopped], [200, 'yes', false], 'resume: SMS is a yes again');
      e = await smsEntry();
      assertEqual([e?.state, e?.revokedVia, e?.source], ['granted', null, 'owner'], `granted again: ${JSON.stringify(e)}`);
    });

    await test("stop all, then a venue opened later: an old SMS opt-out imported there keeps the owner's mark, so a START is held there too; resume all gives it back", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      const person = { firstName: 'Fay', email: 'fay@test.local', phone: '791118041', phoneCountryCode: '+41', phoneVerified: true, consent: true };
      const g = await joined(S1.tenant, { venue: S1, ...person, guestId: 'g_fay' });
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      let res = await api.call('POST', path, { action: 'stop', scope: 'all', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 3], `stopped at all venues (S1 is the only one yet): ${res.text.slice(0, 200)}`);
      assert((await db.collection(COL.contacts).doc(g).get()).get('ownerStoppedAll'), 'the contact remembers "stop all"');

      // The owner opens S3 later; Fay connects there ticking the box, and her guest record carries an old STOP flag.
      await setupVenue(S3);
      await advance(MINUTE_MS);
      await connect({ venue: S3, ...person, guestId: 'g_fay_s3', legacy: { smsOptOut: true } });
      await runDue();
      assertEqual(await contactIdFor(S3.tenant, 'g_fay_s3'), g, 'the same guest');
      const s3 = `venue:${S3.venueId}`;
      const smsAt = async (scope: string) => (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[scope]?.sms;
      let e = await smsAt(s3);
      assertEqual([e?.state, e?.revokedVia, e?.source, e?.ownerStopped], ['revoked', 'channel', 'import_legacy', true], `her old STOP at S3, with the owner's mark: ${JSON.stringify(e)}`);

      // She texts START: at S3 it is held for the owner (not a yes while the owner's stop stands).
      await advance(MINUTE_MS);
      await adaptiveOnInboundSms({ from: '+41791118041', body: 'START', legacyKind: 'start', messageSid: 'SMfaystart1', optOutType: null, signatureChecked: true });
      await runDue();
      e = await smsAt(s3);
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', true, 'granted'], `S3 stays stopped, the START kept for the owner: ${JSON.stringify(e)}`);
      const held = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.channel === 'sms' && d.action === 'grant' && d.source === 'sms_keyword');
      assertEqual(held.map((d) => [d.scope, d.sourceRef?.heldByOwnerStop]), [[s3, true]], 'one ledger grant for the START at S3, marked held');
      assertEqual((await smsAt(`venue:${S1.venueId}`))?.state, 'revoked', 'S1 still stopped by the owner');

      // The owner resumes everything: SMS is a yes again at S3 (and at S1, where she said yes on the splash).
      res = await api.call('POST', path, { action: 'resume', scope: 'all', actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'resumed');
      e = await smsAt(s3);
      assertEqual([e?.state, e?.ownerStopped ?? false], ['granted', false], `S3 SMS granted: ${JSON.stringify(e)}`);
      assertEqual((await smsAt(`venue:${S1.venueId}`))?.state, 'granted', 'S1 SMS granted');
    });

    await test("a splash yes while the owner's stop stands (no yes before): kept as a held ledger grant, still stopped; resume gives it back; the timeline says so", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      const g = await joined(S1.tenant, { venue: S1, firstName: 'Nora', email: 'nora@test.local', consent: false, guestId: 'g_nora' });
      const scope = `venue:${S1.venueId}`;
      const emailEntry = async () => (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[scope]?.email;
      assertEqual(await emailEntry(), undefined, 'no answer yet');
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      let res = await api.call('POST', path, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 3], 'the owner stops marketing here');
      let e = await emailEntry();
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', true, 'none'], 'stopped with no yes before');

      // She comes back and ticks the box.
      await advance(5 * MINUTE_MS);
      await connect({ venue: S1, guestId: 'g_nora', firstName: 'Nora', email: 'nora@test.local', consent: true });
      await runDue();
      e = await emailEntry();
      assertEqual([e?.state, e?.revokedVia, e?.source, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', 'owner', true, 'granted'], `still stopped, her yes remembered: ${JSON.stringify(e)}`);
      const grants = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.action === 'grant');
      assertEqual(grants.map((d) => [d.channel, d.source, d.scope, d.sourceRef?.heldByOwnerStop]), [['email', 'splash', scope, true]], 'one ledger grant, marked held');
      assertEqual(e?.eventId, grants[0].id, 'the projection points at it');
      const chip = (await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}`)).body.venue.consent.email;
      assertEqual([chip.state, chip.ownerStopped], ['no', true], 'the owner sees email stopped');
      for (const [lang, re] of [
        ['en', /Said yes to messages by .+ on the Wi-Fi page\. Marketing stays stopped here until you resume it\./],
        ['de', /Werbung bleibt hier gestoppt, bis du sie wieder einschaltest\./],
      ] as const) {
        const tl = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}?lang=${lang}`);
        const sentences = (tl.body.timeline as any[]).map((i) => i.sentence as string);
        assert(sentences.some((x) => re.test(x)), `${lang}: the held yes is explained: ${sentences.join(' | ')}`);
      }

      // The owner resumes: her yes is back; channels she never said yes to stay "no answer".
      res = await api.call('POST', path, { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.consent.email.state, res.body.consent.email.ownerStopped], [200, 'yes', false], 'resume: email is a yes');
      assertEqual([res.body.consent.sms.state, res.body.consent.whatsapp.state], ['none', 'none'], 'no yes to give back on SMS / WhatsApp');
      assertEqual((await emailEntry())?.state, 'granted', 'granted');
    });

    await test("stop all, then a splash yes at a venue opened later: the ledger has the owner's stop AND the guest's yes (held) for the channel with an address; the timeline says so; resume all gives the yes back", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      // Email only: SMS / WhatsApp have no address.
      const person = { firstName: 'Ola', email: 'ola@test.local', consent: true };
      const g = await joined(S1.tenant, { venue: S1, ...person, guestId: 'g_ola' });
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      let res = await api.call('POST', path, { action: 'stop', scope: 'all', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 3], `stopped at all venues: ${res.text.slice(0, 200)}`);

      // The owner opens S3 later; Ola connects there ticking the box.
      await setupVenue(S3);
      await advance(MINUTE_MS);
      await connect({ venue: S3, ...person, guestId: 'g_ola_s3' });
      await runDue();
      assertEqual(await contactIdFor(S3.tenant, 'g_ola_s3'), g, 'the same guest');
      const s3 = `venue:${S3.venueId}`;
      const atS3 = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.scope === s3);
      const rows = atS3.map((d) => JSON.stringify([d.channel, d.action, d.source, d.sourceRef?.kind ?? null, d.sourceRef?.heldByOwnerStop === true])).sort();
      assertEqual(
        rows,
        [
          ['email', 'grant', 'splash', null, true],
          ['email', 'revoke', 'owner', 'owner_stop_all', false],
          ['sms', 'revoke', 'owner', 'owner_stop_all', false],
          ['whatsapp', 'revoke', 'owner', 'owner_stop_all', false],
        ].map((r) => JSON.stringify(r)),
        "S3's ledger: the owner's stop for every channel, her yes (held) for email only",
      );
      const entries = (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[s3] ?? {};
      const heldGrant = atS3.find((d) => d.action === 'grant')!;
      assertEqual(
        [entries.email?.state, entries.email?.revokedVia, entries.email?.ownerStopped, entries.email?.ownerPrior, entries.email?.eventId],
        ['revoked', 'owner', true, 'granted', heldGrant.id],
        `email at S3: still stopped, her yes remembered (the projection points at the grant): ${JSON.stringify(entries.email)}`,
      );
      assertEqual([entries.sms?.state, entries.sms?.revokedVia, entries.sms?.ownerStopped, entries.sms?.ownerPrior], ['revoked', 'owner', true, 'none'], 'SMS at S3: stopped, no yes behind it');
      const chips = async (venue: VenueFixture) => (await api.get(`/tenants/${S1.tenant}/venues/${venue.venueId}/guests/${g}`)).body.venue.consent;
      const before = await chips(S3);
      assertEqual([before.email.state, before.email.ownerStopped], ['no', true], 'the owner sees email stopped at S3');
      for (const [lang, re] of [
        ['en', /Said yes to messages by .+ on the Wi-Fi page\. Marketing stays stopped here until you resume it\./],
        ['de', /Werbung bleibt hier gestoppt, bis du sie wieder einschaltest\./],
      ] as const) {
        const tl = await api.get(`/tenants/${S1.tenant}/venues/${S3.venueId}/guests/${g}?lang=${lang}`);
        const sentences = (tl.body.timeline as any[]).map((i) => i.sentence as string);
        assert(sentences.some((x) => re.test(x)), `${lang}: the held yes is explained: ${sentences.join(' | ')}`);
      }
      assertEqual((await docsWhere(COL.journeyInstances, 'contactId', g)).filter((i) => i.venueId === S3.venueId).length, 0, 'nothing started at S3 while stopped');

      // The owner resumes everything: her yes at S3 is back; SMS / WhatsApp (never a yes) are "no answer".
      res = await api.call('POST', path, { action: 'resume', scope: 'all', actor: OWNER_ACTOR });
      assertEqual(res.status, 200, 'resumed');
      const after = await chips(S3);
      assertEqual([after.email.state, after.email.ownerStopped, after.sms.state, after.whatsapp.state], ['yes', false, 'none', 'none'], `S3 after the resume: ${JSON.stringify(after)}`);
      assertEqual((await chips(S1)).email.state, 'yes', 'S1 email is a yes again');
      assertEqual((await db.collection(COL.contacts).doc(g).get()).get('ownerStoppedAll') ?? null, null, '"stop all" is gone');
    });

    await test("owner stop with no yes behind it, then a tick with an old SMS opt-out: an import_legacy revoke keeping the owner's mark; START is then held; resume gives the yes back", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      const person = { firstName: 'Lee', email: 'lee@test.local', phone: '791118051', phoneCountryCode: '+41', phoneVerified: true };
      const g = await joined(S1.tenant, { venue: S1, ...person, consent: false, guestId: 'g_lee' });
      const scope = `venue:${S1.venueId}`;
      const entry = async (ch: string) => (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[scope]?.[ch];
      assertEqual(await entry('sms'), undefined, 'no answer yet');
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      let res = await api.call('POST', path, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.changed], [200, 3], 'the owner stops marketing here');
      let e = await entry('sms');
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', true, 'none'], 'stopped with no yes before');

      // She comes back and ticks the box; a guest record of hers carries an old STOP flag.
      await advance(5 * MINUTE_MS);
      await connect({ venue: S1, ...person, consent: true, guestId: 'g_lee_old', legacy: { smsOptOut: true } });
      await runDue();
      assertEqual(await contactIdFor(S1.tenant, 'g_lee_old'), g, 'the same guest');
      e = await entry('sms');
      assertEqual([e?.state, e?.revokedVia, e?.source, e?.ownerStopped], ['revoked', 'channel', 'import_legacy', true], `her old STOP, with the owner's mark: ${JSON.stringify(e)}`);
      const imported = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.channel === 'sms' && d.source === 'import_legacy');
      assertEqual(imported.map((d) => [d.scope, d.action]), [[scope, 'revoke']], 'one import_legacy revoke in the ledger');
      assertEqual([(await entry('email'))?.ownerPrior, (await entry('email'))?.ownerStopped], ['granted', true], 'email: her tick held by the owner\'s stop');

      // She texts START: held for the owner (not a yes while the owner's stop stands).
      await advance(MINUTE_MS);
      await adaptiveOnInboundSms({ from: '+41791118051', body: 'START', legacyKind: 'start', messageSid: 'SMleestart1', optOutType: null, signatureChecked: true });
      await runDue();
      e = await entry('sms');
      assertEqual([e?.state, e?.revokedVia, e?.ownerStopped, e?.ownerPrior], ['revoked', 'owner', true, 'granted'], `held by the owner's stop: ${JSON.stringify(e)}`);
      const held = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.channel === 'sms' && d.action === 'grant' && d.source === 'sms_keyword');
      assertEqual(held.map((d) => [d.scope, d.sourceRef?.heldByOwnerStop]), [[scope, true]], 'one ledger grant for the START, marked held');

      // The owner resumes: SMS is a yes again (her START), and email (her tick).
      res = await api.call('POST', path, { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.consent.sms.state, res.body.consent.sms.ownerStopped, res.body.consent.email.state], [200, 'yes', false, 'yes'], `resume: ${JSON.stringify(res.body.consent)}`);
      assertEqual((await entry('sms'))?.state, 'granted', 'SMS granted');
    });

    await test("the owner's lift (stop, then resume, where the guest had no yes) reads as no answer: the next marketing step is skipped as no_consent 'no yes for email…', not as stopped", async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      const t0 = nextTuesday1240();
      await setClock(t0);
      await setLaunch({ [S1.tenant]: 'test' });
      // Email only, a yes on the splash: the welcome journey runs and its welcome goes.
      const g = await joined(S1.tenant, { venue: S1, firstName: 'Ivo', email: 'ivo@test.local', consent: true });
      await advance(15 * MINUTE_MS);
      await runDue();
      const a1 = await a1Of(g, S1.venueId);
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', a1.id)).map((x) => x.nodeId), ['s1'], 'the welcome went (test run)');
      const scope = `venue:${S1.venueId}`;
      // Written directly: no answer on email here (as if the guest had never said yes), then the owner's real stop + resume.
      await db.collection(COL.contacts).doc(g).update(new FieldPath('marketingConsent', scope, 'email'), FieldValue.delete());
      const path = `/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${g}/marketing`;
      assertEqual((await api.call('POST', path, { action: 'stop', scope: 'venue', actor: OWNER_ACTOR })).body.changed, 3, 'the owner stops');
      const res = await api.call('POST', path, { action: 'resume', scope: 'venue', actor: OWNER_ACTOR });
      assertEqual([res.status, res.body.consent.email.state], [200, 'none'], 'resume: email is "no answer" (nothing to give back)');
      const e = (await db.collection(COL.contacts).doc(g).get()).get('marketingConsent')?.[scope]?.email;
      assertEqual([e?.state, e?.revokedVia ?? null, e?.source], ['revoked', null, 'owner_resume'], `the lift entry: ${JSON.stringify(e)}`);
      const lift = (await docsWhere(COL.consentEvents, 'contactId', g)).filter((d) => d.sourceRef?.kind === 'owner_lift' && d.channel === 'email');
      assertEqual(lift.length, 1, 'an owner_lift ledger doc');

      // Her next marketing step at S1.
      await runUntil(t0 + 4 * DAY_MS);
      const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((x) => x.type === 'send.skipped');
      assert(skipped.length >= 1, `the next marketing step is skipped (${skipped.length})`);
      const d = skipped[0].data.decision;
      assertEqual(
        d.channel.rejected.filter((r: any) => r.channel === 'email').map((r: any) => r.reason),
        ['no_consent'],
        `email rejected as no answer, not as revoked: ${JSON.stringify(d.channel.rejected)}`,
      );
      const facts = (d.checks as any[]).map((c) => String(c.fact));
      assert(!facts.some((f) => /stopped/.test(f)), `not the "stopped" wording: ${facts.join(' | ')}`);
      assertEqual([d.rule, d.reason], ['consent', 'no_consent'], `skipped for consent: ${d.rule}/${d.reason} (${facts.join(' | ')})`);
      assert(facts.some((f) => /^no yes for email/.test(f)), `the fact says there is no yes: ${facts.join(' | ')}`);
      assertEqual((await docsWhere(COL.journeySends, 'instanceId', a1.id)).map((x) => x.nodeId), ['s1'], 'nothing sent after the welcome');
    });

    await test('the sign-up breaker: a `journey.not_started` event (not counted), and the owner timeline says why', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(S1);
      await setClock(nextTuesday1240());
      await setLaunch({ [S1.tenant]: 'test' });
      await setSafety({ maxNewContactsPerApPerHour: 1 });
      await joined(S1.tenant, { venue: S1, email: 'first.breaker@test.local', consent: true });
      const second = await joined(S1.tenant, { venue: S1, firstName: 'Nia', email: 'second.breaker@test.local', consent: true });
      const ev = (await docsWhere(COL.journeyEvents, 'contactId', second)).filter((e) => e.type === 'journey.not_started');
      assertEqual(ev.map((e) => e.data.reason), ['signup_breaker'], 'why nothing started');
      assertEqual((await docsWhere(COL.journeyInstances, 'contactId', second)).length, 0, 'no journey');
      const tl = await api.get(`/tenants/${S1.tenant}/venues/${S1.venueId}/guests/${second}?lang=en`);
      assert(tl.body.timeline.some((i: any) => i.kind === 'journey.not_started' && /unusually many new guests/.test(i.sentence)), `the sentence: ${tl.body.timeline.map((i: any) => i.sentence).join(' | ')}`);
      await rollupVenue(S1.venueId, { cutoffMs: Date.now() + 1000 });
      const day = (await docsWhere(COL.journeyStats, 'venueId', S1.venueId)).find((d) => d.journeyKey === '_venue')!;
      assertEqual(day.dryRun?.entered, 1, 'one guest started (the breaker case is not counted as a start)');
      assert(!JSON.stringify(day).includes('not_started'), 'no counter for the trace event');
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
