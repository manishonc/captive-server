/**
 * Tests for adaptive/core/validatePlaybook — the admin "Check" dialog and the
 * publish gate.
 *
 * Run: npx tsx tests/adaptivePlaybookRules.test.ts   (from captive-server/server)
 *
 * No Firestore. Each test starts from the seeded Restaurant growth playbook
 * (which passes) and breaks one thing, so every rule is shown to bite on its
 * own and nothing else fires:
 *
 *  - errors (P01, P02, P03, P06, P07, V04, V09, V14, K02) block publishing;
 *  - warnings (P04, P05, V07, V10) never do;
 *  - a draft can be half-finished — shape errors come back as K01, not a throw.
 */

import { validatePlaybook, type PlaybookCheckContext, type TemplateInfo } from '../src/adaptive/core/validatePlaybook';
import { journeyDefinitionSchema, journeyTemplateHeaderSchema, playbookContentSchema, type PlaybookContent } from '../src/adaptive/core/schemas';
import { buildWordingIndex } from '../src/adaptive/core/wording';
import { SEED } from '../src/adaptive/seed/definitions';
import { DEFAULT_RULES } from '../src/adaptive/core/constants';

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

function seedContext(): PlaybookCheckContext {
  const templates = new Map<string, TemplateInfo>();
  for (const j of SEED.journeys) {
    const header = journeyTemplateHeaderSchema.parse(j.header);
    templates.set(header.key, {
      header: { ...header, publishedVersion: 1 },
      versions: new Map([[1, { state: 'published' as const, definition: journeyDefinitionSchema.parse(j.definition) }]]),
    });
  }
  const wording = buildWordingIndex(SEED.variants.map((v) => ({ ...v, status: 'active', locales: v.locales ?? {} })));
  const questions = new Map(SEED.questions.map((q) => [q.key, q]));
  return { templates, wording, questions, rules: DEFAULT_RULES, publishedKind: null };
}

function restaurantGrowth(): PlaybookContent {
  const seed = SEED.playbooks.find((p) => p.key === 'restaurant_growth')!;
  return playbookContentSchema.parse(JSON.parse(JSON.stringify(seed.content)));
}

function codes(content: unknown, ctx = seedContext()) {
  const report = validatePlaybook(content, ctx);
  return {
    report,
    errors: report.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    warnings: report.issues.filter((i) => i.severity === 'warning').map((i) => i.code),
  };
}

test('the seeded Restaurant growth passes', () => {
  const { report, errors, warnings } = codes(restaurantGrowth());
  assert(report.ok, JSON.stringify(report.issues));
  assert(errors.length === 0 && warnings.length === 0, `unexpected: ${[...errors, ...warnings]}`);
});

test('P01: an empty name is an error', () => {
  const c = restaurantGrowth();
  c.name.en = '  ';
  assert(codes(c).errors.includes('P01'), 'P01 expected');
});

test('P02: a playbook with no journeys is an error', () => {
  const c = restaurantGrowth();
  c.journeys = [];
  const { errors } = codes(c);
  assert(errors.includes('P02'), `P02 expected, got ${errors}`);
});

test('P03: required but off by default is an error', () => {
  const c = restaurantGrowth();
  c.journeys[0].required = true;
  c.journeys[0].defaultEnabled = false;
  assert(codes(c).errors.includes('P03'), 'P03 expected');
});

test('P04: pinning an older version is only a warning', () => {
  const ctx = seedContext();
  const welcome = ctx.templates.get('welcome_second_visit')!;
  welcome.versions.set(2, { ...welcome.versions.get(1)! });
  welcome.header = { ...welcome.header, publishedVersion: 2 };
  const { report, warnings } = codes(restaurantGrowth(), ctx);
  assert(report.ok && warnings.includes('P04'), `P04 warning expected, got ${warnings}`);
});

test('P06: a journey that does not exist, or an unpublished version, is an error', () => {
  const c = restaurantGrowth();
  c.journeys.push({ journeyKey: 'no_such_journey', templateVersion: 1, defaultEnabled: false, required: false, priority: 1, slotDefaults: {} });
  assert(codes(c).errors.includes('P06'), 'P06 expected for missing journey');
  const c2 = restaurantGrowth();
  c2.journeys[0].templateVersion = 9;
  assert(codes(c2).errors.includes('P06'), 'P06 expected for missing version');
});

