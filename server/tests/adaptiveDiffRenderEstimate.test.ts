/**
 * Tests for adaptive/core diff, render, estimate and checksum.
 *
 * Run: npx tsx tests/adaptiveDiffRenderEstimate.test.ts   (from captive-server/server)
 *
 * No Firestore. What these pin:
 *
 *  - **"What changed" lists exactly the edits** — a description tweak, a newly
 *    pinned journey version, a journey switched on, an offer added, the order.
 *  - **Previews fill every blank for the example guest** and leave unknown ones
 *    visible, with `default:` and `date:` filters and the old {{firstName}} alias.
 *  - **The estimate charges marketing only**, prices phone guests at the first of
 *    SMS/email on the ladder and email-only guests at email, and is 0 with no
 *    opted-in guests.
 *  - **The checksum ignores key order**, so re-saving the same content never
 *    looks like a change.
 *  - **The owner's fit label names what fits** — "Any venue" only when every
 *    venue type does, so an Airbnb is never told a playbook is for any venue.
 */

import { diffPlaybookContent } from '../src/adaptive/core/diff';
import { renderText, sampleValues, formatDate } from '../src/adaptive/core/render';
import { estimateMonthly } from '../src/adaptive/core/estimate';
import { canonicalJson, contentChecksum } from '../src/adaptive/core/checksum';
import { playbookContentSchema } from '../src/adaptive/core/schemas';
import { SEED } from '../src/adaptive/seed/definitions';
import { fitLabel } from '../src/adaptive/core/constants';

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

const base = () => playbookContentSchema.parse(JSON.parse(JSON.stringify(SEED.playbooks[0].content)));

test('no changes → no diff lines', () => {
  assertEqual(diffPlaybookContent(base(), base()), [], 'lines');
});

test('diff lists the description, pin, default, offer and order changes', () => {
  const after = base();
  after.summary.en += ' Now with a welcome drink.';
  after.journeys[1].templateVersion = 2;
  after.journeys[2].defaultEnabled = true;
  after.offerMenuDefaults.push({ offerKey: 'cake', name: 'Free cake', label: { en: 'a free cake' }, kind: 'free_item', value: 0, expiryDays: 7 });
  [after.journeys[0], after.journeys[1]] = [after.journeys[1], after.journeys[0]];
  const labels = diffPlaybookContent(base(), after).map((l) => l.label);
  for (const want of ['Description', 'review_ask: pinned version', 'win_back: on by default', 'Default offer added', 'Journey order (priority)']) {
    assert(labels.includes(want), `missing “${want}” in ${JSON.stringify(labels)}`);
  }
});

test('a first version diff says so', () => {
  const lines = diffPlaybookContent(null, base());
  assertEqual(lines.map((l) => l.label), ['First version'], 'labels');
});

test('render fills the example guest, filters and aliases', () => {
  const values = sampleValues({
    lang: 'de',
    venueName: 'Madras Jungle',
    slots: { offer: 'dessert', offer_days: 14 },
    offers: base().offerMenuDefaults,
    now: new Date('2026-09-23T10:00:00Z'),
  });
  const out = renderText('Hallo {{contact.firstName | default:"du"}}, bis {{offer.expiryDate | date:"d.M."}}: {{offer.label}} bei {{venueName}}', values);
  assertEqual(out.text, 'Hallo Anna, bis 7.10.: ein Gratis-Dessert bei Madras Jungle', 'text');
  assertEqual(out.unknown, [], 'unknown');
});

test('render keeps unknown blanks visible and applies defaults', () => {
  const out = renderText('Hi {{contact.nickname}} {{slot.missing | default:"friend"}}', {});
  assertEqual(out.text, 'Hi {{contact.nickname}} friend', 'text');
  assertEqual(out.unknown, ['contact.nickname'], 'unknown');
});

test('formatDate handles d.M. and dd.MM.yyyy', () => {
  assertEqual(formatDate('2026-03-05T00:00:00Z', 'd.M.'), '5.3.', 'short');
  assertEqual(formatDate('2026-03-05T00:00:00Z', 'dd.MM.yyyy'), '05.03.2026', 'long');
});

test('estimate: marketing only, weighted by who left a phone', () => {
  const result = estimateMonthly(
    [{ venueId: 'v1', captures30d: 200, optedIn30d: 100, withPhone: 50, emailOnly: 50 }],
    [
      { journeyKey: 'welcome', purpose: 'marketing', avgTouchesPerGuest: 2, ladder: ['sms', 'email', 'whatsapp'] },
      { journeyKey: 'thanks', purpose: 'service', avgTouchesPerGuest: 1, ladder: ['email'] },
    ],
    { email: 1, sms: 15, creditsPerUnit: 100, currency: 'CHF' },
    { returnRate: 0.12, avgSpendMinor: 4500 },
  );
  // 100 guests × 2 touches × (0.5 × 15 + 0.5 × 1) = 1600 credits
  assertEqual(result.creditsPerMonth, 1600, 'credits');
  assertEqual(result.costPerMonthMinor, 1600, 'CHF 16.00');
  // 100 × 0.12 × CHF 45 = CHF 540
  assertEqual(result.revenuePerMonthMinor, 54000, 'revenue');
  assertEqual(result.perJourney.map((j) => j.journeyKey), ['welcome'], 'service journeys cost nothing');
});

test('estimate: an email-first ladder prices phone guests at email too', () => {
  const r = estimateMonthly(
    [{ venueId: 'v1', captures30d: 10, optedIn30d: 10, withPhone: 10, emailOnly: 0 }],
    [{ journeyKey: 'tips', purpose: 'marketing', avgTouchesPerGuest: 1, ladder: ['email', 'whatsapp'] }],
    { email: 1, sms: 15, creditsPerUnit: 100, currency: 'CHF' },
    { returnRate: 0, avgSpendMinor: 0 },
  );
  assertEqual(r.creditsPerMonth, 10, 'credits');
});

test('estimate: nobody opted in → zero', () => {
  const r = estimateMonthly(
    [{ venueId: 'v1', captures30d: 50, optedIn30d: 0, withPhone: 0, emailOnly: 0 }],
    [{ journeyKey: 'welcome', purpose: 'marketing', avgTouchesPerGuest: 2, ladder: ['sms', 'email'] }],
    { email: 1, sms: 15, creditsPerUnit: 100, currency: 'CHF' },
    { returnRate: 0.1, avgSpendMinor: 1000 },
  );
  assertEqual([r.creditsPerMonth, r.revenuePerMonthMinor], [0, 0], 'zero');
});

test('checksum ignores key order and changes with content', () => {
  assertEqual(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}', 'canonical');
  assertEqual(contentChecksum({ a: 1, b: 2 }), contentChecksum({ b: 2, a: 1 }), 'order');
  assert(contentChecksum({ a: 1 }) !== contentChecksum({ a: 2 }), 'content');
});

test('the fit label names the venue types, and says "Any venue" only when all of them fit', () => {
  assertEqual(fitLabel(['restaurant', 'cafe']), 'Restaurants & cafés', 'restaurant growth');
  assertEqual(fitLabel(['airbnb']), 'Airbnb & holiday rentals', 'airbnb stay');
  assertEqual(fitLabel(['restaurant', 'cafe', 'other']), 'Restaurants, cafés & other businesses', 'local business');
  assertEqual(fitLabel(['restaurant', 'cafe', 'airbnb', 'other']), 'Any venue', 'guest info');
  assertEqual(fitLabel(['cafe']), 'Cafés', 'one type');
  assertEqual(fitLabel([]), 'No venue type yet', 'none');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
