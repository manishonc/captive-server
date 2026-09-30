/**
 * PR F1 on the emulator: the bandit on the live send path, its record, Replay, the learner, the
 * pooled priors and the admin switch.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - Settings: a missing or malformed `bandit` reads as off; an account override wins.
 *  - Off: exactly the rotation (no `bandit` field, `rotation:*` methods) — PR B's behaviour.
 *  - On: the welcome's wording is a Thompson pick (`bandit:prior`), recorded with its draws;
 *    Replay re-checks them (`banditChecked`); the send arms the learner run that closes it.
 *  - Sticky: a welcome held by quiet hours keeps the wording (and draws) its first look picked.
 *  - Slots: the follow-up's slot is a bandit pick kept in the wait; its wording is forced by
 *    `requireDiff`; the send says whether it went inside its slot.
 *  - The learner: a click is counted once (re-running changes nothing) and its α+1 lands when the
 *    send finishes, 7 days later, with β+1 for each send without a click (the draw sees finished
 *    sends only); test runs never train; a corrupt arms doc doesn't stop a send.
 *  - The pool: two venues summed; a step no venue has any more is deleted by the rebuild. The
 *    launch card: "BANDIT ON" to turn it on, off in one click.
 *  - The admin Journeys numbers: every wording of the welcome with its sends.
 *  - Round-1 review fixes: a retired wording is never sent (the one left goes as
 *    `forced:retired` and still trains); a text edited during a hold is drawn again; the parked
 *    wait of a claimed send keeps the picks; a journey's return visit is credited once across
 *    learner runs; an unsubscribe and a spam report for one email are one penalty.
 */

import {
  advance,
  assert,
  assertEqual,
  clearCaches,
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
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  TZ,
  withoutReviewAsk,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, mountApi } from './ownerApiHelpers';
import { CONFIG_DOC_ID } from '../../src/adaptive/store/collections';
import { banditModeFor, parseEngineSettings } from '../../src/adaptive/store/engineSettings';
import { learnVenue, rebuildPools } from '../../src/adaptive/bandit/learn';
import { learnCloseTask } from '../../src/adaptive/bandit/tasks';
import { devProviderEvent } from '../../src/adaptive/service/engine';
import { replayDecision } from '../../src/adaptive/service/replay';
import { sendKeyFor, taskIdFor, banditArmsIdFor, banditPoolIdFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, MINUTE_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';
import { __clearBanditArmsCache, loadStepArms } from '../../src/adaptive/engine/banditArms';
import { __sendTestHooks } from '../../src/adaptive/engine/sendPath';
import { variantArmKey } from '../../src/adaptive/core/runtime/banditKeys';

const V: VenueFixture = { tenant: 'tenant_bd', venueId: 'venue_bd', apId: 'ap_bd', apMac: 'aa:aa:aa:aa:bd:01' };
const W: VenueFixture = { tenant: 'tenant_bd2', venueId: 'venue_bd2', apId: 'ap_bd2', apMac: 'aa:aa:aa:aa:bd:02' };
const A1 = 'welcome_second_visit';

async function setBandit(accounts: Record<string, 'on' | 'off'>, mode: 'on' | 'off' = 'off'): Promise<void> {
  const update: Record<string, unknown> = { 'bandit.mode': mode };
  for (const [t, m] of Object.entries(accounts)) update[`bandit.accounts.${t}`] = m;
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update(update);
  clearCaches();
  __clearBanditArmsCache();
}

async function fresh(mode: 'live' | 'test' = 'live', venues: VenueFixture[] = [V]): Promise<number> {
  await resetEmulator();
  await seedCatalogue();
  for (const v of venues) {
    await setupVenue(v);
    await withoutReviewAsk(v);
    await seedWallet(v.tenant, 5000);
  }
  const t0 = nextTuesday1240();
  await setClock(t0);
  await setLaunch(Object.fromEntries(venues.map((v) => [v.tenant, mode])), { paused: false });
  __clearBanditArmsCache();
  return t0;
}

let guestN = 0;
function guest(venue: VenueFixture, over: Record<string, unknown> = {}) {
  guestN += 1;
  // Never ending in 0000–0003: the sandbox's failure triggers (STOP, unknown, try later, refused).
  return { venue, firstName: `G${guestN}`, email: `g${guestN}@test.local`, phone: `7913${String(10000 + guestN * 11).padStart(5, '0')}`, phoneCountryCode: '+41', phoneVerified: true, consent: true, language: 'en', ...over };
}

async function welcomeOf(venue: VenueFixture, guestId: string): Promise<{ inst: AnyDoc; s1: AnyDoc | null }> {
  const contactId = await contactIdFor(venue.tenant, guestId);
  const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1);
  if (!inst) throw new Error('no welcome journey');
  const snap = await db.collection(COL.journeySends).doc(sendKeyFor(inst.id, 's1')).get();
  return { inst, s1: snap.exists ? { ...(snap.data() as Record<string, any>), id: snap.id } : null };
}

