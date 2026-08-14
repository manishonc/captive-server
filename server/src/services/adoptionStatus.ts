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
 * 4 upgrading, 5 provisioning, 6 heartbeat missed, 7 adopting, 10 adoption failed,
 * 11 isolated. Only 1 means "done". Actively-working states (4/5/7) stay 'adopting' with no
 * time limit — a slow firmware download is still progress — while the can't-reach-it states
 * (0/6/11 and anything unknown) only count as 'adopting' inside a grace window after our
 * adopt command; past it they are 'offline'. The wire phase stays a five-value enum for old
 * clients; the `reason` field carries the finer distinction for clients that can use it.
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

/** How long a can't-reach-it state may persist after an adopt before we call it offline. */
const OFFLINE_GRACE_MS = 10 * 60_000;

/**
 * Why a device is stuck in its current phase — the actionable detail underneath the
 * five-value wire phase. Extra members beyond the classifier's own output exist for the
 * status endpoint to report conditions the classifier cannot see (controller down, WiFi
 * apply failing, MAC not registered).
 */
export type AdoptionStallReason =
  | 'provisioning'
  | 'upgrading'
  | 'heartbeat_missed'
  | 'isolated'
  | 'adopt_failed'
  | 'disconnected'
  | 'unknown_state'
  | 'controller_unreachable'
  | 'wifi_apply_failed'
  | 'not_registered';

export interface AdoptionClassification {
  phase: AdoptionPhase;
  reason: AdoptionStallReason | null;
  /** Raw controller `state`, or null when there is no row / the state is junk. */
  deviceState: number | null;
}

/**
 * @param row              the device's `stat/device` entry, or null when absent entirely
 * @param adoptRequestedAt epoch ms of our adopt command, or null if we never sent one
 */
export function classifyAdoption(
  row: DeviceStateRow | null | undefined,
  adoptRequestedAt: number | null = null,
  now: number = Date.now(),
): AdoptionClassification {
  if (!row) return { phase: 'waiting_for_device', reason: null, deviceState: null };

  const state = Number(row.state);
  const adopted = row.adopted;
  const deviceState = Number.isNaN(state) ? null : state;

  if (state === 1) return { phase: 'connected', reason: null, deviceState };

  // `adopted === false` is authoritative when the controller sends it; state 2 is the
  // fallback for firmware that omits the flag. Mirrors isPendingDevice's precedence.
  if (adopted === false) return { phase: 'pending', reason: null, deviceState };
  if (state === 2 && adopted !== true) return { phase: 'pending', reason: null, deviceState };

  // Actively working: no time cutoff. A device mid-provision or mid-upgrade is making
  // progress however long it takes, and calling it offline would tell the person on the
  // ladder to power-cycle at the worst possible moment.
  if (state === 5 || state === 7) return { phase: 'adopting', reason: 'provisioning', deviceState };
  if (state === 4) return { phase: 'adopting', reason: 'upgrading', deviceState };

  // Adoption failed outright — waiting will not fix it, so no grace window.
  if (state === 10) return { phase: 'offline', reason: 'adopt_failed', deviceState };

  // Everything else means the controller cannot currently talk to the device: 0
  // disconnected, 6 heartbeat missed, 11 isolated, or something we have never seen.
  // Right after our adopt that is normal — the device drops while it reboots into the
  // controller's config — so within the grace window it still counts as 'adopting'.
  const withinGrace = adoptRequestedAt !== null && now - adoptRequestedAt < OFFLINE_GRACE_MS;
  const reason: AdoptionStallReason =
    state === 6 ? 'heartbeat_missed'
    : state === 11 ? 'isolated'
    : state === 0 || deviceState === null ? 'disconnected'
    : 'unknown_state';

  if (withinGrace) return { phase: 'adopting', reason, deviceState };

  // With no adopt on record, a disconnected-looking row is indistinguishable from a device
  // that simply hasn't checked in yet — keep the pre-adopt phase for 0/NaN. States 6/11
  // can only exist for a device the controller once held, so those are offline regardless.
  if ((state === 0 || deviceState === null) && adoptRequestedAt === null) {
    return { phase: 'waiting_for_device', reason: null, deviceState };
  }
  return { phase: 'offline', reason, deviceState };
}

/** Back-compat wrapper for callers that only need the wire phase. */
export function classifyAdoptionPhase(
  row: DeviceStateRow | null | undefined,
  adoptRequestedAt: number | null = null,
  now: number = Date.now(),
): AdoptionPhase {
  return classifyAdoption(row, adoptRequestedAt, now).phase;
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

/**
 * The single definition of "adoption finished": connected AND the guest WiFi applied.
 * Clients stop polling on this, not on the bare phase.
 */
export function isAdoptionDone(phase: AdoptionPhase, wifiApplied: boolean): boolean {
  return phase === 'connected' && wifiApplied;
}

/** An AP document's adoption-relevant fields, flattened for {@link summarizeAdoptionProgress}. */
export interface AdoptionProgressInput {
  apId: string;
  apName?: string;
  venueId?: string;
  /** Canonical MAC as produced by canonMac — must match the device-row map's keys. */
  mac: string;
  adoptionState?: string;
  adoptionRequestedAt: number | null;
  createdAt: number | null;
  wifiApplied: boolean;
  lastError?: string | null;
}

/** One access point's row in the dashboard's live adoption view. */
export interface AdoptionProgressEntry {
  apId: string;
  apName: string | null;
  venueId: string | null;
  mac: string;
  adoptionState: string | null;
  phase: AdoptionPhase;
  reason: AdoptionStallReason | null;
  wifiApplied: boolean;
  done: boolean;
  createdAt: string | null;
  adoptionRequestedAt: string | null;
  deviceState: number | null;
  lastError: string | null;
}

/**
 * Classify a tenant's self-serve APs against the controller's device list, newest first.
 * Pure, like the classifier — the caller supplies the Firestore rows and the device map.
 */
export function summarizeAdoptionProgress(
  aps: AdoptionProgressInput[],
  deviceRows: Map<string, DeviceStateRow>,
  now: number = Date.now(),
): AdoptionProgressEntry[] {
  const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
  return aps
    .map((ap) => {
      const cls = classifyAdoption(deviceRows.get(ap.mac) ?? null, ap.adoptionRequestedAt, now);
      // Connected but the WiFi step keeps failing — that detail lives on the AP doc, not
      // in the controller row, so the classifier can't see it.
      const reason: AdoptionStallReason | null =
        cls.phase === 'connected' && !ap.wifiApplied && ap.lastError ? 'wifi_apply_failed' : cls.reason;
      return {
        apId: ap.apId,
        apName: ap.apName?.trim() || null,
        venueId: ap.venueId || null,
        mac: ap.mac,
        adoptionState: ap.adoptionState || null,
        phase: cls.phase,
        reason,
        wifiApplied: ap.wifiApplied,
        done: isAdoptionDone(cls.phase, ap.wifiApplied),
        createdAt: toIso(ap.createdAt),
        adoptionRequestedAt: toIso(ap.adoptionRequestedAt),
        deviceState: cls.deviceState,
        lastError: ap.lastError || null,
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
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
