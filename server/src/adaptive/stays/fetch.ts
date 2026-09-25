/**
 * Fetching an owner's calendar link safely (plan §2.6 "Safe calendar fetching",
 * brief §1, D-C24) — pure: no Firestore, so its tests run without credentials.
 *
 *  - https only, port 443, no user:pass@ and no IP-literal hosts (Node skips the
 *    `lookup` hook for those, so they could never be checked);
 *  - the address must be public: every resolved IP is checked against private,
 *    loopback, link-local, CGNAT, unique-local, cloud-metadata, NAT64, IPv4-mapped and
 *    reserved ranges, and the socket connects to exactly the checked IP (the `lookup`
 *    hook pins it, `agent: false` — no pooled socket, no env proxy — so DNS rebinding
 *    can't swap it);
 *  - redirects by hand (at most 3), each hop re-checked the same way;
 *  - one 10 s deadline for the whole chain (a real abort that destroys the socket), a
 *    1 MB cap on the decompressed body.
 *
 * The URL is a secret (Airbnb's `?s=`, Booking.com's `?t=`). Nothing here puts it in an
 * error: `new URL()` throws ERR_INVALID_URL with the whole URL on `err.input` (and the
 * previous hop on `err.base`), so every parse is wrapped and turned into a bare code,
 * Node network errors are mapped to codes, and the result has no final URL.
 */

import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

export type FeedErrorCode =
  | 'BAD_URL'
  | 'BAD_REDIRECT'
  | 'NOT_HTTPS'
  | 'CREDENTIALS_IN_URL'
  | 'BAD_PORT'
  | 'IP_LITERAL'
  | 'BLOCKED_HOST'
  | 'BLOCKED_ADDRESS'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'BAD_ENCODING'
  | 'REDIRECT_WITHOUT_LOCATION'
  | 'TOO_MANY_REDIRECTS'
  | 'TLS'
  | 'NETWORK';

/** A fetch failure: the code only — never a URL, a host's answer or an address. */
export class FeedFetchError extends Error {
  constructor(public readonly code: FeedErrorCode) {
    super(code);
    this.name = 'FeedFetchError';
  }
}

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_REDIRECTS = 3;

const DENY = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  DENY.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [
  ['::', 96], // unspecified, and the deprecated IPv4-compatible ::a.b.c.d
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  DENY.addSubnet(a, p, 'ipv6');
}

/** Not a public unicast address (IPv4-mapped IPv6 is checked against the IPv4 rules). */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return DENY.check(mapped[1], 'ipv4');
    if (/^::ffff:/i.test(ip)) return true; // hex-written mapped form — never a feed host
  }
  return DENY.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const BLOCKED_HOST = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i;

/** Name resolution; injectable so tests never need real DNS. */
export type Resolve = (host: string, opts: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void) => void;
const systemResolve: Resolve = (host, opts, cb) => dns.lookup(host, opts, cb);

/** The HTTP request function (https.request); injectable for tests. */
export type RequestFn = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

/** A `lookup` for https.request that refuses non-public addresses and pins the checked ones. */
export function safeLookup(resolve: Resolve): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    resolve(hostname, { family: options.family as dns.LookupAllOptions['family'], hints: options.hints, all: true }, (err, addrs) => {
      if (err) return cb(new FeedFetchError('DNS_FAILED'));
      if (!addrs?.length) return cb(new FeedFetchError('DNS_FAILED'));
      if (addrs.some((a) => isBlockedIp(a.address))) return cb(new FeedFetchError('BLOCKED_ADDRESS'));
      if ((options as dns.LookupAllOptions).all) return cb(null, addrs); // Node >= 20 asks for all
      cb(null, addrs[0].address, addrs[0].family);
    });
  }) as unknown as net.LookupFunction;
}

/** `new URL()` without the URL ever reaching an error. */
function parseUrl(raw: string, base?: URL): URL {
  try {
    return base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new FeedFetchError(base ? 'BAD_REDIRECT' : 'BAD_URL');
  }
}

/** The rules every hop must pass before anything is resolved. */
export function checkUrl(u: URL): URL {
  if (u.protocol !== 'https:') throw new FeedFetchError('NOT_HTTPS');
  if (u.username || u.password) throw new FeedFetchError('CREDENTIALS_IN_URL');
  if (u.port && u.port !== '443') throw new FeedFetchError('BAD_PORT');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) throw new FeedFetchError('IP_LITERAL');
  if (!host || !host.includes('.') || BLOCKED_HOST.test(host) || host === 'metadata.google.internal') throw new FeedFetchError('BLOCKED_HOST');
  return u;
}

/** A calendar link that passes the rules (for saving): the parsed URL, or the error code. */
export function checkFeedUrl(raw: string): URL {
  return checkUrl(parseUrl(raw));
}

