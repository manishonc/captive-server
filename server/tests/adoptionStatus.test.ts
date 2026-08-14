/**
 * Tests for the adoption phase classifier — what the installer's progress screen shows.
 *
 * Run: npx tsx tests/adoptionStatus.test.ts   (from captive-server/server)
 *
 * Pure module, no credentials needed.
 *
 * Why this is load-bearing: the two obvious existing helpers are both wrong here, and the
 * tests pin down the difference. isPendingDevice() calls anything with adopted===false
 * "pending" regardless of state, which would show no progress for the whole provision AND
 * make the 5-minute cron re-issue `adopt` every pass at a device that is already adopting.
 * mapDeviceState() calls everything except state 1 "offline", which would tell someone their
 * brand-new access point is broken during a normal two-minute provision.
 */

import {
  classifyAdoption,
  classifyAdoptionPhase,
  controllerDeviceName,
  isAdoptionDone,
  retryAfterSeconds,
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

console.log('\nthe device is not on the controller yet');

test('a missing row is "waiting", not an error', () => {
  assertEqual(classifyAdoptionPhase(null), 'waiting_for_device');
  assertEqual(classifyAdoptionPhase(undefined), 'waiting_for_device');
});

console.log('\npending vs adopting — the distinction isPendingDevice cannot make');

test('state 2 with adopted:false is pending', () => {
  assertEqual(classifyAdoptionPhase({ state: 2, adopted: false }), 'pending');
});

test('state 2 with the flag omitted is pending', () => {
  // Some firmware omits `adopted` entirely; state 2 is the fallback signal.
  assertEqual(classifyAdoptionPhase({ state: 2 }), 'pending');
});

test('state 5 with adopted:true is ADOPTING, not pending', () => {
  // The exact case isPendingDevice gets wrong is the inverse of this one; here the flag is
  // already true, so both agree. The next test is the one that matters.
  assertEqual(classifyAdoptionPhase({ state: 5, adopted: true }), 'adopting');
});

test('state 4 (firmware upgrade) is adopting, not offline', () => {
  assertEqual(classifyAdoptionPhase({ state: 4, adopted: true }), 'adopting');
});

test('state 7 (adopting) is adopting', () => {
  assertEqual(classifyAdoptionPhase({ state: 7, adopted: true }), 'adopting');
});

test('actively-working states have NO time cutoff', () => {
  // A slow firmware download is still progress; only the can't-reach-it states go offline.
  assertEqual(classifyAdoptionPhase({ state: 4, adopted: true }, T0, T0 + 30 * 60_000), 'adopting');
  assertEqual(classifyAdoptionPhase({ state: 5, adopted: true }, T0, T0 + 30 * 60_000), 'adopting');
});

console.log('\nthe can\'t-reach-it states — heartbeat missed, isolated, unknown');

test('heartbeat missed (6) is adopting within the grace window, offline past it', () => {
  // This was the stuck-forever bug: 6 used to fall through to "adopting" with no limit,
  // so an adopted-but-unreachable device spun on "connecting" until the client timed out.
  assertEqual(classifyAdoption({ state: 6, adopted: true }, T0, T0 + 30_000), {
    phase: 'adopting',
    reason: 'heartbeat_missed',
    deviceState: 6,
  });
  assertEqual(classifyAdoption({ state: 6, adopted: true }, T0, T0 + 11 * 60_000), {
    phase: 'offline',
    reason: 'heartbeat_missed',
    deviceState: 6,
  });
});

test('heartbeat missed with no adopt of ours is offline, not waiting', () => {
  // States 6/11 can only exist for a device the controller once held — unlike state 0,
  // there is no "hasn't checked in yet" reading to fall back to.
  assertEqual(classifyAdoptionPhase({ state: 6, adopted: true }), 'offline');
});

test('isolated (11) behaves like heartbeat missed, with its own reason', () => {
  assertEqual(classifyAdoption({ state: 11, adopted: true }, T0, T0 + 30_000), {
    phase: 'adopting',
    reason: 'isolated',
    deviceState: 11,
  });
  assertEqual(classifyAdoption({ state: 11, adopted: true }, T0, T0 + 11 * 60_000).phase, 'offline');
});

test('adoption failed (10) is offline immediately — waiting will not fix it', () => {
  assertEqual(classifyAdoption({ state: 10, adopted: true }, T0, T0 + 5_000), {
    phase: 'offline',
    reason: 'adopt_failed',
    deviceState: 10,
  });
});

test('an unrecognised non-zero state gets the grace window, then offline', () => {
  assertEqual(classifyAdoption({ state: 3, adopted: true }, T0, T0 + 30_000), {
    phase: 'adopting',
    reason: 'unknown_state',
    deviceState: 3,
  });
  assertEqual(classifyAdoption({ state: 3, adopted: true }, T0, T0 + 11 * 60_000).phase, 'offline');
});

console.log('\nconnected');

test('state 1 is connected regardless of the adopted flag', () => {
  assertEqual(classifyAdoptionPhase({ state: 1, adopted: true }), 'connected');
  assertEqual(classifyAdoptionPhase({ state: 1 }), 'connected');
});

test('done means connected AND WiFi applied — never one without the other', () => {
  assertEqual(isAdoptionDone('connected', true), true);
  assertEqual(isAdoptionDone('connected', false), false);
  assertEqual(isAdoptionDone('adopting', true), false);
  assertEqual(isAdoptionDone('pending', true), false);
  assertEqual(isAdoptionDone('waiting_for_device', true), false);
  assertEqual(isAdoptionDone('offline', true), false);
});

console.log('\nstate 0 — the reboot-versus-dead distinction');

test('a drop just after our adopt is still adopting', () => {
  // Devices routinely go quiet while rebooting into the controller's config. Calling that
  // "offline" would fail the install at the exact moment it is succeeding.
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 30_000), 'adopting');
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 9 * 60_000), 'adopting');
});

