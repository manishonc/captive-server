/**
 * Entry point of the `adaptive-worker` process:
 *
 *   node dist/adaptive/worker/main.js
 *
 * Same Docker image as the API, different command (docker-compose.adaptive-worker.yml).
 * It deliberately does NOT import server.ts, so the Campaign Manager scheduler,
 * the AP monitor and the expiry sweep never run twice.
 */

import { AdaptiveWorker } from './worker';
import { ENGINE_RUNTIME_VERSION } from '../core/runtime/version';
import { sandboxEnabled } from '../engine/clock';
import { identityReady } from '../identity/key';

process.on('unhandledRejection', (reason) => {
  console.error('[ADAPTIVE WORKER] unhandled rejection:', reason);
});

const worker = new AdaptiveWorker();
console.log(
  `[ADAPTIVE WORKER] ${worker.id} starting · engine ${ENGINE_RUNTIME_VERSION}` +
    `${sandboxEnabled() ? ' · SANDBOX (emulator only)' : ''}` +
    `${identityReady() ? '' : ' · GUEST_OTP_PEPPER missing: staying idle'}`,
);
worker.start().catch((err) => {
  console.error('[ADAPTIVE WORKER] fatal:', err);
  process.exit(1);
});
