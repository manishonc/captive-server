import { db } from '../firebase';

/**
 * Resolve a venue's display name for use in marketing messages.
 *
 * Source of truth is `CaptivePortal_Venues/{venueId}.venue_name`. The
 * EntityMarketing doc does NOT store a venueName, so callers that fall back to
 * `marketingDoc.data()?.venueName` always got an empty value — use this instead.
 *
 * @param venueId        Venue id (the part after `venue_` in the marketing doc id)
 * @param fallbackName   Optional cached name (e.g. a venueName field if one ever exists)
 */
export async function getVenueName(venueId: string, fallbackName?: string): Promise<string> {
  if (venueId) {
    try {
      const venueDoc = await db.collection('CaptivePortal_Venues').doc(venueId).get();
      const name = venueDoc.data()?.venue_name;
      if (name) return String(name);
    } catch (err) {
      console.error('[VENUE NAME LOOKUP ERROR]', err);
    }
  }
  return fallbackName || '';
}
