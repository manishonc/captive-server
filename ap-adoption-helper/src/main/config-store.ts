// Effective app config = bundled config.json (build-time branding/defaults)
// merged with the user's settings.json overrides in userData.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './lib/log';

const FALLBACK_CONFIG: AppConfig = {
  appName: 'HeidiFi AP Adoption Helper',
  informUrl: 'http://34.116.224.72:8085/inform',
  homeUrl: 'https://heidifi.ai/',
  brand: { primary: '#1c2b4a', surface: '#f4f5f7', background: '#ffffff' },
};

let bundled: AppConfig | null = null;

function bundledConfig(): AppConfig {
  if (bundled) return bundled;
  let config = FALLBACK_CONFIG;
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'config.json'), 'utf8');
    config = { ...FALLBACK_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    log(`Could not read bundled config.json, using defaults: ${(err as Error).message}`);
  }
  bundled = config;
  return config;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function readSettings(): UserSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSettings(patch: UserSettings): UserSettings {
  const merged: Record<string, unknown> = { ...readSettings(), ...patch };
  // An empty value clears the override.
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value == null || (typeof value === 'string' && value.trim() === '')) delete merged[key];
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  return merged as UserSettings;
}

export function effectiveConfig(): EffectiveConfig {
  const config = bundledConfig();
  const settings = readSettings();
  return {
    ...config,
    settings,
    effectiveInformUrl: settings.controllerUrl?.trim() || config.informUrl,
  };
}
