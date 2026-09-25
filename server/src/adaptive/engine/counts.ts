/**
 * Counts the gate needs (venue / platform daily ceilings, service fair use),
 * as Firestore count() aggregations — one read per 1,000 matches, no documents
 * loaded. Only live sends count; test-run (dry_run) records never do.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';

const sends = () => db.collection(COL.journeySends);

async function count(q: FirebaseFirestore.Query): Promise<number> {
  const snap = await q.count().get();
  return snap.data().count;
}

export function venueLiveSendsSince(venueId: string, sinceMs: number): Promise<number> {
  return count(sends().where('venueId', '==', venueId).where('mode', '==', 'live').where('createdAt', '>=', new Date(sinceMs)));
}

export function platformLiveSendsSince(sinceMs: number): Promise<number> {
  return count(sends().where('mode', '==', 'live').where('createdAt', '>=', new Date(sinceMs)));
}

export function venueServiceSendsSince(venueId: string, sinceMs: number): Promise<number> {
  return count(
    sends()
      .where('venueId', '==', venueId)
      .where('mode', '==', 'live')
      .where('purpose', '==', 'service')
      .where('createdAt', '>=', new Date(sinceMs)),
  );
}
