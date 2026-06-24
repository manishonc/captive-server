import https from 'node:https';
import http from 'node:http';
import { UnifiConfig } from '../types/captive';

interface Session {
  cookie: string;
  csrfToken?: string;
  expiresAt: number;
}

// In-memory session cache keyed by controllerUrl
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 55 * 60 * 1000; // 55 min (controller sessions last ~1h)

export interface UnifiDevice {
  mac: string;
  state: number;
  name?: string;
  model?: string;
  version?: string;
  uptime?: number;
  lastSeen?: number;
}

export interface UnifiWlan {
  _id: string;
  name: string;
  enabled?: boolean;
  ap_group_ids?: string[];
  ap_group_mode?: string;
  wlangroup_id?: string;
  [k: string]: unknown;
}

export interface UnifiApGroup {
  _id: string;
  name: string;
  device_macs?: string[];
  attr_no_delete?: boolean;
  [k: string]: unknown;
}

export function normalizeMac(mac: string): string {
  return String(mac || '').toLowerCase().trim();
}

/** state === 1 means the device is connected/adopted and online. */
export function mapDeviceState(state: number | undefined): 'online' | 'offline' {
  return Number(state) === 1 ? 'online' : 'offline';
}

/**
 * The controller URL captive-server should dial. The AP doc's stored `controllerUrl`
 * is the PUBLIC address (for the admin browser / setup guide); captive-server runs on
 * the same Docker network as the controller and must use the internal address (e.g.
 * `https://unifi:8443`) — a container cannot NAT-hairpin to its host's public IP.
 * Set `UNIFI_CONTROLLER_URL` on the captive-server deployment to force it; falls back
 * to the AP's stored URL when unset (no behavior change).
 */
export function effectiveControllerUrl(storedUrl?: string): string {
  return String(process.env.UNIFI_CONTROLLER_URL || storedUrl || '').replace(/\/+$/, '');
}

