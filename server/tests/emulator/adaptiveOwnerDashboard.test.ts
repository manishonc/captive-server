/**
 * The owner dashboard (spec §13; 2026-11-04) on the emulator, through the real router and worker.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - A visit says whether the guest can get offers from the venue after the login (`reachable`);
 *    a reached goal names the journey's last message (`lastTouch`).
 *  - After a rollup, `GET /results?detail=1` has the capture rate (new / returning), the visits
 *    heatmap in the venue's local hours, and the welcome's funnel per channel and send time with
 *    credits (= the ledger), their CHF value and the estimated revenue next to them.
 *  - Without `detail`: `capture` only (no heatmap, no journeys), as the running cards ask.
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
  ledger,
  nextTuesday1240,
  resetEmulator,
  runDue,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type VenueFixture,
} from './helpers';
import { mountApi } from './ownerApiHelpers';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { adaptiveVenueId } from '../../src/adaptive/store/collections';
import { DAY_MS, MINUTE_MS, localDateKey, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const D: VenueFixture = { tenant: 'tenant_dash', venueId: 'venue_dash', apId: 'ap_dash', apMac: 'aa:dd:dd:dd:dd:01' };
const A1 = 'welcome_second_visit';

async function main() {
  const api = await mountApi();
  try {
    console.log('\nOwner dashboard (spec §13)\n');

    await test('capture rate, heatmap and the welcome funnel after a rollup', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(D);
      await seedWallet(D.tenant, 5000);
      await setLaunch({ [D.tenant]: 'live' }, { paused: false });
      const t0 = nextTuesday1240();
      await setClock(t0);

      // Tuesday 12:40: Ana says yes (a verified phone), Bob doesn't (email only).
      const ana = await connect({ venue: D, firstName: 'Ana', email: 'ana.dash@test.local', phone: '791117001', phoneCountryCode: '+41', phoneVerified: true, consent: true, consentAsked: true });
      await connect({ venue: D, firstName: 'Bob', email: 'bob.dash@test.local', consent: false, consentAsked: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();

      const anaId = await contactIdFor(D.tenant, ana);
      const sends = (await docsWhere(COL.journeySends, 'contactId', anaId)).filter((s) => s.journeyKey === A1 && s.mode === 'live');
      assertEqual(sends.length, 1, `one live welcome: ${JSON.stringify(sends.map((s) => [s.channel, s.status]))}`);
      const welcome = sends[0];
      await devProviderEvent({ sendKey: welcome.id, event: 'delivered' });
      await devProviderEvent({ sendKey: welcome.id, event: 'click' });
      await runDue();

      // Wednesday 10:00: Ana comes back → the welcome's goal.
      const p = localParts(new Date(t0), TZ);
      await setClock(zonedTime(p.year, p.month, p.day + 1, 10, 0, TZ).getTime());
      await connect({ venue: D, guestId: ana, firstName: 'Ana', email: 'ana.dash@test.local', phone: '791117001', phoneCountryCode: '+41', phoneVerified: true, consent: true, consentAsked: true });
      await runDue();

      const events = await docsWhere(COL.journeyEvents, 'venueId', D.venueId);
      const visits = events.filter((e) => e.type === 'visit.started');
      assertEqual(visits.map((e) => [e.data.isFirstVisit, e.data.reachable]).sort(), [[false, true], [true, false], [true, true]].sort(), 'visits say first/returning and reachable');
      const conv = events.filter((e) => e.type === 'journey.converted');
      assertEqual(conv.length, 1, 'one goal reached');
      assertEqual(conv[0].data.lastTouch, { channel: welcome.channel, slot: welcome.slot, purpose: 'marketing' }, 'the goal names the last message');

      await rollupVenue(D.venueId, { cutoffMs: Date.now() + 1000 });
      const from = localDateKey(new Date(t0 - DAY_MS), TZ);
      const to = localDateKey(new Date(t0 + 2 * DAY_MS), TZ);
      const res = await api.get(`/tenants/${D.tenant}/results?venueId=${D.venueId}&from=${from}&to=${to}&detail=1`);
      assertEqual(res.status, 200, `GET results detail: ${res.text.slice(0, 200)}`);
      const v = res.body.venues[0];

      // Capture rate: 2 first visits (1 yes), 1 returning (yes).
      assertEqual(v.capture.first, { visits: 2, yes: 1, rate: 0.5 }, 'new guests');
      assertEqual(v.capture.returning, { visits: 1, yes: 1, rate: 1 }, 'returning guests');
      assertEqual(v.capture.visits, { total: 3, first: 2, returning: 1 }, 'visits');
      assert(v.capture.logins >= 3, `logins: ${v.capture.logins}`);

      // Heatmap: Tuesday 12:00 twice, Wednesday 10:00 once (local hours; Monday is row 0).
      assertEqual([v.heatmap.cells[1][12], v.heatmap.cells[2][10], v.heatmap.total], [2, 1, 3], 'heatmap cells');
      assertEqual(v.heatmap.busiest, { weekday: 2, hour: 12, visits: 2 }, 'busiest');
      assertEqual(v.heatmap.timezone, TZ, 'the venue zone');

      // The welcome's funnel.
      const j = v.journeys.find((x: any) => x.journeyKey === A1);
      assertEqual(j.goal, 'visit', 'goal is a visit');
      const f = j.funnel;
      // Every message of the journey counts as sent: the welcome and the free thank-you after the goal.
      const all = (await docsWhere(COL.journeySends, 'contactId', anaId)).filter((s) => s.journeyKey === A1 && s.mode === 'live' && s.status !== 'failed');
      assert(all.length >= 2 && all.some((s) => s.purpose === 'service'), `welcome + thank-you: ${JSON.stringify(all.map((s) => [s.channel, s.purpose]))}`);
      const ch = f.byChannel.find((r: any) => r.key === welcome.channel);
      assertEqual([ch.sent, ch.delivered, ch.clicked, ch.converted], [all.filter((s) => s.channel === welcome.channel).length, 1, 1, 1], `${welcome.channel} row`);
      assertEqual(f.serviceSent, all.filter((s) => s.purpose === 'service').length, 'the free info messages');
      if (welcome.channel === 'sms') assertEqual(ch.opened, null, 'SMS: no opens');
      const debits = (await ledger(D.tenant)).filter((l) => l.id.startsWith('debit_auto_')).reduce((n, l) => n - Number(l.credits), 0);
      assertEqual(ch.credits, debits, 'credits = the ledger');
      assertEqual(ch.creditsValue, { amountMinor: debits, currency: 'CHF' }, 'credits in CHF (100 a franc)');
      const avg = (await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(D.venueId)).get()).get('avgSpendPerVisit');
      assertEqual(ch.revenue, { amountMinor: avg.amountMinor, currency: avg.currency }, 'revenue = 1 × average spend');
      const slot = f.bySlot.find((r: any) => r.key === welcome.slot);
      assertEqual([slot.sent, slot.delivered, slot.clicked, slot.converted, slot.credits], [all.filter((s) => s.slot === welcome.slot).length, 1, 1, 1, debits], `${welcome.slot} row`);
      assertEqual([f.total.converted, f.convertedNotSplit, f.convertedBeforeMessage], [1, 0, 0], 'journey line');
      assertEqual(j.testRunFunnel.total.sent, 0, 'no test run');

      // The running cards' call: capture, no heatmap, no journeys.
      const plain = await api.get(`/tenants/${D.tenant}/results?from=${from}&to=${to}`);
      const pv = plain.body.venues[0];
      assertEqual(pv.capture.first.rate, 0.5, 'capture on the card call');
      assert(pv.heatmap === undefined && pv.journeys === undefined, 'no heatmap or journeys without detail');
      // `days` (the dashboard's 7 / 30 / 90 buttons): the last N days ending `to` (default today).
      const week = await api.get(`/tenants/${D.tenant}/results?venueId=${D.venueId}&to=${to}&days=7`);
      assertEqual(week.body.range, { from: localDateKey(new Date(t0 - 4 * DAY_MS), TZ), to }, '7 days ending `to`');
      assertEqual(week.body.venues[0].capture.first.visits, 2, 'same visits in the week');
      for (const bad of ['0', '93', '2.5', 'x']) assertEqual((await api.get(`/tenants/${D.tenant}/results?venueId=${D.venueId}&days=${bad}`)).status, 400, `days=${bad} → 400`);
      // `journeys=1` alone keeps its old shape (no funnel).
      const old = await api.get(`/tenants/${D.tenant}/results?venueId=${D.venueId}&from=${from}&to=${to}&journeys=1`);
      assert(old.body.venues[0].journeys.every((x: any) => x.funnel === undefined && x.goal === undefined), 'journeys=1 unchanged');
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
