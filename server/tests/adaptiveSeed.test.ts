/**
 * Tests for adaptive/seed — the playbooks, journeys and wording shipped with
 * the first Adaptive Campaigns release.
 *
 * Run: npx tsx tests/adaptiveSeed.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials. The boot-time seed writes exactly what
 * buildSeedPlan returns, so these tests pin:
 *
 *  - **Every seeded definition passes the same checks the admin screens run.**
 *    A playbook that fails its own Check could never be republished by an admin.
 *  - **The four prototype playbooks and twelve journeys are all there**, with
 *    win-back, birthday, quiet hours and holidays marked coming soon.
 *  - **Every available journey has English and German wording** for SMS and
 *    email, and no wording uses a blank it doesn't have.
 *  - **Ids are deterministic**, so two replicas booting at once create the same
 *    docs and the second one simply finds them.
 */

import { buildSeedPlan, variantId } from '../src/adaptive/seed/buildSeed';
import { SEED } from '../src/adaptive/seed/definitions';
import { COL } from '../src/adaptive/store/collections';

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

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || 'value'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const NOW = new Date('2026-09-23T10:00:00Z');
const plan = buildSeedPlan(NOW);

test('the seed has no problems', () => {
  assertEqual(plan.problems, [], 'problems');
});

test('every journey template passes its checks with no errors', () => {
  for (const [key, report] of Object.entries(plan.reports.journeys)) {
    assert(report.ok, `${key}: ${report.issues.map((i) => `${i.code} ${i.message}`).join('; ')}`);
  }
  assertEqual(Object.keys(plan.reports.journeys).length, 12, 'journey count');
});

test('every playbook passes its checks with no errors', () => {
  for (const [key, report] of Object.entries(plan.reports.playbooks)) {
    assert(report.ok, `${key}: ${report.issues.map((i) => `${i.code} ${i.message}`).join('; ')}`);
  }
  assertEqual(Object.keys(plan.reports.playbooks).sort(), ['guest_info', 'local_business', 'restaurant_growth', 'str_stay'], 'playbooks');
});

test('playbook warnings are only about WhatsApp not being live yet', () => {
  for (const [key, report] of Object.entries(plan.reports.playbooks)) {
    const warnings = report.issues.filter((i) => i.severity === 'warning');
    assertEqual(warnings, [], `${key} warnings`);
  }
});

test('win-back, birthday, quiet hours and holidays are coming soon; the rest are available', () => {
  const soon = SEED.journeys.filter((j) => j.header.availability === 'coming_soon').map((j) => j.header.key).sort();
  assertEqual(soon, ['birthday', 'holidays', 'quiet_hours_filler', 'win_back'], 'coming soon');
});

test('coming-soon journeys are off by default and not required in every playbook', () => {
  const soon = new Set(SEED.journeys.filter((j) => j.header.availability === 'coming_soon').map((j) => j.header.key));
  for (const p of SEED.playbooks) {
    for (const j of p.content.journeys) {
      if (soon.has(j.journeyKey)) assert(!j.defaultEnabled && !j.required, `${p.key}/${j.journeyKey}`);
    }
  }
});

test('every available journey pool has EN and DE wording for its SMS and email channels', () => {
  const available = SEED.journeys.filter((j) => j.header.availability === 'available');
  for (const j of available) {
    for (const [poolKey, pool] of Object.entries(j.definition.pools ?? {})) {
      const variants = SEED.variants.filter((v) => v.poolKey === poolKey);
      assert(variants.length > 0, `${j.header.key}/${poolKey} has no wording`);
      for (const channel of pool.channels.filter((c) => c !== 'whatsapp')) {
        assert(
          variants.some((v) => v.channels[channel] && v.locales?.de?.[channel]),
          `${j.header.key}/${poolKey}/${channel} is missing EN or DE`,
        );
      }
    }
  }
});

test('the guest info playbook is utility and carries no offers', () => {
  const gi = SEED.playbooks.find((p) => p.key === 'guest_info');
  assert(Boolean(gi), 'guest_info exists');
  assertEqual(gi!.content.kind, 'utility', 'kind');
  assertEqual(gi!.content.offerMenuDefaults, [], 'offers');
});

test('units are anchored on their header doc and create header + v1 together', () => {
  const pb = plan.units.find((u) => u.label === 'Playbook restaurant_growth v1');
  assert(Boolean(pb), 'restaurant_growth unit');
  assertEqual(pb!.anchor, [COL.playbooks, 'restaurant_growth'], 'anchor');
  assertEqual(pb!.docs.map((d) => d.path.join('/')), [
    'CaptivePortal_Playbooks/restaurant_growth',
    'CaptivePortal_Playbooks/restaurant_growth/versions/1',
  ], 'paths');
  const header = pb!.docs[0].data;
  assertEqual([header.status, header.latestVersion, header.publishedVersion], ['published', 1, 1], 'header state');
  const version = pb!.docs[1].data;
  assertEqual(version.state, 'published', 'version state');
  assert(typeof version.checksum === 'string' && (version.checksum as string).length === 64, 'checksum');
});

test('the platform rules start with sending paused', () => {
  const cfg = plan.units.find((u) => u.label === 'AdaptiveConfig/global v1');
  assert(Boolean(cfg), 'config unit');
  assertEqual((cfg!.docs[0].data.killSwitch as { sendingPaused: boolean }).sendingPaused, true, 'sendingPaused');
});

test('wording ids are deterministic and distinct', () => {
  assertEqual(variantId('welcome_offer', 'A'), variantId('welcome_offer', 'A'), 'stable');
  const ids = new Set(SEED.variants.map((v) => variantId(v.poolKey, v.letter)));
  assertEqual(ids.size, SEED.variants.length, 'distinct');
  assert(/^var_[0-9a-f]{32}$/.test(variantId('welcome_offer', 'A')), 'format');
});

test('building the plan twice gives the same documents', () => {
  const again = buildSeedPlan(NOW);
  assertEqual(JSON.stringify(again.units), JSON.stringify(plan.units), 'units');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
