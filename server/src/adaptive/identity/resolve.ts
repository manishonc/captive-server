/**
 * "Who is this guest?" (04-engine-runtime §2.3 step 1), in one transaction:
 *
 *  1. email / phone → contact points (hashed ids, no raw address in the doc);
 *  2. this owner's contact from `tenantContacts[tenant]`, or a new one;
 *  3. the network person (all owners), or a new one;
 *  4. consent sync — the splash tick in THIS request becomes a `grant` for each
 *     channel we have an address for (Decision D7), except a channel the guest
 *     revoked through that channel itself (STOP, an unsubscribe link: PRD CO-3);
 *     old opt-out flags on guest docs become `revoke` events (import_legacy).
 *
 * Today's `CaptivePortal_Users` docs are never written; they're linked through
 * `Contacts.guestIds`. Email + phone pointing at two different contacts of the
 * same owner is logged as a conflict and the email's contact wins (merging is P1).
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ConsentEntry, ContactDoc, ContactPointDoc } from '../store/engineTypes';
import type { Channel, Lang } from '../core/constants';
import { SCHEMA_VERSION } from '../core/constants';
import { contactPointId } from './key';
import { phoneCountry } from '../core/runtime/phoneCountry';
import { tsMs } from '../store/time';

export interface ResolveInput {
  tenantUserId: string;
  venueId: string;
  guestId: string;
  email: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  lang: Lang | null;
  /** The guest ticked the marketing box in this request. */
  consentGiven: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  /** Old opt-out flags found on this guest's docs (import once as revokes). */
  legacy: { smsStop: boolean; whatsappStop: boolean; emailUnsubscribed: boolean };
  occurredAt: number;
  sourceEventId: string;
  consentTextHash?: string | null;
}

export interface ResolveResult {
  contactId: string;
  networkId: string;
  created: boolean;
  conflict: string | null;
  grantedChannels: Channel[];
}

const MAX_GUEST_IDS = 50;

