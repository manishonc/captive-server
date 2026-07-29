/**
 * The single source of truth for "does this venue require verification, and by
 * which channels, right now".
 *
 * Both `/splash-config` (what the portal renders) and the grant paths
 * (`/create-user`, `/unifi/authorize`) call `resolveVerification`. If they used
 * separate logic they could disagree — the portal showing a verify step the
 * grant path doesn't require, or worse, a grant path demanding a token for a
 * channel the portal never offered, which locks every guest out of the venue.
 *
 * MIRROR SITE — this file is one of six that must agree on the verificationPage
 * shape. See the header of cms/app/api/captive-portal/_lib/connected-page.js.
 */

import type { VerifyChannel } from './guestOtp';
import { verificationSubsystemReady } from './verificationToken';

export const VERIFICATION_CHANNELS: VerifyChannel[] = ['email', 'sms', 'whatsapp'];

/** Which login-form field a channel proves. sms and whatsapp share one number. */
export const VERIFICATION_CHANNEL_TARGET: Record<VerifyChannel, 'email' | 'phone'> = {
  email: 'email',
  sms: 'phone',
  whatsapp: 'phone',
};

export interface VerificationChannelConfig {
  enabled: boolean;
}

export interface VerificationPageConfig {
  enabled: boolean;
  channels: Record<VerifyChannel, VerificationChannelConfig>;
  defaultChannel: VerifyChannel;
  allowGuestChoice: boolean;
  requirement: 'any' | 'all';
  heading: string;
  subheading: string;
  codeInputLabel: string;
  sendButtonText: string;
  verifyButtonText: string;
  resendLabel: string;
  /** Skip re-verification for this many days on the same device. 0 = every visit. */
  rememberDays: number;
}

export const REMEMBER_DAYS_MAX = 90;

/**
 * `enabled: false` is load-bearing. Every venue that predates this key reads
 * through these defaults, so a default of true would drop an OTP wall in front
 * of every existing venue's wifi the moment this deploys.
 */
export const VERIFICATION_PAGE_DEFAULTS: VerificationPageConfig = {
  enabled: false,
  channels: {
    email: { enabled: true },
    sms: { enabled: false },
    whatsapp: { enabled: false },
  },
  defaultChannel: 'email',
  allowGuestChoice: false,
  requirement: 'any',
  heading: 'Verify your details',
  subheading: "We'll send you a code to confirm it's you.",
  codeInputLabel: 'Verification code',
  sendButtonText: 'Send code',
  verifyButtonText: 'Verify',
  resendLabel: 'Resend code',
  rememberDays: 30,
};

function clampDays(value: unknown): number {
  const n = typeof value === 'number' || (typeof value === 'string' && String(value).trim() !== '')
    ? Number(value)
    : NaN;
  if (!Number.isFinite(n)) return VERIFICATION_PAGE_DEFAULTS.rememberDays;
  return Math.min(REMEMBER_DAYS_MAX, Math.max(0, Math.round(n)));
}

/** Deep-merges a stored verificationPage over the defaults. */
export function mergeVerification(docData: Record<string, any>): VerificationPageConfig {
  const stored =
    docData && docData.verificationPage && typeof docData.verificationPage === 'object'
      && !Array.isArray(docData.verificationPage)
      ? docData.verificationPage
      : {};

  const storedChannels =
    stored.channels && typeof stored.channels === 'object' && !Array.isArray(stored.channels)
      ? stored.channels
      : {};

  const channels = {} as Record<VerifyChannel, VerificationChannelConfig>;
  for (const key of VERIFICATION_CHANNELS) {
    // Per-channel merge: a doc written before `whatsapp` existed must not lose
    // the other two channels' settings.
    channels[key] = {
      ...VERIFICATION_PAGE_DEFAULTS.channels[key],
      ...(storedChannels[key] && typeof storedChannels[key] === 'object' ? storedChannels[key] : {}),
      enabled: Boolean(
        storedChannels[key] && typeof storedChannels[key] === 'object'
          && storedChannels[key].enabled !== undefined
          ? storedChannels[key].enabled
          : VERIFICATION_PAGE_DEFAULTS.channels[key].enabled,
      ),
    };
  }

  const defaultChannel = VERIFICATION_CHANNELS.includes(stored.defaultChannel)
    ? (stored.defaultChannel as VerifyChannel)
    : VERIFICATION_PAGE_DEFAULTS.defaultChannel;

  return {
    ...VERIFICATION_PAGE_DEFAULTS,
    ...stored,
    enabled: stored.enabled === true,
    channels,
    defaultChannel,
    allowGuestChoice: stored.allowGuestChoice === true,
    requirement: stored.requirement === 'all' ? 'all' : 'any',
    rememberDays: clampDays(stored.rememberDays),
  };
}

