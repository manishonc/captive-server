/**
 * The splash's built-in Birthday month field on the emulator: the guest's pick reaches the
 * Adaptive contact's profile (profile.birthdayMonth, via 'splash') through the real connect
 * hook and worker — the same field the Birthday journey's scan and the guest pages read.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - A first answer lands on the profile.
 *  - A later answer replaces it; a connect that skips the field keeps it.
 *  - An answer kept on the guest doc from an earlier connect (e.g. before the venue turned
 *    Adaptive on) fills a profile that has none — and never overrides a newer answer.
 */

import {
  advance,
  assertEqual,
  COL,
  connect,
  contactIdFor,
  db,
  done,
  nextTuesday1240,
  resetEmulator,
  runDue,
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type VenueFixture,
} from './helpers';
import { saveSetups } from '../../src/adaptive/service/tenant';

const V: VenueFixture = { tenant: 'tenant_bday', venueId: 'venue_bday', apId: 'ap_bday', apMac: 'aa:aa:aa:aa:bd:01' };
const OWNER = { uid: 'tenant_bday_owner', kind: 'tenant_user' as const, role: 'ADMIN' as const };

async function freshVenue(): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(V);
  await saveSetups(
    V.tenant,
    { playbookKey: 'restaurant_growth', venueIds: [V.venueId], journeys: { birthday: { enabled: true, slots: {} } } as never },
    OWNER,
  );
  await setLaunch({ [V.tenant]: 'test' });
  await setClock(nextTuesday1240());
}

async function profileOf(guestId: string): Promise<Record<string, unknown> | null> {
  const contactId = await contactIdFor(V.tenant, guestId);
  const c = (await db.collection(COL.contacts).doc(contactId).get()).data() ?? {};
  return (c.profile as Record<string, unknown> | undefined) ?? null;
}

/** A connect a few minutes later (one connect per guest per minute is one event). */
async function later(): Promise<void> {
  await advance(10 * 60_000);
}

async function main() {
  console.log('\nSplash Birthday month → Adaptive profile (emulator)');

  await test('a first answer lands on the profile, via splash', async () => {
    await freshVenue();
    const anna = await connect({ venue: V, firstName: 'Anna', email: 'anna@bday.test', consent: true, birthdayMonth: 3 });
    await runDue();
    const p = await profileOf(anna);
    assertEqual([p?.birthdayMonth, p?.birthdayMonthVia], [3, 'splash'], 'month and source');
  });

  await test('a later answer replaces it; a connect that skips the field keeps it', async () => {
    await freshVenue();
    const ben = await connect({ venue: V, firstName: 'Ben', email: 'ben@bday.test', consent: true, birthdayMonth: 3 });
    await runDue();
    await later();
    await connect({ venue: V, guestId: ben, firstName: 'Ben', email: 'ben@bday.test', consent: true, birthdayMonth: 7 });
    await runDue();
    assertEqual((await profileOf(ben))?.birthdayMonth, 7, 'the new answer');
    await later();
    // A skip: the portal sends no month, so the guest doc keeps 7 and so does the profile.
    await connect({ venue: V, guestId: ben, firstName: 'Ben', email: 'ben@bday.test', consent: true });
    await runDue();
    assertEqual((await profileOf(ben))?.birthdayMonth, 7, 'kept after a skip');
  });

  await test('an earlier answer on the guest doc fills an empty profile, never a newer answer', async () => {
    await freshVenue();
    // Answered on a visit before the venue was on Adaptive: only the guest doc has it.
    const cleo = await connect({ venue: V, firstName: 'Cleo', email: 'cleo@bday.test', consent: true, legacy: { birthdayMonth: 5 } });
    await runDue();
    const p = await profileOf(cleo);
    assertEqual([p?.birthdayMonth, p?.birthdayMonthVia], [5, 'splash'], 'filled from the guest doc');

    // Dan answered 9 at one access point; his guest doc at another still holds an older 4.
    const dan = await connect({ venue: V, firstName: 'Dan', email: 'dan@bday.test', consent: true, birthdayMonth: 9 });
    await runDue();
    await later();
    await connect({ venue: V, guestId: dan, firstName: 'Dan', email: 'dan@bday.test', consent: true, legacy: { birthdayMonth: 4 } });
    await runDue();
    assertEqual((await profileOf(dan))?.birthdayMonth, 9, 'the newer answer stays');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
