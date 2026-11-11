/**
 * PR image header: reads a header picture from HeidiFi's media library (the Bunny CDN) and checks it
 * the way WhatsApp would (core/whatsapp/image.ts) — for the venue's WhatsApp picture when it is saved,
 * and for a template's sample picture at Send to Meta (which uploads the bytes to Meta).
 *
 * One GET, never more: https on *.b-cdn.net only (checked before the request), no redirects, a 15 s
 * timeout, at most 5 MB read (a bigger file is refused without reading it all). The link is never
 * logged (the CDN path holds the account id).
 */

import { inspectWaImage, waImageUrlProblem, WA_IMAGE_MAX_BYTES, type WaImageFacts } from '../core/whatsapp/image';

const TIMEOUT_MS = 15_000;

export type WaImageRead = { ok: true; bytes: Uint8Array; facts: WaImageFacts } | { ok: false; reason: string };

let fetchOverride: typeof fetch | null = null;

/** Tests only: a stub fetch for the pictures (null puts the real one back). */
export function __setImageFetchForTests(f: typeof fetch | null): void {
  fetchOverride = f;
}

export async function readWaImage(url: string): Promise<WaImageRead> {
  const bad = waImageUrlProblem(url);
  if (bad) return { ok: false, reason: bad };
  const fetchImpl = fetchOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  let status = 0;
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.trim(), { method: 'GET', signal: ctrl.signal, redirect: 'error', headers: { Accept: 'image/jpeg, image/png' } });
    } catch {
      return { ok: false, reason: 'The picture couldn’t be loaded (no answer from the media library)' };
    }
    status = res.status;
    if (res.status === 404) return { ok: false, reason: 'The picture isn’t in the media library any more' };
    if (!res.ok) return { ok: false, reason: `The picture couldn’t be loaded (the media library answered ${res.status})` };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > WA_IMAGE_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `The picture is ${(declared / 1024 / 1024).toFixed(1)} MB; WhatsApp takes at most 5 MB` };
    }
    const bytes = await readCapped(res, WA_IMAGE_MAX_BYTES + 1);
    if (!bytes) return { ok: false, reason: 'The picture couldn’t be read' };
    const seen = inspectWaImage(bytes);
    if (!seen.ok) return seen;
    return { ok: true, bytes, facts: seen.facts };
  } finally {
    clearTimeout(timer);
    console.log(`[WA IMAGE] GET ${status || 'no-answer'} ${Date.now() - started}ms`);
  }
}

/** The body, stopping once it passes `cap` bytes (then a slice of `cap`: the size check refuses it). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  try {
    if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, cap);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= cap) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const out = new Uint8Array(Math.min(total, cap));
    let at = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (at >= out.length) break;
    }
    return out;
  } catch {
    return null;
  }
}
