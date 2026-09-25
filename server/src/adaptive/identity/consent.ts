/**
 * Consent and blocks after the splash (plan §3.9): STOP / START, the unsubscribe
 * link, Brevo unsubscribe / spam, hard bounces, Twilio 21610. Same ledger +
 * projection shapes as resolve.ts (which stays as it is); these helpers only
 * WRITE — the caller reads everything first, as a Firestore transaction requires.
 *
 *  - Every revoke that came through the channel itself carries
 *    `revokedVia: 'channel'`, so a later splash tick can't grant it again (CO-3).
 *  - The projection entry remembers its `source`, so START re-grants exactly the
 *    scopes a STOP took away.
 *  - One contact doc gets one update per transaction (all its changes together).
 */

import { FieldPath, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { Channel, Lang } from '../core/constants';
import { SCHEMA_VERSION } from '../core/constants';
import type { ConsentEntry, ContactDoc, ContactPointDoc, RevokedVia, SuppressionEntry } from '../store/engineTypes';
import { venueScope } from './resolve';

export type ConsentSource =
  | 'sms_keyword'
  | 'unsubscribe_page'
  | 'brevo_unsubscribed'
  | 'brevo_spam'
  | 'provider_stop'
  | 'owner'
  | 'import_legacy';

export interface ConsentChange {
  venueId: string;
  channel: Channel;
  action: 'grant' | 'revoke';
  source: ConsentSource;
  revokedVia?: RevokedVia | null;
  sourceRef?: Record<string, unknown>;
}

/**
 * Writes the ledger docs and ONE projection update for a contact. Skips changes
 * that would not change the state (a replayed STOP writes nothing).
 * Returns the changes actually written.
 */
export function writeConsentChanges(
  tx: Transaction,
  contactId: string,
  contact: ContactDoc,
  changes: ConsentChange[],
  occurredAt: number,
): ConsentChange[] {
  const written: ConsentChange[] = [];
  const pairs: Array<[FieldPath, unknown]> = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const scope = venueScope(c.venueId);
    const key = `${scope}|${c.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const current = contact.marketingConsent?.[scope]?.[c.channel];
    const target = c.action === 'grant' ? 'granted' : 'revoked';
    if (current?.state === target) continue;
    const ref = db.collection(COL.consentEvents).doc();
    tx.set(ref, {
      tenantUserId: contact.tenantUserId,
      contactId,
      networkId: contact.networkId,
      venueId: c.venueId,
      scope,
      channel: c.channel,
      purpose: 'marketing',
      action: c.action,
      source: c.source,
      sourceRef: c.sourceRef ?? {},
      locale: (contact.lang ?? 'en') as Lang,
      occurredAt: new Date(occurredAt),
      recordedAt: new Date(),
      schemaVersion: SCHEMA_VERSION,
    });
    const entry: ConsentEntry = {
      state: target,
      at: new Date(occurredAt),
      eventId: ref.id,
      revokedVia: c.action === 'revoke' ? c.revokedVia ?? null : null,
      source: c.source,
    };
    pairs.push([new FieldPath('marketingConsent', scope, c.channel), entry]);
    written.push(c);
  }
  if (pairs.length) {
    pairs.push([new FieldPath('updatedAt'), new Date()]);
    const [first, ...rest] = pairs;
    tx.update(db.collection(COL.contacts).doc(contactId), first[0], first[1], ...rest.flat());
  }
  return written;
}

/** Every venue scope where this contact currently has `channel` granted. */
export function grantedScopes(contact: ContactDoc, channel: Channel): string[] {
  return Object.entries(contact.marketingConsent ?? {})
    .filter(([, byCh]) => byCh?.[channel]?.state === 'granted')
    .map(([scope]) => scope.replace(/^venue:/, ''));
}

/** Venue scopes where `channel` was revoked by one of `sources` (START undoes exactly what STOP took). */
export function revokedScopesBy(contact: ContactDoc, channel: Channel, sources: string[]): string[] {
  return Object.entries(contact.marketingConsent ?? {})
    .filter(([, byCh]) => byCh?.[channel]?.state === 'revoked' && sources.includes(String(byCh?.[channel]?.source ?? '')))
    .map(([scope]) => scope.replace(/^venue:/, ''));
}

/** Blocks a channel on an address for every owner (merge; an existing block is kept). */
export function writeSuppression(
  tx: Transaction,
  pointId: string,
  point: ContactPointDoc | null,
  channel: Channel,
  entry: Omit<SuppressionEntry, 'at'> & { at: number },
): boolean {
  if (point?.suppression?.[channel]) return false;
  tx.set(
    db.collection(COL.contactPoints).doc(pointId),
    { suppression: { [channel]: { ...entry, at: new Date(entry.at) } }, updatedAt: new Date() },
    { merge: true },
  );
  return true;
}

/** Lifts a block only if it has the given reason (START lifts a STOP, never a bounce). */
export function liftSuppression(tx: Transaction, pointId: string, point: ContactPointDoc | null, channel: Channel, reason: SuppressionEntry['reason']): boolean {
  if (point?.suppression?.[channel]?.reason !== reason) return false;
  const { [channel]: _removed, ...rest } = point.suppression;
  tx.update(db.collection(COL.contactPoints).doc(pointId), { suppression: rest, updatedAt: new Date() });
  return true;
}
