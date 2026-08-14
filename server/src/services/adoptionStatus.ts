/**
 * Classifying where a device is in the adoption lifecycle, for the installer's progress screen.
 *
 * Pure: takes a raw `stat/device` row and returns a phase. No Firestore, no controller, so it
 * stays unit-testable without credentials.
 *
 * WHY THIS EXISTS RATHER THAN REUSING WHAT WE HAD. Two existing helpers look like they would
 * do the job and both are wrong for it:
 *
 *   isPendingDevice() returns true whenever `adopted === false`, whatever the state. The
 *   controller keeps `adopted:false` for a while after accepting the adoption, as the device
 *   moves 2 -> 4/5, so the installer would sit on "waiting" through the whole provision and
 *   the 5-minute sweep would re-issue `adopt` on every pass.
 *
 *   mapDeviceState() collapses everything except state 1 to 'offline'. Polling it would tell
 *   someone their brand-new access point is offline during a completely normal two-minute
 *   provision — the single worst thing to show a person standing on a ladder.
 *
 * UniFi device states seen in practice: 0 disconnected, 1 connected, 2 pending adoption,
 * 4 upgrading, 5 provisioning, 6 heartbeat missed, 11 isolated. Only 1 means "done"; the
 * mid-adoption values are treated as one 'adopting' phase because the distinction between
 * them means nothing to a venue employee.
 */

/** Just the fields we read — the controller sends far more. */
export interface DeviceStateRow {
  state?: unknown;
  adopted?: unknown;
}

export type AdoptionPhase =
  /** Not on the controller at all yet — still booting, or set-inform hasn't landed. */
  | 'waiting_for_device'
  /** Visible and adoptable, but nobody has accepted it. */
  | 'pending'
  /** Adoption accepted; downloading config / provisioning / upgrading firmware. */
  | 'adopting'
  /** Connected and serving. */
  | 'connected'
  /** Adopted, but the controller has since lost it. */
  | 'offline';

/** How long a device may sit at state 0 after an adopt before we call it offline. */
const OFFLINE_GRACE_MS = 10 * 60_000;

/**
 * @param row              the device's `stat/device` entry, or null when absent entirely
 * @param adoptRequestedAt epoch ms of our adopt command, or null if we never sent one
 */
export function classifyAdoptionPhase(
  row: DeviceStateRow | null | undefined,
  adoptRequestedAt: number | null = null,
  now: number = Date.now(),
): AdoptionPhase {
  if (!row) return 'waiting_for_device';

  const state = Number(row.state);
  const adopted = row.adopted;

  if (state === 1) return 'connected';

  // `adopted === false` is authoritative when the controller sends it; state 2 is the
  // fallback for firmware that omits the flag. Mirrors isPendingDevice's precedence.
  if (adopted === false) return 'pending';
  if (state === 2 && adopted !== true) return 'pending';

  // Adopted but not yet connected: provisioning (5), upgrading (4), or anything else
  // transient. Grouped, because "upgrading firmware" vs "provisioning" is not a
  // distinction the person on site can act on.
  if (state === 0 || Number.isNaN(state)) {
    // A device that has gone quiet. Only call it offline once our adopt has had time to
    // land — immediately after the command it is normal for the device to drop while it
    // reboots into the controller's config.
    if (adoptRequestedAt !== null && now - adoptRequestedAt < OFFLINE_GRACE_MS) return 'adopting';
    return adoptRequestedAt === null ? 'waiting_for_device' : 'offline';
  }

  return 'adopting';
}

/**
 * How long the client should wait before polling again. Starts responsive while the installer
 * is watching closely, then backs off — a full venue rollout has several helpers polling at
 * once, and every poll costs a controller round trip.
 */
export function retryAfterSeconds(elapsedMs: number): number {
  if (elapsedMs < 20_000) return 2;
  if (elapsedMs < 60_000) return 3;
  return 10;
}

/** Terminal phases — the client stops polling on these. */
export function isTerminalPhase(phase: AdoptionPhase): boolean {
  return phase === 'connected';
}

/** UniFi truncates long aliases in the Devices list; keep the useful part visible. */
const MAX_DEVICE_NAME = 64;

/**
 * The alias to give a device on the controller.
 *
 * Every access point otherwise displays as its model — a shared site full of rows all
 * reading "U6 Pro", across every tenant, with no way to tell whose hardware is whose. That
 * was tolerable when a human adopted each device and already knew; it is not once tenants
 * adopt their own.
 *
 * Format: `Venue · AP name (venueId prefix)`. The venue id prefix is not decoration — venue
 * display names are NOT unique across tenants (two tenants may both have "The Coffee
 * House"), and it matches the `venue-<venueId>` AP group, so an admin can get from a device
 * row to the right group and WLAN without a database lookup.
 */
export function controllerDeviceName(args: {
  venueName?: string;
  apName?: string;
  venueId: string;
}): string {
  const venue = String(args.venueName || '').trim();
  const ap = String(args.apName || '').trim();
  const tag = `(${args.venueId.slice(0, 6)})`;

  const parts = [venue, ap].filter(Boolean).join(' · ');
  const label = parts || 'HeidiFi access point';

  // Trim the label rather than the tag: the tag is what disambiguates two identically
  // named venues, so it is the last thing that should be lost.
  const room = MAX_DEVICE_NAME - tag.length - 1;
  const trimmed = label.length > room ? `${label.slice(0, Math.max(0, room - 1)).trimEnd()}…` : label;
  return `${trimmed} ${tag}`;
}
