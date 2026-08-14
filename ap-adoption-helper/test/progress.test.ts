// Tests for the claiming screen's progress model (src/renderer/progress.ts).
//
// The renderer is a classic script, so the model exposes itself via the module.exports
// guard at the bottom of the file — require() picks that up here, where `import` cannot.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { progressModel, pollDeadlineMs } = require('../src/renderer/progress.ts') as {
  progressModel: (
    s: {
      phase: string;
      wifiApplied: boolean;
      retryAfterSeconds: number;
      done?: boolean;
      reason?: string | null;
    },
    wifiFailStreak: number,
  ) => { kind: string; step?: number; detail?: string; code?: string };
  pollDeadlineMs: (reason: string | null | undefined) => number;
};

const base = { wifiApplied: false, retryAfterSeconds: 3 };

test('server done wins outright', () => {
  const action = progressModel({ ...base, phase: 'connected', wifiApplied: true, done: true }, 0);
  assert.equal(action.kind, 'done');
});

test('without a done field (old server), connected + wifiApplied is done', () => {
  const action = progressModel({ ...base, phase: 'connected', wifiApplied: true }, 0);
  assert.equal(action.kind, 'done');
});

test('bare wifiApplied proves nothing — a rebooting re-run must not show "WiFi is on"', () => {
  // Regression: renderProgress used to short-circuit on wifiApplied alone, rendering the
  // all-green step 4 while the device was mid-reboot on a re-run.
  const action = progressModel(
    { ...base, phase: 'adopting', wifiApplied: true, done: false },
    0,
  );
  assert.equal(action.kind, 'render');
  assert.equal(action.step, 3);
});

test('offline is an actionable error, not a checklist rewind', () => {
  // Regression: 'offline' used to rewind the cursor to step 2 and keep polling into the
  // generic timeout, with no hint that power/cabling is the thing to check.
  const action = progressModel({ ...base, phase: 'offline' }, 0);
  assert.deepEqual(action, { kind: 'error', code: 'DEVICE_OFFLINE' });
});

test('connected but WiFi failing shows retry copy, then escalates to WIFI_STUCK', () => {
  const early = progressModel({ ...base, phase: 'connected', reason: 'wifi_apply_failed' }, 3);
  assert.equal(early.kind, 'render');
  assert.equal(early.step, 4);
  const late = progressModel({ ...base, phase: 'connected', reason: 'wifi_apply_failed' }, 6);
  assert.deepEqual(late, { kind: 'error', code: 'WIFI_STUCK' });
});

test('reasons pick the step-3 copy: upgrading vs reconnecting vs plain provisioning', () => {
  const upgrading = progressModel({ ...base, phase: 'adopting', reason: 'upgrading' }, 0);
  const heartbeat = progressModel({ ...base, phase: 'adopting', reason: 'heartbeat_missed' }, 0);
  const plain = progressModel({ ...base, phase: 'adopting', reason: 'provisioning' }, 0);
  assert.equal(upgrading.step, 3);
  assert.equal(heartbeat.step, 3);
  assert.equal(plain.step, 3);
  assert.notEqual(upgrading.detail, plain.detail);
  assert.notEqual(heartbeat.detail, plain.detail);
  assert.match(String(upgrading.detail), /update/i);
});

test('controller_unreachable gets its own copy on step 2', () => {
  const action = progressModel(
    { ...base, phase: 'waiting_for_device', reason: 'controller_unreachable' },
    0,
  );
  assert.equal(action.step, 2);
  assert.match(String(action.detail), /controller/i);
});

test('an old server with no reason field reproduces the legacy step mapping', () => {
  assert.equal(progressModel({ ...base, phase: 'waiting_for_device' }, 0).step, 2);
  assert.equal(progressModel({ ...base, phase: 'pending' }, 0).step, 2);
  assert.equal(progressModel({ ...base, phase: 'adopting' }, 0).step, 3);
  assert.equal(progressModel({ ...base, phase: 'connected' }, 0).step, 4);
});

test('the poll deadline stretches for a firmware upgrade only', () => {
  assert.equal(pollDeadlineMs('upgrading'), 600_000);
  assert.equal(pollDeadlineMs('provisioning'), 180_000);
  assert.equal(pollDeadlineMs(null), 180_000);
  assert.equal(pollDeadlineMs(undefined), 180_000);
});
