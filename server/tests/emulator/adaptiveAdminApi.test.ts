/**
 * PR D — the HeidiFi admin routes on the emulator, through the real router (spec E4, E14,
 * E15, E17, E18).
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - Launch card (`GET/PUT /admin/launch`, `POST /admin/launch/check`): a typed phrase only for
 *    loosening (D-D5); `baseVersion` 409 only for loosening; the brake (pause, test, off, lower
 *    limits) never fails; `history/{n}` once per real change; `version` bumped; PR 1's
 *    `getAdaptiveConfig()` and the engine's `readEngineSettings()` both still read the doc
 *    (killSwitch.reason a string or null); validation; super_admin only; `accountNames` also
 *    names an account with no override whose venue waits for Start sending.
 *  - Dead tasks: listed in `GET /admin/engine` (no payload); retry → queued, attempts 0, the same
 *    dueAt, runs once; a task that isn't dead → 409; a dead STOP that lost its number → 409; a
 *    timer retried a week late is skipped as stale (no late message); a Wi-Fi connect retried
 *    past the stale limit gets the "no journey starts" warning. A dead rating: stars only
 *    and already applied → no warning, applied once; a ≤3★ with feedback never applied → the
 *    lost-feedback warning; 4★ → none.
 *  - Guest search across accounts by email and phone; the identity-key guard (409); a GET with
 *    `?email=` is a plain 404; no address in a response or a log line.
 *  - `checkIndexes()` passes with the PR D probes.
 *  - Route guard smoke: every PR D path → JSON 401 without the secret, unknown → JSON 404,
 *    writes without an actor → 400, admin writes by anyone but HeidiFi staff → 403.
 */

import { FieldValue } from 'firebase-admin/firestore';
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
  type VenueFixture,
} from './helpers';
import { ADMIN_ACTOR, MCP_ACTOR, OWNER_ACTOR, captureLogs, clearEngineStatus, mountApi, seedWorkerHeartbeat, type Api } from './ownerApiHelpers';
import { CONFIG_DOC_ID, ENGINE_STATUS_DOC_ID, HISTORY } from '../../src/adaptive/store/collections';
import { readEngineSettings } from '../../src/adaptive/store/engineSettings';
import { getAdaptiveConfig } from '../../src/adaptive/store/definitions';
import { adaptiveOnInboundSms } from '../../src/adaptive/ingest/signals';
import { checkIndexes } from '../../src/adaptive/worker/indexCheck';
import { keyFingerprint } from '../../src/adaptive/identity/key';
import { AdaptiveWorker } from '../../src/adaptive/worker/worker';
import { claimDue, failTask } from '../../src/adaptive/queue/firestoreQueue';
import { sendKeyFor, taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';
import { devProviderEvent } from '../../src/adaptive/service/engine';

const A: VenueFixture = { tenant: 'tenant_ad', venueId: 'venue_ad', apId: 'ap_ad', apMac: 'aa:aa:aa:aa:aa:71' };
const C: VenueFixture = { tenant: 'tenant_ad2', venueId: 'venue_ad2', apId: 'ap_ad2', apMac: 'aa:aa:aa:aa:aa:72' };
const A1 = 'welcome_second_visit';
const configRef = () => db.collection(COL.config).doc(CONFIG_DOC_ID);
const historyCount = async () => (await configRef().collection(HISTORY).get()).size;

async function fresh(venues: VenueFixture[] = [A]): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  for (const v of venues) await setupVenue(v);
}

