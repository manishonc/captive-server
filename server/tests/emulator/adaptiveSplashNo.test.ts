/**
 * "I don't want to stay in touch" on a later visit, on the emulator: through the real connect hook
 * and worker, the guest's explicit no takes back the yes they gave at that venue.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - An explicit no (the consent step was shown) revokes every channel's yes at that venue, even
 *    a channel this form had no address for; a later Accept gives the yes back.
 *  - A venue that hides the consent step sends a "no" that isn't the guest's: nothing changes.
 *  - A STOP stays a STOP; with no yes there is nothing to take back; other venues keep theirs.
 *  - A yes the owner's stop is holding is taken back too, so the owner's Resume can't give it back.
 *  - A welcome already planned is not sent once the guest has said no.
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
  seedCatalogue,
  setClock,
  setLaunch,
  setupVenue,
  test,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { applyPhoneStop } from '../../src/adaptive/engine/optouts';
import { consentState } from '../../src/adaptive/identity/resolve';
import { setGuestMarketing } from '../../src/adaptive/service/guests';
import { MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const V: VenueFixture = { tenant: 'tenant_no', venueId: 'venue_no', apId: 'ap_no', apMac: 'aa:aa:aa:aa:4e:01' };
const V2: VenueFixture = { tenant: 'tenant_no', venueId: 'venue_no2', apId: 'ap_no2', apMac: 'aa:aa:aa:aa:4e:02' };
const OWNER = { uid: 'tenant_no_owner', kind: 'tenant_user' as const, role: 'ADMIN' as const };
const CHANNELS = ['email', 'sms', 'whatsapp'] as const;

async function freshVenues(...venues: VenueFixture[]): Promise<void> {
  await resetEmulator();
  await seedCatalogue();
  for (const v of venues) await setupVenue(v);
  await setLaunch({ [V.tenant]: 'test' });
  await setClock(nextTuesday1240());
}

/** A connect a few minutes later (one connect per guest per minute is one event). */
async function later(): Promise<void> {
  await advance(10 * MINUTE_MS);
}

async function contactOf(guestId: string): Promise<AnyDoc> {
  const id = await contactIdFor(V.tenant, guestId);
  return { ...((await db.collection(COL.contacts).doc(id).get()).data() as AnyDoc), id };
}

/** state per channel at one venue: granted / revoked / none (as the gate reads it). */
async function statesAt(guestId: string, venue: VenueFixture): Promise<string[]> {
  const c = await contactOf(guestId);
  return CHANNELS.map((ch) => consentState(c.marketingConsent?.[`venue:${venue.venueId}`]?.[ch]));
}

async function ledgerOf(guestId: string): Promise<AnyDoc[]> {
  const c = await contactOf(guestId);
  return (await docsWhere(COL.consentEvents, 'contactId', c.id)).sort((a, b) => a.occurredAt.toMillis() - b.occurredAt.toMillis());
}

const PHONE = { phone: '791234561', phoneCountryCode: '+41', phoneVerified: true };