async function armsDoc(venue: VenueFixture, nodeId: string): Promise<Record<string, any> | null> {
  const snap = await db.collection(COL.banditArms).doc(banditArmsIdFor(venue.venueId, A1, nodeId)).get();
  return snap.exists ? (snap.data() as Record<string, any>) : null;
}

const learnNow = (venue: VenueFixture) => learnVenue(venue.venueId, { engineNow: now(), cutoffMs: Date.now() + 1000 });

async function main() {
  console.log('\nPR F1 — the bandit (emulator)');

  await test('settings: a missing or malformed switch is off; the account override wins', async () => {
    assertEqual(banditModeFor(parseEngineSettings({}), 't1'), 'off', 'missing');
    assertEqual(banditModeFor(parseEngineSettings({ bandit: { mode: 'maybe' } }), 't1'), 'off', 'malformed');
    const s = parseEngineSettings({ bandit: { mode: 'off', accounts: { t1: 'on', t2: 'nonsense' } } });
    assertEqual([banditModeFor(s, 't1'), banditModeFor(s, 't2'), banditModeFor(s, 't3'), banditModeFor(s, null)], ['on', 'off', 'off', 'off'], 'per account');
    assertEqual(banditModeFor(parseEngineSettings({ bandit: { mode: 'on' } }), 't3'), 'on', 'global on');
  });

  await test('off: exactly the rotation — no bandit field, rotation:first, and nothing for the learner', async () => {
    await fresh();
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const { s1 } = await welcomeOf(V, g);
    assert(s1 && s1.status === 'sent', `sent: ${s1?.status}`);
    assertEqual([s1.decision.variant.method, s1.decision.v, s1.bandit === undefined], ['rotation:first', 3, true], 'the rotation, v3, no block');
    await learnNow(V);
    assertEqual(await armsDoc(V, 's1'), null, 'no arms written');
  });

  await test('on: a Thompson pick with its draws; Replay re-checks them; the send arms its closing run', async () => {
    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const { s1 } = await welcomeOf(V, g);
    assert(s1 && s1.status === 'sent', `sent: ${s1?.status}`);
    const b = s1.bandit;
    assertEqual([s1.decision.variant.method, b.v, b.seg, b.var.lvl, b.var.d.length, b.slot], ['bandit:prior', 1, 'new', 'prior', 2, null], 'a prior-level pick between A and B');
    assertEqual(b.var.vid, s1.variantId, 'the block names the sent wording');
    assertEqual(b.var.d.map((d: any) => d.l).sort(), ['A', 'B'], 'both wordings drawn');
    const r = await replayDecision({ sendKey: s1.id });
    assert(r.replayable && r.same && (r as any).banditChecked === true, JSON.stringify(r));
    const close = learnCloseTask(V.venueId, V.tenant, s1.createdAt.toMillis());
    assert((await db.collection(COL.journeyTasks).doc(taskIdFor(close.dedupeKey)).get()).exists, 'the closing run is armed');
    // A tampered θ shows in Replay.
    const t = JSON.parse(JSON.stringify(b));
    t.var.d[0].t = t.var.d[0].t > 0.5 ? 0.000001 : 0.999999;
    await db.collection(COL.journeySends).doc(s1.id).update({ bandit: t });
    const r2 = await replayDecision({ sendKey: s1.id });
    assert(r2.replayable && !r2.same && r2.differences.some((d) => d.field.startsWith('bandit.var')), JSON.stringify(r2.replayable ? r2.differences : r2));
  });

  await test('sticky: a welcome held by quiet hours keeps the wording and draws its first look picked', async () => {
    const t0 = await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const p = localParts(new Date(t0), TZ);
    await setClock(zonedTime(p.year, p.month, p.day, 20, 50, TZ).getTime());
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS); // 21:05: quiet hours
    await runDue();
    const held = await welcomeOf(V, g);
    assertEqual(held.s1, null, 'not sent at night');
    assertEqual(held.inst.state?.waiting?.variantPick?.method ?? held.inst.waiting?.variantPick?.method, 'bandit:prior', 'the pick waits with the send');
    const deferred = (await docsWhere(COL.journeyEvents, 'instanceId', held.inst.id)).find((e) => e.type === 'send.deferred');
    assert(deferred?.data?.bandit?.var?.pick, 'the hold records the pick');
    await runUntil(zonedTime(p.year, p.month, p.day + 1, 9, 45, TZ).getTime());
    const { s1 } = await welcomeOf(V, g);
    assert(s1 && s1.status === 'sent', `sent in the morning: ${s1?.status}`);
    assertEqual(s1.bandit.var, deferred.data.bandit.var, 'the same pick and draws');
  });

  await test('slots: the follow-up\'s slot is a bandit pick kept in the wait; its wording is forced by requireDiff', async () => {
    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const first = await welcomeOf(V, g);
    assert(first.s1?.status === 'sent', 's1 sent');
    // No click for 48 h: the follow-up goes on the next rung (email) in a slot. Its claim parks
    // the journey with the picks, so a lost final commit resumes with the same slot and wording.
    const parked: Record<string, any>[] = [];
    __sendTestHooks.afterClaim = async (sendKey) => {
      if (sendKey !== sendKeyFor(first.inst.id, 's2_next')) return;
      const i = (await db.collection(COL.journeyInstances).doc(first.inst.id).get()).data() as Record<string, any>;
      parked.push(i.state?.waiting ?? i.waiting);
    };
    try {
      await runUntil(now() + 3 * DAY_MS);
    } finally {
      delete __sendTestHooks.afterClaim;
    }
    const s2 = (await db.collection(COL.journeySends).doc(sendKeyFor(first.inst.id, 's2_next')).get()).data() as Record<string, any> | undefined;
    assert(s2 && s2.status === 'sent', `s2_next sent: ${s2?.status}`);
    assertEqual([s2.channel, s2.decision.variant.method, s2.bandit.var], ['email', 'forced:require_diff', null], 'the other wording, forced, no wording draws');
    assert(s2.variantId !== first.s1!.variantId, 'a different wording');
    assertEqual([s2.bandit.slot.d.length, s2.bandit.slot.pick, s2.decision.slot.picked, s2.decision.slot.rule], [3, s2.slot, s2.slot, 'bandit:prior'], 'the slot draw is the slot');
    assertEqual(s2.bandit.slot.in, true, 'it went inside its slot');
    assertEqual(parked.length, 1, 'claimed once');
    assertEqual([parked[0].kind, parked[0].slotPick?.pick, parked[0].variantPick?.vid, parked[0].variantPick?.method], ['send_due', s2.slot, s2.variantId, 'forced:require_diff'], 'the parked wait keeps the picks');
  });

  await test('a retired wording is never sent: the one left goes as forced:retired, and still trains', async () => {
    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const pool = await docsWhere(COL.variants, 'poolKey', 'welcome_offer');
    const a = pool.find((v) => v.letter === 'A')!;
    const b = pool.find((v) => v.letter === 'B')!;
    await db
      .collection(COL.banditArms)
      .doc(banditArmsIdFor(V.venueId, A1, 's1'))
      .set({ scope: 'venue', tenantUserId: V.tenant, venueId: V.venueId, journeyKey: A1, nodeId: 's1', segments: { all: { variant: { [variantArmKey(a)]: { a: 1, b: 300, pulls: 300, closed: 300, retired: true } } } } });
    __clearBanditArmsCache();
    const ids = [await connect(guest(V)), await connect(guest(V))];
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    for (const id of ids) {
      const { s1 } = await welcomeOf(V, id);
      assert(s1?.status === 'sent', `sent: ${s1?.status}`);
      assertEqual([s1.variantId, s1.decision.variant.method, s1.bandit.var.d.length, s1.bandit.var.pick], [b.id, 'forced:retired', 1, variantArmKey(b)], 'B, the only one left, with one draw');
      const r = await replayDecision({ sendKey: s1.id });
      assert(r.replayable && r.same && (r as any).banditChecked === true, JSON.stringify(r));
    }
    await learnNow(V);
    const arms = (await armsDoc(V, 's1'))!.segments.all.variant;
    assertEqual([arms[variantArmKey(b)].pulls, arms[variantArmKey(a)].pulls, arms[variantArmKey(a)].retired], [2, 300, true], 'B keeps learning; A stays retired');
  });

  await test('sticky: a wording whose text is edited during the hold is drawn again (its old text is no arm now)', async () => {
    const t0 = await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const p = localParts(new Date(t0), TZ);
    await setClock(zonedTime(p.year, p.month, p.day, 20, 50, TZ).getTime());
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS); // 21:05: quiet hours
    await runDue();
    const held = await welcomeOf(V, g);
    const pick = held.inst.state?.waiting?.variantPick ?? held.inst.waiting?.variantPick;
    assert(pick?.part?.pick, `held with a pick: ${JSON.stringify(pick)}`);
    await db.collection(COL.variants).doc(pick.vid).update({ 'channels.sms.text': 'Hi {{contact.firstName | default:"there"}}, something new at {{venue.name}}: {{link.offer}}' });
    clearCaches();
    await runUntil(zonedTime(p.year, p.month, p.day + 1, 9, 45, TZ).getTime());
    const { s1 } = await welcomeOf(V, g);
    assert(s1 && s1.status === 'sent', `sent in the morning: ${s1?.status}`);
    assert(s1.bandit.var.pick !== pick.part.pick, 'not the old text\'s arm');
    assertEqual(s1.bandit.var.d.length, 2, 'drawn again between both wordings');
  });

  await test('return visits: a journey is credited once, across learner runs (a page without a credit keeps the saved ones)', async () => {
    const t0 = await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const g1 = guest(V);
    const id1 = await connect(g1);
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const s1 = (await welcomeOf(V, id1)).s1!;
    assert(s1?.status === 'sent', `sent: ${s1?.status}`);
    await learnNow(V);
    // Back the next morning: a return visit, α+4 to the welcome's last message.
    const p0 = localParts(new Date(t0), TZ);
    await setClock(zonedTime(p0.year, p0.month, p0.day + 1, 10, 0, TZ).getTime());
    await connect({ ...g1, guestId: id1 });
    await runDue();
    await learnNow(V);
    let arm = (await armsDoc(V, 's1'))!.segments.all.variant[s1.bandit.var.pick];
    assertEqual([arm.rewards?.visit, arm.a ?? 0], [1, 0], 'the visit: counted, its α+4 waits for the close');
    // Another guest's events: a learner page with no new credit.
    await connect(guest(V));
    await runDue();
    await learnNow(V);
    let state = (await db.collection(COL.banditArms).doc(`learn_${V.venueId}`).get()).data()!;
    assertEqual([Object.keys(state.facts?.visitCredits ?? {}), Object.keys(state.facts?.visited ?? {})], [[s1.instanceId], [s1.id]], 'the credit and the credited send are still saved');
    // Back again the day after, still inside the 7 days: that journey was credited already.
    await setClock(zonedTime(p0.year, p0.month, p0.day + 2, 10, 0, TZ).getTime());
    await connect({ ...g1, guestId: id1 });
    await runDue();
    await learnNow(V);
    arm = (await armsDoc(V, 's1'))!.segments.all.variant[s1.bandit.var.pick];
    assertEqual(arm.rewards?.visit, 1, 'no second credit');
    // Its 7 days over: the send closes with the visit's α+4 (and β+1: no click), drifted once.
    await setClock(t0 + 9 * DAY_MS);
    await learnNow(V);
    arm = (await armsDoc(V, 's1'))!.segments.all.variant[s1.bandit.var.pick];
    assertEqual(Math.round((arm.a ?? 0) * 1000) / 1000, 3.8, 'α+4 once, at close (× 0.95)');
    state = (await db.collection(COL.banditArms).doc(`learn_${V.venueId}`).get()).data()!;
    assert(state.closed?.id, 'closed');
  });

  await test('an unsubscribe and a spam report for one email: one penalty', async () => {
    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const id = await connect(guest(V, { phone: '', phoneCountryCode: '', phoneVerified: false }));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const { s1 } = await welcomeOf(V, id);
    assert(s1?.status === 'sent' && s1.channel === 'email', `an email: ${s1?.status} ${s1?.channel}`);
    await devProviderEvent({ sendKey: s1.id, event: 'unsubscribe' });
    await devProviderEvent({ sendKey: s1.id, event: 'spam' });
    await runDue();
    const revoked = (await docsWhere(COL.journeyEvents, 'sendKey', s1.id)).filter((e) => e.type === 'consent.revoked');
    assertEqual(revoked.length, 2, 'two revocations in the log');
    await learnNow(V);
    let arm = (await armsDoc(V, 's1'))!.segments.all.variant[s1.bandit.var.pick];
    assertEqual([arm.penalties?.unsub, arm.b ?? 0], [1, 0], 'counted once; its β waits for the close');
    const state = (await db.collection(COL.banditArms).doc(`learn_${V.venueId}`).get()).data()!;
    assertEqual(Object.keys(state.facts?.penalized ?? {}), [s1.id], 'the send is remembered');
    // Its 7 days over: β+10 once, + 1 for no click, drifted once.
    await setClock(now() + 9 * DAY_MS);
    await learnNow(V);
    arm = (await armsDoc(V, 's1'))!.segments.all.variant[s1.bandit.var.pick];
    assertEqual(Math.round((arm.b ?? 0) * 1000) / 1000, 10.45, 'β 11 at close (× 0.95), not 21');
  });

  await test('the learner: a click counted once; re-running changes nothing; after 7 days every send finishes with its reward (click α+1, β+1 without)', async () => {
    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    const g1 = await connect(guest(V));
    const g2 = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const a = (await welcomeOf(V, g1)).s1!;
    const b = (await welcomeOf(V, g2)).s1!;
    await devProviderEvent({ sendKey: a.id, event: 'click' });
    await runDue();
    const r1 = await learnNow(V);
    assert(r1.events > 0, `events read: ${r1.events}`);
    let doc = (await armsDoc(V, 's1'))!;
    const armA = doc.segments.all.variant[a.bandit.var.pick];
    const armB = doc.segments.all.variant[b.bandit.var.pick];
    const pulls = a.bandit.var.pick === b.bandit.var.pick ? 2 : 1;
    assertEqual([armA.pulls, armA.rewards.click, armA.a ?? 0, armA.b ?? 0], [pulls, 1, 0, 0], 'the clicked wording: counted, no α before its 7 days');
    assertEqual(armB.pulls, pulls, 'a pull for the other');
    assertEqual(doc.segments.new.variant[a.bandit.var.pick].rewards.click, 1, 'the segment too');
    const before = JSON.stringify(doc.segments);
    const r2 = await learnNow(V);
    assertEqual(r2.events, 0, 'nothing new');
    assertEqual(JSON.stringify((await armsDoc(V, 's1'))!.segments), before, 'unchanged');

    await setClock(now() + 8 * DAY_MS);
    const r3 = await learnNow(V);
    // This run is also the weekly drift (the first run set the date): α and β × 0.95, counts stay.
    assertEqual(r3.drifted, 1, 'drifted once');
    doc = (await armsDoc(V, 's1'))!;
    if (a.bandit.var.pick === b.bandit.var.pick) {
      const arm = doc.segments.all.variant[a.bandit.var.pick];
      assertEqual([arm.closed, arm.b, arm.a], [2, 0.95, 0.95], 'both finished, one without a click (drifted)');
    } else {
      assertEqual([doc.segments.all.variant[a.bandit.var.pick].closed, doc.segments.all.variant[a.bandit.var.pick].b ?? 0, doc.segments.all.variant[a.bandit.var.pick].a], [1, 0, 0.95], 'clicked: finished, no β');
      assertEqual([doc.segments.all.variant[b.bandit.var.pick].closed, doc.segments.all.variant[b.bandit.var.pick].b], [1, 0.95], 'no click: β+1 (drifted)');
    }
    const r4 = await learnNow(V);
    assertEqual([r4.drifted, r4.closed], [0, 0], 'no second drift the same week, nothing left to close');
    const state = (await db.collection(COL.banditArms).doc(`learn_${V.venueId}`).get()).data()!;
    assert(state.events?.id && state.closed?.id, 'both marks kept');
  });

  await test('test runs never train; a corrupt arms doc doesn\'t stop a send', async () => {
    await fresh('test');
    await setBandit({ [V.tenant]: 'on' });
    const g = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const { s1 } = await welcomeOf(V, g);
    assert(s1 && s1.status === 'dry_run' && s1.bandit?.var?.pick, 'a test run records the pick');
    await learnNow(V);
    const doc = await armsDoc(V, 's1');
    assert(!doc || !doc.segments?.all?.variant?.[s1.bandit.var.pick]?.pulls, `no pulls from a test run: ${JSON.stringify(doc?.segments)}`);

    await fresh();
    await setBandit({ [V.tenant]: 'on' });
    await db.collection(COL.banditArms).doc(banditArmsIdFor(V.venueId, A1, 's1')).set({ scope: 'venue', tenantUserId: V.tenant, venueId: V.venueId, journeyKey: A1, nodeId: 's1', segments: 'garbage' });
    __clearBanditArmsCache();
    const g2 = await connect(guest(V));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const w = await welcomeOf(V, g2);
    assert(w.s1?.status === 'sent', `still sent: ${w.s1?.status}`);
  });

  await test('the pool: two venues summed per step; the admin numbers show both wordings', async () => {
    await fresh('live', [V, W]);
    await setBandit({}, 'on');
    for (const v of [V, W]) await connect(guest(v));
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    for (const v of [V, W]) await learnNow(v);
    const r = await rebuildPools();
    assert(r.pools >= 1 && r.venueDocs >= 2, JSON.stringify(r));
    const pool = (await db.collection(COL.banditArms).doc(banditPoolIdFor(A1, 's1')).get()).data()!;
    const pulls = Object.values(pool.segments.all.variant as Record<string, any>).reduce((s, x) => s + x.pulls, 0);
    assertEqual([pool.scope, pool.tenantUserId, pool.venues, pulls], ['pool', null, 2, 2], 'two venues, two sends, no tenant');

    const api = await mountApi();
    try {
      const res = await api.get(`/admin/journeys/${A1}/bandit`);
      assertEqual(res.status, 200, `GET numbers: ${res.text.slice(0, 200)}`);
      const s1 = res.body.steps.find((s: any) => s.nodeId === 's1');
      assertEqual(s1.wordings.filter((w: any) => !w.earlierText).map((w: any) => w.letter), ['A', 'B'], 'both wordings');
      assertEqual(s1.wordings.reduce((s: number, w: any) => s + w.pulls, 0), 2, 'their sends');
      assertEqual(res.body.bandit.mode, 'on', 'the switch');
      assert(!JSON.stringify(res.body).includes('@'), 'no addresses');
      // A paused wording keeps its row but no chance of being best (the pick can't choose it).
      const b = (await docsWhere(COL.variants, 'poolKey', 'welcome_offer')).find((v) => v.letter === 'B')!;
      await db.collection(COL.variants).doc(b.id).update({ status: 'paused' });
      clearCaches();
      const paused = (await api.get(`/admin/journeys/${A1}/bandit`)).body.steps.find((x: any) => x.nodeId === 's1');
      assertEqual(paused.wordings.find((w: any) => w.letter === 'B')?.chanceBest ?? null, null, 'no chance for a paused wording');
      await db.collection(COL.variants).doc(b.id).update({ status: 'active' });
      clearCaches();
    } finally {
      await api.close();
    }
    // A slower rebuild never deletes a pool a newer run wrote after it started.
    await db.collection(COL.banditArms).doc('pool_newer_run').set({ scope: 'pool', tenantUserId: null, journeyKey: 'x', nodeId: 'y', segments: {}, venues: 1, rebuiltAt: new Date(Date.now() + 60 * MINUTE_MS) });
    await rebuildPools();
    assert((await db.collection(COL.banditArms).doc('pool_newer_run').get()).exists, 'a newer run\'s pool kept');
    await db.collection(COL.banditArms).doc('pool_newer_run').delete();
    // The send path reads the fresh pool, and leaves out one not rebuilt for 48 hours (it may hold a deleted account's share).
    __clearBanditArmsCache();
    assert((await loadStepArms(V.venueId, A1, 's1'))?.pool, 'the fresh pool is read');
    await db.collection(COL.banditArms).doc(banditPoolIdFor(A1, 's1')).update({ rebuiltAt: new Date(Date.now() - 3 * DAY_MS) });
    __clearBanditArmsCache();
    assertEqual((await loadStepArms(V.venueId, A1, 's1'))?.pool ?? null, null, 'a 3-day-old pool is left out');
    // W's account is deleted (the cms removes its arms docs): the next rebuild counts V alone.
    await db.collection(COL.banditArms).doc(banditArmsIdFor(W.venueId, A1, 's1')).delete();
    await rebuildPools();
    assertEqual((await db.collection(COL.banditArms).doc(banditPoolIdFor(A1, 's1')).get()).get('venues'), 1, 'one venue left');
    // No venue has the step any more: its pooled numbers go too.
    await db.collection(COL.banditArms).doc(banditArmsIdFor(V.venueId, A1, 's1')).delete();
    const gone = await rebuildPools();
    assert(gone.removed >= 1 && !(await db.collection(COL.banditArms).doc(banditPoolIdFor(A1, 's1')).get()).exists, `the stale pool is deleted: ${JSON.stringify(gone)}`);
  });

  await test('the launch card: "BANDIT ON" to turn it on for an account; off is one click', async () => {
    await fresh();
    const api = await mountApi();
    try {
      const card = await api.get('/admin/launch');
      assertEqual([card.status, card.body.bandit.mode], [200, 'off'], 'off by default');
      const change = { change: { bandit: { accounts: { [V.tenant]: 'on' } } }, baseVersion: card.body.version, actor: ADMIN_ACTOR };
      const noPhrase = await api.call('PUT', '/admin/launch', change);
      assertEqual([noPhrase.status, noPhrase.body?.code], [400, 'confirmation_required'], 'a phrase is needed');
      const on = await api.call('PUT', '/admin/launch', { ...change, confirm: 'BANDIT ON' });
      assertEqual([on.status, on.body.bandit.accounts[V.tenant]], [200, 'on'], 'on');
      const off = await api.call('PUT', '/admin/launch', { change: { bandit: { accounts: { [V.tenant]: 'off' } } }, actor: ADMIN_ACTOR });
      assertEqual([off.status, off.body.bandit.accounts[V.tenant]], [200, 'off'], 'off: one click, no base version');
      const history = await db.collection(COL.config).doc(CONFIG_DOC_ID).collection('history').get();
      assert(history.docs.some((d) => ((d.get('lines') ?? []) as string[]).some((l) => l.includes('learning'))), 'in the history');
    } finally {
      await api.close();
    }
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
