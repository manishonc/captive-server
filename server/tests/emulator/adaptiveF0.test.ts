/**
 * PR F0 on the emulator: the seed upgrade step, the spacing rule on the live send path, and
 * the German welcome SMS priced as GSM-7.
 *
 * Run: bash tests/emulator/run.sh   (from captive-server/server; runs every emulator test)
 *
 *  - **Seed upgrade:** a welcome A doc still holding the PR 1 text is rewritten to today's
 *    text (hash, `seedUpgrades`, the old text in `history/`); a hand-edited welcome B is left
 *    alone; a second boot changes nothing.
 *  - **Spacing:** a guest who got a marketing SMS from another owner's venue 30 minutes ago
 *    gets this venue's welcome only 4 h (+ up to 20 min) after that one, with the "why" in the
 *    record; then it goes.
 *  - **GSM-7:** the German welcome SMS goes as 2 parts (30 credits), not 4 (60), without 🎁.
 *  - **Phase 1 re-reads the spacing:** another place's message recorded between the first
 *    look and the claim still holds the send (two sends to one person at the same moment).
 *  - **A hold that moves is recorded again:** when another message goes during the hold, the
 *    next look holds it anew and writes a second `send.deferred` with the new time.
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
  outbox,
  resetEmulator,
  runDue,
  seedCatalogue,
  seedWallet,
  setClock,
  setLaunch,
  setupVenue,
  test,
  withoutReviewAsk,
  type AnyDoc,
  type VenueFixture,
} from './helpers';
import { ensureAdaptiveSeed } from '../../src/adaptive/seed/ensureSeed';
import { buildSeedPlan, variantId } from '../../src/adaptive/seed/buildSeed';
import { WORDING_UPGRADES, wordingHash } from '../../src/adaptive/seed/wordingUpgrades';
import { invalidateCatalogue } from '../../src/adaptive/service/catalogue';
import { sendKeyFor } from '../../src/adaptive/core/runtime/ids';
import { __sendTestHooks } from '../../src/adaptive/engine/sendPath';
import { HOUR_MS, MINUTE_MS } from '../../src/adaptive/core/runtime/time';

const A: VenueFixture = { tenant: 'tenant_f0a', venueId: 'venue_f0a', apId: 'ap_f0a', apMac: 'aa:aa:aa:aa:f0:0a' };
const B: VenueFixture = { tenant: 'tenant_f0b', venueId: 'venue_f0b', apId: 'ap_f0b', apMac: 'aa:aa:aa:aa:f0:0b' };

const HI_EN = 'Hi {{contact.firstName | default:"there"}}';
const HI_DE = 'Hallo {{contact.firstName | default:"du"}}';

function seedDoc(pool: string, letter: string): Record<string, any> {
  const id = variantId(pool, letter);
  const doc = buildSeedPlan().units.flatMap((u) => u.docs).find((d) => d.path[0] === COL.variants && d.path[1] === id);
  if (!doc) throw new Error(`no seed doc ${pool}/${letter}`);
  return JSON.parse(JSON.stringify(doc.data));
}

async function welcomeSend(venue: VenueFixture, guestId: string): Promise<{ inst: AnyDoc; send: AnyDoc | null }> {
  const contactId = await contactIdFor(venue.tenant, guestId);
  const inst = (await docsWhere(COL.journeyInstances, 'contactId', contactId)).find((i) => i.journeyKey === 'welcome_second_visit');
  if (!inst) throw new Error(`no welcome journey at ${venue.venueId}`);
  const key = sendKeyFor(inst.id, 's1');
  const snap = await db.collection(COL.journeySends).doc(key).get();
  return { inst, send: snap.exists ? { ...(snap.data() as Record<string, any>), id: key } : null };
}

async function main() {
  console.log('\nPR F0 (emulator)');

  await test('seed upgrade: an old seed text is rewritten, a hand edit is kept, a second boot does nothing', async () => {
    await resetEmulator();
    const a = seedDoc('welcome_offer', 'A');
    const target = a.contentHash;
    // Welcome A as the PR 1 seed wrote it.
    a.channels.sms.text = `${HI_EN}, thanks for visiting {{venue.name}}! Come back within {{offer.days}} days for {{offer.label}} 🎁 {{link.offer}}`;
    a.channels.email.body = `${HI_EN},\n\nthanks for stopping by {{venue.name}}! Come back within {{offer.days}} days and enjoy {{offer.label}} on us.\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`;
    a.locales.de.sms.text = `${HI_DE}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich 🎁 {{link.offer}}`;
    a.locales.de.email.body = `${HI_DE},\n\ndanke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich, aufs Haus.\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`;
    const oldHash = wordingHash(a);
    assert(WORDING_UPGRADES.some((u) => u.replaces.includes(oldHash)), 'this is a listed earlier text');
    a.contentHash = oldHash;
    // Welcome B edited by hand in the console (the hash field left stale, as a console edit does).
    const b = seedDoc('welcome_offer', 'B');
    b.channels.sms.text = 'Our own words: {{offer.label}} at {{venue.name}} {{link.offer}}';
    await db.collection(COL.variants).doc(variantId('welcome_offer', 'A')).set(a);
    await db.collection(COL.variants).doc(variantId('welcome_offer', 'B')).set(b);

    const r = await ensureAdaptiveSeed();
    assertEqual(r.problems, [], 'no problems');
    assertEqual(r.failed, [], 'nothing failed');
    assert((r.upgraded ?? []).some((l) => l.includes('welcome_offer/A')), `A upgraded: ${JSON.stringify(r.upgraded)}`);
    assert((r.keptEdited ?? []).some((l) => l.includes('welcome_offer/B')), `B kept: ${JSON.stringify(r.keptEdited)}`);

    const storedA = (await db.collection(COL.variants).doc(variantId('welcome_offer', 'A')).get()).data()!;
    assertEqual([wordingHash(storedA), storedA.contentHash], [target, target], "today's text and hash");
    assertEqual(storedA.seedUpgrades, ['f0-gsm7-welcome-a'], 'the upgrade is recorded');
    assert(!String(storedA.channels.sms.text).includes('🎁') && String(storedA.channels.email.body).includes('🎁'), 'emoji only in the email now');
    const history = await db.collection(COL.variants).doc(variantId('welcome_offer', 'A')).collection('history').get();
    assertEqual(history.docs.map((d) => [d.get('contentHash'), d.get('replacedBy')]), [[oldHash, 'f0-gsm7-welcome-a']], 'the old text kept');
    const storedB = (await db.collection(COL.variants).doc(variantId('welcome_offer', 'B')).get()).data()!;
    assertEqual(storedB.channels.sms.text, 'Our own words: {{offer.label}} at {{venue.name}} {{link.offer}}', 'the hand edit is untouched');

    const again = await ensureAdaptiveSeed();
    assertEqual([again.upgraded, again.created.length], [[], 0], 'the second boot changes nothing');

    // Someone puts the old text back on purpose (e.g. copied from history/): the next boot leaves it.
    await db.collection(COL.variants).doc(variantId('welcome_offer', 'A')).update({ channels: a.channels, locales: a.locales, contentHash: oldHash });
    const third = await ensureAdaptiveSeed();
    assert((third.keptEdited ?? []).some((l) => l.includes('welcome_offer/A')) && !(third.upgraded ?? []).length, `kept: ${JSON.stringify(third)}`);
    const putBack = (await db.collection(COL.variants).doc(variantId('welcome_offer', 'A')).get()).data()!;
    assertEqual(wordingHash(putBack), oldHash, 'the old text stays');
    invalidateCatalogue();
  });

  await test('spacing: a welcome 30 min after another owner’s SMS waits 4 h after it, then goes', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(A);
    await setupVenue(B);
    await withoutReviewAsk(A);
    await withoutReviewAsk(B);
    const t0 = nextTuesday1240();
    await setClock(t0);
    await seedWallet(A.tenant, 5000);
    await seedWallet(B.tenant, 5000);
    await setLaunch({ [A.tenant]: 'live', [B.tenant]: 'live' }, { paused: false });

    const guest = { firstName: 'Lea', email: null, phone: '791234599', phoneCountryCode: '+41', phoneVerified: true, consent: true, language: 'de' };
    // At B first: its welcome SMS goes 15 minutes later.
    const atB = await connect({ ...guest, venue: B });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const b1 = (await welcomeSend(B, atB)).send;
    assert(b1 && b1.status === 'sent', `B's welcome went: ${b1?.status}`);
    const bSentAt = b1.createdAt.toMillis();

    // Then at A, 30 minutes later: A's welcome is due 15 minutes after that — too close.
    await advance(15 * MINUTE_MS);
    const atA = await connect({ ...guest, venue: A });
    await runDue();
    await advance(15 * MINUTE_MS);
    await runDue();
    const held = await welcomeSend(A, atA);
    assertEqual(held.send, null, 'not sent yet');
    const deferred = (await docsWhere(COL.journeyEvents, 'instanceId', held.inst.id)).filter((e) => e.type === 'send.deferred');
    assertEqual(deferred.map((e) => [e.data.decision.rule, e.data.decision.reason]), [['spacing', 'spacing']], 'held by spacing');
    const until = deferred[0].data.decision.until;
    // + up to 20 min, and up to 1 min more: the gap's end is rounded up to a whole minute.
    assert(until >= bSentAt + 4 * HOUR_MS && until <= bSentAt + 4 * HOUR_MS + 21 * MINUTE_MS, 'until = 4 h after the other SMS + up to 21 min');
    assert(String(deferred[0].data.decision.checks.find((c: any) => c.rule === 'spacing').fact).includes('gap 4 h'), 'the fact names the gap');
    assertEqual(deferred[0].data.replay.gate.spacing, { lastAt: bSentAt, minGapMs: 4 * HOUR_MS }, 'the replay input');

    await setClock(until + MINUTE_MS);
    await runDue();
    const a1 = (await welcomeSend(A, atA)).send;
    assert(a1 && a1.status === 'sent', `A's welcome went after the gap: ${a1?.status}`);
    const spacing = a1.decision.checks.find((c: any) => c.rule === 'spacing');
    assert(spacing.ok && /^last marketing message 4 h( \d+ min)? ago \(gap 4 h\)$/.test(spacing.fact), spacing.fact);
    assertEqual(a1.decision.checks.length, 11, 'eleven checks');

    // The German welcome is GSM-7 now: 2 parts, 30 credits, no emoji.
    assertEqual([a1.smsSegments, a1.credits.amount], [2, 30], '2 parts, 30 credits');
    const ob = (await outbox()).find((o) => o.id === a1.id)!;
    assert(ob && !String(ob.text ?? ob.body).includes('🎁') && !String(ob.text ?? ob.body).includes('–'), 'no 🎁, no en dash');
  });

  await test('phase 1 re-reads the spacing; a hold that moves writes a new send.deferred; then it goes', async () => {
    await resetEmulator();
    await seedCatalogue();
    await setupVenue(A);
    await withoutReviewAsk(A);
    const t0 = nextTuesday1240();
    await setClock(t0);
    await seedWallet(A.tenant, 5000);
    await setLaunch({ [A.tenant]: 'live' }, { paused: false });
    const guestId = await connect({ venue: A, firstName: 'Ria', email: null, phone: '791234588', phoneCountryCode: '+41', phoneVerified: true, consent: true, language: 'en' });
    await runDue();
    const contactId = await contactIdFor(A.tenant, guestId);
    const networkId = (await db.collection(COL.contacts).doc(contactId).get()).get('networkId') as string;
    const touch = (atMs: number, sendKey: string) => ({ at: new Date(atMs), channel: 'sms', tenantUserId: 'tenant_elsewhere', venueId: 'venue_elsewhere', sendKey });
    const npRef = db.collection(COL.networkPeople).doc(networkId);

    // The first look finds no other message; another place's SMS is recorded just before the claim.
    let otherAt = 0;
    __sendTestHooks.beforeClaim = async () => {
      otherAt = now() - MINUTE_MS;
      await npRef.set({ recentMarketingTouches: [touch(otherAt, 'js_elsewhere_1')] }, { merge: true });
    };
    try {
      await advance(15 * MINUTE_MS);
      await runDue();
    } finally {
      delete __sendTestHooks.beforeClaim;
    }
    const first = await welcomeSend(A, guestId);
    assertEqual(first.send, null, 'the claim held it: nothing sent');
    let deferred = (await docsWhere(COL.journeyEvents, 'instanceId', first.inst.id)).filter((e) => e.type === 'send.deferred');
    assertEqual(deferred.map((e) => e.data.decision.rule), ['spacing'], 'held by spacing (in phase 1)');
    assertEqual(deferred[0].data.replay.gate.spacing.lastAt, otherAt, "the claim's own input is the replay input");
    const until1 = deferred[0].data.decision.until as number;
    assert(until1 >= otherAt + 4 * HOUR_MS && until1 % MINUTE_MS === 0, 'until: 4 h after it, on a whole minute');

    // Another place's message goes during the hold: the next look holds it anew and says so.
    const secondAt = until1 - 30 * MINUTE_MS;
    await npRef.set({ recentMarketingTouches: [touch(otherAt, 'js_elsewhere_1'), touch(secondAt, 'js_elsewhere_2')] }, { merge: true });
    await setClock(until1 + MINUTE_MS);
    await runDue();
    assertEqual((await welcomeSend(A, guestId)).send, null, 'still held');
    deferred = (await docsWhere(COL.journeyEvents, 'instanceId', first.inst.id)).filter((e) => e.type === 'send.deferred').sort((a, b) => a.occurredAt.toMillis() - b.occurredAt.toMillis());
    assertEqual(deferred.length, 2, 'a second send.deferred for the moved hold');
    const until2 = deferred[1].data.decision.until as number;
    assert(until2 >= secondAt + 4 * HOUR_MS && until2 > until1, 'the new time: 4 h after the second message');

    // Exactly at the new time, as the engine does: both holds add the same jitter minute, so
    // until2 can be 20:59, and a minute later is quiet hours.
    await setClock(until2);
    await runDue();
    const sent = (await welcomeSend(A, guestId)).send;
    assert(sent && sent.status === 'sent', `then it goes: ${sent?.status}`);
    const np = (await npRef.get()).data()!;
    assertEqual(np.recentMarketingTouches.map((t: any) => t.sendKey).sort(), ['js_elsewhere_1', 'js_elsewhere_2', sent.id].sort(), 'its own touch added once');
  });

  done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
