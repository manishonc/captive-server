/**
 * Tests for adaptive/core/validateSetup — what an owner may save and turn on.
 *
 * Run: npx tsx tests/adaptiveSetupRules.test.ts   (from captive-server/server)
 *
 * No Firestore. Pins the owner-side rules the prototypes left open:
 *
 *  - **Required journeys can't be switched off** and coming-soon ones can't be
 *    switched on (S02) — the owner prototype let both happen.
 *  - **Blanks the owner didn't send keep the venue's current value** (or the
 *    playbook default for a new setup), so a partial form or an MCP client
 *    can't wipe the offer.
 *  - **Slot values are checked against their bounds and the offer menu** (S03).
 *  - **Venues must belong to the tenant and fit the playbook** (S01).
 *  - **Turn on needs a real IANA time zone, an active account and an
 *    acknowledged overlap** (F01–F03); WhatsApp and the stay calendar are notes.
 */

import {
  isValidTimeZone,
  preflightTurnOn,
  resolveSetupJourneys,
  validateSetup,
  type SetupPlaybook,
  type SetupTemplate,
  type SetupVenue,
} from '../src/adaptive/core/validateSetup';
import { journeyDefinitionSchema, journeyTemplateHeaderSchema, playbookContentSchema } from '../src/adaptive/core/schemas';
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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const TENANT = 'tenant1';

function playbook(key = 'restaurant_growth'): SetupPlaybook {
  const seed = SEED.playbooks.find((p) => p.key === key)!;
  const content = playbookContentSchema.parse(JSON.parse(JSON.stringify(seed.content)));
  return { key, kind: content.kind, status: 'published', publishedVersion: 1, content };
}

function templates(): Map<string, SetupTemplate> {
  return new Map(
    SEED.journeys.map((j) => [
      j.header.key,
      { header: journeyTemplateHeaderSchema.parse(j.header), version: 1, definition: journeyDefinitionSchema.parse(j.definition) },
    ]),
  );
}

const venues = new Map<string, SetupVenue | null>([
  ['v1', { venueId: 'v1', tenantUserId: TENANT, venueType: 'restaurant', name: 'Madras Jungle' }],
  ['v2', { venueId: 'v2', tenantUserId: TENANT, venueType: 'airbnb', name: 'Retreat' }],
  ['v3', { venueId: 'v3', tenantUserId: 'someone_else', venueType: 'restaurant', name: 'Not yours' }],
]);

function run(journeys: Record<string, any>, venueIds = ['v1'], pb = playbook()) {
  const result = validateSetup({ tenantUserId: TENANT, venueIds, journeys, playbook: pb, templates: templates(), venues });
  return { ...result, codes: result.report.issues.filter((i) => i.severity === 'error').map((i) => i.code) };
}

test('an empty submission keeps the playbook defaults and passes', () => {
  const { report, journeys } = run({});
  assert(report.ok, JSON.stringify(report.issues));
  assert(journeys.welcome_second_visit.enabled && journeys.review_ask.enabled, 'welcome + review on');
  assert(journeys.welcome_second_visit.slots.offer === 'dessert', 'default offer kept');
  assert(journeys.welcome_second_visit.slots.offer_days === 14, 'default days kept');
  assert(!journeys.win_back.enabled, 'coming soon stays off');
});

test('a blank the owner did not send keeps its default', () => {
  const { journeys } = run({ welcome_second_visit: { enabled: true, slots: { offer_days: 21 } } });
  assert(journeys.welcome_second_visit.slots.offer === 'dessert', 'offer kept');
  assert(journeys.welcome_second_visit.slots.offer_days === 21, 'days changed');
});

test('a later partial save keeps the venue’s current values, not the playbook defaults', () => {
  const pb = playbook();
  const base = {
    welcome_second_visit: { enabled: true, slots: { offer: 'coffee', offer_days: 21 } },
    review_ask: { enabled: false, slots: { staff_name: 'Priya' } },
  };
  const { journeys, issues } = resolveSetupJourneys({ review_ask: { enabled: true, slots: {} } }, pb, templates(), base);
  assert(issues.filter((i) => i.severity === 'error').length === 0, JSON.stringify(issues));
  assert(journeys.welcome_second_visit.slots.offer === 'coffee' && journeys.welcome_second_visit.slots.offer_days === 21, 'welcome kept');
  assert(journeys.review_ask.enabled && journeys.review_ask.slots.staff_name === 'Priya', 'staff name kept');
});

test('a stored value that breaks a rule is corrected, not reported', () => {
  const { journeys, issues } = resolveSetupJourneys({}, playbook(), templates(), {
    welcome_second_visit: { enabled: false, slots: {} },
    win_back: { enabled: true, slots: {} },
  });
  assert(issues.filter((i) => i.severity === 'error').length === 0, JSON.stringify(issues));
  assert(journeys.welcome_second_visit.enabled, 'required stays on');
  assert(!journeys.win_back.enabled, 'coming soon stays off');
});

