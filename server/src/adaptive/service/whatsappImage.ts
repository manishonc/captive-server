/**
 * The venue's WhatsApp picture (PR image header): the picture at the top of the venue's WhatsApp
 * messages when a message has an image template (`AdaptiveVenues.whatsappImage`). The owner picks it
 * from the media library (owner portal → Adaptive → venue settings); a super admin through the MCP
 * (`set_venue_whatsapp_image`). Without one — or while Meta couldn't load it (`status: 'broken'`) —
 * the venue's guests get the plain templates (no picture): WhatsApp still sends.
 *
 *   GET  …/venues/:venueId/whatsapp-image             → { image | null, rules }
 *   PUT  …/venues/:venueId/whatsapp-image {url|null}  → the same (null removes it)
 *
 * A picture is read and checked when it's saved (JPEG/PNG, ≤ 5 MB, ≤ 4096 px, 8-bit), never at send.
 */

import { z } from 'zod';
import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import { getVenues } from '../store/tenantData';
import { ApiError, conflict, validationFailed } from '../api/errors';
import { toJson } from '../store/serialize';
import type { Actor } from '../core/schemas';
import { WA_IMAGE_MAX_BYTES, WA_IMAGE_MAX_EDGE, type WaVenueImage } from '../core/whatsapp/image';
import { readWaImage } from '../whatsapp/imageFetch';

const RULES = {
  types: ['image/jpeg', 'image/png'],
  maxBytes: WA_IMAGE_MAX_BYTES,
  maxEdge: WA_IMAGE_MAX_EDGE,
  hint: 'JPEG or PNG from the media library, at most 5 MB. Landscape pictures look best (WhatsApp shows them across the top of the message).',
};

const putSchema = z.object({ url: z.string().trim().max(1000).nullable() }).strict();

async function ownedVenue(tenantUserId: string, venueId: string): Promise<void> {
  const venue = (await getVenues([venueId])).get(venueId);
  if (!venue || venue.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
}

function viewOf(raw: unknown, at: unknown) {
  const img = raw && typeof raw === 'object' ? (raw as Partial<WaVenueImage> & Record<string, unknown>) : null;
  if (!img || typeof img.url !== 'string') return { image: null, rules: RULES };
  return {
    image: {
      url: img.url,
      type: img.type ?? null,
      width: img.width ?? null,
      height: img.height ?? null,
      bytes: img.bytes ?? null,
      status: img.status === 'broken' ? 'broken' : 'ok',
      brokenReason: img.status === 'broken' ? String(img.brokenReason ?? 'WhatsApp couldn’t load it') : null,
      brokenAt: img.status === 'broken' ? toJson(img.brokenAt ?? null) : null,
      setAt: toJson(at ?? null),
    },
    rules: RULES,
  };
}

export async function getWhatsAppImage(tenantUserId: string, venueId: string) {
  await ownedVenue(tenantUserId, venueId);
  const snap = await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get();
  return viewOf(snap.get('whatsappImage'), snap.get('whatsappImageUpdatedAt'));
}

export async function putWhatsAppImage(tenantUserId: string, venueId: string, body: unknown, actor: Actor) {
  await ownedVenue(tenantUserId, venueId);
  // Named fields only (the body also carries the actor).
  const input = putSchema.parse({ url: ((body ?? {}) as Record<string, unknown>).url ?? null });
  let image: WaVenueImage | null = null;
  if (input.url) {
    const pic = await readWaImage(input.url);
    if (!pic.ok) throw validationFailed(pic.reason, [{ code: 'WA_IMAGE', severity: 'error', message: pic.reason, path: 'url' }]);
    image = { url: input.url, ...pic.facts, status: 'ok', brokenReason: null };
  }
  const ref = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw conflict('Set this venue up for Adaptive first (the picture belongs to its setup)');
    if (snap.get('tenantUserId') !== tenantUserId) throw new ApiError('forbidden', `Venue ${venueId} was not found in this account`);
    // Named fields only (the setup write keeps the whole doc it reads).
    tx.update(ref, { whatsappImage: image, whatsappImageUpdatedAt: new Date(), whatsappImageUpdatedBy: actor.uid });
  });
  return getWhatsAppImage(tenantUserId, venueId);
}
