/**
 * PR image header: the one write the send path makes to the venue's WhatsApp picture
 * (`AdaptiveVenues.whatsappImage`) — Meta couldn't load it at a send. Kept apart from
 * service/whatsappImage.ts (which reads pictures from the CDN) so the engine imports only this.
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from './collections';
import { usableVenueImage, type WaVenueImage } from '../core/whatsapp/image';

/**
 * A send whose picture Meta couldn't load (131052/131053): the venue's next messages use the plain
 * templates until the picture is set again. Only when the link is still the one that failed (the
 * owner may have picked another meanwhile). Never throws.
 */
export async function markWhatsAppImageBroken(venueId: string, url: string, reason: string): Promise<void> {
  const ref = db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const img = snap.get('whatsappImage') as WaVenueImage | null | undefined;
      if (!img || img.url !== url || img.status === 'broken') return;
      tx.update(ref, { 'whatsappImage.status': 'broken', 'whatsappImage.brokenReason': reason.slice(0, 300), 'whatsappImage.brokenAt': new Date() });
    });
  } catch (err) {
    console.warn('[ADAPTIVE] WhatsApp picture not marked broken:', (err as Error)?.name ?? 'Error');
  }
}

/** The venue's usable WhatsApp picture (null: none, broken, or not this account's venue). Never throws. */
export async function venueWhatsAppImageUrl(tenantUserId: string, venueId: string): Promise<string | null> {
  try {
    const snap = await db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get();
    if (!snap.exists || snap.get('tenantUserId') !== tenantUserId) return null;
    return usableVenueImage(snap.get('whatsappImage'))?.url ?? null;
  } catch {
    return null;
  }
}
