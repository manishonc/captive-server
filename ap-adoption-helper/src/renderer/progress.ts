// The claiming screen's progress model: server status in, one UI action out.
//
// Classic script, like renderer.ts — index.html loads it first, so `progressModel` and
// `pollDeadlineMs` are plain globals by the time the renderer runs. No imports or exports;
// the `module.exports` guard at the bottom is dead code in the browser and exists only so
// test/progress.test.ts can require this file under `node --test`.
//
// Split out of renderer.ts for the same reason api-errors.ts was split out of api.ts: the
// renderer touches the DOM and cannot run under node, and this mapping is exactly the part
// that keeps growing cases worth pinning with tests.
//
// User-facing strings live in PROGRESS_COPY below (not inline), matching renderer.ts's
// rule that translating the app is a data swap.

type ProgressAction =
  | { kind: 'render'; step: number; detail: string }
  | { kind: 'done' }
  | { kind: 'error'; code: 'DEVICE_OFFLINE' | 'WIFI_STUCK' };

/** Consecutive wifi_apply_failed polls before we stop spinning and say so (~1 minute). */
const WIFI_FAIL_STREAK_LIMIT = 6;

const PROGRESS_COPY = {
  waiting:
    'Your access point is starting up and calling home. This usually takes about a minute.',
  controllerUnreachable:
    'HeidiFi can’t reach your WiFi controller right now. We’ll keep trying — nothing is lost.',
  pending: 'It’s checking in now.',
  adopting: 'Almost there — applying your settings.',
  upgrading:
    'It’s installing a software update first. This can take up to ten minutes — leave it plugged in.',
  reconnecting: 'It’s restarting and reconnecting. This is normal — hang on.',
  wifi: 'Setting up your WiFi network.',
  wifiRetrying: 'Having trouble switching the WiFi on — retrying automatically.',
};

/**
 * What the claiming screen should do with a status response.
 *
 * The single source of "we're finished" is the server's `done` (connected AND WiFi applied);
 * against a pre-Aug-2026 server that doesn't send it, the same conjunction is computed here.
 * A bare `wifiApplied` deliberately proves nothing — on a re-run the flag can be true while
 * the device is mid-reboot, and rendering "your WiFi is on" then would be a lie.
 */
function progressModel(s: AdoptionStatus, wifiFailStreak: number): ProgressAction {
  const done = s.done ?? (s.phase === 'connected' && s.wifiApplied);
  if (done) return { kind: 'done' };

  switch (s.phase) {
    case 'offline':
      // Actionable, not a rewind: freezing the checklist and explaining beats walking the
      // cursor backwards and spinning to the deadline.
      return { kind: 'error', code: 'DEVICE_OFFLINE' };
    case 'connected':
      if (s.reason === 'wifi_apply_failed') {
        if (wifiFailStreak >= WIFI_FAIL_STREAK_LIMIT) return { kind: 'error', code: 'WIFI_STUCK' };
        return { kind: 'render', step: 4, detail: PROGRESS_COPY.wifiRetrying };
      }
      return { kind: 'render', step: 4, detail: PROGRESS_COPY.wifi };
    case 'adopting':
      if (s.reason === 'upgrading') return { kind: 'render', step: 3, detail: PROGRESS_COPY.upgrading };
      if (s.reason === 'heartbeat_missed' || s.reason === 'disconnected' || s.reason === 'isolated' || s.reason === 'unknown_state') {
        return { kind: 'render', step: 3, detail: PROGRESS_COPY.reconnecting };
      }
      return { kind: 'render', step: 3, detail: PROGRESS_COPY.adopting };
    case 'pending':
      return { kind: 'render', step: 2, detail: PROGRESS_COPY.pending };
    case 'waiting_for_device':
    default:
      if (s.reason === 'controller_unreachable') {
        return { kind: 'render', step: 2, detail: PROGRESS_COPY.controllerUnreachable };
      }
      return { kind: 'render', step: 2, detail: PROGRESS_COPY.waiting };
  }
}

/**
 * The overall give-up deadline for the claiming screen. A first-boot firmware upgrade
 * routinely outlives the normal three minutes, and interrupting one with "taking longer
 * than usual" invites exactly the power-cycle that bricks the update.
 */
function pollDeadlineMs(reason: string | null | undefined): number {
  return reason === 'upgrading' ? 600_000 : 180_000;
}

// Browser: `module` doesn't exist and this is skipped. Tests: require() picks these up.
// (The identifier itself is typed via @types/node, which the compile happens to include.)
if (typeof module !== 'undefined' && module) {
  module.exports = { progressModel, pollDeadlineMs };
}
