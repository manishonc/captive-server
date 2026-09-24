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

export type LaunchMode = 'off' | 'test' | 'live';

const modeSchema = z.enum(['off', 'test', 'live']);

const settingsSchema = z.object({
  launch: z
    .object({
      default: modeSchema.catch('off'),
      accounts: z.record(z.string(), modeSchema).catch({}),
      changedAt: z.unknown().optional(),
      changedBy: z.string().nullable().optional(),
    })
    .catch({ default: 'off', accounts: {} }),
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
  launch: { default: LaunchMode; accounts: Record<string, LaunchMode>; changedBy: string | null };
  safety: { maxSendsPerVenuePerDay: number; maxSendsPlatformPerDay: number; maxNewContactsPerApPerHour: number; staleAfterHours: number };
  sms: { allowedCountries: string[] };
  alerts: { email: string | null };
  paused: boolean;
}

export const SAFE_SETTINGS: EngineSettings = {
  launch: { default: 'off', accounts: {}, changedBy: null },
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
    launch: { default: p.launch.default, accounts: p.launch.accounts, changedBy: p.launch.changedBy ?? null },
    safety: p.safety,
    sms: p.sms,
    alerts: { email: p.alerts.email ?? null },
    paused: p.killSwitch.sendingPaused,
  };
}

/** Fresh read; any failure reads as off + paused. */
export async function readEngineSettings(): Promise<EngineSettings> {
  try {
    const snap = await db.collection(COL.config).doc(CONFIG_DOC_ID).get();
    return parseEngineSettings(snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
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
