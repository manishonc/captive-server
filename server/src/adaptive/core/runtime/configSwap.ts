/**
 * Mid-journey edits (plan §3.10): which of the owner's config versions a guest's
 * next step runs with. Pure.
 *
 * An owner save with "apply to guests already in this journey" marks each running
 * instance with `pendingConfigVersion` + `pendingConfigAt` (the save time). The
 * instance moves to the new version at its first step after the freeze window
 * (`freezeWindowMinutes`, 60): a send that goes out within 60 minutes of the save —
 * whether it was planned before the save or a delay ending or a click reaches it —
 * keeps the values it was planned with. So:
 *  - a step taken within the window runs on the old version (and the marker stays);
 *  - a send planned within the window runs on the old version even if a pause or a
 *    provider retry holds it past the window, and so does anything else that happens
 *    while the guest waits on it;
 *  - any other step after the window moves the guest.
 */

import type { WaitState } from './types';

export interface ConfigPin {
  configVersion: number;
  pendingConfigVersion: number | null;
  /** When the owner saved the pending version (engine clock, epoch ms). */
  pendingConfigAt: number | null;
}

export type ConfigSwap =
  /** No pending version: keep the pinned one. */
  | { kind: 'keep'; use: number }
  /** A pending version older than (or equal to) the pinned one: keep, and clear the marker. */
  | { kind: 'stale'; use: number }
  /** Within the freeze window, or a send planned within it is next: keep the old values for now. */
  | { kind: 'hold'; use: number; pending: number }
  /** Run this step with the new version and pin it. */
  | { kind: 'swap'; use: number; from: number };

export function decideConfigSwap(pin: ConfigPin, waiting: WaitState | null, freezeWindowMs: number, now: number): ConfigSwap {
  const pending = pin.pendingConfigVersion;
  if (pending === null || pending === undefined || !Number.isFinite(pending)) return { kind: 'keep', use: pin.configVersion };
  if (pending <= pin.configVersion) return { kind: 'stale', use: pin.configVersion };
  if (pin.pendingConfigAt !== null) {
    const windowEnd = pin.pendingConfigAt + freezeWindowMs;
    const plannedSend = waiting?.kind === 'send_due' && typeof waiting.intendedAt === 'number' ? waiting.intendedAt : null;
    if (now <= windowEnd || (plannedSend !== null && plannedSend <= windowEnd)) return { kind: 'hold', use: pin.configVersion, pending };
  }
  return { kind: 'swap', use: pending, from: pin.configVersion };
}
