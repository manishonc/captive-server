/**
 * The WhatsApp adapter for the owner's Send test (PR PV): Meta's Cloud API, or the sandbox in the
 * local emulator stack (the same choice index.ts makes for email and SMS).
 *
 * Kept out of index.ts on purpose: the engine (worker) imports index.ts, and until W3 switches
 * WhatsApp sending on it never even loads the WhatsApp sender — `registerAdapters` fills email and
 * SMS only, and engine/sendPath.ts refuses WhatsApp (`whatsapp_off`). Guarded by
 * tests/adaptiveWhatsAppBoundary.test.ts.
 */

import { sandboxEnabled } from '../../engine/clock';
import { createSandboxAdapter } from './sandbox';
import { createWhatsAppAdapter } from './whatsapp';
import type { ChannelAdapter } from './types';

let real: ChannelAdapter | null = null;
let sandbox: ChannelAdapter | null = null;

export function whatsappTestAdapter(): ChannelAdapter {
  if (sandboxEnabled()) return (sandbox ??= createSandboxAdapter('whatsapp'));
  return (real ??= createWhatsAppAdapter());
}
