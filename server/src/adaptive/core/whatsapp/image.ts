/**
 * WhatsApp header pictures — the pure part: which links we accept and whether a file is a picture
 * WhatsApp takes (Meta's media rules, read 2026-11-10: JPEG or PNG, at most 5 MB, 8-bit RGB/RGBA,
 * at most 4096 px on an edge; the template sample upload takes jpeg/png only, so no WebP here).
 *
 * One picture per venue (`AdaptiveVenues.whatsappImage`) goes at the top of the venue's image
 * templates; each image template also has a sample picture for Meta's review (`source.header.sample`).
 * Both are links into HeidiFi's media library on the Bunny CDN (the dashboard's Media page), the
 * same rule as a splash logo.
 *
 * Pure: no network, no Firestore — the bytes come in as arguments.
 */

export const WA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WA_IMAGE_MAX_EDGE = 4096;
export const WA_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
export type WaImageType = (typeof WA_IMAGE_TYPES)[number];

/** A link we accept for a header picture: https, on the Bunny CDN (`*.b-cdn.net`), no login in it. */
export function waImageUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'Pick a picture';
  if (url.length > 1000) return 'The picture’s link is too long';
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'That isn’t a link to a picture';
  }
  if (u.protocol !== 'https:') return 'The picture’s link must start with https://';
  if (u.username || u.password) return 'The picture’s link can’t hold a login';
  if (u.port) return 'The picture’s link can’t name a port';
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.b-cdn\.net$/.test(host)) return 'Pick a picture from the media library (Media in the dashboard)';
  return null;
}

export interface WaImageFacts {
  type: WaImageType;
  width: number;
  height: number;
  bytes: number;
}

/** The file → its facts, or the reason WhatsApp would refuse it (in words for the owner). */
export function inspectWaImage(buf: Uint8Array): { ok: true; facts: WaImageFacts } | { ok: false; reason: string } {
  if (!buf.length) return { ok: false, reason: 'The picture is empty' };
  if (buf.length > WA_IMAGE_MAX_BYTES) return { ok: false, reason: `The picture is ${mb(buf.length)}; WhatsApp takes at most 5 MB` };
  const png = pngFacts(buf);
  const jpeg = png ? null : jpegFacts(buf);
  const f = png ?? jpeg;
  if (!f) return { ok: false, reason: 'WhatsApp takes JPEG or PNG pictures only (save it as .jpg or .png)' };
  if ('reason' in f) return { ok: false, reason: f.reason };
  if (!f.width || !f.height) return { ok: false, reason: 'The picture’s size can’t be read' };
  if (f.width > WA_IMAGE_MAX_EDGE || f.height > WA_IMAGE_MAX_EDGE) {
    return { ok: false, reason: `The picture is ${f.width}×${f.height} px; WhatsApp takes at most ${WA_IMAGE_MAX_EDGE} px on a side` };
  }
  return { ok: true, facts: { type: f.type, width: f.width, height: f.height, bytes: buf.length } };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

type Read = { type: WaImageType; width: number; height: number } | { reason: string };

/** PNG: the signature, then IHDR (width, height, bit depth, colour type). WhatsApp wants 8-bit. */
function pngFacts(b: Uint8Array): Read | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || sig.some((v, i) => b[i] !== v)) return null;
  if (b.length < 29 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return { reason: 'The PNG file is damaged' };
  const width = u32(b, 16);
  const height = u32(b, 20);
  const depth = b[24];
  const colour = b[25];
  // 8-bit RGB (2) or RGBA (6); palette (3) and grey (0, 4) PNGs are 8-bit pictures too — WhatsApp shows them.
  if (depth !== 8) return { reason: `The PNG uses ${depth}-bit colour; WhatsApp takes 8-bit pictures (save it again as an ordinary PNG or JPEG)` };
  if (![0, 2, 3, 4, 6].includes(colour)) return { reason: 'The PNG file is damaged' };
  return { type: 'image/png', width, height };
}

/** JPEG: SOI, then the first frame header (SOF0–SOF15 but DHT/JPG/DAC) — precision, height, width, components. */
function jpegFacts(b: Uint8Array): Read | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return { reason: 'The JPEG file is damaged' };
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end, or the picture data without a frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return { reason: 'The JPEG file is damaged' };
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 >= b.length) return { reason: 'The JPEG file is damaged' };
      const precision = b[i + 4];
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const comps = b[i + 9];
      if (precision !== 8) return { reason: `The JPEG uses ${precision}-bit colour; WhatsApp takes 8-bit pictures` };
      // 1 = grey, 3 = colour (RGB/YCbCr); 4 = CMYK (print files), which phones show wrongly.
      if (comps === 4) return { reason: 'The JPEG is in print colours (CMYK); save it again for the web (RGB)' };
      return { type: 'image/jpeg', width, height };
    }
    i += 2 + len;
  }
  return { reason: 'The JPEG file is damaged (no picture size found)' };
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

/** What a venue's picture record looks like (`AdaptiveVenues.whatsappImage`). */
export interface WaVenueImage {
  url: string;
  type: WaImageType;
  width: number;
  height: number;
  bytes: number;
  /** `broken`: Meta couldn't load it at a send (131052/131053) — plain templates until it's set again. */
  status: 'ok' | 'broken';
  brokenReason?: string | null;
}

/** The picture a send may use, or null (no picture, or Meta couldn't load it last time). */
export function usableVenueImage(v: unknown): WaVenueImage | null {
  if (!v || typeof v !== 'object') return null;
  const img = v as Partial<WaVenueImage>;
  if (img.status !== 'ok' || typeof img.url !== 'string' || waImageUrlProblem(img.url)) return null;
  return img as WaVenueImage;
}

/** Meta's codes for a header picture it couldn't fetch or read at a send. */
export const WA_MEDIA_ERROR_CODES: ReadonlySet<string> = new Set(['131052', '131053']);
