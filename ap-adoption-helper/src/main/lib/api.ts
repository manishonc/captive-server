// HTTP client for the HeidiFi self-serve setup API.
//
// Lives in the main process because it has to: the renderer's CSP is `default-src 'self'`
// with no connect-src, so a fetch from there is blocked outright. Everything crosses via IPC.
//
// Uses Electron's `net.fetch` rather than the global one — it goes through Chromium's network
// stack, so it honours system proxy settings and certificate stores. Venue networks are
// exactly where a corporate proxy shows up.
//
// Returns result objects, never throws and never rejects. An `ipcRenderer.invoke` rejection
// crosses the bridge as a stringified Error and loses the `code` property, which is the only
// part the UI needs — the same reason the existing AdoptResult is a discriminated union.

import { net } from 'electron';
import { log } from './log';
import { mapFailure } from './api-errors';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiOptions {
  timeoutMs?: number;
  helperVersion: string;
}

export async function apiPost<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  opts: ApiOptions,
): Promise<AdoptionResult<T>> {
  let url: URL;
  try {
    url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    return { ok: false, code: 'INSECURE_ENDPOINT', detail: 'The HeidiFi address is not valid.' };
  }

  // The setup code is a bearer credential. Refuse to put it on the wire in the clear —
  // installers work on café and hotel WiFi, which is precisely where that gets read.
  // localhost is exempt so `npm start` against a dev server works.
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !localhost) {
    log(`Refusing to send a setup code over ${url.protocol}//${url.host}`);
    return { ok: false, code: 'INSECURE_ENDPOINT', detail: url.protocol };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  try {
    const res = await net.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Nothing reads this yet. Sending it from day one is what will make it possible to
        // refuse old clients later without shipping a new mechanism to detect them.
        'x-heidifi-helper': opts.helperVersion,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    // Status and timing only — the request body carries the setup code.
    log(`POST ${path} -> ${res.status} (${Date.now() - started}ms)`);

    if (!res.ok) {
      const detail = (json as { message?: unknown } | null)?.message;
      const ssid = (json as { ssid?: unknown } | null)?.ssid;
      return {
        ok: false,
        code: mapFailure(res.status, json),
        detail: typeof detail === 'string' ? detail : undefined,
        ssid: typeof ssid === 'string' ? ssid : undefined,
      };
    }
    if (json === null) return { ok: false, code: 'BAD_RESPONSE' };
    return { ok: true, data: json as T };
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    log(`POST ${path} failed: ${aborted ? 'timed out' : (err as Error).message}`);
    return { ok: false, code: aborted ? 'TIMEOUT' : 'OFFLINE' };
  } finally {
    clearTimeout(timer);
  }
}