test('P07: a coming-soon journey switched on by default is an error', () => {
  const c = restaurantGrowth();
  const winBack = c.journeys.find((j) => j.journeyKey === 'win_back')!;
  winBack.defaultEnabled = true;
  assert(codes(c).errors.includes('P07'), 'P07 expected');
});

test('V09: a venue type a journey does not support is an error; no venue types too', () => {
  const c = restaurantGrowth();
  c.venueTypes = ['restaurant', 'airbnb'];
  const { report } = codes(c);
  assert(report.issues.some((i) => i.code === 'V09' && /Airbnb/.test(i.message)), 'V09 naming Airbnb expected');
  const c2 = restaurantGrowth();
  c2.venueTypes = [];
  assert(codes(c2).errors.includes('V09'), 'V09 expected for empty types');
});

test('V04: a discount above 50% or an expiry outside 1–90 days is an error', () => {
  const c = restaurantGrowth();
  c.offerMenuDefaults[3].value = 60;
  assert(codes(c).errors.includes('V04'), 'V04 expected for 60%');
  const c2 = restaurantGrowth();
  c2.offerMenuDefaults[0].expiryDays = 120;
  assert(codes(c2).errors.includes('V04'), 'V04 expected for 120 days');
});

test('V04: an offer blank defaulting to an offer not in the menu is an error', () => {
  const c = restaurantGrowth();
  c.journeys[0].slotDefaults = { offer: 'pizza', offer_days: 14 };
  assert(codes(c).errors.includes('V04'), 'V04 expected');
});

test('V04: removing every offer while a journey gives one is an error', () => {
  const c = restaurantGrowth();
  c.offerMenuDefaults = [];
  c.journeys[0].slotDefaults = { offer_days: 14 };
  assert(codes(c).errors.includes('V04'), 'V04 expected');
});

test('V04: a default outside its bounds is an error', () => {
  const c = restaurantGrowth();
  c.journeys[0].slotDefaults = { offer: 'dessert', offer_days: 400 };
  assert(codes(c).errors.includes('V04'), 'V04 expected');
});

test('V07: a pool with no German wording is a warning, not an error', () => {
  const ctx = seedContext();
  ctx.wording.set('review_ask', { sms: new Set(['en']), email: new Set(['en', 'de']) });
  const { report, warnings } = codes(restaurantGrowth(), ctx);
  assert(report.ok && warnings.includes('V07'), `V07 warning expected, got ${warnings}`);
});

test('V10: two marketing journeys on the same trigger is a warning', () => {
  const ctx = seedContext();
  const review = ctx.templates.get('review_ask')!;
  const welcomeDef = ctx.templates.get('welcome_second_visit')!.versions.get(1)!.definition;
  const def = { ...review.versions.get(1)!.definition, entry: { ...welcomeDef.entry } };
  review.versions.set(1, { state: 'published', definition: def });
  const { report, warnings } = codes(restaurantGrowth(), ctx);
  assert(report.ok && warnings.includes('V10'), `V10 warning expected, got ${warnings}`);
});

test('V14: a utility playbook with a marketing journey or an offer is an error', () => {
  const c = restaurantGrowth();
  c.kind = 'utility';
  const { report } = codes(c);
  assert(report.issues.filter((i) => i.code === 'V14').length >= 2, 'V14 for the journey and for the offers');
});

test('P05: an unknown or switched-off question is a warning', () => {
  const c = restaurantGrowth();
  c.questionKeys = ['source', 'no_such_question'];
  const { report, warnings } = codes(c);
  assert(report.ok, 'still ok');
  assert(warnings.filter((w) => w === 'P05').length === 2, `two P05 warnings, got ${warnings}`);
});

test('K02: changing the kind after the first publish is an error', () => {
  const ctx = seedContext();
  ctx.publishedKind = 'utility';
  assert(codes(restaurantGrowth(), ctx).errors.includes('K02'), 'K02 expected');
});

test('K01: a malformed draft returns shape errors instead of throwing', () => {
  const { report } = codes({ kind: 'marketing', name: 'not an object' });
  assert(!report.ok && report.issues.every((i) => i.code === 'K01'), JSON.stringify(report.issues));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
