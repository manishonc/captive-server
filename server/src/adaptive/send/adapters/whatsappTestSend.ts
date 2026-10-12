/**
 * The WhatsApp adapter for the owner's Send test (PR PV): Meta's Cloud API, or the sandbox in the
 * local emulator stack (the same choice index.ts makes for email and SMS). The API server's own
 * copy — since PR W3 the worker gets its WhatsApp adapter from index.ts (`registerAdapters`).
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