/** Node's own error codes → ours, so no raw message (which may name the host) escapes. */
function codeOf(err: unknown): FeedErrorCode {
  if (err instanceof FeedFetchError) return err.code;
  const e = err as { code?: string; name?: string };
  const code = String(e?.code ?? '');
  const name = String(e?.name ?? '');
  if (code === 'ABORT_ERR' || name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'DNS_FAILED';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS';
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') return 'BAD_ENCODING';
  return 'NETWORK';
}

interface Hop {
  status: number;
  location?: string;
  etag?: string | null;
  body?: Buffer;
}

function once(u: URL, signal: AbortSignal, maxBytes: number, etag: string | null, lookup: net.LookupFunction, request: RequestFn): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(new FeedFetchError(codeOf(err)));
    };
    const ok = (hop: Hop) => {
      if (settled) return;
      settled = true;
      resolve(hop);
    };
    if (signal.aborted) return fail(new FeedFetchError('TIMEOUT'));
    const headers: Record<string, string> = {
      'user-agent': 'HeidiFi-Calendar/1.0',
      accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
      'accept-encoding': 'identity',
    };
    if (etag) headers['if-none-match'] = etag;
    let req: ClientRequest;
    try {
      req = request(
        { protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: 443, path: u.pathname + u.search, method: 'GET', headers, lookup, agent: false, signal, maxHeaderSize: 16_384 },
        (res) => {
          const status = res.statusCode ?? 0;
          const header = (name: string) => {
            const v = res.headers[name];
            return Array.isArray(v) ? v[0] : v;
          };
          res.on('error', fail);
          if (status >= 300 && status < 400 && status !== 304) {
            res.resume();
            return ok({ status, location: header('location') ?? '' });
          }
          if (status !== 200) {
            res.resume();
            return ok({ status, etag: header('etag') ?? null });
          }
          if (Number(header('content-length') ?? 0) > maxBytes) {
            res.destroy();
            return fail(new FeedFetchError('TOO_LARGE'));
          }
          // We ask for no compression; a server that compresses anyway is decoded (the cap
          // counts decoded bytes), anything else refused.
          const enc = String(header('content-encoding') ?? 'identity').trim().toLowerCase();
          const body = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'identity' || enc === '' ? res : null;
          if (!body) {
            res.destroy();
            return fail(new FeedFetchError('BAD_ENCODING'));
          }
          const chunks: Buffer[] = [];
          let n = 0;
          body.on('data', (c: Buffer) => {
            n += c.length;
            if (n > maxBytes) {
              res.destroy();
              if (body !== res) body.destroy();
              fail(new FeedFetchError('TOO_LARGE'));
            } else chunks.push(c);
          });
          body.on('end', () => ok({ status, etag: header('etag') ?? null, body: Buffer.concat(chunks) }));
          body.on('error', fail);
          // A body that drips past the deadline is cut off too.
          signal.addEventListener('abort', () => {
            res.destroy();
            fail(new FeedFetchError('TIMEOUT'));
          }, { once: true });
        },
      );
    } catch (err) {
      return fail(err);
    }
    req.on('error', fail);
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

export interface FetchFeedOptions {
  /** The last response's ETag (a 304 then means "the same content again"). */
  etag?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: Resolve;
  request?: RequestFn;
}

/** No final URL (any hop can carry a token), no headers beyond the ETag. */
export interface FetchFeedResult {
  status: number;
  etag: string | null;
  body?: Buffer;
}

/**
 * GETs a calendar link under the rules above. Resolves with the final hop's status (a
 * 200 with its body, a 304, or an error status — the caller decides); throws only a
 * `FeedFetchError`.
 */
export async function fetchFeed(raw: string, o: FetchFeedOptions = {}): Promise<FetchFeedResult> {
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_BODY_BYTES;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); // one budget for the whole chain
  const lookup = safeLookup(o.resolve ?? systemResolve);
  const request = o.request ?? (https.request as unknown as RequestFn);
  try {
    let u = checkUrl(parseUrl(raw));
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const r = await Promise.race([
        once(u, controller.signal, maxBytes, o.etag ?? null, lookup, request),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new FeedFetchError('TIMEOUT'));
          controller.signal.addEventListener('abort', () => reject(new FeedFetchError('TIMEOUT')), { once: true });
        }),
      ]);
      if (r.location === undefined) return { status: r.status, etag: r.etag ?? null, ...(r.body ? { body: r.body } : {}) };
      if (!r.location) throw new FeedFetchError('REDIRECT_WITHOUT_LOCATION');
      u = checkUrl(parseUrl(r.location, u)); // every hop: wrapped parse, https only, no IP literal; lookup checks the IPs
    }
    throw new FeedFetchError('TOO_MANY_REDIRECTS');
  } catch (err) {
    throw err instanceof FeedFetchError ? err : new FeedFetchError(codeOf(err));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
