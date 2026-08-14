/**
 * Tests for summarizeAdoptionProgress — the dashboard's live "Add Access Point" view.
 *
 * Run: npx tsx tests/adoptionProgress.test.ts   (from captive-server/server)
 *
 * Pure module, no credentials needed: Firestore rows and controller rows both arrive as
 * plain arguments.
 */

import {
  AdoptionProgressInput,
  DeviceStateRow,
  summarizeAdoptionProgress,
} from '../src/services/adoptionStatus';

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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

const T0 = 1_700_000_000_000;

function input(overrides: Partial<AdoptionProgressInput> = {}): AdoptionProgressInput {
  return {
    apId: 'ap1',
    apName: 'Main access point',
    venueId: 'venue1',
    mac: 'aabbccddeeff',
    adoptionState: 'adopt_requested',
    adoptionRequestedAt: T0,
    createdAt: T0,
    wifiApplied: false,
    ...overrides,
  };
}

function rows(entries: [string, DeviceStateRow][]): Map<string, DeviceStateRow> {
  return new Map(entries);
}

console.log('\nphases flow through from the classifier');

test('no controller row is waiting_for_device with null adoptRequestedAt', () => {
  const [e] = summarizeAdoptionProgress(
    [input({ adoptionRequestedAt: null, adoptionState: 'registered' })],
    rows([]),
    T0 + 30_000,
  );
  assertEqual(e.phase, 'waiting_for_device');
  assertEqual(e.done, false);
  assertEqual(e.deviceState, null);
});

test('a pending row is pending', () => {
  const [e] = summarizeAdoptionProgress(
    [input()],
    rows([['aabbccddeeff', { state: 2, adopted: false }]]),
    T0 + 30_000,
  );
  assertEqual(e.phase, 'pending');
  assertEqual(e.deviceState, 2);
});

test('a provisioning row is adopting with its reason', () => {
  const [e] = summarizeAdoptionProgress(
    [input()],
    rows([['aabbccddeeff', { state: 5, adopted: true }]]),
    T0 + 30_000,
  );
  assertEqual(e.phase, 'adopting');
  assertEqual(e.reason, 'provisioning');
});

test('a long-quiet state 0 row is offline', () => {
  const [e] = summarizeAdoptionProgress(
    [input()],
    rows([['aabbccddeeff', { state: 0, adopted: true }]]),
    T0 + 11 * 60_000,
  );
  assertEqual(e.phase, 'offline');
  assertEqual(e.reason, 'disconnected');
});

console.log('\ndone — connected AND WiFi applied, never one alone');

test('connected without WiFi is not done', () => {
  const [e] = summarizeAdoptionProgress(
    [input()],
    rows([['aabbccddeeff', { state: 1 }]]),
    T0 + 30_000,
  );
  assertEqual(e.phase, 'connected');
  assertEqual(e.done, false);
});

test('connected with WiFi applied is done', () => {
  const [e] = summarizeAdoptionProgress(
    [input({ wifiApplied: true, adoptionState: 'wifi_applied' })],
    rows([['aabbccddeeff', { state: 1 }]]),
    T0 + 30_000,
  );
  assertEqual(e.done, true);
});

test('connected with a stored apply error surfaces wifi_apply_failed', () => {
  // The classifier cannot see this — it lives on the AP document, not the controller row.
  const [e] = summarizeAdoptionProgress(
    [input({ lastError: 'apgroup write rejected' })],
    rows([['aabbccddeeff', { state: 1 }]]),
    T0 + 30_000,
  );
  assertEqual(e.reason, 'wifi_apply_failed');
  assertEqual(e.lastError, 'apgroup write rejected');
});

console.log('\noutput shape');

test('timestamps convert to ISO, missing ones to null', () => {
  const [e] = summarizeAdoptionProgress(
    [input({ adoptionRequestedAt: null })],
    rows([]),
    T0,
  );
  assertEqual(e.createdAt, new Date(T0).toISOString());
  assertEqual(e.adoptionRequestedAt, null);
});

test('newest adoption first — the one the person is watching', () => {
  const out = summarizeAdoptionProgress(
    [
      input({ apId: 'old', createdAt: T0 - 60_000, mac: 'aaaaaaaaaaaa' }),
      input({ apId: 'new', createdAt: T0, mac: 'bbbbbbbbbbbb' }),
    ],
    rows([]),
    T0,
  );
  assertEqual(out.map((e) => e.apId), ['new', 'old']);
});

test('blank names become null rather than empty strings', () => {
  const [e] = summarizeAdoptionProgress([input({ apName: '  ' })], rows([]), T0);
  assertEqual(e.apName, null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
