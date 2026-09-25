/**
 * PR B2 — mid-journey edits and switches (plan §3.10) on the emulator.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Edit test, 50 guests mid-journey: "don't apply" keeps the old values; "apply"
 *    uses the new ones from the next step, except sends planned within 60 minutes
 *    of the save (they go with the values they were planned with).
 *  - Two saves handled out of order never move a guest back to the older version.
 *  - Switch test: the old playbook's guests stop at their next send (a send due
 *    within 60 minutes of the switch still goes); its settings are kept.
 *  - A paused venue stays paused after an unrelated save: "off since" is the pause,
 *    not the last save. Journey on/off and Guest info off keep their own off-times.
 *
 * The welcome wording is given a `[days:{{slot.offer_days}}]` marker, so the stored
 * preview shows which values each message was rendered with.
 */

import {
  COL,
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
  resetEmulator,
  runDue,
  runUntil,
  seedCatalogue,
  setClock,
  setLaunch,
  setSafety,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { saveSetups, pauseVenue, resumeVenue, setGuestInfo } from '../../src/adaptive/service/tenant';
import { applyConfigInFlight } from '../../src/adaptive/engine/applyInFlight';
import { journeyOnState, loadVenueContext } from '../../src/adaptive/engine/context';
import { invalidateCatalogue } from '../../src/adaptive/service/catalogue';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const TENANT = 'tenant_e';
const A: VenueFixture = { tenant: TENANT, venueId: 'venue_ea', apId: 'ap_ea', apMac: 'aa:aa:aa:aa:aa:41' };
const B: VenueFixture = { tenant: TENANT, venueId: 'venue_eb', apId: 'ap_eb', apMac: 'aa:aa:aa:aa:aa:42' };
const OWNER = { uid: `${TENANT}_owner`, kind: 'tenant_user' as const, role: 'ADMIN' };
const A1 = 'welcome_second_visit';

/** The welcome wording shows the owner's "valid for N days" value. */
async function showOfferDays(): Promise<void> {
  const snap = await db.collection(COL.variants).where('poolKey', '==', 'welcome_offer').get();
  for (const d of snap.docs) {
    const upd: Record<string, unknown> = {};
    const mark = (path: string, text: unknown) => {
      if (typeof text === 'string') upd[path] = `[days:{{slot.offer_days}}] ${text}`;
    };
    mark('channels.sms.text', d.get('channels.sms.text'));
    mark('channels.email.body', d.get('channels.email.body'));
    mark('locales.de.sms.text', d.get('locales.de.sms.text'));
    mark('locales.de.email.body', d.get('locales.de.email.body'));
    await d.ref.update(upd);
  }
  invalidateCatalogue();
}

async function fresh(venues: VenueFixture[]): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  for (const v of venues) await setupVenue(v);
  await showOfferDays();
  const t0 = nextTuesday1240();
  await setClock(t0);
  await setLaunch({ [TENANT]: 'test' });
  await setSafety({ maxNewContactsPerApPerHour: 10_000 });
  return t0;
}

async function saveA1(venueId: string, offerDays: number, apply: boolean): Promise<void> {
  await saveSetups(
    TENANT,
    { playbookKey: 'restaurant_growth', venueIds: [venueId], journeys: { [A1]: { enabled: true, slots: { offer: 'dessert', offer_days: offerDays } } }, ...(apply ? { applyToInFlight: true } : {}) },
    OWNER,
  );
  clearCaches();
}

async function guests(venue: VenueFixture, n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 10) {
    ids.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(10, n - i) }, (_, k) =>
          connect({ venue, email: `${tag}${i + k}@test.local`, phone: `79${String(3000000 + i + k + tag.length * 1000).padStart(7, '0')}`, phoneCountryCode: '+41', phoneVerified: true, consent: true }),
        ),
      )),
    );
  }
  return ids;
}

async function a1Instances(venueId: string): Promise<AnyDoc[]> {
  return (await docsWhere(COL.journeyInstances, 'venueId', venueId)).filter((i) => i.journeyKey === A1);
}

async function send(instanceId: string, nodeId: string): Promise<AnyDoc | null> {
  const snap = await db.collection(COL.journeySends).doc(sendKeyFor(instanceId, nodeId)).get();
  return snap.exists ? { ...(snap.data() as Record<string, any>), id: snap.id } : null;
}

/** The sandbox clock keeps running between setting it and a save: times recorded by a save are within seconds. */
const near = (a: number | undefined, b: number, msg: string) => assert(typeof a === 'number' && Math.abs(a - b) < 10_000, `${msg}: ${a} vs ${b}`);

async function a1Of(guestId: string): Promise<AnyDoc> {
  return (await docsWhere(COL.journeyInstances, 'contactId', await contactIdFor(TENANT, guestId))).find((x) => x.journeyKey === A1)!;
}

