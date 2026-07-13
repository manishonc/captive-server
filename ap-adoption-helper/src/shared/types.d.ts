// Ambient types shared by the main process, preload, and renderer.
// Declaration-only (no imports/exports) so the renderer can stay a classic
// script with no module loader.

interface DiscoveredDevice {
  mac: string;
  ip: string;
  hostname?: string;
  model?: string;
  firmware?: string;
  isUbiquitiOui: boolean;
  /** Hex dump of the discovery reply, for the Advanced panel. */
  raw?: string;
}

type AdoptErrorCode =
  | 'INVALID_URL'
  | 'AUTH_FAILED'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'COMMAND_NOT_FOUND'
  | 'UNEXPECTED_OUTPUT';

interface AdoptSuccess {
  ok: true;
  informUrl: string;
  raw: string;
}

interface AdoptFailure {
  ok: false;
  code: AdoptErrorCode;
  raw: string;
}

type AdoptResult = AdoptSuccess | AdoptFailure;

interface AdoptRequest {
  ip: string;
}

interface BrandConfig {
  primary: string;
  surface: string;
  background: string;
}

interface AppConfig {
  appName: string;
  informUrl: string;
  homeUrl: string;
  brand: BrandConfig;
}

interface UserSettings {
  /** Overrides AppConfig.informUrl when set (custom controller). */
  controllerUrl?: string;
  /** Overrides the default 'ubnt' SSH password when set. */
  sshPassword?: string;
}

interface EffectiveConfig extends AppConfig {
  settings: UserSettings;
  effectiveInformUrl: string;
}

interface PreflightResult {
  reachable: boolean;
  host: string;
  port: number;
  error?: string;
}

interface HeidiFiApi {
  scan(): Promise<DiscoveredDevice[]>;
  adopt(req: AdoptRequest): Promise<AdoptResult>;
  preflight(): Promise<PreflightResult>;
  getConfig(): Promise<EffectiveConfig>;
  saveSettings(settings: UserSettings): Promise<EffectiveConfig>;
  getLog(): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  onDevice(cb: (device: DiscoveredDevice) => void): void;
  onLog(cb: (line: string) => void): void;
}

interface Window {
  heidifi: HeidiFiApi;
}