test('a drop long after our adopt is offline', () => {
  assertEqual(classifyAdoptionPhase({ state: 0 }, T0, T0 + 11 * 60_000), 'offline');
});

test('state 0 with no adopt of ours is waiting, not offline', () => {
  // We never asked this device to do anything, so there is nothing to have failed.
  assertEqual(classifyAdoptionPhase({ state: 0 }, null, T0), 'waiting_for_device');
});

test('a missing or junk state is treated as state 0', () => {
  assertEqual(classifyAdoptionPhase({}, null, T0), 'waiting_for_device');
  assertEqual(classifyAdoptionPhase({ state: 'banana' }, T0, T0 + 30_000), 'adopting');
});

console.log('\nretryAfterSeconds — responsive first, then cheap');

test('backs off as the wait lengthens', () => {
  assertEqual(retryAfterSeconds(0), 2);
  assertEqual(retryAfterSeconds(19_000), 2);
  assertEqual(retryAfterSeconds(20_000), 3);
  assertEqual(retryAfterSeconds(59_000), 3);
  assertEqual(retryAfterSeconds(60_000), 10);
  assertEqual(retryAfterSeconds(10 * 60_000), 10);
});

console.log('\ncontrollerDeviceName — telling one tenant\'s U6 Pro from another\'s');

test('combines venue and access point name with a venue-id tag', () => {
  assertEqual(
    controllerDeviceName({ venueName: 'Cafe Rosa', apName: 'Main access point', venueId: 'Wy5nKlFXEW5bTFZ9JmIP' }),
    'Cafe Rosa · Main access point (Wy5nKl)',
  );
});

test('the tag matches the AP group name, so an admin can cross-reference', () => {
  // AP groups are named venue-<venueId>; the tag is that id's prefix, which is how you get
  // from a device row to the right group and WLAN without a database lookup.
  const venueId = 'Wy5nKlFXEW5bTFZ9JmIP';
  const name = controllerDeviceName({ venueName: 'X', apName: 'Y', venueId });
  assertEqual(name.includes(venueId.slice(0, 6)), true);
});

test('two identically named venues still produce different aliases', () => {
  // Venue display names are NOT unique across tenants — that is the whole reason the tag
  // exists rather than just using the venue name.
  const a = controllerDeviceName({ venueName: 'The Coffee House', apName: 'Main', venueId: 'aaaaaa1111' });
  const b = controllerDeviceName({ venueName: 'The Coffee House', apName: 'Main', venueId: 'bbbbbb2222' });
  if (a === b) throw new Error(`collision: ${a}`);
});

test('copes with missing pieces rather than rendering blanks', () => {
  assertEqual(controllerDeviceName({ venueId: 'abc123xyz' }), 'HeidiFi access point (abc123)');
  assertEqual(controllerDeviceName({ venueName: 'Cafe Rosa', venueId: 'abc123xyz' }), 'Cafe Rosa (abc123)');
  assertEqual(controllerDeviceName({ apName: 'Lobby', venueId: 'abc123xyz' }), 'Lobby (abc123)');
});

test('truncates the label, never the tag', () => {
  const name = controllerDeviceName({
    venueName: 'A Very Long Venue Name That Goes On And On Forever',
    apName: 'And An Equally Long Access Point Name',
    venueId: 'abc123xyz',
  });
  assertEqual(name.length <= 64, true, 'length');
  // The tag is what disambiguates, so it must survive.
  assertEqual(name.endsWith('(abc123)'), true, 'tag preserved');
  assertEqual(name.includes('…'), true, 'ellipsis marks the trim');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