/** Mirrors each provider service's own configured-check, read lazily. */
export function channelConfigured(channel: VerifyChannel): boolean {
  if (channel === 'email') {
    return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
  }
  if (channel === 'sms') {
    return !!(
      process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      // Without one of these there is no `from`, so the send would always fail.
      && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_PHONE_NUMBER)
    );
  }
  return !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

export type DegradedReason = 'not_configured' | 'no_channels' | 'fields_disabled';

export interface ResolvedVerification {
  /** What both the portal and the grant paths obey. */
  effective: VerificationPageConfig;
  /** Channels the tenant enabled that cannot be used on this deployment. */
  channelsUnavailable: VerifyChannel[];
  degraded: DegradedReason | null;
}

/**
 * Subtracts everything that cannot actually work, then fails OPEN.
 *
 * When a venue's verification is unusable — no provider configured, signing
 * secret unset, or the login form doesn't collect the contact the channel needs
 * — the guest gets wifi WITHOUT verification rather than being stranded. A
 * misconfigured provider must never become a wifi outage for a whole venue.
 *
 * The safety property preserved in that case: nothing is ever *labelled*
 * verified. `emailVerified` / `phoneVerified` stay false, so downstream code
 * cannot mistake a degraded guest for a checked one.
 */
export function resolveVerification(
  docData: Record<string, any>,
  loginFields: { email?: { enabled?: boolean }; phone?: { enabled?: boolean } } | null,
): ResolvedVerification {
  const merged = mergeVerification(docData);

  if (!merged.enabled) {
    return { effective: merged, channelsUnavailable: [], degraded: null };
  }

  if (!verificationSubsystemReady()) {
    console.error(
      '[VERIFICATION] Venue requires verification but GUEST_VERIFICATION_SIGNING_SECRET '
      + 'and/or GUEST_OTP_PEPPER are unset — connecting guests unverified.',
    );
    return {
      effective: { ...merged, enabled: false },
      channelsUnavailable: [...VERIFICATION_CHANNELS],
      degraded: 'not_configured',
    };
  }

  const emailFieldOn = loginFields?.email?.enabled !== false;
  const phoneFieldOn = loginFields?.phone?.enabled !== false;

  const unavailable: VerifyChannel[] = [];
  let fieldBlocked = false;

  const channels = {} as Record<VerifyChannel, VerificationChannelConfig>;
  for (const channel of VERIFICATION_CHANNELS) {
    let enabled = merged.channels[channel].enabled;
    if (enabled && !channelConfigured(channel)) {
      enabled = false;
      unavailable.push(channel);
    }
    if (enabled) {
      // A channel whose contact field isn't on the form asks the guest for a
      // code at an address they were never given a box to type.
      const target = VERIFICATION_CHANNEL_TARGET[channel];
      const fieldOn = target === 'email' ? emailFieldOn : phoneFieldOn;
      if (!fieldOn) {
        enabled = false;
        fieldBlocked = true;
        unavailable.push(channel);
      }
    }
    channels[channel] = { enabled };
  }

  const active = VERIFICATION_CHANNELS.filter((c) => channels[c].enabled);

  if (!active.length) {
    console.error(
      `[VERIFICATION] Venue requires verification but no channel is usable `
      + `(unavailable: ${unavailable.join(',') || 'none'}) — connecting guests unverified.`,
    );
    return {
      effective: { ...merged, enabled: false, channels },
      channelsUnavailable: unavailable,
      degraded: fieldBlocked ? 'fields_disabled' : 'no_channels',
    };
  }

  const defaultChannel = active.includes(merged.defaultChannel) ? merged.defaultChannel : active[0];

  return {
    effective: { ...merged, channels, defaultChannel },
    channelsUnavailable: unavailable,
    degraded: null,
  };
}

/** The channels a resolved config actually offers, in stable order. */
export function activeChannels(config: VerificationPageConfig): VerifyChannel[] {
  return VERIFICATION_CHANNELS.filter((c) => config.channels[c].enabled);
}