async function main() {
  console.log('\nAdmin launch card (PR D, D-D5)\n');
  const api = await mountApi();
  const put = (body: Record<string, unknown>, actor: unknown = ADMIN_ACTOR) => api.call('PUT', '/admin/launch', { ...body, actor });
  try {
    await test('launch card: the brake needs one click; loosening needs baseVersion + the typed phrase; history once per change; both parsers read it', async () => {
      await fresh();
      let card = await api.get('/admin/launch');
      assertEqual(card.status, 200, 'GET /admin/launch');
      assertEqual([card.body.version, card.body.launch.default, card.body.paused, card.body.pauseReason], [1, 'off', true, 'Engine not launched yet'], 'the seed');
      assert(card.body.sms.knownCountries.includes('CH') && card.body.warnings.some((w: string) => w.includes('alert email')), 'known countries; the alert-email warning');
      const h0 = await historyCount();

      // Who may: HeidiFi staff only.
      assertEqual((await put({ change: { paused: true } }, OWNER_ACTOR)).status, 403, 'an owner → 403');
      assertEqual((await put({ change: { paused: true } }, MCP_ACTOR)).status, 403, 'the MCP → 403');
      assertEqual((await api.call('PUT', '/admin/launch', { change: { paused: true } })).status, 400, 'no actor → 400');
      assertEqual((await api.call('POST', '/admin/launch/check', { change: { paused: false }, actor: OWNER_ACTOR })).status, 403, 'check: an owner → 403');

      // A move to a test run: one click (no phrase, no baseVersion).
      let res = await put({ change: { accounts: { [A.tenant]: 'test' } }, note: 'pilot' });
      assertEqual([res.status, res.body.changed, res.body.version, res.body.launch.accounts[A.tenant]], [200, true, 2, 'test'], `to test: ${res.text.slice(0, 200)}`);
      assertEqual(res.body.summary.confirmPhrase, null, 'no phrase for a test run');
      assertEqual(await historyCount(), h0 + 1, 'history/2 written');
      const h2 = (await configRef().collection(HISTORY).doc('2').get()).data()!;
      assertEqual([h2.version, h2.kind, h2.by, h2.note, h2.before.accounts, h2.after.accounts], [2, 'launch', ADMIN_ACTOR.uid, 'pilot', {}, { [A.tenant]: 'test' }], 'history/2 before/after');

      // Releasing the pause loosens: baseVersion first, then the phrase the server computes.
      res = await put({ change: { paused: false } });
      assertEqual([res.status, res.body.code], [400, 'bad_request'], 'no baseVersion → 400');
      res = await put({ change: { paused: false }, baseVersion: 1 });
      assertEqual([res.status, res.body.code], [409, 'conflict'], 'a stale baseVersion → 409');
      const check = await api.call('POST', '/admin/launch/check', { change: { paused: false }, actor: ADMIN_ACTOR });
      assertEqual([check.status, check.body.summary.confirmPhrase, check.body.summary.loosening], [200, 'RELEASE PAUSE', ['release_pause']], 'check says what it needs');
      res = await put({ change: { paused: false }, baseVersion: 2 });
      assertEqual([res.status, res.body.code, res.body.confirmPhrase], [400, 'confirmation_required', 'RELEASE PAUSE'], 'the phrase is required');
      res = await put({ change: { paused: false }, baseVersion: 2, confirm: 'release pause' });
      assertEqual([res.status, res.body.version, res.body.paused, res.body.pauseReason], [200, 3, false, null], 'released (case and spaces do not matter)');
      assertEqual(await historyCount(), h0 + 2, 'history/3');
      assertEqual((await configRef().get()).get('version'), 3, 'the check wrote nothing; version 3');

      // Both parsers still read it (PR 1's rules parser would fall back to the paused seed on a bad doc).
      let rules = await getAdaptiveConfig();
      assertEqual([rules.version, rules.killSwitch.sendingPaused, rules.killSwitch.reason, rules.quietHours.start], [3, false, null, '21:00'], "PR 1's getAdaptiveConfig");
      let settings = await readEngineSettings();
      assertEqual([settings.paused, settings.launch.accounts[A.tenant]], [false, 'test'], 'the engine settings');

      // The brake: pause with a reason, even with a stale baseVersion — never refused.
      res = await put({ change: { paused: true }, baseVersion: 1, pauseReason: 'Provider outage' });
      assertEqual([res.status, res.body.paused, res.body.pauseReason, res.body.version], [200, true, 'Provider outage', 4], 'paused');
      rules = await getAdaptiveConfig();
      assertEqual([rules.version, rules.killSwitch.sendingPaused, rules.killSwitch.reason], [4, true, 'Provider outage'], 'the reason stays a string');
      // The same again: nothing changes, no history, no version.
      res = await put({ change: { paused: true } });
      assertEqual([res.status, res.body.changed, res.body.version], [200, false, 4], 'a no-op');
      assertEqual(await historyCount(), h0 + 3, 'no history for a no-op');

      // Limits: lower = one click; higher = LOOSEN LIMITS. Countries: added = LOOSEN LIMITS; removed = one click.
      res = await put({ change: { safety: { maxSendsPerVenuePerDay: 400, staleAfterHours: 4 } } });
      assertEqual([res.status, res.body.safety.maxSendsPerVenuePerDay, res.body.safety.staleAfterHours], [200, 400, 4], 'lower limits: one click');
      const v5 = res.body.version;
      res = await put({ change: { safety: { maxSendsPerVenuePerDay: 900 } }, baseVersion: v5 });
      assertEqual([res.status, res.body.confirmPhrase], [400, 'LOOSEN LIMITS'], 'a higher limit needs the phrase');
      res = await put({ change: { safety: { maxSendsPerVenuePerDay: 900 } }, baseVersion: v5, confirm: 'LOOSEN LIMITS' });
      assertEqual([res.status, res.body.safety.maxSendsPerVenuePerDay], [200, 900], 'raised');
      res = await put({ change: { smsCountries: ['CH', 'LI', 'DE', 'AT', 'FR'] } });
      assertEqual([res.status, res.body.sms.allowedCountries], [200, ['CH', 'LI', 'DE', 'AT', 'FR']], 'a country removed: one click');
      const addable = (card.body.sms.knownCountries as string[]).find((c) => !['CH', 'LI', 'DE', 'AT', 'FR', 'IT'].includes(c))!;
      res = await put({ change: { smsCountries: ['CH', 'LI', 'DE', 'AT', 'FR', addable] }, baseVersion: res.body.version });
      assertEqual([res.status, res.body.confirmPhrase], [400, 'LOOSEN LIMITS'], `adding ${addable} needs the phrase`);
      assertEqual((await put({ change: { smsCountries: ['CH', 'ZZ'] } })).status, 400, 'an unknown country → 400');
      assertEqual((await put({ change: { safety: { staleAfterHours: 0 } } })).status, 400, 'staleAfterHours below 1 → 400');
      assertEqual((await put({ change: { safety: { staleAfterHours: 100 } } })).status, 400, 'staleAfterHours above 72 → 400');
      assertEqual((await put({ change: { alertsEmail: 'not-an-address' } })).status, 400, 'a bad alert email → 400');
      assertEqual((await put({ change: { launchEverything: true } })).status, 400, 'an unknown field → 400');
      assertEqual((await put({ change: { accounts: { 'bad.tenant': 'test' } } })).status, 400, 'a tenant id with a dot → 400');
      // The alert email: baseVersion, but no phrase (docs/adaptive-api.md, PUT /admin/launch).
      res = await put({ change: { alertsEmail: 'ops@heidifi.test' } });
      assertEqual([res.status, res.body.code], [400, 'bad_request'], 'the alert email without baseVersion → 400');
      res = await put({ change: { alertsEmail: 'ops@heidifi.test' }, baseVersion: (await api.get('/admin/launch')).body.version });
      assertEqual([res.status, res.body.alerts?.email], [200, 'ops@heidifi.test'], `alert email set: ${res.text.slice(0, 200)}`);
      settings = await readEngineSettings();
      assertEqual([settings.alerts.email, settings.safety.maxSendsPerVenuePerDay, settings.safety.staleAfterHours, settings.sms.allowedCountries.length], ['ops@heidifi.test', 900, 4, 5], 'the engine reads them');
      rules = await getAdaptiveConfig();
      assert(rules.version === res.body.version && rules.killSwitch.reason === 'Provider outage', "PR 1's parser still reads the doc");

      // Going live: refused without an alive worker on this code; then the phrase; liveSince stamped.
      await clearEngineStatus();
      const v = res.body.version;
      res = await put({ change: { accounts: { [A.tenant]: 'live' } }, baseVersion: v, confirm: 'GO LIVE' });
      assertEqual([res.status, res.body.code], [409, 'engine_not_ready'], 'no worker → 409');
      assertEqual(res.body.blockers?.length > 0, true, 'blockers listed');
      await seedWorkerHeartbeat();
      res = await put({ change: { accounts: { [A.tenant]: 'live' } }, baseVersion: v });
      assertEqual([res.status, res.body.confirmPhrase], [400, 'GO LIVE'], 'going live needs GO LIVE');
      const before = Date.now();
      res = await put({ change: { accounts: { [A.tenant]: 'live' } }, baseVersion: v, confirm: 'GO LIVE' });
      assertEqual([res.status, res.body.launch.accounts[A.tenant]], [200, 'live'], 'live');
      const since = Date.parse(res.body.launch.liveSince.accounts[A.tenant]);
      assert(since >= before - 1000 && since <= Date.now() + 1000, 'liveSince stamped in real time');
      // Back to a test run: one click, keeps the history.
      res = await put({ change: { accounts: { [A.tenant]: null } } });
      assertEqual([res.status, res.body.launch.accounts[A.tenant]], [200, undefined], 'the override removed (follows the default: off)');
      // The default going live for everyone needs its own phrase.
      const chk = await api.call('POST', '/admin/launch/check', { change: { default: 'live' }, actor: ADMIN_ACTOR });
      assertEqual(chk.body.summary.confirmPhrase, 'LIVE FOR EVERYONE', 'the default phrase');
      card = await api.get('/admin/launch');
      assertEqual(card.body.history[0].version, card.body.version, 'the card lists the newest history first');
      assertEqual(await historyCount(), card.body.version, 'exactly one history doc per version (the seed wrote history/1)');
      settings = await readEngineSettings();
      assert(settings.launch.liveSince?.accounts[A.tenant] !== undefined, 'the engine parses liveSince');
    });

    await test('launch card: live for everyone and an account with no override whose venue waits for Start sending → its name in accountNames', async () => {
      await fresh();
      await db.collection(COL.tenantUsers).doc(A.tenant).set({ displayName: 'Cafe Held' }, { merge: true });
      // "Live since" just after the venue was first turned on: it waits for its owner's Start sending.
      const firstOn = (await db.collection(COL.adaptiveVenues).doc(`venue_${A.venueId}`).get()).get('firstOnAt').toMillis();
      await configRef().update({ 'launch.default': 'live', 'launch.accounts': {}, 'launch.liveSince': { default: new Date(firstOn + 1000), accounts: {} } });
      clearCaches();
      const card = await api.get('/admin/launch');
      assertEqual(card.status, 200, 'GET /admin/launch');
      assertEqual([card.body.launch.default, card.body.launch.accounts], ['live', {}], 'live for everyone, no override');
      assertEqual(card.body.waitingForStartSending, { [A.tenant]: 1 }, 'its venue waits for Start sending');
      assertEqual(card.body.accountNames[A.tenant], { name: 'Cafe Held', email: `${A.tenant}@test.local` }, `named on the card: ${JSON.stringify(card.body.accountNames)}`);
    });

    console.log('\nDead tasks and retry\n');

    await test('dead tasks: listed without payload; retry → queued, attempts 0, same dueAt, runs once; not dead → 409; a dead STOP → 409', async () => {
      await fresh();
      const t0 = nextTuesday1240();
      await setClock(t0);
      await setLaunch({ [A.tenant]: 'test' });
      const guestId = await connect({ venue: A, email: 'retry@test.local', phone: '791239876', phoneCountryCode: '+41', phoneVerified: true, consent: true });
      await runDue();
      const contactId = await contactIdFor(A.tenant, guestId);
      const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1)!;
      const timer = (await docsWhere(COL.journeyTasks, 'kind', 'node_run')).find((t) => t.status === 'queued' && t.payload?.instanceId === a1.id);
      assert(timer, 'the 15-minute timer task');
      const dueAt = timer.dueAt.toMillis();

      const fail = await api.call('POST', '/dev/fail-task', { taskId: timer.id });
      assertEqual([fail.status, fail.body.status], [200, 'dead'], 'killed');
      const engine = await api.get('/admin/engine');
      assertEqual(engine.status, 200, 'GET /admin/engine');
      const listed = engine.body.deadTasks.find((d: any) => d.taskId === timer.id);
      assert(listed && listed.kind === 'node_run' && listed.venueId === A.venueId && listed.lastError, `listed: ${JSON.stringify(engine.body.deadTasks)}`);
      assert(!JSON.stringify(engine.body.deadTasks).includes('payload') && !JSON.stringify(engine.body).includes('retry@test.local'), 'no payload, no address');

      assertEqual((await api.call('POST', `/admin/tasks/${timer.id}/retry`, { actor: OWNER_ACTOR })).status, 403, 'an owner → 403');
      assertEqual((await api.call('POST', `/admin/tasks/${timer.id}/retry`, {})).status, 400, 'no actor → 400');
      assertEqual((await api.call('POST', '/admin/tasks/jt_nope/retry', { actor: ADMIN_ACTOR })).status, 404, 'unknown → 404');
      const res = await api.call('POST', `/admin/tasks/${timer.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([res.status, res.body.retried], [200, true], `retried: ${res.text.slice(0, 200)}`);
      const t = (await db.collection(COL.journeyTasks).doc(timer.id).get()).data()!;
      assertEqual([t.status, t.attempts, t.dueAt.toMillis(), t.doneAt, t.leaseOwner, t.retry.count, t.retry.by], ['queued', 0, dueAt, null, null, 1, ADMIN_ACTOR.uid], 'queued, attempts 0, same dueAt');
      assertEqual(t.lastError, 'failed by /dev/fail-task', 'the last error is kept');
      const again = await api.call('POST', `/admin/tasks/${timer.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([again.status, again.body.code], [409, 'conflict'], 'not dead any more → 409');
      await advance(15 * MINUTE_MS);
      await runDue();
      assertEqual((await db.collection(COL.journeyTasks).doc(timer.id).get()).get('status'), 'done', 'it ran');
      const s1 = (await db.collection(COL.journeySends).doc(sendKeyFor(a1.id, 's1')).get()).data();
      assertEqual(s1?.status, 'dry_run', 'the welcome (test run) happened once');

      // A STOP whose number was removed when it died: a retry would change nothing → 409.
      await adaptiveOnInboundSms({ from: '+41791239876', body: 'STOP', legacyKind: 'stop', messageSid: 'SMdeadstop', optOutType: null, signatureChecked: true });
      const stop = (await docsWhere(COL.journeyTasks, 'kind', 'signal')).find((x) => x.status === 'queued')!;
      assert(stop && stop.payload.guest?.phone, 'the STOP task holds the number until it is done');
      await api.call('POST', '/dev/fail-task', { taskId: stop.id });
      const listedStop = (await api.get('/admin/engine')).body.deadTasks.find((d: any) => d.taskId === stop.id);
      assert(listedStop, 'the dead STOP is listed');
      assertEqual([listedStop.urgent, listedStop.what, listedStop.guestDetails], [true, 'sms_stop', 'removed'], 'flagged urgent: a STOP not applied');
      const engineAfter = (await api.get('/admin/engine')).body;
      assertEqual(engineAfter.deadTasks[0].taskId, stop.id, 'urgent rows first');
      assert(engineAfter.urgentDeadTasks >= 1, 'counted as urgent');
      assert(!JSON.stringify(engineAfter).includes('41791239876'), 'no phone number in the list');
      const refused = await api.call('POST', `/admin/tasks/${stop.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([refused.status, refused.body.code], [409, 'conflict'], `a dead STOP → 409: ${refused.body.error}`);
      assertEqual((await db.collection(COL.journeyTasks).doc(stop.id).get()).get('status'), 'dead', 'left dead');
    });

    await test('a Wi-Fi connect that really died (8 failures → dead): listed, retried with a warning, handled from the saved guest record', async () => {
      await fresh();
      await setClock(nextTuesday1240());
      await setLaunch({ [A.tenant]: 'test' });
      const guestId = await connect({ venue: A, firstName: 'Dora', email: 'dead-connect@test.local', consent: true });
      const task = (await docsWhere(COL.journeyTasks, 'kind', 'event_route')).find((t) => t.status === 'queued')!;
      await db.collection(COL.journeyTasks).doc(task.id).update({ maxAttempts: 1 });
      const leased = (await claimDue('test-worker', now(), 10)).find((t) => t.id === task.id)!;
      assert(leased, 'claimed');
      await failTask(leased.id, 'test-worker', 'boom for dora@example.com at +41791234567', now());
      const dead = (await db.collection(COL.journeyTasks).doc(task.id).get()).data()!;
      assertEqual([dead.status, dead.payload.guest], ['dead', undefined], 'dead, details removed');
      const listed = (await api.get('/admin/engine')).body.deadTasks.find((d: any) => d.taskId === task.id);
      assert(listed && listed.kind === 'event_route', 'listed');
      assert(!listed.lastError.includes('dora@example.com') && !listed.lastError.includes('791234567'), `the error words are scrubbed: ${listed.lastError}`);
      const res = await api.call('POST', `/admin/tasks/${task.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([res.status, res.body.retried, typeof res.body.warning], [200, true, 'string'], `retried with a warning: ${res.text.slice(0, 200)}`);
      await runDue();
      const contactId = await contactIdFor(A.tenant, guestId);
      assert((await docsWhere(COL.journeyInstances, 'contactId', contactId)).some((i) => i.journeyKey === A1), 'handled: the welcome journey started');
    });

    await test('a dead Wi-Fi connect retried when its login is 10 h old (engine clock): 200 with the stale warning; the guest is recorded, no journey starts', async () => {
      await fresh();
      await setClock(nextTuesday1240());
      await setLaunch({ [A.tenant]: 'test' });
      const guestId = await connect({ venue: A, firstName: 'Lars', email: 'late-connect@test.local', consent: true });
      const task = (await docsWhere(COL.journeyTasks, 'kind', 'event_route')).find((t) => t.status === 'queued')!;
      await db.collection(COL.journeyTasks).doc(task.id).update({ maxAttempts: 1 });
      const leased = (await claimDue('test-worker', now(), 10)).find((t) => t.id === task.id)!;
      assert(leased, 'claimed');
      await failTask(leased.id, 'test-worker', 'boom', now());
      assertEqual((await db.collection(COL.journeyTasks).doc(task.id).get()).get('status'), 'dead', 'dead');

      // 5 h old (under the stale limit, 6 h by default): the usual warning only. Then it dies again.
      await advance(5 * HOUR_MS);
      const early = await api.call('POST', `/admin/tasks/${task.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([early.status, typeof early.body.warning], [200, 'string'], `retried at 5 h: ${early.text.slice(0, 300)}`);
      assert(!/no journey starts/.test(early.body.warning), `no stale warning at 5 h: ${early.body.warning}`);
      const again = (await claimDue('test-worker', now(), 10)).find((t) => t.id === task.id)!;
      assert(again, 'claimed again');
      await failTask(again.id, 'test-worker', 'boom again', now());
      assertEqual((await db.collection(COL.journeyTasks).doc(task.id).get()).get('status'), 'dead', 'dead again');

      await advance(5 * HOUR_MS); // 10 h: past the stale limit, well under 72 h
      const res = await api.call('POST', `/admin/tasks/${task.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([res.status, res.body.retried], [200, true], `retried: ${res.text.slice(0, 300)}`);
      assert(
        typeof res.body.warning === 'string' && /more than 6 hours old/.test(res.body.warning) && /no journey starts/.test(res.body.warning),
        `the stale warning: ${res.body.warning}`,
      );
      await runDue();
      const contactId = await contactIdFor(A.tenant, guestId);
      assertEqual((await docsWhere(COL.journeyInstances, 'contactId', contactId)).length, 0, 'the guest is recorded, but no journey started');

      // More than 72 h on the engine clock: refused, nothing queued.
      await api.call('POST', '/dev/fail-task', { taskId: task.id });
      await advance(63 * HOUR_MS);
      const tooLate = await api.call('POST', `/admin/tasks/${task.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual([tooLate.status, tooLate.body.code], [409, 'conflict'], `73 h → 409: ${tooLate.text.slice(0, 200)}`);
      assertEqual((await db.collection(COL.journeyTasks).doc(task.id).get()).get('status'), 'dead', 'left dead');
    });

    await test('a timer retried a week late keeps its dueAt: the welcome is skipped as stale (no late message)', async () => {
      await fresh();
      await setClock(nextTuesday1240());
      await setLaunch({ [A.tenant]: 'test' });
      const guestId = await connect({ venue: A, email: 'late-retry@test.local', consent: true });
      await runDue();
      const contactId = await contactIdFor(A.tenant, guestId);
      const a1 = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === A1)!;
      const timer = (await docsWhere(COL.journeyTasks, 'kind', 'node_run')).find((x) => x.status === 'queued' && x.payload?.instanceId === a1.id)!;
      await api.call('POST', '/dev/fail-task', { taskId: timer.id });
      await advance(7 * DAY_MS);
      const res = await api.call('POST', `/admin/tasks/${timer.id}/retry`, { actor: ADMIN_ACTOR });
      assertEqual(res.status, 200, 'retried');
      await runDue();
      const sends = await docsWhere(COL.journeySends, 'instanceId', a1.id);
      assertEqual(sends.length, 0, 'no welcome a week late');
      const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', a1.id)).filter((e) => e.type === 'send.skipped').map((e) => e.data?.decision?.reason);
      assertEqual(skipped, ['stale'], 'skipped as stale');
    });

    await test('a dead rating: stars only and already applied → retried, no warning, applied once; a 3★ with feedback never applied → the lost-feedback warning; 4★ → none', async () => {
      await fresh();
      const t0 = nextTuesday1240();
      await setClock(t0);
      await seedWallet(A.tenant, 5000);
      await setLaunch({ [A.tenant]: 'live' }, { paused: false });
      const names = ['sven', 'lea', 'ole'];
      const guests: string[] = [];
      for (const n of names) guests.push(await connect({ venue: A, firstName: n, email: `${n}.rating@test.local`, consent: true }));
      await runUntil(t0 + 7 * HOUR_MS); // the welcome, then the review ask ~6 h after the visit
      const asks: string[] = [];
      for (const g of guests) {
        const c = await contactIdFor(A.tenant, g);
        const a2 = (await docsWhere(COL.journeyInstances, 'contactId', c)).find((i) => i.journeyKey === 'review_ask')!;
        const key = sendKeyFor(a2.id, 's1');
        assertEqual((await db.collection(COL.journeySends).doc(key).get()).get('status'), 'sent', `${c}: the review ask went out`);
        asks.push(key);
      }
      const ratingOf = async (sendKey: string) => (await docsWhere(COL.journeyEvents, 'sendKey', sendKey)).find((e) => e.type === 'rating.submitted')!;
      const taskOf = (eventId: string) => db.collection(COL.journeyTasks).doc(taskIdFor(`signal:${eventId}`));
      const retry = (eventId: string) => api.call('POST', `/admin/tasks/${taskIdFor(`signal:${eventId}`)}/retry`, { actor: ADMIN_ACTOR });
      const lowAlerts = async () => {
        await new Promise((r) => setTimeout(r, 200)); // alerts are fire-and-forget
        return docsWhere(COL.alerts, 'kind', 'low_rating');
      };

      // Sven: 2★, no words. Applied (low rating + the owner's alert), then the task dies.
      await devProviderEvent({ sendKey: asks[0], event: 'rating', stars: 2 });
      const sven = await ratingOf(asks[0]);
      assertEqual(sven.data.hasFeedback, false, 'stars only');
      await runDue();
      const appliedAt = (await db.collection(COL.journeyEvents).doc(sven.id).get()).get('appliedAt');
      assert(appliedAt, 'applied');
      assertEqual((await lowAlerts()).length, 1, "the owner's alert");
      await api.call('POST', '/dev/fail-task', { taskId: taskOf(sven.id).id });
      assertEqual((await taskOf(sven.id).get()).get('status'), 'dead', 'dead');
      let res = await retry(sven.id);
      assertEqual([res.status, res.body.retried, res.body.kind, 'warning' in res.body], [200, true, 'signal', false], `retried without a warning: ${res.text.slice(0, 300)}`);
      await runDue();
      assertEqual((await taskOf(sven.id).get()).get('status'), 'done', 'it ran');
      assertEqual((await db.collection(COL.journeyEvents).doc(sven.id).get()).get('appliedAt').toMillis(), appliedAt.toMillis(), 'not applied twice');
      assertEqual((await lowAlerts()).length, 1, 'no second alert');

      // Lea: 3★ with private feedback; the task dies before it runs (the feedback is removed with it).
      await devProviderEvent({ sendKey: asks[1], event: 'rating', stars: 3, text: 'cold soup' });
      const lea = await ratingOf(asks[1]);
      assertEqual((await taskOf(lea.id).get()).get('payload.guest.feedback'), 'cold soup', 'the task holds the feedback until it runs');
      await api.call('POST', '/dev/fail-task', { taskId: taskOf(lea.id).id });
      // Ole: 4★ with words, also dies unapplied.
      await devProviderEvent({ sendKey: asks[2], event: 'rating', stars: 4, text: 'lovely' });
      const ole = await ratingOf(asks[2]);
      await api.call('POST', '/dev/fail-task', { taskId: taskOf(ole.id).id });

      res = await retry(lea.id);
      assertEqual([res.status, res.body.retried], [200, true], 'Lea retried');
      assert(typeof res.body.warning === 'string' && /private feedback/.test(res.body.warning), `the lost-feedback warning: ${res.body.warning}`);
      res = await retry(ole.id);
      assertEqual([res.status, res.body.retried, 'warning' in res.body], [200, true, false], `4★ (above the alert line): no warning: ${res.text.slice(0, 300)}`);
      await runDue();
      assert((await db.collection(COL.journeyEvents).doc(lea.id).get()).get('appliedAt'), "Lea's rating applied on the retry");
      const alerts = await lowAlerts();
      assertEqual(alerts.length, 2, "Lea's alert too (3★), none for Ole (4★)");
      assert(alerts.every((a) => !String(a.text).includes('cold soup')), 'the alert goes out without the lost feedback');
    });

    console.log('\nGuest search and the key guard\n');

    await test('search finds the person across accounts by email and phone; unknown → []; a GET with ?email= is a plain 404; nothing leaks', async () => {
      await fresh([A, C]);
      await setClock(nextTuesday1240());
      await setLaunch({ [A.tenant]: 'test', [C.tenant]: 'test' });
      const person = { email: 'Mia.Search@Test.Local', phone: '791230077', phoneCountryCode: '+41', phoneVerified: true, consent: true, firstName: 'Mia' };
      const g1 = await connect({ venue: A, ...person });
      const g2 = await connect({ venue: C, ...person });
      await runDue();
      const c1 = await contactIdFor(A.tenant, g1);
      const c2 = await contactIdFor(C.tenant, g2);
      const { result, logs } = await captureLogs(async () => ({
        byEmail: await api.call('POST', '/admin/guests/search', { email: 'mia.search@test.local', actor: ADMIN_ACTOR }),
        byPhone: await api.call('POST', '/admin/guests/search', { phone: '+41791230077', actor: ADMIN_ACTOR }),
        nobody: await api.call('POST', '/admin/guests/search', { email: 'nobody@test.local', actor: ADMIN_ACTOR }),
        viaGet: await api.get('/admin/guests/search?email=mia.search@test.local'),
        noActor: await api.call('POST', '/admin/guests/search', { email: 'mia.search@test.local' }),
        owner: await api.call('POST', '/admin/guests/search', { email: 'mia.search@test.local', actor: OWNER_ACTOR }),
        bad: await api.call('POST', '/admin/guests/search', { email: 'not-an-address', actor: ADMIN_ACTOR }),
      }));
      const pairs = (r: any) => r.body.results.map((x: any) => `${x.tenantUserId}:${x.contactId}`).sort();
      assertEqual(pairs(result.byEmail), [`${A.tenant}:${c1}`, `${C.tenant}:${c2}`].sort(), 'by email: both accounts');
      assertEqual(pairs(result.byPhone), [`${A.tenant}:${c1}`, `${C.tenant}:${c2}`].sort(), 'by phone: both accounts');
      assert(result.byEmail.body.results.every((r: any) => r.matchedBy.includes('email') && r.venues.length === 1), 'matched by, venues');
      assertEqual([result.nobody.status, result.nobody.body.results], [200, []], 'unknown → []');
      assertEqual([result.viaGet.status, result.viaGet.body.code], [404, 'not_found'], 'GET ?email= → 404');
      assertEqual([result.noActor.status, result.owner.status, result.bad.status], [400, 403, 400], 'no actor 400, an owner 403, a bad address 400');
      const everything = JSON.stringify(Object.values(result).map((r: any) => r.text)) + logs.join('\n');
      assert(!/mia\.search@test\.local/i.test(everything) && !everything.includes('791230077'), 'no raw address in any answer or log line');
    });

    await test('key guard: a pinned key that differs → 409 (admin search and the owner lookup); nothing pinned → compare with alive workers', async () => {
      await fresh();
      await setClock(nextTuesday1240());
      await setLaunch({ [A.tenant]: 'test' });
      await connect({ venue: A, email: 'guard@test.local', consent: true });
      await new AdaptiveWorker().runDue(); // a fresh worker pins this key (the shared one confirmed it before the reset)
      const status = db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID);
      assertEqual((await status.get()).get('identity.keyFingerprint'), keyFingerprint(), 'pinned');
      assertEqual((await api.call('POST', '/admin/guests/search', { email: 'guard@test.local', actor: ADMIN_ACTOR })).body.results.length, 1, 'found while the keys agree');
      await status.set({ identity: { keyFingerprint: 'bbbbbbbbbbbb' } }, { merge: true });
      const refused = await api.call('POST', '/admin/guests/search', { email: 'guard@test.local', actor: ADMIN_ACTOR });
      assertEqual([refused.status, refused.body.code], [409, 'conflict'], 'the pinned key differs → 409');
      const find = await api.call('POST', `/tenants/${A.tenant}/guests/find`, { email: 'guard@test.local' });
      assertEqual(find.status, 409, "the owner's (MCP) lookup is refused too");
      // Nothing pinned: an alive worker with another key refuses; a dead one doesn't count.
      await status.update({ identity: FieldValue.delete() });
      await clearEngineStatus();
      await seedWorkerHeartbeat({ keyFingerprint: 'cccccccccccc' });
      assertEqual((await api.call('POST', '/admin/guests/search', { email: 'guard@test.local', actor: ADMIN_ACTOR })).status, 409, "an alive worker's other key → 409");
      await clearEngineStatus();
      await seedWorkerHeartbeat({ keyFingerprint: 'cccccccccccc', ageMs: 10 * MINUTE_MS });
      assertEqual((await api.call('POST', '/admin/guests/search', { email: 'guard@test.local', actor: ADMIN_ACTOR })).status, 200, 'a worker gone for 10 minutes does not count');
    });

    console.log('\nIndexes and the route guard\n');

    await test('checkIndexes() passes with the PR D probes', async () => {
      const r = await checkIndexes();
      assert(r.ok, `missing: ${JSON.stringify(r.missing)}`);
    });

    await test('route guard: every PR D path → JSON 401 without the secret; unknown → JSON 404; writes without an actor → 400', async () => {
      const T = `/tenants/${A.tenant}`;
      const V = `${T}/venues/${A.venueId}`;
      const cid = `${A.tenant}_${'a'.repeat(24)}`;
      const routes: Array<[string, string, boolean]> = [
        // [method, path, is a write that needs an actor]
        ['GET', `${V}/stay-feed`, false],
        ['PUT', `${V}/stay-feed`, true],
        ['DELETE', `${V}/stay-feed`, true],
        ['POST', `${V}/stay-feed/check`, true],
        ['POST', `${V}/stay-feed/sync`, true],
        ['POST', `${V}/stays/stay_1/unlink`, true],
        ['POST', `${V}/stays/stay_1/link`, true],
        ['GET', `${V}/guest-info`, false],
        ['PUT', `${V}/guest-info`, true],
        ['GET', `${V}/audience`, false],
        ['PUT', `${V}/audience`, true],
        ['POST', `${V}/test-send`, true],
        ['GET', `${T}/results`, false],
        ['GET', `${V}/guests`, false],
        ['GET', `${V}/guests/${cid}`, false],
        ['POST', `${V}/guests/${cid}/marketing`, true],
        ['GET', `${V}/messages`, false],
        ['POST', `${T}/guests/find`, false],
        ['POST', `${V}/start-sending`, true],
        ['GET', '/public/offer/abcdefgh?venueId=venue_x', false],
        ['GET', '/public/info/abcdefgh?venueId=venue_x', false],
        ['GET', '/admin/launch', false],
        ['POST', '/admin/launch/check', true],
        ['PUT', '/admin/launch', true],
        ['POST', '/admin/tasks/jt_x/retry', true],
        ['POST', '/admin/guests/search', true],
        ['GET', `/admin/guests/${cid}`, false],
        ['POST', '/admin/decisions/replay', true],
        ['POST', '/dev/fail-task', false],
      ];
      for (const [method, path, write] of routes) {
        const body = method === 'GET' ? undefined : { url: 'sandbox:calendar/r', sms: 'all', email: 'all', change: { paused: true }, email_: 'x' };
        for (const secret of [null, 'wrong-secret']) {
          const res = await api.call(method, path, body, { secret });
          assert(res.status === 401 && res.body?.ok === false && res.body?.code === 'unauthorized', `${method} ${path} without the secret (${secret}): ${res.status} ${res.text.slice(0, 80)}`);
        }
        if (write) {
          const res = await api.call(method, path, body);
          assert(res.status === 400 && res.body?.ok === false && res.body?.code === 'bad_request', `${method} ${path} without an actor: ${res.status} ${res.text.slice(0, 120)}`);
        }
      }
      for (const [method, path] of [
        ['GET', '/admin/nothing-here'],
        ['POST', `${V}/stay-feed/nothing`],
        ['GET', `${T}/venues`],
        ['DELETE', '/admin/launch'],
      ]) {
        const res = await api.call(method, path, method === 'GET' ? undefined : {});
        assert(res.status === 404 && res.body?.code === 'not_found' && res.headers.get('content-type')?.includes('application/json'), `${method} ${path}: JSON 404 (${res.status})`);
      }
      // Admin writes by anyone but HeidiFi staff → 403.
      for (const [method, path, body] of [
        ['POST', '/admin/launch/check', { change: { paused: true } }],
        ['PUT', '/admin/launch', { change: { paused: true } }],
        ['POST', '/admin/tasks/jt_x/retry', {}],
        ['POST', '/admin/guests/search', { email: 'x@test.local' }],
        ['POST', '/admin/decisions/replay', { sendKey: 'js_x' }],
      ] as const) {
        for (const actor of [OWNER_ACTOR, MCP_ACTOR, { uid: 'seed', kind: 'seed' }]) {
          const res = await api.call(method, path, { ...body, actor });
          assertEqual(res.status, 403, `${method} ${path} as ${actor.kind}`);
        }
      }
      // Owner writes: the MCP and the seed never.
      const res = await api.call('PUT', `${V}/audience`, { sms: 'all', email: 'all', actor: MCP_ACTOR });
      assertEqual(res.status, 403, 'an owner write as the MCP → 403');
      // An id that isn't one of ours → 400 before anything is read.
      assertEqual((await api.get(`${T}/venues/bad.id/guest-info`)).status, 400, 'a venue id with a dot → 400');
      // Ids that arrive in a query or a body (not the path) are never a 500 either.
      await setupVenue(A);
      for (const [label, pending] of [
        ['results ?venueId=a/b', api.get(`${T}/results?venueId=${encodeURIComponent('a/b')}`)],
        ['guests/find contactId a/b', api.call('POST', `${T}/guests/find`, { contactId: 'a/b' })],
        ['guests/find guestId a/b', api.call('POST', `${T}/guests/find`, { guestId: 'a/b' })],
        ['link contactId a/b', api.call('POST', `${V}/stays/stay_1/link`, { contactId: 'a/b', actor: OWNER_ACTOR })],
        ['unlink expectContactId a/b', api.call('POST', `${V}/stays/stay_1/unlink`, { expectContactId: 'a/b', actor: OWNER_ACTOR })],
      ] as const) {
        const res = await pending;
        assert(res.status >= 400 && res.status < 500 && res.body?.ok === false, `${label}: a 4xx, not ${res.status} ${res.text.slice(0, 100)}`);
      }
    });
  } finally {
    await api.close();
  }
  void runUntil;
  void now;
  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
