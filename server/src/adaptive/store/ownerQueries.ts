/**
 * Every query the PR D owner / admin / MCP routes run — as exported builders, so
 * worker/indexCheck.ts probes exactly these (the emulator doesn't enforce indexes; the probe
 * is the only guard in production). Composites are listed in firestore.adaptive.indexes.json
 * and docs/adaptive-engine.md; create them by hand, never with the Firebase CLI.
 */

import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from './collections';

/** The guests seen at a venue, most recent visit first — composite ContactVenues(venueId↑, lastVisitAt↓). */
export const venueGuestsQuery = (venueId: string) =>
  db.collection(COL.contactVenues).where('venueId', '==', venueId).orderBy('lastVisitAt', 'desc').orderBy(FieldPath.documentId(), 'desc');

/** One guest's log, newest first — composite JourneyEvents(contactId↑, occurredAt↓). */
export const contactEventsQuery = (contactId: string) =>
  db.collection(COL.journeyEvents).where('contactId', '==', contactId).orderBy('occurredAt', 'desc');

/** One guest's consent ledger, newest first — composite ConsentEvents(contactId↑, occurredAt↓). */
export const contactConsentQuery = (contactId: string) =>
  db.collection(COL.consentEvents).where('contactId', '==', contactId).orderBy('occurredAt', 'desc');

/**
 * A venue's events of some types, newest first (the messages list; recent waits for credits) —
 * composite JourneyEvents(venueId↑, type↑, occurredAt↓). `since` bounds it from below.
 */
export const venueEventsOfTypesQuery = (venueId: string, types: string[], since: Date | null = null) => {
  let q = db.collection(COL.journeyEvents).where('venueId', '==', venueId).where('type', 'in', types);
  if (since) q = q.where('occurredAt', '>=', since);
  return q.orderBy('occurredAt', 'desc');
};

/** Dead tasks, the newest first — composite JourneyTasks(status↑, doneAt↓). */
export const deadTasksQuery = () => db.collection(COL.journeyTasks).where('status', '==', 'dead').orderBy('doneAt', 'desc');

// Equality only (served by merged single-field indexes) — probed so an exempted field shows up.

/** One guest's journeys, every status. */
export const contactInstancesQuery = (contactId: string) => db.collection(COL.journeyInstances).where('contactId', '==', contactId);

/** One guest's send records. */
export const contactSendsQuery = (contactId: string) => db.collection(COL.journeySends).where('contactId', '==', contactId);

/** One guest's stays, any venue of the account. */
export const contactAllStaysQuery = (contactId: string) => db.collection(COL.stays).where('contactId', '==', contactId);

/** The places a guest has been, one doc per venue. */
export const contactVenuesQuery = (contactId: string) => db.collection(COL.contactVenues).where('contactId', '==', contactId);

/**
 * An account's running journeys whose message couldn't be paid at its last look (the results
 * card): `waiting.creditsShort`, which quiet hours or a pause don't hide (engine/sendPath.ts).
 * The whole account at once: its wallet pays all of them.
 */
export const accountCreditWaitQuery = (tenantUserId: string) =>
  db.collection(COL.journeyInstances).where('tenantUserId', '==', tenantUserId).where('status', '==', 'active').where('waiting.creditsShort', '==', true);

/** A venue's setups (every playbook, any state). */
export const venueSetupsQuery = (venueId: string) => db.collection(COL.venuePlaybooks).where('venueId', '==', venueId);
