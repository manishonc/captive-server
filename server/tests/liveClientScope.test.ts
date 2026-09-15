/**
 * Tests for the live-clients scoping rules.
 *
 * Run: npx tsx tests/liveClientScope.test.ts   (from captive-server/server)
 *
 * These cover the multi-tenant isolation boundary. Every tenant shares ONE UniFi site, so
 * `stat/sta` returns every tenant's clients on every call and `filterToVenue` is the only
 * thing keeping one venue's guests out of another venue's dashboard. `scopedDevices` is the
 * second, independent guard: it governs whether a MAC gets a person's NAME attached, which
 * is a PII leak rather than a presence leak. A regression in either is silent and serious,
 * which is why they live in a Firestore-free module that can be tested with no credentials.
 *
 * `groupGuests` is here for a different reason: it is the fix for guests being keyed on
 * `email + accessPointId`, which means one person can own several guest documents at a
 * single venue.
 */

import {
  apIndex,
  buildRow,
  connectionAge,
  filterToVenue,
  groupGuests,
  MAX_PLAUSIBLE_UPTIME_SEC,
  ScopedAp,
  ScopedDevice,
  scopedDevices,
} from '../src/services/liveClientScope';
import { UnifiClient } from '../src/services/unifi';

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

/** Minimal client row; only the fields the scoping logic reads actually matter. */
function client(over: Partial<UnifiClient> & { mac: string }): UnifiClient {
  return {
    mac: over.mac,
    canon: over.canon ?? over.mac.replace(/[^0-9a-f]/g, ''),
    apMac: over.apMac ?? null,
    apCanon: over.apCanon ?? (over.apMac ? over.apMac.replace(/[^0-9a-f]/g, '') : null),
    isWired: over.isWired ?? false,
    authorized: over.authorized ?? true,
    isGuest: over.isGuest ?? true,
    hostname: over.hostname ?? null,
    name: over.name ?? null,
    ip: over.ip ?? null,
    essid: over.essid ?? null,
    network: over.network ?? null,
    oui: over.oui ?? null,
    uptimeSec: over.uptimeSec ?? 120,
    idleSec: over.idleSec ?? 0,
    assocTime: over.assocTime ?? null,
    rxBytes: over.rxBytes ?? 0,
    txBytes: over.txBytes ?? 0,
    signal: over.signal ?? null,
    rssi: over.rssi ?? null,
    channel: over.channel ?? null,
    radio: over.radio ?? null,
    satisfaction: over.satisfaction ?? null,
  };
}

const OUR_AP: ScopedAp = { id: 'ap-ours', mac: 'aa:bb:cc:00:00:01', name: 'Bar' };
const OUR_AP_2: ScopedAp = { id: 'ap-ours-2', mac: 'aa:bb:cc:00:00:02', name: 'Terrace' };
const THEIR_AP = 'ff:ee:dd:00:00:09';

console.log('\nfilterToVenue — the isolation boundary\n');

test('keeps only stations on this venue\'s access points', () => {
  const idx = apIndex([OUR_AP, OUR_AP_2]);
  const rows = filterToVenue(
    [
      client({ mac: '11:11:11:11:11:11', apMac: OUR_AP.mac }),
      client({ mac: '22:22:22:22:22:22', apMac: THEIR_AP }),
      client({ mac: '33:33:33:33:33:33', apMac: OUR_AP_2.mac }),
    ],
    idx,
  );
  assertEqual(rows.map((r) => r.mac), ['11:11:11:11:11:11', '33:33:33:33:33:33']);
});

test('drops another tenant\'s station even when the SSID matches ours', () => {
  // SSIDs are not unique across tenants on the shared site, so a matching essid must
  // never be enough to claim a station.
  const idx = apIndex([OUR_AP]);
  const rows = filterToVenue(
    [client({ mac: '22:22:22:22:22:22', apMac: THEIR_AP, essid: 'Guest WiFi' })],
    idx,
  );
  assertEqual(rows.length, 0, 'leaked cross-tenant client');
});

test('drops wired stations, which carry no ap_mac to scope them by', () => {
  const idx = apIndex([OUR_AP]);
  const rows = filterToVenue(
    [client({ mac: '44:44:44:44:44:44', apMac: OUR_AP.mac, isWired: true })],
    idx,
  );
  assertEqual(rows.length, 0, 'wired station was not dropped');
});

test('drops stations with a missing or unknown ap_mac', () => {
  const idx = apIndex([OUR_AP]);
  const rows = filterToVenue(
    [
      client({ mac: '55:55:55:55:55:55', apMac: null }),
      client({ mac: '66:66:66:66:66:66', apMac: '00:00:00:00:00:00' }),
    ],
    idx,
  );
  assertEqual(rows.length, 0, 'unprovable station was kept');
});

test('matches APs whose stored MAC uses a legacy spelling', () => {
  // Older AP documents hold hyphenated, bare-hex or upper-case MACs; the controller
  // always reports colon-lowercase. A miss here would silently show a venue as empty.
  const idx = apIndex([{ id: 'ap-legacy', mac: 'AA-BB-CC-00-00-01' }]);
  const rows = filterToVenue([client({ mac: '11:11:11:11:11:11', apMac: 'aa:bb:cc:00:00:01' })], idx);
  assertEqual(rows.length, 1, 'legacy MAC spelling failed to match');
});

test('an empty allowlist matches nothing rather than everything', () => {
  const rows = filterToVenue([client({ mac: '11:11:11:11:11:11', apMac: OUR_AP.mac })], apIndex([]));
  assertEqual(rows.length, 0, 'empty allowlist behaved as allow-all');
});

console.log('\nscopedDevices — the PII guard\n');

