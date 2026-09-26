/**
 * The engine's switches in `CaptivePortal_AdaptiveConfig/global`: launch mode
 * (default + per account), the pause, safety ceilings, the SMS country list and
 * the alert address.
 *
 * Read raw — PR 1's `getAdaptiveConfig()` parses a fixed shape and drops these
 * keys. Anything missing or malformed reads as the SAFE value: launch `off`,
 * sending paused. So a bad write can only ever stop the engine, never loosen it.
 */

import { z } from 'zod';
import { db } from '../../firebase';
import { COL, CONFIG_DOC_ID } from './collections';
import { DEFAULT_SMS_COUNTRIES } from '../core/runtime/phoneCountry';
import { tsMs } from './time';
import { venueMode, sendingHeld as heldRule, needsStartSending as needsRule, type HoldVenue } from '../core/runtime/hold';
import type { AdaptiveVenueDoc } from './types';

export type LaunchMode = 'off' | 'test' | 'live';

const modeSchema = z.enum(['off', 'test', 'live']);

/** A time that may be a Timestamp, a Date or ms; anything unreadable is null (read as "unknown" → held). */
const timeSchema = z.unknown().transform((v) => tsMs(v));
/** When each account moved into live (PR D Start sending): the default's date, and per-account dates. */
const liveSinceSchema = z
  .object({ default: timeSchema.catch(null), accounts: z.record(z.string(), timeSchema).catch({}) })
  .catch({ default: null, accounts: {} });

const settingsSchema = z.object({
  launch: z
    .object({
      default: modeSchema.catch('off'),
      // Each entry on its own: a bad value turns only that account off, never
      // another account's explicit 'off' back to the default.
      accounts: z.record(z.string(), modeSchema.catch('off')).catch({}),
      changedAt: z.unknown().optional(),
      changedBy: z.string().nullable().optional(),
      liveSince: liveSinceSchema.optional(),
    })
    .catch({ default: 'off', accounts: {}, liveSince: { default: null, accounts: {} } }),
  safety: z
    .object({
      maxSendsPerVenuePerDay: z.number().int().min(1).catch(500),
      maxSendsPlatformPerDay: z.number().int().min(1).catch(5000),
      maxNewContactsPerApPerHour: z.number().int().min(1).catch(60),
      staleAfterHours: z.number().min(1).max(72).catch(6),
    })
    .catch({ maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 }),
  sms: z.object({ allowedCountries: z.array(z.string().length(2)).catch(DEFAULT_SMS_COUNTRIES) }).catch({ allowedCountries: DEFAULT_SMS_COUNTRIES }),
  alerts: z.object({ email: z.string().email().nullable().catch(null) }).catch({ email: null }),
  killSwitch: z.object({ sendingPaused: z.boolean().catch(true) }).catch({ sendingPaused: true }),
});

export interface EngineSettings {
  launch: {
    default: LaunchMode;
    accounts: Record<string, LaunchMode>;
    changedBy: string | null;
    /** When the default / each account moved into live (epoch ms; null = unknown). */
    liveSince?: { default: number | null; accounts: Record<string, number | null> };
  };
  safety: { maxSendsPerVenuePerDay: number; maxSendsPlatformPerDay: number; maxNewContactsPerApPerHour: number; staleAfterHours: number };
  sms: { allowedCountries: string[] };
  alerts: { email: string | null };
  paused: boolean;
}

export const SAFE_SETTINGS: EngineSettings = {
  launch: { default: 'off', accounts: {}, changedBy: null, liveSince: { default: null, accounts: {} } },
  safety: { maxSendsPerVenuePerDay: 500, maxSendsPlatformPerDay: 5000, maxNewContactsPerApPerHour: 60, staleAfterHours: 6 },
  sms: { allowedCountries: DEFAULT_SMS_COUNTRIES },
  alerts: { email: null },
  paused: true,
};

export function parseEngineSettings(data: Record<string, unknown> | undefined): EngineSettings {
  if (!data) return SAFE_SETTINGS;
  const p = settingsSchema.parse({
    launch: data.launch ?? {},
    safety: data.safety ?? {},
    sms: data.sms ?? {},
    alerts: data.alerts ?? {},
    killSwitch: data.killSwitch ?? {},
  });
  return {
    launch: {
      default: p.launch.default,
      accounts: p.launch.accounts,
      changedBy: p.launch.changedBy ?? null,
      liveSince: p.launch.liveSince ?? { default: null, accounts: {} },
    },
    safety: p.safety,
    sms: p.sms,
    alerts: { email: p.alerts.email ?? null },
    paused: p.killSwitch.sendingPaused,
  };
}

