/**
 * PR E server follow-ups on the emulator, through the real router (decisions E-D6, E-D10):
 *
 *  - The German guest timeline names an issued offer in German, from the venue's offer menu (the
 *    owner's guest drawer and HeidiFi's guest view); English keeps the label the event stored.
 *    When reading the labels fails, both views still answer, with the stored label.
 *  - Account names from `display_name` (what cms owner docs have) on the admin launch card and in
 *    guest search; `displayName` still comes first.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server)
 */

import {
  COL,
  advance,
  assert,
  assertEqual,
  connect,
  contactIdFor,
  db,
  docsWhere,
  done,
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
import { ADMIN_ACTOR, mountApi } from './ownerApiHelpers';
import { venuePlaybookId } from '../../src/adaptive/store/collections';
import { MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const P: VenueFixture = { tenant: 'tenant_fu', venueId: 'venue_fu', apId: 'ap_fu', apMac: 'aa:ee:ee:ee:ee:01' };

async function main() {
  const api = await mountApi();
  try {
    console.log('\nGerman offer names in the timeline\n');

    let contactId = '';
    await test('an issued offer: German in the German timeline (owner and admin), the stored English label in English', async () => {
      await resetEmulator();
      await seedCatalogue();
      await setupVenue(P);
      await setClock(nextTuesday1240());
      await seedWallet(P.tenant, 5000);
      await setLaunch({ [P.tenant]: 'live' }, { paused: false });
      const guestId = await connect({ venue: P, firstName: 'Lena', email: 'lena.fu@test.local', consent: true });
      await runDue();
      await advance(15 * MINUTE_MS);
      await runDue();
      contactId = await contactIdFor(P.tenant, guestId);

      const issued = (await docsWhere(COL.journeyEvents, 'contactId', contactId)).find((e) => e.type === 'offer.issued');
      assert(issued, 'the welcome issued an offer');
      const setup = (await db.collection(COL.venuePlaybooks).doc(venuePlaybookId(P.venueId, 'restaurant_growth')).get()).data()!;
      const label = (setup.offerMenu as Array<{ offerKey: string; label: { en: string; de?: string } }>).find((o) => o.offerKey === issued.data.offerKey)!.label;
      assert(label.de && label.de !== issued.data.label, `a German label that differs from the stored one: ${JSON.stringify(label)} / ${issued.data.label}`);
      assertEqual(issued.data.label, label.en, 'the event stores the English label');

      const sentence = async (path: string) => {
        const res = await api.get(path);
        assertEqual(res.status, 200, `GET ${path}: ${res.text.slice(0, 200)}`);
        const item = (res.body.timeline as Array<{ kind: string; sentence: string }>).find((i) => i.kind === 'offer.issued');
        assert(item, `an offer line in ${path}`);
        return item.sentence;
      };
      const owner = `/tenants/${P.tenant}/venues/${P.venueId}/guests/${contactId}`;
      assert((await sentence(`${owner}?lang=de`)).includes(`„${label.de}“`), 'owner, German: the German label');
      assert((await sentence(`${owner}?lang=en`)).includes(`“${label.en}”`), 'owner, English: the stored label');
      assert((await sentence(`/admin/guests/${contactId}?lang=de`)).includes(`„${label.de}“`), 'admin, German: the German label');
      assert((await sentence(`/admin/guests/${contactId}?lang=en`)).includes(`“${label.en}”`), 'admin, English: the stored label');
    });

    await test('a failing German-label read never fails the guest view: the stored label, only the error name logged', async () => {
      assert(contactId, 'runs after the timeline test');
      const issued = (await docsWhere(COL.journeyEvents, 'contactId', contactId)).find((e) => e.type === 'offer.issued')!;
      // A hand-edited setup whose offer menu isn't a list: reading the labels throws (TypeError).
      const odd = db.collection(COL.venuePlaybooks).doc(venuePlaybookId(P.venueId, 'zz_odd_setup'));
      await odd.set({ tenantUserId: P.tenant, venueId: P.venueId, playbookKey: 'zz_odd_setup', state: 'draft', offerMenu: { dessert: 'not a list' } });
      const logged: unknown[][] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        for (const path of [`/tenants/${P.tenant}/venues/${P.venueId}/guests/${contactId}?lang=de`, `/admin/guests/${contactId}?lang=de`]) {
          const res = await api.get(path);
          assertEqual(res.status, 200, `GET ${path}: ${res.text.slice(0, 200)}`);
          const item = (res.body.timeline as Array<{ kind: string; sentence: string }>).find((i) => i.kind === 'offer.issued');
          assert(item?.sentence.includes(`„${issued.data.label}“`), `${path}: the stored label in the German sentence: ${item?.sentence}`);
        }
      } finally {
        console.error = consoleError;
        await odd.delete();
      }
      const lines = logged.filter((args) => String(args[0]).includes('German offer labels'));
      assertEqual(lines.map((args) => args.slice(1)), [['TypeError'], ['TypeError']], 'logged once per view, only the error name');
    });

    console.log('\nAccount names\n');

    await test('display_name names the account on the launch card and in guest search; displayName still wins', async () => {
      assert(contactId, 'runs after the timeline test');
      await db.collection(COL.tenantUsers).doc(P.tenant).set({ display_name: 'Pia Owner' }, { merge: true });
      let card = await api.get('/admin/launch');
      assertEqual(card.status, 200, 'GET /admin/launch');
      assertEqual(card.body.accountNames[P.tenant], { name: 'Pia Owner', email: `${P.tenant}@test.local` }, `on the card: ${JSON.stringify(card.body.accountNames)}`);
      const found = await api.call('POST', '/admin/guests/search', { email: 'lena.fu@test.local', actor: ADMIN_ACTOR });
      assertEqual(found.status, 200, 'search');
      assertEqual(found.body.results.map((r: any) => r.account), [{ name: 'Pia Owner', email: `${P.tenant}@test.local` }], 'in guest search');

      await db.collection(COL.tenantUsers).doc(P.tenant).set({ displayName: 'Staff Name' }, { merge: true });
      card = await api.get('/admin/launch');
      assertEqual(card.body.accountNames[P.tenant].name, 'Staff Name', 'displayName first, as before');
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
