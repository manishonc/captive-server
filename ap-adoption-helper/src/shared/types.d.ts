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
  /** HeidiFi API origin for the self-serve setup flow. Must be https — see main/lib/api.ts. */
  apiBaseUrl: string;
  /** Tenant dashboard, used for the "continue on your dashboard" button. */
  dashboardUrl: string;
  supportEmail: string;
  brand: BrandConfig;
}

interface UserSettings {
  /** Overrides AppConfig.informUrl when set (custom controller). */
  controllerUrl?: string;
  /** Overrides the default 'ubnt' SSH password when set. */
  sshPassword?: string;
  /** Overrides AppConfig.apiBaseUrl when set (staging / self-hosted). */
  apiBaseUrl?: string;
}

interface EffectiveConfig extends AppConfig {
  settings: UserSettings;
  effectiveInformUrl: string;
  effectiveApiBaseUrl: string;
}

// ── Self-serve setup (HeidiFi API) ────────────────────────────────────────────

interface AdoptionVenue {
  id: string;
  name: string;
}

interface AdoptionSession {
  venues: AdoptionVenue[];
}

interface AdoptionVenueDetail {
  id: string;
  name: string;
  /** Null when this location has no WiFi network yet. */
  wifiSsid: string | null;
  apCount: number;
}

type AdoptionPrecheckState =
  | 'unknown'
  | 'pending'
  | 'adopted_unregistered'
  | 'already_registered_here'
  | 'registered_elsewhere';

interface AdoptionPrecheckDevice {
  /** Canonical MAC (lowercase, no separators) — compare with canonMac, not ===. */
  mac: string;
  state: AdoptionPrecheckState;
  /** Only ever present for `already_registered_here`. */
  venueName?: string;
  apName?: string;
}

interface AdoptionPrecheck {
  devices: AdoptionPrecheckDevice[];
}

type AdoptionPhase = 'waiting_for_device' | 'pending' | 'adopting' | 'connected' | 'offline';

interface AdoptionStatus {
  phase: AdoptionPhase;
  wifiApplied: boolean;
  retryAfterSeconds: number;
  apName?: string;
  venueName?: string;
}

interface AdoptionClaimRequest {
  code: string;
  mac: string;
  venueId: string;
  ssid: string;
  apName?: string;
  model?: string;
  firmware?: string;
  /** Set only when the installer explicitly unlocked and confirmed a rename. */
  confirmRename?: boolean;
}

interface AdoptionClaim {
  apId: string;
  apName: string;
  venueId: string;
  venueName: string;
  ssid: string;
  phase: AdoptionPhase;
  wifiApplied: boolean;
  retryAfterSeconds: number;
}

type AdoptionErrorCode =
  | 'OFFLINE'
  | 'TIMEOUT'
  | 'INSECURE_ENDPOINT'
  | 'BAD_CODE'
  | 'RATE_LIMITED'
  | 'NO_VENUES'
  | 'VENUE_GONE'
  | 'DEVICE_NOT_READY'
  | 'MAC_CONFLICT'
  | 'SSID_INVALID'
  | 'SSID_NEEDS_CONFIRM'
  | 'PLAN_LIMIT'
  | 'SUBSCRIPTION_LAPSED'
  | 'DAILY_LIMIT'
  | 'UNAVAILABLE'
  | 'VERSION_UNSUPPORTED'
  | 'CLAIM_TIMEOUT'
  | 'SERVER_ERROR'
  | 'BAD_RESPONSE';

interface AdoptionOk<T> {
  ok: true;
  data: T;
}

interface AdoptionErr {
  ok: false;
  code: AdoptionErrorCode;
  /** Server-supplied detail, safe to show. Not every code carries one. */
  detail?: string;
  /** Present on SSID_NEEDS_CONFIRM — the name the location currently broadcasts. */
  ssid?: string;
}

type AdoptionResult<T> = AdoptionOk<T> | AdoptionErr;

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
  /** Exchange a setup code for the account's locations. */
  adoptionSession(req: { code: string }): Promise<AdoptionResult<AdoptionSession>>;
  adoptionVenue(req: { code: string; venueId: string }): Promise<AdoptionResult<AdoptionVenueDetail>>;
  /** Batched — one call for every device the scan found. */
  adoptionPrecheck(req: { code: string; macs: string[] }): Promise<AdoptionResult<AdoptionPrecheck>>;
  adoptionClaim(req: AdoptionClaimRequest): Promise<AdoptionResult<AdoptionClaim>>;
  adoptionStatus(req: { code: string; mac: string }): Promise<AdoptionResult<AdoptionStatus>>;
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
