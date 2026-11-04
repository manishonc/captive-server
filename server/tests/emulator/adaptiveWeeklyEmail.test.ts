/**
 * The weekly numbers email (spec §12 P0 interim; D6–D10 of 2026-11-04) on the emulator, through
 * the real worker, router and sandbox email adapter.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 *
 *  - The worker's watchdog arms the next Monday's task (08:00 Zurich) for a live account; at that
 *    time the email lands in the sandbox outbox once, to the owner's login email, with last week's
 *    numbers; running it again sends nothing.
 *  - Skipped and recorded: switched off, the account not live, a quiet week.
 *  - Owner routes: the settings (on by default, English), a masked recipient, the next Monday;
 *    a bad body → 400; the preview in German, nothing sent.
 */

import {
  COL,
  TZ,
  advance,
  assert,
  assertEqual,
  connect,
  db,
  done,
  nextTuesday1240,
  now,
  outbox,
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
import { OWNER_ACTOR, mountApi } from './ownerApiHelpers';
import { rollupVenue } from '../../src/adaptive/rollups/rollup';
import { readEngineSettings } from '../../src/adaptive/store/engineSettings';
import { runWeeklyEmail, weeklyEmailKey, weeklyEmailWatchdog } from '../../src/adaptive/service/weeklyEmail';
import { ownerEmailWeekId } from '../../src/adaptive/store/collections';
import { taskIdFor } from '../../src/adaptive/core/runtime/ids';
import { DAY_MS, localParts, zonedTime } from '../../src/adaptive/core/runtime/time';

const D: VenueFixture = { tenant: 'tenant_week', venueId: 'venue_week', apId: 'ap_week', apMac: 'aa:ee:ee:ee:ee:01' };

async function main() {
  const api = await mountApi();
  try {
    console.log('\nWeekly numbers email (spec §12 P0)\n');

    await test('armed for Monday 08:00, sent once to the owner with last week’s numbers', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(D);
      await seedWallet(D.tenant, 5000);
      await setLaunch({ [D.tenant]: 'live' }, { paused: false });
      const t0 = nextTuesday1240();
      await setClock(t0);
      await connect({ venue: D, firstName: 'Ana', email: 'ana.week@test.local', phone: '791118001', phoneCountryCode: '+41', phoneVerified: true, consent: true, consentAsked: true });
      await runDue();
      await advance(15 * 60_000);
      await runDue();
      await rollupVenue(D.venueId, { cutoffMs: Date.now() + 1000 });

      // The watchdog (hourly in the worker) arms the next Monday's task.
      const settings = await readEngineSettings();
      assertEqual((await weeklyEmailWatchdog({ now: now(), settings })).armed, 1, 'one live account');
      const p = localParts(new Date(t0), TZ);
      const monday = zonedTime(p.year, p.month, p.day + 6, 8, 0, TZ).getTime();
      const sendDate = `${localParts(new Date(monday), TZ).year}-${String(localParts(new Date(monday), TZ).month).padStart(2, '0')}-${String(localParts(new Date(monday), TZ).day).padStart(2, '0')}`;
      const task = await db.collection(COL.journeyTasks).doc(taskIdFor(weeklyEmailKey(D.tenant, sendDate))).get();
      assert(task.exists, `a weekly_email task for ${sendDate}`);
      assertEqual([task.get('kind'), task.get('dueAt').toMillis()], ['weekly_email', monday], 'due Monday 08:00 Zurich');
      await weeklyEmailWatchdog({ now: now(), settings });
      assertEqual((await db.collection(COL.journeyTasks).where('kind', '==', 'weekly_email').get()).size, 1, 'arming twice is a no-op');

      // Monday 08:05: the worker sends it.
      const before = (await outbox()).filter((m) => m.channel === 'email' && m.to === `${D.tenant}@test.local`).length;
      await setClock(monday + 5 * 60_000);
      await runDue();
      const mails = (await outbox()).filter((m) => m.channel === 'email' && m.to === `${D.tenant}@test.local`);
      assertEqual(mails.length, before + 1, 'one email to the owner');
      const mail = mails[mails.length - 1];
      assert(String(mail.subject).startsWith('Your week at Venue venue_week:'), `subject: ${mail.subject}`);
      assert(String(mail.html).includes('Snapshot') && String(mail.html).includes('Guests reached'), 'the numbers');
      assert(String(mail.text).includes('Wi-Fi visits: 1 (1 new · 0 returning)'), `last week's visit: ${String(mail.text).split('\n').find((l: string) => l.startsWith('Wi-Fi'))}`);
      assertEqual(mail.unsubscribeUrl, null, 'a service email: no unsubscribe header');
      assert(!String(mail.html).includes('ana.week'), 'no guest address in it');
      const rec = await db.collection(COL.ownerEmails).doc(ownerEmailWeekId(D.tenant, sendDate)).get();
      assertEqual([rec.get('status'), rec.get('weekStart'), rec.get('venues')], ['sent', localDay(monday - 7 * DAY_MS), 1], 'the record');
      assert(!String(rec.get('to')).includes(`${D.tenant}@`), 'the record keeps a masked address');

      // Again (a retried task, a second worker): nothing more.
      const again = await runWeeklyEmail({ tenantUserId: D.tenant, sendDate }, { now: now(), settings });
      assertEqual(again, { status: 'done_before', was: 'sent' }, 'once per Monday');
      assertEqual((await outbox()).filter((m) => m.channel === 'email' && m.to === `${D.tenant}@test.local`).length, mails.length, 'still one');
    });

    await test('skipped and recorded: switched off, not live, a quiet week', async () => {
      const settings = await readEngineSettings();
      const at = now();
      const off = await api.call('PUT', `/tenants/${D.tenant}/weekly-email`, { enabled: false, actor: OWNER_ACTOR });
      assertEqual([off.status, off.body.settings.enabled, off.body.wouldSend, off.body.reason], [200, false, false, 'off'], 'switched off');
      assertEqual(await runWeeklyEmail({ tenantUserId: D.tenant, sendDate: '2030-01-07' }, { now: at, settings }), { status: 'skipped', reason: 'off' }, 'off → skipped');
      await api.call('PUT', `/tenants/${D.tenant}/weekly-email`, { enabled: true, actor: OWNER_ACTOR });
      // A week far ahead has no visits and no messages.
      assertEqual(await runWeeklyEmail({ tenantUserId: D.tenant, sendDate: '2030-01-14' }, { now: at, settings }), { status: 'skipped', reason: 'quiet_week' }, 'quiet week');
      await setLaunch({ [D.tenant]: 'test' });
      const testRun = await readEngineSettings();
      assertEqual(await runWeeklyEmail({ tenantUserId: D.tenant, sendDate: '2030-01-21' }, { now: at, settings: testRun }), { status: 'skipped', reason: 'not_live' }, 'a test run → skipped');
      assertEqual((await db.collection(COL.ownerEmails).doc(ownerEmailWeekId(D.tenant, '2030-01-21')).get()).get('status'), 'skipped', 'recorded');
      await setLaunch({ [D.tenant]: 'live' }, { paused: false });
    });

    await test('owner routes: settings, a masked recipient, the next Monday, 400s, the German preview', async () => {
      const get = await api.get(`/tenants/${D.tenant}/weekly-email`);
      assertEqual(get.status, 200, `GET: ${get.text.slice(0, 200)}`);
      assertEqual([get.body.settings.enabled, get.body.settings.lang, get.body.wouldSend, get.body.timezone], [true, 'en', true, TZ], 'defaults');
      assert(get.body.recipient && !get.body.recipient.startsWith(D.tenant), `masked: ${get.body.recipient}`);
      assertEqual(localParts(new Date(get.body.next.at), TZ).weekday, 1, 'next is a Monday');
      assert(get.body.last && ['sent', 'skipped'].includes(get.body.last.status), 'the last one');
      for (const bad of [{}, { lang: 'fr' }, { enabled: 'yes' }, { other: 1 }]) {
        assertEqual((await api.call('PUT', `/tenants/${D.tenant}/weekly-email`, { ...bad, actor: OWNER_ACTOR })).status, 400, `400 for ${JSON.stringify(bad)}`);
      }
      const de = await api.call('PUT', `/tenants/${D.tenant}/weekly-email`, { lang: 'de', actor: OWNER_ACTOR });
      assertEqual(de.body.settings.lang, 'de', 'German saved');
      const sent = (await outbox()).length;
      const preview = await api.get(`/tenants/${D.tenant}/weekly-email/preview`);
      assertEqual(preview.status, 200, `preview: ${preview.text.slice(0, 200)}`);
      assert(String(preview.body.subject).startsWith('Ihre Woche bei'), `German subject: ${preview.body.subject}`);
      assert(String(preview.body.html).includes('Überblick'), 'German html');
      assertEqual((await outbox()).length, sent, 'the preview sends nothing');
      const en = await api.get(`/tenants/${D.tenant}/weekly-email/preview?lang=en`);
      assert(String(en.body.subject).startsWith('Your week at'), 'lang=en overrides');
      assertEqual((await api.get(`/tenants/tenant_nobody/weekly-email`)).body.wouldSend, false, 'an account without venues');
    });
  } finally {
    await api.close();
  }
  done();
}

function localDay(ms: number): string {
  const p = localParts(new Date(ms), TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
