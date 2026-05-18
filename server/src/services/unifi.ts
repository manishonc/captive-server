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

export async function authorizeGuest(
  config: UnifiConfig,
  clientMac: string,
  minutes: number,
): Promise<void> {
  const apiBase =
    config.controllerType === 'udm'
      ? `${config.controllerUrl}/proxy/network`
      : config.controllerUrl;

  const url = `${apiBase}/api/s/${config.site}/cmd/stamgr`;
  const body = JSON.stringify({ cmd: 'authorize-guest', mac: clientMac.toLowerCase(), minutes });

  const attempt = async (session: Session): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      Cookie: session.cookie,
    };
    if (session.csrfToken) headers['X-Csrf-Token'] = session.csrfToken;
    return rawRequest(url, { method: 'POST', headers, body, rejectUnauthorized: false });
  };

  let session = await getSession(config);
  let res = await attempt(session);

  if (res.status === 401) {
    sessions.delete(config.controllerUrl);
    session = await login(config);
    res = await attempt(session);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`UniFi authorize-guest failed HTTP ${res.status}: ${res.body}`);
  }

  console.log('[UNIFI] Authorized guest', clientMac, 'for', minutes, 'min via', config.controllerUrl);
}