export const venueScope = (venueId: string) => `venue:${venueId}`;

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export async function resolveContact(input: ResolveInput): Promise<ResolveResult> {
  const cpEmailId = input.email ? contactPointId('email', input.email) : null;
  const cpPhoneId = input.phoneE164 ? contactPointId('phone', input.phoneE164) : null;
  if (!cpEmailId && !cpPhoneId) throw new Error('resolveContact: the guest left no email or phone');

  const cpCol = db.collection(COL.contactPoints);
  const scope = venueScope(input.venueId);

  return db.runTransaction(async (tx) => {
    // ── reads ──
    const [cpEmailSnap, cpPhoneSnap] = await Promise.all([
      cpEmailId ? tx.get(cpCol.doc(cpEmailId)) : Promise.resolve(null),
      cpPhoneId ? tx.get(cpCol.doc(cpPhoneId)) : Promise.resolve(null),
    ]);
    const cpEmail = cpEmailSnap?.exists ? (cpEmailSnap.data() as ContactPointDoc) : null;
    const cpPhone = cpPhoneSnap?.exists ? (cpPhoneSnap.data() as ContactPointDoc) : null;
    // A START recorded after the last STOP beats an old STOP flag still found on a
    // guest doc (the flag scan is cached for a few minutes).
    const keywords = (cpPhone as unknown as { smsKeywordAt?: { start?: unknown; stop?: unknown } } | null)?.smsKeywordAt;
    const startedAgain = (tsMs(keywords?.start) ?? 0) > (tsMs(keywords?.stop) ?? 0);
    const legacySmsStop = input.legacy.smsStop && !startedAgain;

    const fromEmail = cpEmail?.tenantContacts?.[input.tenantUserId] ?? null;
    const fromPhone = cpPhone?.tenantContacts?.[input.tenantUserId] ?? null;
    const conflict = fromEmail && fromPhone && fromEmail !== fromPhone ? `email→${fromEmail} phone→${fromPhone}` : null;
    let contactId = fromEmail ?? fromPhone ?? null;

    let contact: ContactDoc | null = null;
    if (contactId) {
      const snap = await tx.get(db.collection(COL.contacts).doc(contactId));
      contact = snap.exists ? (snap.data() as ContactDoc) : null;
    }
    const created = !contact;
    if (!contactId || !contact) contactId = `${input.tenantUserId}_${randomId('')}`;

    const networkId = cpEmail?.networkId ?? cpPhone?.networkId ?? contact?.networkId ?? randomId('np_');
    const npRef = db.collection(COL.networkPeople).doc(networkId);
    const npSnap = await tx.get(npRef);

    // ── consent sync (pure decisions on what we read) ──
    const now = new Date(input.occurredAt);
    const current: Partial<Record<Channel, ConsentEntry>> = { ...(contact?.marketingConsent?.[scope] ?? {}) };
    const events: Array<{ channel: Channel; action: 'grant' | 'revoke'; source: string; revokedVia?: 'channel' }> = [];

    const channelsWithAddress: Channel[] = [
      ...(input.email ? (['email'] as Channel[]) : []),
      ...(input.phoneE164 ? (['sms', 'whatsapp'] as Channel[]) : []),
    ];
    const legacyRevoke: Partial<Record<Channel, boolean>> = {
      email: input.legacy.emailUnsubscribed,
      sms: legacySmsStop,
      whatsapp: input.legacy.whatsappStop,
    };
    for (const ch of channelsWithAddress) {
      // Only a yes (now or earlier) is taken back; with no yes there is nothing to revoke
      // (and a later START must not turn this into a yes the guest never gave).
      const hadYes = input.consentGiven || current[ch]?.state === 'granted';
      if (legacyRevoke[ch] && hadYes && current[ch]?.state !== 'revoked') {
        events.push({ channel: ch, action: 'revoke', source: 'import_legacy', revokedVia: 'channel' });
      }
    }
    if (input.consentGiven) {
      for (const ch of channelsWithAddress) {
        const willBeRevokedViaChannel =
          legacyRevoke[ch] || (current[ch]?.state === 'revoked' && current[ch]?.revokedVia === 'channel');
        if (current[ch]?.state === 'granted' || willBeRevokedViaChannel) continue;
        events.push({ channel: ch, action: 'grant', source: 'splash' });
      }
    }

    // ── writes ──
    const consentCol = db.collection(COL.consentEvents);
    const projectionUpdates: Record<string, unknown> = {};
    const granted: Channel[] = [];
    for (const e of events) {
      const ref = consentCol.doc();
      tx.set(ref, {
        tenantUserId: input.tenantUserId,
        contactId,
        networkId,
        venueId: input.venueId,
        scope,
        channel: e.channel,
        purpose: 'marketing',
        action: e.action,
        source: e.source,
        sourceRef: { guestId: input.guestId, eventId: input.sourceEventId, consentTextHash: input.consentTextHash ?? null },
        locale: input.lang,
        occurredAt: now,
        recordedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
      const entry: ConsentEntry = {
        state: e.action === 'grant' ? 'granted' : 'revoked',
        at: now,
        eventId: ref.id,
        revokedVia: e.action === 'revoke' ? e.revokedVia ?? null : null,
        source: e.source,
      };
      current[e.channel] = entry;
      projectionUpdates[e.channel] = entry;
      if (e.action === 'grant') granted.push(e.channel);
    }

    const contactRef = db.collection(COL.contacts).doc(contactId);
    const guestIds = contact?.guestIds ?? [];
    const addGuest = !guestIds.includes(input.guestId) && guestIds.length < MAX_GUEST_IDS;
    if (created) {
      const doc: ContactDoc = {
        tenantUserId: input.tenantUserId,
        networkId,
        status: 'active',
        firstName: input.firstName || null,
        lastName: input.lastName || null,
        email: input.email,
        emailPointId: cpEmailId,
        emailVerified: input.emailVerified,
        phoneE164: input.phoneE164,
        phonePointId: cpPhoneId,
        phoneVerified: input.phoneVerified,
        phoneCountry: phoneCountry(input.phoneE164)?.country ?? null,
        lang: input.lang,
        langSource: input.lang ? 'splash' : null,
        guestIds: [input.guestId],
        firstVenueId: input.venueId,
        firstSeenAt: now,
        lastSeenAt: now,
        marketingConsent: Object.keys(current).length ? { [scope]: current } : {},
        channelHealth: {},
        engagement: {
          preferredChannel: null,
          preferredChannelSetAt: null,
          consecutiveNoClickOnPreferred: 0,
          preferredSlot: null,
          slotHistogram: {},
          opens: 0,
          clicks: 0,
          lastClickAt: null,
          lastClickChannel: null,
        },
        replyNoticeSentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      };
      tx.set(contactRef, doc);
    } else {
      // FieldPath segments, because consent scopes are keys like `venue:abc`.
      const pairs: Array<[FieldPath, unknown]> = [
        [new FieldPath('lastSeenAt'), now],
        [new FieldPath('updatedAt'), new Date()],
      ];
      const set = (field: string, value: unknown) => pairs.push([new FieldPath(field), value]);
      if (input.firstName) set('firstName', input.firstName);
      if (input.lastName) set('lastName', input.lastName);
      if (input.email && !contact!.email) {
        set('email', input.email);
        set('emailPointId', cpEmailId);
      }
      if (input.phoneE164 && !contact!.phoneE164) {
        set('phoneE164', input.phoneE164);
        set('phonePointId', cpPhoneId);
        set('phoneCountry', phoneCountry(input.phoneE164)?.country ?? null);
      }
      if (input.emailVerified && input.email === (contact!.email ?? input.email)) set('emailVerified', true);
      if (input.phoneVerified && input.phoneE164 === (contact!.phoneE164 ?? input.phoneE164)) set('phoneVerified', true);
      if (input.lang) {
        set('lang', input.lang);
        set('langSource', 'splash');
      }
      if (addGuest) set('guestIds', FieldValue.arrayUnion(input.guestId));
      for (const [ch, entry] of Object.entries(projectionUpdates)) {
        pairs.push([new FieldPath('marketingConsent', scope, ch), entry]);
      }
      const [first, ...rest] = pairs;
      tx.update(contactRef, first[0], first[1], ...rest.flat());
    }

    const pointWrite = (id: string, kind: 'email' | 'phone', existing: ContactPointDoc | null, verified: boolean) => {
      const base: Record<string, unknown> = {
        kind,
        networkId: existing?.networkId ?? networkId,
        [`tenantContacts`]: { ...(existing?.tenantContacts ?? {}), [input.tenantUserId]: contactId },
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      };
      if (!existing) {
        base.suppression = {};
        base.hardBounceCount = 0;
        base.lastBounceAt = null;
        base.verifiedAt = verified ? now : null;
        base.createdAt = new Date();
      } else if (verified && !existing.verifiedAt) {
        base.verifiedAt = now;
      }
      // Old STOP flags block SMS / WhatsApp for every owner (one shared sender).
      if (kind === 'phone') {
        const suppression: Record<string, unknown> = {};
        if (legacySmsStop && !existing?.suppression?.sms) suppression.sms = { reason: 'stop', source: 'import_legacy', at: now };
        if (input.legacy.whatsappStop && !existing?.suppression?.whatsapp) suppression.whatsapp = { reason: 'stop', source: 'import_legacy', at: now };
        if (Object.keys(suppression).length) base.suppression = { ...(existing?.suppression ?? {}), ...suppression };
      }
      tx.set(cpCol.doc(id), base, { merge: true });
    };
    if (cpEmailId) pointWrite(cpEmailId, 'email', cpEmail, input.emailVerified);
    if (cpPhoneId) pointWrite(cpPhoneId, 'phone', cpPhone, input.phoneVerified);

    const pointIds = [cpEmailId, cpPhoneId].filter((x): x is string => Boolean(x));
    if (npSnap.exists) {
      const have = (npSnap.get('pointIds') as string[]) ?? [];
      const add = pointIds.filter((p) => !have.includes(p));
      if (add.length && have.length + add.length <= 10) tx.update(npRef, { pointIds: FieldValue.arrayUnion(...add), updatedAt: new Date() });
    } else {
      tx.set(npRef, {
        pointIds,
        recentMarketingTouches: [],
        status: 'active',
        erasedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
    }

    if (conflict) console.warn('[ADAPTIVE] contact conflict for tenant', input.tenantUserId, conflict);
    return { contactId: contactId!, networkId, created, conflict, grantedChannels: granted };
  });
}

/** The consent projection for one venue (`marketingConsent['venue:{id}']`). */
export function consentFor(contact: Pick<ContactDoc, 'marketingConsent'>, venueId: string): Partial<Record<Channel, ConsentEntry>> {
  return contact.marketingConsent?.[venueScope(venueId)] ?? {};
}
