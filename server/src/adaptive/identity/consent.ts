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
  /**
   * A START for a scope the owner has stopped (PR D): the guest's yes is recorded in the ledger,
   * but the scope stays stopped until the owner resumes — then that yes comes back.
   */
  heldByOwnerStop?: boolean;
}

/** How firmly a revoke holds: the guest's own channel (STOP, unsubscribe) > the owner > anything else. */
function revokeRank(via: RevokedVia | null | undefined): number {
  return via === 'channel' ? 2 : via === 'owner' ? 1 : 0;
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
    // Already so — unless a firmer revoke arrives (the guest's own unsubscribe over an owner's stop, PR D).
    if (current?.state === target && !(c.action === 'revoke' && revokeRank(c.revokedVia) > revokeRank(current.revokedVia))) continue;
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
    const entry: ConsentEntry = c.heldByOwnerStop
      ? // The guest's yes, held by the owner's stop: Resume gives it back.
        { state: 'revoked', at: new Date(occurredAt), eventId: ref.id, revokedVia: 'owner', source: 'owner', ownerStopped: true, ownerPrior: 'granted' }
      : {
          state: target,
          at: new Date(occurredAt),
          eventId: ref.id,
          revokedVia: c.action === 'revoke' ? c.revokedVia ?? null : null,
          source: c.source,
          // An owner's stop stays on the scope when the guest's own revoke replaces it (PR D).
          ...(c.action === 'revoke' && current?.ownerStopped ? { ownerStopped: true } : {}),
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

/**
 * Where a guest's own STOP must be recorded: the scopes granted now, and those the owner stopped
 * after the guest had said yes (PR D). There the STOP replaces the owner's revoke (keeping its
 * `ownerStopped` mark), so the owner's Resume can never give back a yes the guest took away.
 * Not a scope the guest never said yes to: a later START would turn it into a yes they never gave.
 */
export function stopScopes(contact: ContactDoc, channel: Channel): string[] {
  return Object.entries(contact.marketingConsent ?? {})
    .filter(([, byCh]) => {
      const e = byCh?.[channel];
      return e?.state === 'granted' || (e?.state === 'revoked' && e.revokedVia === 'owner' && e.ownerPrior === 'granted');
    })
    .map(([scope]) => scope.replace(/^venue:/, ''));
}

/** Venue scopes where `channel` was revoked by one of `sources` (START undoes exactly what STOP took). */
export function revokedScopesBy(contact: ContactDoc, channel: Channel, sources: string[]): string[] {
  return Object.entries(contact.marketingConsent ?? {})
    // Not a scope the owner stopped (PR D): START gives back the guest's yes only where the owner didn't say no.
    .filter(([, byCh]) => byCh?.[channel]?.state === 'revoked' && !byCh?.[channel]?.ownerStopped && sources.includes(String(byCh?.[channel]?.source ?? '')))
    .map(([scope]) => scope.replace(/^venue:/, ''));
}

/** Scopes a STOP revoked that the owner has stopped since (PR D): a START there is held until the owner resumes. */
export function heldStartScopes(contact: ContactDoc, channel: Channel, sources: string[]): string[] {
  return Object.entries(contact.marketingConsent ?? {})
    .filter(([, byCh]) => {
      const e = byCh?.[channel];
      return e?.state === 'revoked' && e.ownerStopped === true && e.revokedVia === 'channel' && sources.includes(String(e.source ?? ''));
    })
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

// ── The owner's "Stop marketing to this guest" (PR D, D-D6) ─────────────────

const OWNER_CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];

/**
 * Stops or resumes marketing to one guest at the given venues (one venue, or every venue of
 * the owner), every channel. ONE projection update and a ledger doc per real change.
 *
 *  - Stop: a revoke with `source: 'owner'`, `revokedVia: 'owner'` — also for channels the guest
 *    never said yes to (so a later new phone doesn't open SMS) — remembering whether it was
 *    granted before (`ownerPrior`). A scope the guest revoked themselves (STOP, unsubscribe)
 *    keeps that revoke and is only marked `ownerStopped`, so START doesn't undo the owner's no.
 *  - Resume: reverses only the owner's own stop. A channel the guest had said yes to is granted
 *    again (`source: 'owner'`); one they hadn't goes back to "no answer" (a later splash yes can
 *    grant it); a guest's own revoke stays and loses only its `ownerStopped` mark.
 * Returns how many scope×channel entries changed.
 */
export function writeOwnerMarketing(
  tx: Transaction,
  contactId: string,
  contact: ContactDoc,
  args: { action: 'stop' | 'resume'; venueIds: string[]; at: number; by: string; scope?: 'venue' | 'all' },
): number {
  const pairs: Array<[FieldPath, unknown]> = [];
  const ledger = (venueId: string, scope: string, channel: Channel, action: 'grant' | 'revoke', sourceRef: Record<string, unknown>) => {
    const ref = db.collection(COL.consentEvents).doc();
    tx.set(ref, {
      tenantUserId: contact.tenantUserId,
      contactId,
      networkId: contact.networkId,
      venueId,
      scope,
      channel,
      purpose: 'marketing',
      action,
      source: 'owner',
      sourceRef,
      locale: (contact.lang ?? 'en') as Lang,
      occurredAt: new Date(args.at),
      recordedAt: new Date(),
      schemaVersion: SCHEMA_VERSION,
    });
    return ref.id;
  };
  for (const venueId of [...new Set(args.venueIds)]) {
    const scope = venueScope(venueId);
    for (const channel of OWNER_CHANNELS) {
      const cur = contact.marketingConsent?.[scope]?.[channel];
      const path = new FieldPath('marketingConsent', scope, channel);
      if (args.action === 'stop') {
        if (cur?.ownerStopped) continue;
        if (cur?.state === 'revoked' && cur.revokedVia === 'channel') {
          // The guest's own no stays; the owner's stop is recorded beside it.
          ledger(venueId, scope, channel, 'revoke', { by: args.by, kind: 'owner_stop_mark', over: cur.eventId });
          pairs.push([path, { ...cur, ownerStopped: true }]);
          continue;
        }
        const eventId = ledger(venueId, scope, channel, 'revoke', { by: args.by, kind: 'owner_stop' });
        const entry: ConsentEntry = {
          state: 'revoked',
          at: new Date(args.at),
          eventId,
          revokedVia: 'owner',
          source: 'owner',
          ownerStopped: true,
          ownerPrior: cur?.state === 'granted' ? 'granted' : 'none',
        };
        pairs.push([path, entry]);
      } else {
        if (!cur?.ownerStopped) continue;
        if (cur.revokedVia === 'owner' && cur.ownerPrior === 'granted') {
          const eventId = ledger(venueId, scope, channel, 'grant', { by: args.by, kind: 'owner_resume', resumes: cur.eventId });
          pairs.push([path, { state: 'granted', at: new Date(args.at), eventId, revokedVia: null, source: 'owner' } satisfies ConsentEntry]);
        } else if (cur.revokedVia === 'owner') {
          // No yes to give back: "no answer" again (not sticky), so a later splash yes can grant it.
          // Recorded as a (still) revoked state, never a grant the guest didn't give.
          const eventId = ledger(venueId, scope, channel, 'revoke', { by: args.by, kind: 'owner_lift', resumes: cur.eventId });
          pairs.push([path, { state: 'revoked', at: new Date(args.at), eventId, revokedVia: null, source: 'owner_resume' } satisfies ConsentEntry]);
        } else {
          // The guest's own no stays; only the owner's mark goes.
          ledger(venueId, scope, channel, 'revoke', { by: args.by, kind: 'owner_lift_guest_no', resumes: cur.eventId });
          pairs.push([path, { ...cur, ownerStopped: false }]);
        }
      }
    }
  }
  const changed = pairs.length;
  // "All venues": also the venues the owner opens later (identity/resolve.ts reads this).
  if (args.scope === 'all' && args.action === 'stop' && !contact.ownerStoppedAll) pairs.push([new FieldPath('ownerStoppedAll'), { at: new Date(args.at), by: args.by }]);
  if (args.scope === 'all' && args.action === 'resume' && contact.ownerStoppedAll) pairs.push([new FieldPath('ownerStoppedAll'), null]);
  if (pairs.length) {
    pairs.push([new FieldPath('updatedAt'), new Date()]);
    const [first, ...rest] = pairs;
    tx.update(db.collection(COL.contacts).doc(contactId), first[0], first[1], ...rest.flat());
  }
  return changed;
}