const days = (s: AnyDoc) => /\[days:(\d+)\]/.exec(String(s.content?.preview ?? ''))?.[1] ?? null;

async function main() {
  console.log('\nMid-journey edits and switches (PR B2) on the emulator\n');

  await test('edit test, 50 guests: "don\'t apply" keeps the old values; "apply" uses the new ones from the next step, except sends due within 60 min', async () => {
    const t0 = await fresh([A, B]);
    await guests(A, 35, 'apply');
    await guests(B, 15, 'keep');
    await runDue();
    await runUntil(t0 + 20 * MINUTE_MS);
    for (const i of [...(await a1Instances(A.venueId)), ...(await a1Instances(B.venueId))]) {
      const s1 = await send(i.id, 's1');
      assert(s1 && days(s1) === '14', `welcome with the first values: ${s1?.content?.preview}`);
    }
    // No click: 48 h later the follow-up is planned in Thursday's afternoon slot (14:00–17:00).
    await runUntil(t0 + 2 * DAY_MS + 30 * MINUTE_MS); // Thursday 13:10
    await setClock(t0 + 2 * DAY_MS + 70 * MINUTE_MS); // Thursday 13:50
    await saveA1(A.venueId, 30, true);
    await saveA1(B.venueId, 30, false);
    await runDue(); // the apply task marks venue A's running guests
    const marked = await a1Instances(A.venueId);
    const saveAt = marked[0]?.pendingConfigAt?.toMillis();
    near(saveAt, t0 + 2 * DAY_MS + 70 * MINUTE_MS, 'the save time');
    assert(marked.length === 35 && marked.every((i) => i.pendingConfigVersion === 2 && i.pendingConfigAt?.toMillis() === saveAt && i.configVersion === 1), 'A: every running guest marked with version 2');
    assert((await a1Instances(B.venueId)).every((i) => i.pendingConfigVersion == null), 'B: nobody marked');
    const versionDoc = (await db.collection(COL.venuePlaybooks).doc(`${A.venueId}_restaurant_growth`).collection('versions').doc('2').get()).data()!;
    assertEqual(versionDoc.applyToInFlight, true, 'the version records the choice');

    await runUntil(saveAt + 5 * HOUR_MS);
    let held = 0;
    let moved = 0;
    for (const i of await a1Instances(A.venueId)) {
      const s2 = (await send(i.id, 's2_next'))!;
      assert(s2, `A follow-up sent for ${i.id}`);
      const planned = s2.decision.slot.plannedAt;
      const within = planned <= saveAt + 60 * MINUTE_MS;
      if (within) held += 1;
      else moved += 1;
      assertEqual([days(s2), s2.configVersion, s2.decision.versions.config], within ? ['14', 1, 1] : ['30', 2, 2], `A guest planned ${new Date(planned).toISOString()}`);
      assertEqual(
        [i.configVersion, i.pendingConfigVersion ?? null],
        within ? [1, 2] : [2, null],
        `A guest's pin after the follow-up (${within ? 'held until the next step' : 'moved'})`,
      );
    }
    assert(held > 0 && moved > 0, `both cases covered (held ${held}, moved ${moved})`);
    for (const i of await a1Instances(B.venueId)) {
      const s2 = (await send(i.id, 's2_next'))!;
      assertEqual([days(s2), s2.configVersion, i.configVersion], ['14', 1, 1], 'B keeps the old values');
    }
    // The held guests move to the new values at their next step (w2 ends after 72 h).
    await runUntil(saveAt + 4 * DAY_MS);
    const after = await a1Instances(A.venueId);
    assert(after.every((i) => i.configVersion === 2 && i.pendingConfigVersion == null), 'every A guest ends on version 2');
    const updates = (await docsWhere(COL.journeyEvents, 'venueId', A.venueId)).filter((e) => e.type === 'journey.config_updated');
    assertEqual(updates.filter((e) => e.journeyKey === A1).length, 35, 'one "new settings" event per welcome guest');
    // The edit applies to every journey of the playbook (D-11): the same guests' review asks moved too.
    const reviews = (await docsWhere(COL.journeyInstances, 'venueId', A.venueId)).filter((i) => i.journeyKey === 'review_ask');
    assert(reviews.length > 0, 'review asks running');
    assertEqual(updates.filter((e) => e.journeyKey === 'review_ask').length, reviews.filter((i) => i.configVersion === 2).length, 'review asks moved at their next step');
    assertEqual(updates.length, updates.filter((e) => e.journeyKey === A1 || e.journeyKey === 'review_ask').length, 'nothing else');
  });

  await test('a welcome due 10 min after an applied save keeps the old values; the guest moves at the step after', async () => {
    const t0 = await fresh([A]);
    const ids = await guests(A, 4, 'soon');
    await runDue(); // offer issued, the welcome is 15 minutes away
    await setClock(t0 + 5 * MINUTE_MS);
    await saveA1(A.venueId, 30, true);
    await runDue();
    await runUntil(t0 + 20 * MINUTE_MS);
    for (const g of ids) {
      const i = await a1Of(g);
      const s1 = (await send(i.id, 's1'))!;
      assertEqual([days(s1), s1.configVersion, s1.decision.versions.config], ['14', 1, 1], 'the welcome keeps the planned values');
      assertEqual([i.configVersion, i.pendingConfigVersion], [1, 2], 'still marked for the next step');
    }
    await runUntil(t0 + 2 * DAY_MS + 6 * HOUR_MS);
    for (const g of ids) {
      const i = await a1Of(g);
      const s2 = (await send(i.id, 's2_next'))!;
      assertEqual([days(s2), s2.configVersion, i.configVersion, i.pendingConfigVersion ?? null], ['30', 2, 2, null], 'the follow-up two days later has the new values');
    }
  });

  await test('two saves handled out of order never move a guest back', async () => {
    const t0 = await fresh([A]);
    await guests(A, 3, 'order');
    await runDue();
    await runUntil(t0 + 20 * MINUTE_MS);
    const insts = await a1Instances(A.venueId);
    const base = { installId: `${A.venueId}_restaurant_growth`, venueId: A.venueId, journeyKeys: [A1, 'review_ask'] };
    assertEqual((await applyConfigInFlight({ ...base, configVersion: 3, savedAt: now() })).marked, 3, 'v3 marks all');
    assertEqual((await applyConfigInFlight({ ...base, configVersion: 2, savedAt: now() })).marked, 0, 'v2 (late) marks none');
    assertEqual((await applyConfigInFlight({ ...base, configVersion: 3, savedAt: now() })).marked, 0, 'a replay marks none');
    assertEqual((await applyConfigInFlight({ ...base, installId: 'other_install', configVersion: 4, savedAt: now() })).marked, 0, 'another install’s guests are not touched');
    assertEqual((await applyConfigInFlight({ ...base, configVersion: 5, savedAt: now(), templateVersions: { [A1]: 2, review_ask: 2 } })).marked, 0, 'values written for another template version are not applied');
    for (const i of insts) assertEqual((await db.collection(COL.journeyInstances).doc(i.id).get()).get('pendingConfigVersion'), 3, 'still 3');
  });

  await test('switch test: the old playbook’s guests stop at their next send (one due within 60 min still goes); its settings are kept', async () => {
    const t0 = await fresh([A]);
    const early = await guests(A, 10, 'late');
    await runDue();
    await runUntil(t0 + 2 * DAY_MS - 10 * MINUTE_MS); // Thursday 12:30: the first ten wait for their follow-up
    const lastWave = await guests(A, 3, 'early'); // their welcome is due at 12:45
    await runDue();
    const oldSetup = (await db.collection(COL.venuePlaybooks).doc(`${A.venueId}_restaurant_growth`).get()).data()!;
    await setClock(now() + 5 * MINUTE_MS); // 12:35
    await saveSetups(TENANT, { playbookKey: 'local_business', venueIds: [A.venueId], journeys: {}, overlapAck: { [A.venueId]: true }, activate: true }, OWNER);
    clearCaches();
    const av = (await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get()).data()!;
    const switchAt = av.switchedOffAt?.[`${A.venueId}_restaurant_growth`]?.toMillis();
    near(switchAt, now(), 'the switch time is recorded');

    await runUntil(switchAt + 6 * HOUR_MS);
    for (const g of lastWave) {
      const s1 = await send((await a1Of(g)).id, 's1');
      assert(s1 && s1.status === 'dry_run' && s1.decision.slot.plannedAt <= switchAt + 60 * MINUTE_MS, 'a welcome due 10 min after the switch still goes');
    }
    for (const g of early) {
      const i = await a1Of(g);
      assert(!(await send(i.id, 's2_next')), 'no follow-up after the switch');
      assertEqual([i.status, i.exitReason], ['suppressed', 'switched_off'], 'stopped at the next send');
    }
    const kept = (await db.collection(COL.venuePlaybooks).doc(`${A.venueId}_restaurant_growth`).get()).data()!;
    assertEqual([kept.state, kept.configVersion, JSON.stringify(kept.journeys)], ['inactive', oldSetup.configVersion, JSON.stringify(oldSetup.journeys)], 'the old settings are kept');
    // Switching back clears the off-time.
    await saveSetups(TENANT, { playbookKey: 'restaurant_growth', venueIds: [A.venueId], journeys: {}, overlapAck: { [A.venueId]: true }, activate: true }, OWNER);
    const back = (await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get()).data()!;
    assert(!back.switchedOffAt?.[`${A.venueId}_restaurant_growth`] && back.switchedOffAt?.[`${A.venueId}_local_business`], 'running again: no off-time; the other one is off now');
  });

  await test('a paused venue stays paused after an unrelated save: off since the pause, not the save', async () => {
    const t0 = await fresh([A]);
    const ids = await guests(A, 12, 'pause');
    await runDue();
    await runUntil(t0 + 2 * DAY_MS + 30 * MINUTE_MS); // Thursday 13:10: follow-ups planned 14:00–17:00
    await setClock(t0 + 2 * DAY_MS + 60 * MINUTE_MS); // 13:40
    await pauseVenue(TENANT, A.venueId, OWNER);
    clearCaches();
    const pausedSnap = await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get();
    const pausedAt = pausedSnap.get('pausedAt')?.toMillis();
    const updatedAtPause = pausedSnap.get('updatedAt').toMillis();
    near(pausedAt, t0 + 2 * DAY_MS + 60 * MINUTE_MS, 'the pause time');
    await setClock(pausedAt + 30 * MINUTE_MS); // 14:10: an unrelated save (Guest info on, then the setup)
    await setGuestInfo(TENANT, A.venueId, true, OWNER);
    await saveA1(A.venueId, 21, false);
    const av = (await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get()).data()!;
    assertEqual([av.status, av.pausedAt?.toMillis()], ['paused', pausedAt], 'still paused, paused since 13:40');
    assert(av.updatedAt.toMillis() > updatedAtPause, 'the venue doc itself was saved again');

    const ctx = await loadVenueContext(A.venueId);
    const state = await journeyOnState(ctx, `${A.venueId}_restaurant_growth`, A1);
    assertEqual([state.venueOn, state.offSinceAt], [false, pausedAt], 'off since the pause (the later save doesn’t move it)');

    await runUntil(pausedAt + 5 * HOUR_MS);
    for (const g of ids) {
      const i = await a1Of(g);
      const s2 = await send(i.id, 's2_next');
      if (s2) assert(s2.decision.slot.plannedAt <= pausedAt + 60 * MINUTE_MS, `only a follow-up planned within 60 min of the pause went (${new Date(s2.decision.slot.plannedAt).toISOString()})`);
      else assertEqual([i.status, i.exitReason], ['suppressed', 'switched_off'], 'the others stopped');
    }

    await resumeVenue(TENANT, A.venueId, OWNER);
    const resumed = (await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get()).data()!;
    assertEqual([resumed.status, resumed.pausedAt ?? null], ['on', null], 'resumed: no pause time');
  });

  await test('journey off and Guest info off keep their own off-times across later saves', async () => {
    await fresh([A]);
    const install = () => db.collection(COL.venuePlaybooks).doc(`${A.venueId}_restaurant_growth`).get().then((s) => s.data()!);
    const venue = () => db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get().then((s) => s.data()!);
    await saveSetups(TENANT, { playbookKey: 'restaurant_growth', venueIds: [A.venueId], journeys: { review_ask: { enabled: false, slots: {} } } }, OWNER);
    const t1 = (await install()).journeys.review_ask.disabledAt?.toMillis();
    near(t1, now(), 'switched off now');
    assert((await install()).journeys[A1].disabledAt === undefined, 'a journey that is on has none');
    const v2 = (await db.collection(COL.venuePlaybooks).doc(`${A.venueId}_restaurant_growth`).collection('versions').doc('2').get()).data()!;
    assert(v2.journeys.review_ask.disabledAt === undefined, 'the version keeps only the owner’s values');
    await setClock(t1 + HOUR_MS);
    await saveA1(A.venueId, 21, false); // review_ask stays off (not sent → kept)
    assertEqual((await install()).journeys.review_ask.disabledAt?.toMillis(), t1, 'a later save keeps it');
    await saveSetups(TENANT, { playbookKey: 'restaurant_growth', venueIds: [A.venueId], journeys: { review_ask: { enabled: true, slots: {} } } }, OWNER);
    assert((await install()).journeys.review_ask.disabledAt === undefined, 'on again: cleared');

    await setGuestInfo(TENANT, A.venueId, true, OWNER);
    await setClock(now() + 10 * MINUTE_MS);
    await setGuestInfo(TENANT, A.venueId, false, OWNER);
    const t2 = (await venue()).switchedOffAt?.[`${A.venueId}_guest_info`]?.toMillis();
    near(t2, now(), 'Guest info off since now');
    await setClock(t2 + HOUR_MS);
    await setGuestInfo(TENANT, A.venueId, false, OWNER);
    assertEqual((await venue()).switchedOffAt?.[`${A.venueId}_guest_info`]?.toMillis(), t2, 'switching it off again keeps the first time');
    await setGuestInfo(TENANT, A.venueId, true, OWNER);
    assert(!(await venue()).switchedOffAt?.[`${A.venueId}_guest_info`], 'on again: cleared');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
