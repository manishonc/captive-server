/**
 * The guest's time zone from the splash, on the emulator (manager spec §2, §4.2, §14; decisions
 * D1–D5 of 2026-11-04): the real connect hook and worker, a test-run account.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - The splash zone lands on the contact (`profile.timezone`, via 'device', where, when); a later
 *    connect's zone replaces it; a connect without one, or with junk (UTC, an offset), keeps it.
 *  - A journey pins the zone it starts with (`meta.context.deviceTz`); a later zone doesn't move it.
 *  - The welcome due at 22:00 on a London phone (Swiss number, Zurich venue) is held to 09:00–09:20
 *    London; the same guest without a device zone gets it at 09:00 Zurich (08:00 London), as before.
 *  - The follow-up's afternoon slot is in the phone's time: 14:00–17:00 London.
 */

import {
  advance,
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
  test,
  withoutReviewAsk,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, MINUTE_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const V: VenueFixture = { tenant: 'tenant_tz', venueId: 'venue_tz', apId: 'ap_tz', apMac: 'aa:aa:aa:aa:7e:01' };
const LONDON = 'Europe/London';
const ZURICH = 'Europe/Zurich';

const hhmm = (ms: number, tz: string) => {
  const p = localParts(new Date(ms), tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};
const ms = (v: unknown): number => (v as { toMillis(): number }).toMillis();

async function freshVenue(): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(V);
  await withoutReviewAsk(V);
  await setLaunch({ [V.tenant]: 'test' });
  await setClock(nextTuesday1240());
}

async function contactOf(guestId: string): Promise<AnyDoc> {
  const id = await contactIdFor(V.tenant, guestId);
  return { ...((await db.collection(COL.contacts).doc(id).get()).data() as Record<string, any>), id };
}

async function welcomeOf(guestId: string): Promise<AnyDoc> {
  const c = await contactOf(guestId);
  const inst = (await docsWhere(COL.journeyInstances, 'contactId', c.id)).find((i) => i.journeyKey === 'welcome_second_visit');
  if (!inst) throw new Error(`no welcome journey for ${guestId}`);
  return inst;
}

async function sendOf(inst: AnyDoc, nodeId: string): Promise<AnyDoc | null> {
  const key = sendKeyFor(inst.id, nodeId);
  const snap = await db.collection(COL.journeySends).doc(key).get();
  return snap.exists ? { ...(snap.data() as Record<string, any>), id: key } : null;
}

/** The same visit a few minutes later (one connect per guest per minute is one event). */
async function later(): Promise<void> {
  await advance(10 * MINUTE_MS);
}

async function main() {
  console.log('\nGuest time zone from the splash (emulator)');

  await test('the splash zone lands on the contact; a later one replaces it; none or junk keeps it', async () => {
    await freshVenue();
    const anna = await connect({ venue: V, firstName: 'Anna', email: 'anna@tz.test', consent: true, timezone: LONDON });
    await runDue();
    let p = (await contactOf(anna)).profile ?? {};
    assertEqual([p.timezone, p.timezoneVia, p.timezoneVenueId], [LONDON, 'device', V.venueId], 'saved, with where');
    assert(Math.abs(ms(p.timezoneAt) - now()) < 5_000, 'and when (the connect)');

    await later();
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@tz.test', consent: true, timezone: 'America/New_York' });
    await runDue();
    assertEqual((await contactOf(anna)).profile?.timezone, 'America/New_York', 'the newest connect wins');

    for (const tz of [null, 'UTC', '+02:00', 'Zurich']) {
      await later();
      await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@tz.test', consent: true, timezone: tz });
      await runDue();
      assertEqual((await contactOf(anna)).profile?.timezone, 'America/New_York', `kept after ${JSON.stringify(tz)}`);
    }

    const ben = await connect({ venue: V, firstName: 'Ben', email: 'ben@tz.test', consent: true, timezone: 'Etc/UTC', birthdayMonth: 4 });
    await runDue();
    const pb = (await contactOf(ben)).profile ?? {};
    assertEqual([pb.timezone ?? null, pb.birthdayMonth], [null, 4], 'junk dropped; the birthday month still saved beside it');
  });

  await test('a journey pins the zone it starts with; a later zone does not move it', async () => {
    await freshVenue();
    const eve = await connect({ venue: V, firstName: 'Eve', email: 'eve@tz.test', consent: true, timezone: LONDON });
    await runDue();
    assertEqual((await welcomeOf(eve)).context.deviceTz, LONDON, 'pinned');
    await later(); // the same visit: no new journey, no revisit
    await connect({ venue: V, guestId: eve, firstName: 'Eve', email: 'eve@tz.test', consent: true, timezone: 'Asia/Tokyo' });
    await runDue();
    assertEqual((await contactOf(eve)).profile?.timezone, 'Asia/Tokyo', 'the contact has the new one');
    assertEqual((await welcomeOf(eve)).context.deviceTz, LONDON, 'the running journey keeps its zone');
    const fay = await connect({ venue: V, firstName: 'Fay', email: 'fay@tz.test', consent: true });
    await runDue();
    assertEqual((await welcomeOf(fay)).context.deviceTz, null, 'no zone → null (venue zone)');
  });

  await test('22:00 on a London phone: held to 09:00 London (10:00 Zurich); without it, 09:00 Zurich as before; follow-up 14:00–17:00 London', async () => {
    await freshVenue();
    const day = localParts(new Date(now()), LONDON);
    await setClock(zonedTime(day.year, day.month, day.day, 21, 45, LONDON).getTime()); // 22:45 Zurich
    const guest = { venue: V, phoneCountryCode: '+41', phoneVerified: true, consent: true };
    const cleo = await connect({ ...guest, firstName: 'Cleo', email: 'cleo@tz.test', phone: '791234570', timezone: LONDON });
    const dan = await connect({ ...guest, firstName: 'Dan', email: 'dan@tz.test', phone: '791234571' });
    await runDue();

    // 15 minutes later the welcome is due: 22:00 London, 23:00 Zurich — quiet in both.
    await advance(15 * MINUTE_MS);
    await runDue();
    const cleoW = await welcomeOf(cleo);
    const danW = await welcomeOf(dan);
    assertEqual([cleoW.context.deviceTz, danW.context.deviceTz], [LONDON, null], 'zones pinned');
    assertEqual([await sendOf(cleoW, 's1'), await sendOf(danW, 's1')], [null, null], 'nothing sent at night');
    const nextDay = localParts(new Date(now() + DAY_MS), LONDON);
    const nineLondon = zonedTime(nextDay.year, nextDay.month, nextDay.day, 9, 0, LONDON).getTime();
    const nineZurich = zonedTime(nextDay.year, nextDay.month, nextDay.day, 9, 0, ZURICH).getTime();
    const cleoUntil = ms(cleoW.waiting.untilAt);
    const danUntil = ms(danW.waiting.untilAt);
    assert(cleoUntil >= nineLondon && cleoUntil <= nineLondon + 20 * MINUTE_MS, `Cleo held to 09:00–09:20 London, got ${hhmm(cleoUntil, LONDON)} London`);
    assert(danUntil >= nineZurich && danUntil <= nineZurich + 20 * MINUTE_MS, `Dan held to 09:00–09:20 Zurich, got ${hhmm(danUntil, ZURICH)} Zurich`);
    const deferred = (await docsWhere(COL.journeyEvents, 'instanceId', cleoW.id)).find((e) => e.type === 'send.deferred');
    assert(deferred && JSON.stringify(deferred.data.decision).includes(LONDON), 'the "why" record names the phone zone');
    assertEqual(deferred!.data.replay.gate.quiet.deviceTz, LONDON, 'and Replay has it');

    // The morning: Dan's at 08:00–08:20 London (as before), Cleo's at 09:00–09:20 London.
    await runUntil(nineLondon + 30 * MINUTE_MS);
    const cleoS1 = await sendOf(cleoW, 's1');
    const danS1 = await sendOf(danW, 's1');
    assert(cleoS1 && danS1, 'both welcomes went (test run)');
    assertEqual([cleoS1!.status, cleoS1!.channel], ['dry_run', 'sms'], 'Cleo: a test-run SMS');
    const cleoAt = ms(cleoS1!.createdAt);
    const danAt = ms(danS1!.createdAt);
    assert(cleoAt >= nineLondon && cleoAt <= nineLondon + 20 * MINUTE_MS, `Cleo's welcome at ${hhmm(cleoAt, LONDON)} London`);
    assert(danAt >= nineZurich && danAt <= nineZurich + 20 * MINUTE_MS, `Dan's welcome at ${hhmm(danAt, LONDON)} London (${hhmm(danAt, ZURICH)} Zurich)`);

    // No click for 48 h → the follow-up by email in the afternoon slot, in each one's zone.
    await runUntil(now() + 3 * DAY_MS);
    const cleoS2 = await sendOf(cleoW, 's2_next');
    const danS2 = await sendOf(danW, 's2_next');
    assert(cleoS2 && danS2, 'both follow-ups went');
    assertEqual([cleoS2!.channel, cleoS2!.slot], ['email', 'afternoon'], 'Cleo: email, afternoon');
    const cleoHour = localParts(new Date(ms(cleoS2!.createdAt)), LONDON).hour;
    const danHour = localParts(new Date(ms(danS2!.createdAt)), ZURICH).hour;
    assert(cleoHour >= 14 && cleoHour < 17, `Cleo's follow-up at ${hhmm(ms(cleoS2!.createdAt), LONDON)} London`);
    assert(danHour >= 14 && danHour < 17, `Dan's follow-up at ${hhmm(ms(danS2!.createdAt), ZURICH)} Zurich`);
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
