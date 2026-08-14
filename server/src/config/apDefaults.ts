/**
 * Defaults seeded onto a newly created access point document.
 *
 * SOURCE OF TRUTH: cms/lib/captive-portal-constants.js. Mirrored here — not imported —
 * because the two apps are separate deployments, the same way services/subscriptionState.ts
 * mirrors the CMS's plan flags. Keep them identical: an AP created by self-serve adoption and
 * one created from the CMS's Add Access Point form must be indistinguishable afterwards.
 *
 * `events` in particular is not decoration. Marketing dispatch reads it to decide whether a
 * guest connecting to this AP triggers a message, and code elsewhere assumes the three event
 * keys exist. An AP created without it silently never sends anything, which looks like a
 * broken campaign rather than a missing field.
 */

export interface EventMarketing {
  email: { enabled: boolean; messages: unknown[] };
  sms: { enabled: boolean; messages: unknown[] };
  whatsapp: { enabled: boolean; messages: unknown[] };
}

export interface ApEvents {
  onConnect: EventMarketing;
  onReconnect: EventMarketing;
  onDisconnect: EventMarketing;
}

function defaultEventMarketing(): EventMarketing {
  return {
    email: { enabled: false, messages: [] },
    sms: { enabled: false, messages: [] },
    whatsapp: { enabled: false, messages: [] },
  };
}

/** Fresh object per call — these are written into Firestore and must not be shared. */
export function defaultApEvents(): ApEvents {
  return {
    onConnect: defaultEventMarketing(),
    onReconnect: defaultEventMarketing(),
    onDisconnect: defaultEventMarketing(),
  };
}

/** Guest session length in seconds before re-authentication. Matches the CMS form default. */
export const DEFAULT_SESSION_TIMEOUT = 36000;

/** Minutes of silence before the AP monitor calls an access point offline. */
export const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 60;