function rawRequest(
  urlStr: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    rejectUnauthorized: boolean;
  },
): Promise<{ status: number; setCookie: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib: typeof https = isHttps ? https : (http as unknown as typeof https);

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: opts.rejectUnauthorized,
      },
      (res) => {
        let body = '';
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookie: (res.headers['set-cookie'] as string[]) ?? [],
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function extractCookies(setCookieHeaders: string[]): { unifises?: string; csrfToken?: string } {
  let unifises: string | undefined;
  let csrfToken: string | undefined;
  for (const header of setCookieHeaders) {
    const sesMatch = header.match(/unifises=([^;]+)/);
    if (sesMatch) unifises = sesMatch[1];
    const csrfMatch = header.match(/unificesrftoken=([^;]+)/);
    if (csrfMatch) csrfToken = csrfMatch[1];
  }
  return { unifises, csrfToken };
}

async function login(config: UnifiConfig): Promise<Session> {
  const loginPath = config.controllerType === 'udm' ? '/api/auth/login' : '/api/login';
  const body = JSON.stringify({ username: config.username, password: config.password });

  const res = await rawRequest(`${config.controllerUrl}${loginPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    rejectUnauthorized: false,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`UniFi login failed HTTP ${res.status}: ${res.body}`);
  }

  const { unifises, csrfToken } = extractCookies(res.setCookie);
  if (!unifises) throw new Error('UniFi login: no unifises cookie in response');

  const session: Session = {
    cookie: `unifises=${unifises}${csrfToken ? `; unificesrftoken=${csrfToken}` : ''}`,
    csrfToken,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(config.controllerUrl, session);
  console.log('[UNIFI] Logged in to', config.controllerUrl);
  return session;
}

async function getSession(config: UnifiConfig): Promise<Session> {
  const cached = sessions.get(config.controllerUrl);
  if (cached && cached.expiresAt > Date.now()) return cached;
  return login(config);
}

function apiBase(config: UnifiConfig): string {
  return config.controllerType === 'udm' ? `${config.controllerUrl}/proxy/network` : config.controllerUrl;
}
function sitePath(config: UnifiConfig, path: string): string {
  return `${apiBase(config)}/api/s/${config.site}/${path}`;
}

export interface UnifiResponse {
  status: number;
  body: any;
}

/**
 * Authenticated site-scoped request with one re-login retry on 401. Returns the
 * HTTP status + parsed JSON body. Mirrors the cookie + X-Csrf-Token handling used
 * by authorizeGuest. Does NOT throw on non-2xx — callers decide.
 */
export async function siteRequest(
  config: UnifiConfig,
  method: string,
  path: string,
  payload?: unknown,
): Promise<UnifiResponse> {
  const url = sitePath(config, path);
  const bodyStr = payload !== undefined ? JSON.stringify(payload) : undefined;

  const attempt = async (session: Session) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Cookie: session.cookie };
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    if (session.csrfToken) headers['X-Csrf-Token'] = session.csrfToken;
    return rawRequest(url, { method, headers, body: bodyStr, rejectUnauthorized: false });
  };

  let session = await getSession(config);
  let res = await attempt(session);

  if (res.status === 401) {
    sessions.delete(config.controllerUrl);
    session = await login(config);
    res = await attempt(session);
  }

  let parsed: any;
  try {
    parsed = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    parsed = res.body;
  }
  return { status: res.status, body: parsed };
}

function siteV2Path(config: UnifiConfig, path: string): string {
  return `${apiBase(config)}/v2/api/site/${config.site}/${path}`;
}

/**
 * v2 API request (`/v2/api/site/{site}/...`). UniFi Network 7.x+ serves AP groups
 * here; the legacy v1 `rest/apgroup` returns `api.err.InvalidObject` on 10.x. v2
 * responses are RAW JSON (array/object), NOT wrapped in `{meta, data}`.
 */
export async function siteRequestV2(
  config: UnifiConfig,
  method: string,
  path: string,
  payload?: unknown,
): Promise<UnifiResponse> {
  const url = siteV2Path(config, path);
  const bodyStr = payload !== undefined ? JSON.stringify(payload) : undefined;

  const attempt = async (session: Session) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Cookie: session.cookie };
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    if (session.csrfToken) headers['X-Csrf-Token'] = session.csrfToken;
    return rawRequest(url, { method, headers, body: bodyStr, rejectUnauthorized: false });
  };

  let session = await getSession(config);
  let res = await attempt(session);
  if (res.status === 401) {
    sessions.delete(config.controllerUrl);
    session = await login(config);
    res = await attempt(session);
  }
  let parsed: any;
  try {
    parsed = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    parsed = res.body;
  }
  return { status: res.status, body: parsed };
}

/** Unwrap a v2 response (raw array/object), throwing a descriptive error on non-2xx. */
function v2Data(res: UnifiResponse, what: string): any {
  if (res.status < 200 || res.status >= 300) {
    const detail = res.body?.message || res.body?.meta?.msg;
    throw new Error(`UniFi v2 ${what} failed HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.body;
}

function ensureOk(res: UnifiResponse, what: string): any[] {
  if (res.status < 200 || res.status >= 300) {
    // Surface the controller's full reason (meta.msg, e.g. api.err.*, or the raw body).
    const detail = res.body?.meta?.msg || (res.body ? JSON.stringify(res.body) : '');
    throw new Error(`UniFi ${what} failed HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.body?.data ?? [];
}

// ── Guest authorization (unchanged behavior) ──────────────────────────────────

export async function authorizeGuest(config: UnifiConfig, clientMac: string, minutes: number): Promise<void> {
  const res = await siteRequest(config, 'POST', 'cmd/stamgr', {
    cmd: 'authorize-guest',
    mac: normalizeMac(clientMac),
    minutes,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`UniFi authorize-guest failed HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  console.log('[UNIFI] Authorized guest', clientMac, 'for', minutes, 'min via', config.controllerUrl);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getDevices(config: UnifiConfig): Promise<UnifiDevice[]> {
  const rows = ensureOk(await siteRequest(config, 'GET', 'stat/device'), 'stat/device');
  return rows.map((d: any) => ({
    mac: normalizeMac(d.mac),
    state: Number(d.state),
    name: d.name,
    model: d.model,
    version: d.version,
    uptime: d.uptime,
    lastSeen: d.last_seen,
  }));
}

export async function getApGroups(config: UnifiConfig): Promise<UnifiApGroup[]> {
  // AP groups live on the v2 API (Network 7.x+); v1 rest/apgroup is gone on 10.x.
  const body = v2Data(await siteRequestV2(config, 'GET', 'apgroups'), 'apgroups');
  return (Array.isArray(body) ? body : body?.data ?? []) as UnifiApGroup[];
}

export async function getWlans(config: UnifiConfig): Promise<UnifiWlan[]> {
  return ensureOk(await siteRequest(config, 'GET', 'rest/wlanconf'), 'rest/wlanconf') as UnifiWlan[];
}

/** Non-throwing GET for diagnostics — returns status + parsed body. */
export async function rawSiteGet(config: UnifiConfig, path: string): Promise<UnifiResponse> {
  return siteRequest(config, 'GET', path);
}

// ── WLAN / AP-group orchestration primitives ──────────────────────────────────

/**
 * Pick a guest/hotspot WLAN to clone captive-portal settings from. Prefers a WLAN
 * whose name matches `templateName`, else the first portal-enabled WLAN, else the
 * first WLAN.
 */
export async function findGuestWlanTemplate(
  config: UnifiConfig,
  templateName?: string,
): Promise<UnifiWlan | null> {
  const wlans = await getWlans(config);
  if (templateName) {
    const byName = wlans.find((w) => w.name === templateName);
    if (byName) return byName;
  }
  const portal = wlans.find(
    (w) => (w as any).portal_enabled || (w as any).x_portal_customized || (w as any).hotspot_policy,
  );
  return portal || wlans[0] || null;
}

/** Find-or-create/update an AP group whose members are exactly `memberMacs`. Returns its id. */
export async function ensureApGroup(
  config: UnifiConfig,
  args: { groupId?: string | null; name: string; memberMacs: string[] },
): Promise<string> {
  const macs = Array.from(new Set(args.memberMacs.map(normalizeMac).filter(Boolean)));
  const groups = await getApGroups(config);

  const existing =
    (args.groupId && groups.find((g) => g._id === args.groupId)) ||
    groups.find((g) => g.name === args.name && !g.attr_no_delete) ||
    null;

  if (existing) {
    v2Data(
      await siteRequestV2(config, 'PUT', `apgroups/${existing._id}`, { ...existing, name: args.name, device_macs: macs }),
      'update apgroup',
    );
    return existing._id;
  }

  const created = v2Data(await siteRequestV2(config, 'POST', 'apgroups', { name: args.name, device_macs: macs }), 'create apgroup');
  const id = Array.isArray(created) ? created[0]?._id : created?._id;
  if (!id) throw new Error('UniFi v2 did not return the created AP group id.');
  return id;
}

/**
 * Find-or-create/update a WLAN scoped to a single AP group and set its SSID (`name`).
 * On create, clones `template` so captive-portal/hotspot config is preserved.
 * Enforces SSID uniqueness per site. Returns the WLAN id.
 */
export async function ensureWlan(
  config: UnifiConfig,
  args: { wlanId?: string | null; ssid: string; apGroupId: string; template?: UnifiWlan | null },
): Promise<string> {
  const wlans = await getWlans(config);

  const clash = wlans.find((w) => w.name === args.ssid && w._id !== args.wlanId);
  if (clash) throw new Error(`The WiFi name "${args.ssid}" is already in use on this controller.`);

  const scope = { ap_group_ids: [args.apGroupId], ap_group_mode: 'specific' as const };
  const existing = (args.wlanId && wlans.find((w) => w._id === args.wlanId)) || null;

  if (existing) {
    ensureOk(await siteRequest(config, 'PUT', `rest/wlanconf/${existing._id}`, { ...existing, name: args.ssid, enabled: true, ...scope }), 'update wlanconf');
    return existing._id;
  }

  // Cloning the full WLAN object trips `api.err.InvalidPayload` — the controller
  // rejects GET-only/derived fields on create. Build a MINIMAL payload from the
  // template's key references instead. The captive portal is a site-level
  // guest-control setting, so a new `is_guest` WLAN inherits it automatically.
  const t: Record<string, any> = (args.template as Record<string, any>) || {};
  const createBody: Record<string, unknown> = {
    name: args.ssid,
    enabled: true,
    security: t.security ?? 'open',
    is_guest: t.is_guest ?? true,
    hide_ssid: t.hide_ssid ?? false,
    usergroup_id: t.usergroup_id,
    networkconf_id: t.networkconf_id,
    ...(t.wlan_bands ? { wlan_bands: t.wlan_bands } : t.wlan_band ? { wlan_band: t.wlan_band } : {}),
    ...scope,
  };
  const created = ensureOk(await siteRequest(config, 'POST', 'rest/wlanconf', createBody), 'create wlanconf');
  const id = created?.[0]?._id;
  if (!id) throw new Error('UniFi did not return the created WLAN id.');
  return id;
}

/** Remove a member MAC from an AP group. Returns the count of remaining members. */
export async function removeMacFromApGroup(config: UnifiConfig, groupId: string, mac: string): Promise<number> {
  const groups = await getApGroups(config);
  const g = groups.find((x) => x._id === groupId);
  if (!g) return 0;
  const remaining = (g.device_macs || []).map(normalizeMac).filter((m) => m !== normalizeMac(mac));
  v2Data(await siteRequestV2(config, 'PUT', `apgroups/${groupId}`, { ...g, device_macs: remaining }), 'update apgroup');
  return remaining.length;
}

export async function deleteApGroup(config: UnifiConfig, groupId: string): Promise<void> {
  const res = await siteRequestV2(config, 'DELETE', `apgroups/${groupId}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`UniFi v2 delete apgroup failed HTTP ${res.status}`);
}

export async function deleteWlan(config: UnifiConfig, wlanId: string): Promise<void> {
  const res = await siteRequest(config, 'DELETE', `rest/wlanconf/${wlanId}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`UniFi delete wlanconf failed HTTP ${res.status}`);
}