/** Fresh read that throws when Firestore can't be read (the worker keeps its last good copy). */
export async function readEngineSettingsStrict(): Promise<EngineSettings> {
  const snap = await db.collection(COL.config).doc(CONFIG_DOC_ID).get();
  return parseEngineSettings(snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
}

/** Fresh read; any failure reads as off + paused. */
export async function readEngineSettings(): Promise<EngineSettings> {
  try {
    return await readEngineSettingsStrict();
  } catch (err) {
    console.error('[ADAPTIVE] engine settings read failed; treating as off:', err);
    return SAFE_SETTINGS;
  }
}

let cached: { value: EngineSettings; at: number } | null = null;

/** For hot paths (the login hook): at most one read a minute. */
export async function cachedEngineSettings(ttlMs = 60_000): Promise<EngineSettings> {
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;
  const value = await readEngineSettings();
  cached = { value, at: Date.now() };
  return value;
}

export function clearEngineSettingsCache(): void {
  cached = null;
}

/** The launch mode for one account: its override, else the default. */
export function modeFor(settings: EngineSettings, tenantUserId: string | null | undefined): LaunchMode {
  if (!tenantUserId) return 'off';
  return settings.launch.accounts[tenantUserId] ?? settings.launch.default;
}

/** Can anything run at all? (false = every account is off). */
export function anyAccountOn(settings: EngineSettings): boolean {
  return settings.launch.default !== 'off' || Object.values(settings.launch.accounts).some((m) => m !== 'off');
}

/** When this account moved into live: its own date if it has one, else the default's (null = unknown). */
export function accountLiveSince(settings: EngineSettings, tenantUserId: string): number | null {
  const ls = settings.launch.liveSince ?? { default: null, accounts: {} };
  if (Object.prototype.hasOwnProperty.call(ls.accounts, tenantUserId)) return ls.accounts[tenantUserId] ?? null;
  return ls.default ?? null;
}

function holdVenue(av: Partial<AdaptiveVenueDoc>): HoldVenue {
  return {
    status: av.status ?? null,
    utility: { enabled: av.utility?.enabled === true, enabledAt: tsMs(av.utility?.enabledAt) },
    firstOnAt: tsMs(av.firstOnAt),
    activatedAt: tsMs(av.activatedAt),
    sendingConfirmedAt: tsMs(av.sendingConfirmedAt),
  };
}

/**
 * The mode NEW guests at this venue get for an event at `atMs` (engine clock): the
 * account's mode, or `off` while the venue waits for the owner's Start sending (PR D).
 * Running journeys keep the mode they started with.
 */
export function venueModeFor(settings: EngineSettings, av: Partial<AdaptiveVenueDoc>, atMs: number): LaunchMode {
  const tenant = String(av.tenantUserId ?? '');
  return venueMode(modeFor(settings, tenant), accountLiveSince(settings, tenant), holdVenue(av), atMs);
}

/** Is this venue waiting for Start sending for an event at `atMs`? */
export function venueHeld(settings: EngineSettings, av: Partial<AdaptiveVenueDoc>, atMs: number): boolean {
  const tenant = String(av.tenantUserId ?? '');
  return heldRule(modeFor(settings, tenant), accountLiveSince(settings, tenant), holdVenue(av), atMs);
}

/**
 * When this venue started sending after waiting for its owner's Start sending (PR D): the click's
 * time, else null (it never needed one, or it still waits — then it is held anyway).
 */
export function startedSendingAt(settings: EngineSettings, av: Partial<AdaptiveVenueDoc>): number | null {
  return venueNeedsStartSending(settings, av) ? holdVenue(av).sendingConfirmedAt ?? null : null;
}

/** Does this venue need the owner's Start sending at all (its account is live, it was on before)? */
export function venueNeedsStartSending(settings: EngineSettings, av: Partial<AdaptiveVenueDoc>): boolean {
  const tenant = String(av.tenantUserId ?? '');
  return needsRule(modeFor(settings, tenant), accountLiveSince(settings, tenant), holdVenue(av));
}
