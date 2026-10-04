/**
 * Which Meta the template code talks to (PR W1): the sandbox Meta in the local emulator stack
 * (ADAPTIVE_SANDBOX=1 + the emulator), else the real Graph API client (which itself refuses every
 * call under the emulator). The only file that imports the real client — the store, the checks and
 * the webhook hint never reach Meta (tests/adaptiveWhatsAppBoundary.test.ts).
 */

import { sandboxEnabled } from '../engine/clock';
import { createMetaClient, type MetaClient } from './meta';
import { createSandboxMetaClient } from './sandbox';

let real: MetaClient | null = null;
let sandbox: MetaClient | null = null;
let override: MetaClient | null = null;

export function metaClient(): MetaClient {
  if (override) return override;
  if (sandboxEnabled()) return (sandbox ??= createSandboxMetaClient());
  return (real ??= createMetaClient());
}

/** Tests only: a stub client (null puts the normal choice back). */
export function __setMetaClientForTests(client: MetaClient | null): void {
  override = client;
}
