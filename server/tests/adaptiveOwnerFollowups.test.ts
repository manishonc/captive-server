/**
 * PR E server follow-ups (decisions E-D6, E-D10):
 *  - Account names: `display_name` (the field cms owner docs use) joins the name chain of the
 *    admin launch card and guest search.
 *  - The Wi-Fi card wording is venue-neutral (no "Menu, opening hours" at an Airbnb, no "house
 *    info" at a restaurant: SMS and email share one line), with the same blanks as before, so
 *    the stored `mergeFieldsUsed` stays right.
 *
 * Run: npx tsx tests/adaptiveOwnerFollowups.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ACCOUNT_NAME_FIELDS, accountNameOf } from '../src/adaptive/core/owner/accountName';
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
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Account names ────────────────────────────────────────────────────────────

const doc = (fields: Record<string, unknown>) => (field: string) => fields[field];

console.log('\nAccount names\n');

test('the chain: displayName, display_name, companyName, name', () => {
  assertEqual([...ACCOUNT_NAME_FIELDS], ['displayName', 'display_name', 'companyName', 'name'], 'order');
  assertEqual(accountNameOf(doc({ display_name: 'Manish (test)', email: 'o@test.local' })), 'Manish (test)', 'a cms owner doc (display_name only)');
  assertEqual(accountNameOf(doc({ displayName: 'Staff Name', display_name: 'Owner Name' })), 'Staff Name', 'displayName first, as before');
  assertEqual(accountNameOf(doc({ display_name: 'Owner Name', companyName: 'Café Rose AG', name: 'x' })), 'Owner Name', 'display_name before companyName');
  assertEqual(accountNameOf(doc({ companyName: 'Café Rose AG', name: 'x' })), 'Café Rose AG', 'companyName');
  assertEqual(accountNameOf(doc({ name: 'Old doc' })), 'Old doc', 'name');
  assertEqual(accountNameOf(doc({ email: 'o@test.local' })), null, 'none → null (the email is shown separately)');
});

test('empty, blank or non-text values are skipped; names are trimmed', () => {
  assertEqual(accountNameOf(doc({ displayName: '', display_name: 'Owner' })), 'Owner', 'an empty displayName no longer hides display_name');
  assertEqual(accountNameOf(doc({ displayName: '   ', display_name: '  Owner  ' })), 'Owner', 'blank skipped, trimmed');
  assertEqual(accountNameOf(doc({ displayName: 42, display_name: { first: 'x' }, companyName: null, name: 'Name' })), 'Name', 'non-text skipped');
  assertEqual(accountNameOf(doc({})), null, 'an empty or missing doc');
});

test('both readers use the helper (the launch card and guest search)', () => {
  for (const file of ['service/launch.ts', 'service/adminTools.ts']) {
    const src = readFileSync(join(__dirname, '../src/adaptive', file), 'utf8');
    assert(src.includes('accountNameOf('), `${file} calls accountNameOf`);
    assert(!/get\('displayName'\)/.test(src), `${file} has no chain of its own left`);
  }
});

// ── The Wi-Fi card wording ───────────────────────────────────────────────────

console.log('\nWi-Fi card wording\n');

const plan = buildSeedPlan(new Date(0));
const WIFI_ID = variantId('wifi_info', 'A');
const wifiDoc = plan.units.flatMap((u) => u.docs).find((d) => d.path[0] === COL.variants && d.path[1] === WIFI_ID)?.data as Record<string, any> | undefined;

test('the seed plan has no problems, and the Wi-Fi card doc id is the one the hand-edit note names', () => {
  assertEqual(plan.problems, [], 'no problems');
  assertEqual(WIFI_ID, 'var_7600ede441779e425513e5da5952cb21', 'CaptivePortal_Variants doc id (docs/adaptive-api.md "Seed")');
  assert(wifiDoc, 'the wifi_info/A doc is in the plan');
  assertEqual([wifiDoc.poolKey, wifiDoc.journeyKey, wifiDoc.letter, wifiDoc.purpose], ['wifi_info', 'wifi_info_card', 'A', 'service'], 'the card');
});

test('the seeded doc has the venue-neutral text in EN and DE, SMS and email', () => {
  assertEqual(wifiDoc!.channels.sms.text, "Welcome to {{venue.name}}! You're online on {{guestinfo.wifiName}}. Everything you need to know: {{link.hub}}", 'EN SMS');
  assertEqual(
    wifiDoc!.channels.email.body,
    `Hi {{contact.firstName | default:"there"}},\n\nyou're online at {{venue.name}} on the {{guestinfo.wifiName}} network. Everything you need to know: {{link.hub}}\n\nEnjoy your visit,\n{{venue.name}}`,
    'EN email',
  );
  assertEqual(wifiDoc!.locales.de.sms.text, 'Willkommen bei {{venue.name}}! Du bist im WLAN {{guestinfo.wifiName}} online. Alles Wichtige: {{link.hub}}', 'DE SMS');
  assertEqual(
    wifiDoc!.locales.de.email.body,
    `Hallo {{contact.firstName | default:"du"}},\n\ndu bist bei {{venue.name}} im WLAN {{guestinfo.wifiName}} online. Alles Wichtige: {{link.hub}}\n\nViel Spass bei deinem Besuch,\n{{venue.name}}`,
    'DE email',
  );
  const all = JSON.stringify({ channels: wifiDoc!.channels, locales: wifiDoc!.locales });
  assert(!/Menu|Menü|opening hours|Öffnungszeiten/.test(all), 'no menu or opening hours anywhere');
  const lines = [wifiDoc!.channels.sms.text, wifiDoc!.channels.email.body, wifiDoc!.locales.de.sms.text, wifiDoc!.locales.de.email.body];
  for (const text of lines) assert(!/House info|Hausinfos|tips|Tipps/i.test(text), `no "house info" (a restaurant has no house): ${text}`);
  assertEqual(lines.map((text) => /(Everything you need to know|Alles Wichtige): \{\{link\.hub\}\}/.test(text)), [true, true, true, true], 'SMS and email share the neutral line');
  assertEqual([wifiDoc!.channels.email.subject, wifiDoc!.locales.de.email.subject], ["You're online at {{venue.name}}", 'Du bist online bei {{venue.name}}'], 'subjects unchanged');
});

test('the same blanks as before: mergeFieldsUsed is unchanged', () => {
  assertEqual(wifiDoc!.mergeFieldsUsed, ['contact.firstName', 'guestinfo.wifiName', 'link.hub', 'venue.name'], 'mergeFieldsUsed');
});

test('the patch reaches the list the seed reads, and leaves the neighbouring checkout reminder alone', () => {
  const card = SEED.variants.find((v) => v.poolKey === 'wifi_info' && v.letter === 'A');
  assert(card, 'the card is in SEED.variants (the list the seed reads)');
  assertEqual(SEED.variants.filter((v) => v.poolKey === 'wifi_info').length, 1, 'one Wi-Fi card wording');
  const checkout = SEED.variants.find((v) => v.poolKey === 'checkout_info')!;
  assert(/Everything you need: \{\{link\.hub\}\}/.test(checkout.channels.sms!.text), 'the checkout reminder is untouched');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