test('attaches identity when the device belongs to this venue\'s tenant', () => {
  const found = new Map<string, ScopedDevice>([['aaaa', { email: 'a@x.com', tenantUserId: 'tenant-1' }]]);
  assertEqual(scopedDevices(found, 'tenant-1').size, 1);
});

test('withholds identity for a device registered to a different tenant', () => {
  // The phone is genuinely here and must still be counted — but as an anonymous MAC,
  // never as the other tenant's named guest.
  const found = new Map<string, ScopedDevice>([['aaaa', { email: 'a@x.com', tenantUserId: 'tenant-1' }]]);
  assertEqual(scopedDevices(found, 'tenant-2').size, 0, 'leaked cross-tenant PII');
});

test('withholds identity when either side has no tenant recorded', () => {
  const noTenantOnDoc = new Map<string, ScopedDevice>([['aaaa', { email: 'a@x.com', tenantUserId: null }]]);
  assertEqual(scopedDevices(noTenantOnDoc, 'tenant-1').size, 0, 'legacy doc leaked');
  const withDoc = new Map<string, ScopedDevice>([['aaaa', { email: 'a@x.com', tenantUserId: 'tenant-1' }]]);
  assertEqual(scopedDevices(withDoc, null).size, 0, 'unowned venue leaked');
});

console.log('\ngroupGuests — one person, many devices\n');

function row(mac: string, device: ScopedDevice | undefined, uptime = 120) {
  return buildRow(client({ mac, apMac: OUR_AP.mac, uptimeSec: uptime }), OUR_AP, 'venue-1', null, device, undefined);
}

test('groups a guest\'s phone and laptop into one person', () => {
  const groups = groupGuests([
    row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: 'sarah@x.com', firstName: 'Sarah' }),
    row('22:22:22:22:22:22', { wifiGuestId: 'g1', email: 'sarah@x.com', firstName: 'Sarah' }),
  ]);
  assertEqual(groups.length, 1, 'guest was split');
  assertEqual(groups[0].deviceCount, 2);
});

test('groups by email across the duplicate guest docs one venue produces', () => {
  // Guests are keyed on email + accessPointId, so signing in at the bar AP and again at
  // the terrace AP of the SAME venue yields two documents for one human. Grouping on the
  // document id would show them twice, each holding half their devices.
  const groups = groupGuests([
    row('11:11:11:11:11:11', { wifiGuestId: 'g-bar', email: 'sarah@x.com' }),
    row('22:22:22:22:22:22', { wifiGuestId: 'g-terrace', email: 'sarah@x.com' }),
  ]);
  assertEqual(groups.length, 1, 'same person appeared twice');
  assertEqual(groups[0].deviceCount, 2);
  assertEqual(groups[0].wifiGuestIds.sort(), ['g-bar', 'g-terrace']);
});

test('keeps different people apart', () => {
  const groups = groupGuests([
    row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: 'sarah@x.com' }),
    row('22:22:22:22:22:22', { wifiGuestId: 'g2', email: 'tom@x.com' }),
  ]);
  assertEqual(groups.length, 2);
});

test('excludes unidentified devices from the guest grouping', () => {
  // Private/randomized MACs mean these always exist. They are counted elsewhere, but they
  // are not people and must not invent one.
  const groups = groupGuests([row('11:11:11:11:11:11', undefined)]);
  assertEqual(groups.length, 0);
});

test('falls back to the guest id when no email was captured', () => {
  const groups = groupGuests([row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: '' })]);
  assertEqual(groups.length, 1);
  assertEqual(groups[0].key, 'guest:g1');
});

test('reports the longest-running device as the person\'s session length', () => {
  const groups = groupGuests([
    row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: 'sarah@x.com' }, 60),
    row('22:22:22:22:22:22', { wifiGuestId: 'g1', email: 'sarah@x.com' }, 900),
  ]);
  assertEqual(groups[0].connectedSeconds, 900);
});

test('counts a duplicated MAC once', () => {
  const groups = groupGuests([
    row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: 'sarah@x.com' }),
    row('11:11:11:11:11:11', { wifiGuestId: 'g1', email: 'sarah@x.com' }),
  ]);
  assertEqual(groups[0].deviceCount, 1);
});

console.log('\nconnectionAge — controller clock, not ours\n');

test('derives the start time from uptime', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assertEqual(connectionAge(600, now).since, new Date(now - 600_000).toISOString());
});

test('treats a negative or implausible uptime as unknown, not as a number', () => {
  // A stuck row would otherwise render as a multi-year session.
  assertEqual(connectionAge(-5).seconds, null);
  assertEqual(connectionAge(MAX_PLAUSIBLE_UPTIME_SEC + 1).seconds, null);
  assertEqual(connectionAge(null).seconds, null);
});

console.log('\nbuildRow\n');

test('marks a device with no registry entry as unidentified', () => {
  const r = row('11:11:11:11:11:11', undefined);
  assertEqual(r.guest.source, 'unknown');
  assertEqual(r.guest.email, null);
});

test('ssidMatch is informational and never drives scoping', () => {
  const r = buildRow(
    client({ mac: '11:11:11:11:11:11', apMac: OUR_AP.mac, essid: 'Guest WiFi' }),
    OUR_AP,
    'venue-1',
    'Guest WiFi',
    undefined,
    undefined,
  );
  assertEqual(r.ssidMatch, true);
});

test('surfaces the authorization end time when the controller reports one', () => {
  const end = Math.floor(Date.UTC(2026, 0, 1, 20, 0, 0) / 1000);
  const r = buildRow(client({ mac: '11:11:11:11:11:11', apMac: OUR_AP.mac }), OUR_AP, 'venue-1', null, undefined, {
    canon: '111111111111',
    start: null,
    end,
    durationMin: null,
  });
  assertEqual(r.authorizedUntil, new Date(end * 1000).toISOString());
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
