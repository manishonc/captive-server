/**
 * Welcome → come back v2 on the emulator: the journey stays open until its offer ends, so a
 * guest who comes back while the offer is valid counts — the offer is redeemed, the thank-you
 * goes and the journey converts. v1 ended about 5 days in (no click), so a return on day 6–14
 * was missed.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - A new setup runs Restaurant growth v3, which pins the welcome v2.
 *  - No reaction: after the follow-up (or a skipped one) the journey waits in `w_offer` until the
 *    offer ends.
 *  - Back on day 8: `offer.redeemed`, the thank-you (a service message), converted.
 *  - Nobody back: it ends as `exhausted` when the 14-day offer ends.
 */

import {
  assert,
  assertEqual,
  COL,
  connect,
  docsWhere,
  done,
  nextTuesday1240,
  now,
  resetEmulator,
  runUntil,
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { DAY_MS } from '../../src/adaptive/core/runtime/time';

const V: VenueFixture = { tenant: 'tenant_wel', venueId: 'venue_wel', apId: 'ap_wel', apMac: 'aa:aa:aa:aa:3e:01' };

async function welcomeOf(guestEmail: string): Promise<AnyDoc> {
  const all = (await docsWhere(COL.journeyInstances, 'venueId', V.venueId)).filter((i) => i.journeyKey === 'welcome_second_visit');
  const contacts = await docsWhere(COL.contacts, 'email', guestEmail);
  const mine = all.filter((i) => i.contactId === contacts[0]?.id);
  assertEqual(mine.length, 1, `one welcome journey for ${guestEmail}`);
  return mine[0];
}

async function sendsOf(instanceId: string): Promise<AnyDoc[]> {
  const s = await docsWhere(COL.journeySends, 'instanceId', instanceId);
  return s.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function main() {
  console.log('\nWelcome → come back v2: open until the offer ends (emulator)');

  await test('back on day 8 after no reaction: redeemed, thank-you, converted', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(V);
    await setLaunch({ [V.tenant]: 'test' });
    const t0 = nextTuesday1240();
    await setClock(t0);

    // Mia: phone + email → SMS welcome, then the email follow-up. Leo: email only → his follow-up has
    // no channel left (WhatsApp is off) and is skipped — v1 ended there on day 2.
    const mia = await connect({ venue: V, firstName: 'Mia', email: 'mia@wel.test', phone: '1512345678', phoneCountryCode: '+49', phoneVerified: true, consent: true });
    const leo = await connect({ venue: V, firstName: 'Leo', email: 'leo@wel.test', consent: true });
    await runUntil(t0 + 6 * DAY_MS);

    let w = await welcomeOf('mia@wel.test');
    assertEqual(w.templateVersion, 2, 'the welcome v2 (Restaurant growth v3)');
    assertEqual([w.status, w.cursor.nodeId], ['active', 'w_offer'], 'day 6: still open, waiting for the offer to end');
    assertEqual((await sendsOf(w.id)).map((s) => `${s.nodeId}:${s.channel}`), ['s1:sms', 's2_next:email'], 'welcome + follow-up only');
    const l6 = await welcomeOf('leo@wel.test');
    assertEqual([l6.status, l6.cursor.nodeId], ['active', 'w_offer'], 'Leo (follow-up skipped): still open on day 6');

    // Mia comes back on day 8 (a revisit: more than 8 h since her last connect).
    await setClock(t0 + 8 * DAY_MS);
    await connect({ venue: V, guestId: mia, firstName: 'Mia', email: 'mia@wel.test', phone: '1512345678', phoneCountryCode: '+49', phoneVerified: true, consent: true });
    await runUntil(now() + 60 * 60_000);

    w = await welcomeOf('mia@wel.test');
    assertEqual(w.status, 'converted', 'converted');
    assert(w.goal?.reachedAt, 'goal reached');
    const sends = await sendsOf(w.id);
    const thanks = sends.find((s) => s.nodeId === 'thanks');
    assert(thanks, `the thank-you went: ${sends.map((s) => s.nodeId).join(',')}`);
    assertEqual([thanks!.purpose, thanks!.status], ['service', 'dry_run'], 'a service message (test run)');
    const redeemed = (await docsWhere(COL.journeyEvents, 'instanceId', w.id)).filter((e) => e.type === 'offer.redeemed');
    assertEqual([redeemed.length, redeemed[0]?.data?.redeemedVia], [1, 'revisit_auto'], 'the offer counts as redeemed');
    const converted = (await docsWhere(COL.journeyEvents, 'instanceId', w.id)).filter((e) => e.type === 'journey.converted');
    assertEqual(converted.length, 1, 'one journey.converted (the "came back" number)');

    // Leo never comes back: the journey ends when his 14-day offer ends.
    await runUntil(t0 + 15 * DAY_MS);
    const l = await welcomeOf('leo@wel.test');
    assertEqual(l.status, 'exhausted', 'Leo: exhausted at the offer end');
    // Stored as a Firestore timestamp (the engine reads it back as milliseconds).
    const raw = l.vars.offerExpiresAt;
    const ends = typeof raw?.toMillis === 'function' ? raw.toMillis() : Number(raw);
    // Issued when his journey started, a few seconds after t0 (the sandbox clock keeps running).
    assert(Math.abs(ends - t0 - 14 * DAY_MS) < 60_000, `a 14-day offer (${ends - t0} ms)`);
    const exited = (await docsWhere(COL.journeyEvents, 'instanceId', l.id)).find((e) => e.type === 'journey.exited');
    assert(exited && exited.occurredAt.toMillis() >= ends, 'not before the offer ended');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