async function main() {
  console.log('\nSplash "I don\'t want to stay in touch" takes back a yes (emulator)');

  await test('an explicit no revokes every channel at the venue; a later Accept gives the yes back', async () => {
    await freshVenues(V);
    const anna = await connect({ venue: V, firstName: 'Anna', email: 'anna@no.test', ...PHONE, consent: true, consentAsked: true });
    await runDue();
    assertEqual(await statesAt(anna, V), ['granted', 'granted', 'granted'], 'yes on all three');

    await later();
    // This time she only typed her email, and tapped "I don't want to stay in touch".
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@no.test', consent: false, consentAsked: true });
    await runDue();
    assertEqual(await statesAt(anna, V), ['revoked', 'revoked', 'revoked'], 'every channel taken back, the phone ones too');
    const c = await contactOf(anna);
    const email = c.marketingConsent[`venue:${V.venueId}`].email;
    assertEqual([email.source, email.revokedVia, email.ownerStopped ?? null], ['splash', 'splash', null], 'a splash revoke, not sticky');
    const revokes = (await ledgerOf(anna)).filter((e) => e.action === 'revoke');
    assertEqual(revokes.map((e) => [e.channel, e.source, e.sourceRef?.kind]).sort(), [['email', 'splash', 'splash_no'], ['sms', 'splash', 'splash_no'], ['whatsapp', 'splash', 'splash_no']], 'three ledger rows');

    await later();
    await connect({ venue: V, guestId: anna, firstName: 'Anna', email: 'anna@no.test', ...PHONE, consent: true, consentAsked: true });
    await runDue();
    assertEqual(await statesAt(anna, V), ['granted', 'granted', 'granted'], 'Accept gives it back');
  });

  await test('a hidden consent step takes nothing back; with no yes there is nothing to take back', async () => {
    await freshVenues(V);
    const ben = await connect({ venue: V, firstName: 'Ben', email: 'ben@no.test', consent: true, consentAsked: true });
    await runDue();
    const before = (await ledgerOf(ben)).length;
    await later();
    // The venue hides the consent step: the portal sends no, but the guest was never asked.
    await connect({ venue: V, guestId: ben, firstName: 'Ben', email: 'ben@no.test', consent: false, consentAsked: false });
    await runDue();
    assertEqual((await statesAt(ben, V))[0], 'granted', 'still a yes');
    assertEqual((await ledgerOf(ben)).length, before, 'no ledger row');

    const dan = await connect({ venue: V, firstName: 'Dan', email: 'dan@no.test', consent: false, consentAsked: true });
    await runDue();
    assertEqual(await statesAt(dan, V), ['none', 'none', 'none'], 'no answer stays no answer');
    assertEqual((await ledgerOf(dan)).length, 0, 'nothing written');
  });

  await test('a STOP stays a STOP: the no takes back the rest, and Accept never reopens SMS', async () => {
    await freshVenues(V);
    const cleo = await connect({ venue: V, firstName: 'Cleo', email: 'cleo@no.test', ...PHONE, consent: true, consentAsked: true });
    await runDue();
    const c0 = await contactOf(cleo);
    await applyPhoneStop(c0.phonePointId, 'sms_keyword', now());
    await later();
    await connect({ venue: V, guestId: cleo, firstName: 'Cleo', email: 'cleo@no.test', ...PHONE, consent: false, consentAsked: true });
    await runDue();
    const sms = (await contactOf(cleo)).marketingConsent[`venue:${V.venueId}`].sms;
    assertEqual([sms.state, sms.revokedVia, sms.source], ['revoked', 'channel', 'sms_keyword'], 'the STOP is kept as it was');
    assertEqual(await statesAt(cleo, V), ['revoked', 'revoked', 'revoked'], 'email and WhatsApp taken back');

    await later();
    await connect({ venue: V, guestId: cleo, firstName: 'Cleo', email: 'cleo@no.test', ...PHONE, consent: true, consentAsked: true });
    await runDue();
    assertEqual(await statesAt(cleo, V), ['granted', 'revoked', 'granted'], 'Accept gives back email and WhatsApp, never SMS (only START does)');
  });

  await test('only that venue: the yes at the owner\'s other venue stays', async () => {
    await freshVenues(V, V2);
    const eli = await connect({ venue: V, firstName: 'Eli', email: 'eli@no.test', consent: true, consentAsked: true });
    await runDue();
    await later();
    // Her own guest record at the other venue's access point; the same contact by her email.
    await connect({ venue: V2, firstName: 'Eli', email: 'eli@no.test', consent: true, consentAsked: true });
    await runDue();
    await later();
    await connect({ venue: V, guestId: eli, firstName: 'Eli', email: 'eli@no.test', consent: false, consentAsked: true });
    await runDue();
    assertEqual([(await statesAt(eli, V))[0], (await statesAt(eli, V2))[0]], ['revoked', 'granted'], 'no here, yes there');
  });

  await test("a yes the owner's stop holds is taken back: Resume doesn't give it back, a later Accept does", async () => {
    await freshVenues(V);
    const eva = await connect({ venue: V, firstName: 'Eva', email: 'eva@no.test', consent: true, consentAsked: true });
    await runDue();
    const contactId = (await contactOf(eva)).id;
    await setGuestMarketing(V.tenant, V.venueId, contactId, { action: 'stop', scope: 'venue' }, OWNER);
    let email = (await contactOf(eva)).marketingConsent[`venue:${V.venueId}`].email;
    assertEqual([email.revokedVia, email.ownerPrior], ['owner', 'granted'], 'the owner holds her yes');

    await later();
    await connect({ venue: V, guestId: eva, firstName: 'Eva', email: 'eva@no.test', consent: false, consentAsked: true });
    await runDue();
    email = (await contactOf(eva)).marketingConsent[`venue:${V.venueId}`].email;
    assertEqual([email.state, email.revokedVia, email.ownerStopped, email.ownerPrior, email.source], ['revoked', 'owner', true, 'none', 'splash'], 'still the owner\'s stop, no yes behind it');

    await setGuestMarketing(V.tenant, V.venueId, contactId, { action: 'resume', scope: 'venue' }, OWNER);
    assertEqual((await statesAt(eva, V))[0], 'none', 'Resume gives back nothing: she said no');

    await later();
    await connect({ venue: V, guestId: eva, firstName: 'Eva', email: 'eva@no.test', consent: true, consentAsked: true });
    await runDue();
    assertEqual((await statesAt(eva, V))[0], 'granted', 'her next Accept is a yes again');
  });

  await test('a welcome already planned is not sent once the guest says no', async () => {
    await freshVenues(V);
    const finn = await connect({ venue: V, firstName: 'Finn', email: 'finn@no.test', consent: true, consentAsked: true });
    await runDue(); // the welcome waits 15 min
    await advance(5 * MINUTE_MS);
    await connect({ venue: V, guestId: finn, firstName: 'Finn', email: 'finn@no.test', consent: false, consentAsked: true });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const contactId = (await contactOf(finn)).id;
    const welcome = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === 'welcome_second_visit');
    assert(welcome, 'the welcome journey had started');
    const sends = await docsWhere(COL.journeySends, 'instanceId', welcome.id);
    assertEqual(sends.length, 0, 'no welcome message');
    const skipped = (await docsWhere(COL.journeyEvents, 'instanceId', welcome.id)).filter((e) => e.type === 'send.skipped').map((e) => e.data?.decision?.reason);
    assertEqual(skipped, ['no_consent'], 'skipped: no yes any more');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
