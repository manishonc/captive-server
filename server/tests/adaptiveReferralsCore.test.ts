/**
 * Bring-a-friend rules (PR A7, core/referrals.ts): the code's shape, what a guest typed, and
 * whether a friend's sign-up counts.
 *
 * Run: npx tsx tests/adaptiveReferralsCore.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import {
  CODE_ALPHABET,
  REFERRAL_MAX_FRIENDS,
  checkCodeForVenue,
  codeNamePart,
  decideReferral,
  friendOfferOf,
  makeReferralCode,
  normalizeFriendCode,
  type ReferralCodeFacts,
} from '../src/adaptive/core/referrals';
import { buildSeedPlan } from '../src/adaptive/seed/buildSeed';
import { journeyDefinitionSchema } from '../src/adaptive/core/schemas';
import { SEED } from '../src/adaptive/seed/definitions';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('\nBring a friend — codes');

test('the name part: letters of the first name, accents dropped, at most 8; else FRIEND', () => {
  eq(codeNamePart('Mia'), 'MIA', 'Mia');
  eq(codeNamePart('Zoë-Lou'), 'ZOELOU', 'accents and dashes');
  eq(codeNamePart('Maximiliane'), 'MAXIMILI', 'at most 8');
  eq(codeNamePart('J'), 'FRIEND', 'one letter is too short');
  eq(codeNamePart(null), 'FRIEND', 'no name');
  eq(codeNamePart('李'), 'FRIEND', 'no Latin letters');
});

test('a code: name, dash, 4 characters nobody misreads', () => {
  let i = 0;
  const seq = [0, 0.5, 0.99, 0.1];
  const code = makeReferralCode('Mia', () => seq[i++ % seq.length]);
  ok(/^MIA-[A-Z0-9]{4}$/.test(code), `shape: ${code}`);
  for (const ch of code.slice(4)) ok(CODE_ALPHABET.includes(ch), `${ch} is in the alphabet`);
  for (const bad of ['0', 'O', '1', 'I', 'L']) ok(!CODE_ALPHABET.includes(bad), `${bad} is never used`);
});

test('what a guest typed: case, spaces and a missing dash are fine; junk is null', () => {
  eq(normalizeFriendCode('mia-7k2q'), 'MIA-7K2Q', 'lower case');
  eq(normalizeFriendCode(' MIA 7K2Q '), 'MIA-7K2Q', 'a space for the dash');
  eq(normalizeFriendCode('mia7k2q'), 'MIA-7K2Q', 'no dash');
  eq(normalizeFriendCode('zoë-ab12'), 'ZOE-AB12', 'an accent');
  for (const bad of ['', '  ', 'M-7K2Q', 'MIA-7K2', 'MIA--7K2Q', 'ABCDEFGHI-7K2Q', 42, null, undefined]) eq(normalizeFriendCode(bad), null, JSON.stringify(bad) ?? String(bad));
});

console.log('\nBring a friend — who counts');

const NOW = Date.UTC(2026, 9, 10, 12, 0);
const code = (over: Partial<ReferralCodeFacts> = {}): ReferralCodeFacts => ({
  venueId: 'v1',
  contactId: 'regular',
  expiresAt: NOW + 10 * 86_400_000,
  friendsCredited: 0,
  maxFriends: REFERRAL_MAX_FRIENDS,
  friendContactIds: [],
  ...over,
});

test('on the splash: a known code of this venue, not expired, with room left', () => {
  eq(checkCodeForVenue(code(), 'v1', NOW), 'ok', 'ok');
  eq(checkCodeForVenue(null, 'v1', NOW), 'unknown', 'unknown');
  eq(checkCodeForVenue(code(), 'v2', NOW), 'other_venue', 'another venue');
  eq(checkCodeForVenue(code({ expiresAt: NOW }), 'v1', NOW), 'expired', 'expired at the second');
  eq(checkCodeForVenue(code({ friendsCredited: 3 }), 'v1', NOW), 'full', 'three friends already');
});

test('when it counts: a new guest here, not the regular, once per friend, the first 3', () => {
  const friend = { venueId: 'v1', contactId: 'ben', isFirstVisit: true, at: NOW };
  eq(decideReferral(code(), friend), 'ok', 'a new friend counts');
  eq(decideReferral(code(), { ...friend, contactId: 'regular' }), 'own_code', 'the regular themself');
  eq(decideReferral(code({ friendContactIds: ['ben'] }), friend), 'already_counted', 'the same friend twice');
  eq(decideReferral(code(), { ...friend, isFirstVisit: false }), 'not_new', 'someone who had been here');
  eq(decideReferral(code({ friendsCredited: 3, friendContactIds: ['a', 'b', 'c'] }), friend), 'full', 'a 4th friend');
  eq(decideReferral(code(), { ...friend, venueId: 'v2' }), 'other_venue', 'at another venue');
  eq(decideReferral(null, friend), 'unknown', 'no such code');
});

test("the friend's offer comes from the invite's blank and the playbook's menu", () => {
  const offers = [{ offerKey: 'ten_pct', name: '10% off', label: { en: '10% off your next visit', de: '10% Rabatt' }, kind: 'percent' as const, value: 10, expiryDays: 14 }];
  eq(friendOfferOf('ten_pct', offers), { offerKey: 'ten_pct', label: offers[0].label, kind: 'percent', value: 10 }, 'found');
  eq(friendOfferOf('dessert', offers), null, 'not on the menu');
  eq(friendOfferOf(undefined, offers), null, 'no blank');
});

console.log('\nBring a friend — seed');

test('two new journeys; Restaurant growth v4 pins them; the reward queues up to 3', () => {
  const plan = buildSeedPlan(new Date('2026-10-10T00:00:00Z'));
  eq(plan.problems, [], 'no problems');
  const v4 = plan.versions.find((v) => v.key === 'restaurant_growth' && v.version === 4);
  ok(v4, 'Restaurant growth v4 is published');
  ok(v4!.pins!.some((p) => p.journeyKey === 'bring_a_friend' && p.templateVersion === 1), 'pins Bring a friend');
  ok(v4!.pins!.some((p) => p.journeyKey === 'friend_reward' && p.templateVersion === 1), 'pins the Friend reward');
  ok(!plan.versions.some((v) => v.key === 'local_business' && v.version === 4), 'Local business stays at v3');
  const reward = journeyDefinitionSchema.parse(SEED.journeys.find((j) => j.header.key === 'friend_reward')!.definition);
  eq(reward.entry.reentry, { mode: 'after_exit', queue: 3 }, 'one reward per friend, up to 3 waiting');
  eq(reward.entry.trigger, { type: 'event', config: { type: 'referral.joined' } }, 'started by a friend joining');
  const invite = journeyDefinitionSchema.parse(SEED.journeys.find((j) => j.header.key === 'bring_a_friend')!.definition);
  eq(invite.entry.trigger, { type: 'visit.started', config: { visitNumber: { eq: 3 } } }, 'the 3rd visit ("after 2nd revisit")');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