test('S02: switching off a required journey is an error', () => {
  const { codes } = run({ welcome_second_visit: { enabled: false, slots: {} } });
  assert(codes.includes('S02'), `S02 expected, got ${codes}`);
});

test('S02: switching on a coming-soon journey is an error', () => {
  const { codes } = run({ win_back: { enabled: true, slots: {} } });
  assert(codes.includes('S02'), `S02 expected, got ${codes}`);
});

test('S02: a journey that is not in the playbook is an error', () => {
  const { codes } = run({ stay_guide: { enabled: true, slots: {} } });
  assert(codes.includes('S02'), `S02 expected, got ${codes}`);
});

test('S03: an offer outside the menu, days out of bounds or an unknown blank are errors', () => {
  assert(run({ welcome_second_visit: { enabled: true, slots: { offer: 'pizza' } } }).codes.includes('S03'), 'offer');
  assert(run({ welcome_second_visit: { enabled: true, slots: { offer_days: 0 } } }).codes.includes('S03'), 'days');
  assert(run({ welcome_second_visit: { enabled: true, slots: { colour: 'red' } } }).codes.includes('S03'), 'unknown blank');
  assert(run({ review_ask: { enabled: true, slots: { staff_name: 'x'.repeat(41) } } }).codes.includes('S03'), 'too long');
});

test('S03: blanks of a switched-off journey are not checked', () => {
  const { report } = run({ review_ask: { enabled: false, slots: { staff_name: 'x'.repeat(41) } } });
  assert(report.ok, JSON.stringify(report.issues));
});

test('S01: another tenant’s venue, or a venue type that does not fit, is an error', () => {
  assert(run({}, ['v3']).codes.includes('S01'), 'not yours');
  assert(run({}, ['v2']).codes.includes('S01'), 'airbnb in restaurant playbook');
  assert(run({}, ['missing']).codes.includes('S01'), 'missing');
});

test('S04: a hidden or never-published playbook, or the Guest info pack, cannot be set up here', () => {
  const hidden = { ...playbook(), status: 'deprecated' as const };
  assert(run({}, ['v1'], hidden).codes.includes('S04'), 'deprecated');
  const gi = playbook('guest_info');
  assert(run({}, ['v1'], gi).codes.includes('S04'), 'utility');
  // Hidden means "no new setups": venues already running it can still edit it.
  const editing = validateSetup({ tenantUserId: TENANT, venueIds: ['v1'], journeys: {}, playbook: hidden, templates: templates(), venues, existingSetups: true });
  assert(editing.report.ok, `editing a hidden playbook: ${JSON.stringify(editing.report.issues)}`);
});

test('time zones are checked against IANA names', () => {
  assert(isValidTimeZone('Europe/Zurich'), 'Europe/Zurich');
  assert(!isValidTimeZone('Mars/Olympus'), 'Mars/Olympus');
  assert(!isValidTimeZone(''), 'empty');
  assert(!isValidTimeZone(null), 'null');
});

test('F01–F03: time zone, lapsed account and unacknowledged overlap block turn-on', () => {
  const issues = preflightTurnOn(
    [
      { venueId: 'a', name: 'A', timezone: null, lapsed: false, overlap: { legacyOnConnectChannels: [], automations: [] }, overlapAcknowledged: false },
      { venueId: 'b', name: 'B', timezone: 'Europe/Zurich', lapsed: true, overlap: { legacyOnConnectChannels: [], automations: [] }, overlapAcknowledged: false },
      { venueId: 'c', name: 'C', timezone: 'Europe/Zurich', lapsed: false, overlap: { legacyOnConnectChannels: ['sms'], automations: [] }, overlapAcknowledged: false },
      { venueId: 'd', name: 'D', timezone: 'Europe/Zurich', lapsed: false, overlap: { legacyOnConnectChannels: ['sms'], automations: [] }, overlapAcknowledged: true },
    ],
    { enabledLadders: [['sms', 'email', 'whatsapp']], needsStayCalendar: true },
  );
  const errs = issues.filter((i) => i.severity === 'error').map((i) => `${i.code}:${i.path}`);
  assert(errs.includes('F01:venues.a.timezone'), `F01 ${errs}`);
  assert(errs.includes('F02:venues.b'), `F02 ${errs}`);
  assert(errs.includes('F03:venues.c.overlap'), `F03 ${errs}`);
  assert(!errs.some((e) => e.includes('venues.d')), `d is fine ${errs}`);
  assert(issues.some((i) => i.code === 'W01' && i.severity === 'info'), 'W01 info');
  assert(issues.some((i) => i.code === 'W02' && i.severity === 'warning'), 'W02 warning');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
