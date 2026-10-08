/**
 * PR S on the emulator: the four restaurant scan journeys end to end, through the real worker
 * (daily `scan_venue` chain armed by the watchdog, `scan_trigger` per guest), in a test run
 * (dry runs: nothing sent, nothing charged).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - **Seed:** v2 of the four journeys and of Restaurant growth / Local business are published
 *    next to v1; the four are available, the filler is renamed; a second boot changes nothing.
 *  - **Win-back:** 30 days after the last visit the 30-day offer, 60 days after the 60-day one
 *    (one run per stage); a revisit converts the open run and resets the count (no 90-day stage
 *    for the old visit).
 *  - **Birthday:** the 1st of the month at 10:00 for a guest whose month it is; a guest who tells
 *    us on the 5th gets it then; after the 25th, no gift this year.
 *  - **Holidays:** 7 days before Christmas Eve, guests of the last 12 months get the reminder,
 *    spread over 3 mornings, with the owner's booking link in the wording.
 *  - **Slow times:** after 5 weeks of visits, Monday's scan picks the slow Tuesday afternoon and
 *    Thursday evening and invites their guests; the message names the time.
 *  - **v1 setups:** a venue still on Restaurant growth v1 runs none of the four.
 */

import {
  assert,
  assertEqual,
  COL,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
  nextTuesday1240,
  now,
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  seedWallet,
  advance,
  test,
  TZ,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { saveSetups } from '../../src/adaptive/service/tenant';
import { ensureAdaptiveSeed } from '../../src/adaptive/seed/ensureSeed';
import { invalidateCatalogue } from '../../src/adaptive/service/catalogue';
import { readEngineSettings } from '../../src/adaptive/store/engineSettings';
import { scanWatchdog } from '../../src/adaptive/scans/schedule';
import { DAY_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';
import { addDays } from '../../src/adaptive/core/scans/holidays';
import { MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { mountApi } from './ownerApiHelpers';
import { FieldValue } from 'firebase-admin/firestore';

const V: VenueFixture = { tenant: 'tenant_scan', venueId: 'venue_scan', apId: 'ap_scan', apMac: 'aa:aa:aa:aa:5c:01' };
const OWNER = { uid: 'tenant_scan_owner', kind: 'tenant_user' as const, role: 'ADMIN' as const };

const SCAN_ON = {
  win_back: { enabled: true, slots: {} },
  birthday: { enabled: true, slots: {} },
  quiet_hours_filler: { enabled: true, slots: {} },
  holidays: { enabled: true, slots: {} },
  review_ask: { enabled: false, slots: {} },
};

async function freshVenue(journeys: Record<string, { enabled: boolean; slots: Record<string, unknown> }> = SCAN_ON): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(V);
  await saveSetups(V.tenant, { playbookKey: 'restaurant_growth', venueIds: [V.venueId], journeys: journeys as never }, OWNER);
  await setLaunch({ [V.tenant]: 'test' });
}

async function armScans(): Promise<void> {
  await scanWatchdog({ now: now(), settings: await readEngineSettings() });
}

async function instancesOf(guestId: string, journeyKey: string): Promise<AnyDoc[]> {
  const contactId = await contactIdFor(V.tenant, guestId);
  return (await docsWhere(COL.journeyInstances, 'contactId', contactId)).filter((i) => i.journeyKey === journeyKey).sort((a, b) => String(a.entryKey).localeCompare(String(b.entryKey)));
}

async function sendsOf(instanceId: string): Promise<AnyDoc[]> {
  return docsWhere(COL.journeySends, 'instanceId', instanceId);
}

const local = (ms: number) => localParts(new Date(ms), TZ);
const at = (date: string, h: number, m = 0) => {
  const [y, mo, d] = date.split('-').map(Number);
  return zonedTime(y, mo, d, h, m, TZ).getTime();
};
const dateOf = (ms: number) => {
  const p = local(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** Runs the worker to `until` in steps of at most 20 days (runUntil stops after 200 hops). */
async function runTo(until: number): Promise<void> {
  while (now() < until) await runUntil(Math.min(until, now() + 20 * DAY_MS));
}

async function main() {
  console.log('\nPR S scan journeys (emulator)');

  await test('seed: v2 of the four journeys and of both playbooks is published next to v1, once', async () => {
    await resetEmulator();
    const r = await ensureAdaptiveSeed();
    assertEqual(r.problems, [], 'no problems');
    assertEqual(r.failed, [], 'nothing failed');
    assertEqual((r.versionsPublished ?? []).length, 6, `published: ${JSON.stringify(r.versionsPublished)}`);
    for (const key of ['win_back', 'birthday', 'quiet_hours_filler', 'holidays']) {
      const h = (await db.collection(COL.journeyTemplates).doc(key).get()).data()!;
      assertEqual([h.latestVersion, h.publishedVersion, h.availability], [2, 2, 'available'], key);
      const v1 = (await db.collection(COL.journeyTemplates).doc(key).collection('versions').doc('1').get()).data()!;
      assertEqual(v1.state, 'published', `${key} v1 kept`);
    }
    assertEqual(((await db.collection(COL.journeyTemplates).doc('quiet_hours_filler').get()).data()!.name as { en: string }).en, 'Slow-time filler', 'renamed');
    const rg = (await db.collection(COL.playbooks).doc('restaurant_growth').get()).data()!;
    assertEqual([rg.latestVersion, rg.publishedVersion], [2, 2], 'Restaurant growth v2');
    const v2 = (await db.collection(COL.playbooks).doc('restaurant_growth').collection('versions').doc('2').get()).data()!;
    assert((v2.offerMenuDefaults as AnyDoc[]).some((o) => o.offerKey === 'twenty_pct'), '20% on the menu');
    const again = await ensureAdaptiveSeed();
    assertEqual([again.versionsPublished, again.created.length], [[], 0], 'a second boot changes nothing');
    invalidateCatalogue();
  });

  await test('win-back: 30 then 60 days after the last visit, one run per stage; a revisit converts and resets', async () => {
    await freshVenue();
    const t0 = nextTuesday1240();
    await setClock(t0);
    const anna = await connect({ venue: V, firstName: 'Anna', email: 'anna@scan.test', consent: true });
    await runDue();
    await armScans();
    await runTo(t0 + 29 * DAY_MS);
    assertEqual((await instancesOf(anna, 'win_back')).length, 0, 'nothing before day 30');
    await runTo(at(addDays(dateOf(t0), 30), 12));
    let runs = await instancesOf(anna, 'win_back');
    assertEqual(runs.map((r) => String(r.entryKey).split(':').slice(0, 2).join(':')), ['winback:30'], 'the 30-day stage');
    assertEqual([runs[0].mode, runs[0].vars?.offerKey ?? runs[0].state?.vars?.offerKey], ['test', 'ten_pct'], 'test run, 10% off');
    const s30 = await sendsOf(runs[0].id);
    assertEqual(s30.map((s) => [s.status, s.channel]), [['dry_run', 'email']], 'one dry-run email');
    assert(String(s30[0].content?.preview ?? '').includes('10% off'), `the offer in the text: ${s30[0].content?.preview}`);
    const sentAt = local(new Date(s30[0].createdAt?.toMillis?.() ?? s30[0].createdAt).getTime());
    assert(sentAt.hour >= 9 && sentAt.hour < 11, `morning slot: ${sentAt.hour}:${sentAt.minute}`);

    await runTo(at(addDays(dateOf(t0), 60), 12));
    runs = await instancesOf(anna, 'win_back');
    assertEqual(runs.map((r) => [String(r.entryKey).split(':').slice(0, 2).join(':'), r.status]), [['winback:30', 'completed'], ['winback:60', 'active']], 'the 60-day stage; the 30-day run closed when its offer ended');
    const s60 = await sendsOf(runs[1].id);
    assert(String(s60[0]?.content?.preview ?? '').includes('15% off'), `15% off: ${s60[0]?.content?.preview}`);

    // Anna comes back on day 65: the open run converts, and the count starts again.
    await setClock(at(addDays(dateOf(t0), 65), 18));
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@scan.test', consent: true });
    await runDue();
    runs = await instancesOf(anna, 'win_back');
    assertEqual(runs[1].status, 'converted', 'came back');
    await runTo(at(addDays(dateOf(t0), 92), 12));
    runs = await instancesOf(anna, 'win_back');
    assert(!runs.some((r) => String(r.entryKey).startsWith('winback:90:')), 'no 90-day stage for the old visit');
    // 30 days after the revisit (day 65): a new first stage.
    await runTo(at(addDays(dateOf(t0), 96), 12));
    runs = await instancesOf(anna, 'win_back');
    assertEqual(runs.filter((r) => String(r.entryKey).startsWith('winback:30:')).map((r) => r.status), ['completed', 'active'], 'a new 30-day stage after the revisit');
  });

  await test('birthday: the 1st at 10:00; told on the 5th → that day; told after the 25th → not this year', async () => {
    await freshVenue();
    const t0 = nextTuesday1240();
    await setClock(t0);
    const ben = await connect({ venue: V, firstName: 'Ben', email: 'ben@scan.test', consent: true });
    const cleo = await connect({ venue: V, firstName: 'Cleo', email: 'cleo@scan.test', consent: true });
    const dan = await connect({ venue: V, firstName: 'Dan', email: 'dan@scan.test', consent: true });
    await runDue();
    const p = local(t0);
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    const first = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
    await db.collection(COL.contacts).doc(await contactIdFor(V.tenant, ben)).update({ 'profile.birthdayMonth': nextMonth });
    await armScans();
    await runTo(at(first, 12));
    const benRuns = await instancesOf(ben, 'birthday');
    assertEqual(benRuns.map((r) => r.entryKey), [`birthday:${nextYear}`], 'Ben’s gift');
    const bs = await sendsOf(benRuns[0].id);
    assertEqual(bs.length, 1, 'one message');
    const benAt = local(new Date(bs[0].createdAt?.toMillis?.() ?? bs[0].createdAt).getTime());
    assertEqual([benAt.day, benAt.hour], [1, 10], 'the 1st at 10:00');
    assert(String(bs[0].content?.preview ?? '').includes('free dessert'), `the gift: ${bs[0].content?.preview}`);

    await runTo(at(addDays(first, 4), 20));
    await db.collection(COL.contacts).doc(await contactIdFor(V.tenant, cleo)).update({ 'profile.birthdayMonth': nextMonth });
    await runTo(at(addDays(first, 5), 12));
    assertEqual((await instancesOf(cleo, 'birthday')).length, 1, 'Cleo told us on the 5th: gift the next morning');

    await runTo(at(addDays(first, 25), 20));
    await db.collection(COL.contacts).doc(await contactIdFor(V.tenant, dan)).update({ 'profile.birthdayMonth': nextMonth });
    await runTo(at(addDays(first, 27), 12));
    assertEqual((await instancesOf(dan, 'birthday')).length, 0, 'Dan told us after the 25th');
  });

  await test('holidays: 7 days before each picked day, spread over 3 mornings, close days each reach the guest (Christmas Eve, Christmas, New Year’s Eve), a tracked booking link', async () => {
    await freshVenue({ ...SCAN_ON, holidays: { enabled: true, slots: { holidays: 'christmas_eve,christmas,new_years_eve', booking_url: 'https://book.example/scan' } } });
    const t0 = nextTuesday1240();
    await setClock(t0);
    const guests: string[] = [];
    for (let i = 0; i < 6; i += 1) guests.push(await connect({ venue: V, firstName: `G${i}`, email: `g${i}@scan.test`, consent: true }));
    const nobody = await connect({ venue: V, firstName: 'NoConsent', email: 'no@scan.test', consent: false });
    await runDue();
    const year = local(t0).month === 12 && local(t0).day > 17 ? local(t0).year + 1 : local(t0).year;
    await setClock(at(`${year}-12-16`, 2));
    await armScans();
    await runTo(at(`${year}-12-19`, 12));
    const days = new Set<number>();
    for (const g of guests) {
      const runs = await instancesOf(g, 'holidays');
      assert(runs.some((r) => r.entryKey === `holiday:christmas_eve:${year}`), `${g}: the Christmas Eve reminder`);
      const eve = runs.find((r) => r.entryKey === `holiday:christmas_eve:${year}`)!;
      const s = await sendsOf(eve.id);
      assertEqual(s.length, 1, 'one message');
      const text = String(s[0].content?.preview ?? '');
      assert(text.includes('Christmas Eve') && text.includes('[booking link]') && !text.includes('book.example'), `the day and a tracked booking link: ${text}`);
      days.add(local(new Date(s[0].createdAt?.toMillis?.() ?? s[0].createdAt).getTime()).day);
    }
    assert(days.size >= 2 && [...days].every((d) => d >= 17 && d <= 19), `spread over the mornings: ${[...days]}`);

    await runTo(at(`${year}-12-27`, 12));
    for (const g of guests) {
      const runs = await instancesOf(g, 'holidays');
      const byKey = Object.fromEntries(runs.map((r) => [String(r.entryKey).split(':')[1], r]));
      assertEqual(Object.keys(byKey).sort(), ['christmas', 'christmas_eve', 'new_years_eve'], `${g}: three reminders`);
      assertEqual([byKey.christmas_eve.status, byKey.christmas_eve.exitReason], ['completed', 'exit_on:scan.due'], 'Christmas Eve closed by the next day’s reminder');
      for (const k of ['christmas_eve', 'christmas', 'new_years_eve']) assertEqual((await sendsOf(byKey[k].id)).length, 1, `${g}: ${k} sent once`);
    }
    assertEqual((await instancesOf(nobody, 'holidays')).length, 0, 'no consent, no reminder');
    assertEqual((await docsWhere(COL.journeyEvents, 'contactId', await contactIdFor(V.tenant, nobody))).filter((e) => e.type === 'scan.due').length, 0, 'and no scan record either');
  });

  await test('slow times: Monday finds the slow Tuesday afternoon and Thursday evening and invites their guests', async () => {
    await freshVenue();
    // Five weeks of visits, starting on a Monday at least two days from now.
    let monday = nextTuesday1240() + 6 * DAY_MS;
    while (local(monday).weekday !== 1) monday += DAY_MS;
    const start = dateOf(monday);
    const tue: string[] = [];
    const thu: string[] = [];
    const visit = async (date: string, hour: number, guestId: string, name: string) => {
      if (at(date, hour) > now()) await setClock(at(date, hour));
      await connect({ venue: V, guestId, firstName: name, email: `${guestId}@scan.test`, consent: true });
      await runDue();
    };
    for (let w = 0; w < 5; w += 1) {
      const mon = addDays(start, 7 * w);
      for (let i = 0; i < 5; i += 1) await visit(mon, 12, `mon_${w}_${i}`, 'Mo');
      const reg = `tue_reg_${w % 2}`;
      await visit(addDays(mon, 1), 15, reg, 'Tu');
      if (!tue.includes(reg)) tue.push(reg);
      for (let i = 0; i < 3; i += 1) {
        await visit(addDays(mon, 3), 19, `thu_${i}`, 'Th');
        if (!thu.includes(`thu_${i}`)) thu.push(`thu_${i}`);
      }
    }
    const scanMonday = addDays(start, 35);
    await setClock(at(scanMonday, 2));
    await armScans();
    await runTo(at(addDays(scanMonday, 3), 12));
    for (const g of tue) {
      const runs = await instancesOf(g, 'quiet_hours_filler');
      assertEqual(runs.length, 1, `${g} invited`);
      const s = await sendsOf(runs[0].id);
      assert(String(s[0]?.content?.preview ?? '').includes('this Tuesday afternoon'), `names the time: ${s[0]?.content?.preview}`);
      assertEqual(dateOf(new Date(s[0].createdAt?.toMillis?.() ?? s[0].createdAt).getTime()), addDays(scanMonday, 1), 'sent on the Tuesday morning');
    }
    for (const g of thu) {
      const runs = await instancesOf(g, 'quiet_hours_filler');
      assertEqual(runs.length, 1, `${g} invited`);
    }
    assertEqual((await instancesOf('mon_4_0', 'quiet_hours_filler')).length, 0, 'a lunch guest isn’t invited');
  });

  await test('birthday month: asked on a guest page while Birthday runs, saved once, then not asked again', async () => {
    const api = await mountApi();
    try {
      await freshVenue();
      await seedWallet(V.tenant, 5000);
      await setLaunch({ [V.tenant]: 'live' }, { paused: false });
      const t0 = nextTuesday1240();
      await setClock(t0);
      const gia = await connect({ venue: V, firstName: 'Gia', email: 'gia@scan.test', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      const welcome = (await instancesOf(gia, 'welcome_second_visit'))[0];
      const send = (await db.collection(COL.journeySends).doc(sendKeyFor(welcome.id, 's1')).get()).data()!;
      assertEqual([send.status, send.mode], ['sent', 'live'], 'a live welcome');
      let code = '';
      for (const c of send.shortCodes ?? []) if ((await db.collection('CaptivePortal_ShortLinks').doc(c).get()).get('journeyLink') === 'offer') code = c;
      assert(code, 'an offer link');
      let res = await api.get(`/public/offer/${code}?venueId=${V.venueId}`);
      assertEqual([res.status, res.body.birthday], [200, { ask: true }], 'asked');
      const post = (body: unknown) => api.call('POST', `/public/birthday/${code}`, body);
      assertEqual((await post({ venueId: V.venueId, kind: 'offer', month: 13 })).status, 404, 'a month that isn’t one');
      assertEqual((await post({ venueId: 'other', kind: 'offer', month: 3 })).status, 404, 'another venue');
      res = await post({ venueId: V.venueId, kind: 'offer', month: 3 });
      assertEqual([res.status, res.body.saved], [200, true], 'saved');
      res = await post({ venueId: V.venueId, kind: 'offer', month: 4 });
      assertEqual([res.status, res.body.saved], [200, true], 'a second answer reads the same');
      const contact = (await db.collection(COL.contacts).doc(await contactIdFor(V.tenant, gia)).get()).data()!;
      assertEqual(contact.profile?.birthdayMonth, 3, 'stored on the contact');
      res = await api.get(`/public/offer/${code}?venueId=${V.venueId}`);
      assertEqual(res.body.birthday, { ask: false }, 'never asked twice');
      assertEqual((await docsWhere(COL.journeyEvents, 'type', 'profile.birthday_month')).length, 1, 'one timeline event');
      // A guest whose yes to marketing is gone isn't asked, and an answer from them is refused.
      const cid = await contactIdFor(V.tenant, gia);
      await db.collection(COL.contacts).doc(cid).update({ 'profile.birthdayMonth': FieldValue.delete(), [`marketingConsent.venue:${V.venueId}`]: {} });
      res = await api.get(`/public/offer/${code}?venueId=${V.venueId}`);
      assertEqual(res.body.birthday, { ask: false }, 'no consent: not asked');
      assertEqual((await post({ venueId: V.venueId, kind: 'offer', month: 5 })).status, 404, 'no consent: refused');
    } finally {
      await api.close();
    }
  });

  await test('a venue still on Restaurant growth v1 runs none of the four', async () => {
    await freshVenue({ review_ask: { enabled: false, slots: {} } });
    // Pin the setup to v1 with win-back on (as an owner could have saved while v1 showed it).
    const setupRef = db.collection(COL.venuePlaybooks).doc(`${V.venueId}_restaurant_growth`);
    const setup = (await setupRef.get()).data()!;
    await setupRef.update({ playbookVersion: 1, 'journeys.win_back': { ...setup.journeys.win_back, enabled: true, templateVersion: 1, slots: { offer_30: 'ten_pct', offer_60: 'ten_pct', offer_90: 'ten_pct' } } });
    const t0 = nextTuesday1240();
    await setClock(t0);
    const eve = await connect({ venue: V, firstName: 'Eve', email: 'eve@scan.test', consent: true });
    await runDue();
    await armScans();
    await runTo(at(addDays(dateOf(t0), 31), 12));
    assertEqual((await instancesOf(eve, 'win_back')).length, 0, 'v1 never runs');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
