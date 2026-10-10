/**
 * Bring-a-friend codes (PR A7) — `CaptivePortal_ReferralCodes/{code}`, one per regular's invite.
 *
 *  - **Minted at send time** (engine/sendPath.ts), like the short links: the invite's wording names
 *    `{{referral.code}}`, the send gets-or-creates the code of its journey run. A test run mints
 *    one too (nothing is sent, but the preview shows a code that can be tried at the venue).
 *  - **Checked on the splash** (routes/captive.ts, before the friend goes online): a known code of
 *    this venue, not expired, with room left → the friend sees their offer.
 *  - **Counted by the worker** (engine/route.ts handleConnect, once the friend is known): first
 *    visit here, not the regular, once per friend, the first 3 → `referral.joined` for the regular,
 *    which starts their friend reward (`friend_reward`).
 *
 * Never stores the friend's contact details: only their contact id (to count each friend once).
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import { contactPointId, identityReady } from '../identity/key';
import { tsMs, retentionFrom } from '../store/time';
import { DAY_MS } from '../core/runtime/time';
import { eventIdFor } from '../core/runtime/ids';
import {
  REFERRAL_CODE_DAYS,
  REFERRAL_MAX_FRIENDS,
  type FriendOffer,
  checkCodeForVenue,
  decideReferral,
  makeReferralCode,
  normalizeFriendCode,
  type ReferralCodeFacts,
  type ReferralDecision,
} from '../core/referrals';
import { appendEventInTx, eventRef } from '../engine/events';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { loadVenueContext } from '../engine/context';
import { cachedEngineSettings, venueModeFor } from '../store/engineSettings';

export interface ReferralCodeDoc {
  code: string;
  tenantUserId: string;
  venueId: string;
  /** The regular who shares it. */
  contactId: string;
  /** Their invite's journey run. */
  instanceId: string;
  mode: 'test' | 'live';
  /** What a friend gets (the invite's `friend_offer` blank), shown on the splash. */
  friendOffer: FriendOffer | null;
  createdAt: Date;
  expiresAt: Date;
  friendsCredited: number;
  maxFriends: number;
  friendContactIds: string[];
  lastFriendAt: Date | null;
  expireAt: Date;
}

const codeRef = (code: string) => db.collection(COL.referralCodes).doc(code);

function factsOf(d: Record<string, unknown> | undefined): ReferralCodeFacts | null {
  if (!d) return null;
  return {
    venueId: String(d.venueId ?? ''),
    contactId: String(d.contactId ?? ''),
    expiresAt: tsMs(d.expiresAt as never) ?? 0,
    friendsCredited: Number(d.friendsCredited ?? 0),
    maxFriends: Number(d.maxFriends ?? REFERRAL_MAX_FRIENDS),
    friendContactIds: Array.isArray(d.friendContactIds) ? (d.friendContactIds as string[]) : [],
  };
}

/** The code of this invite run, created on first use. Unique across all venues (the doc id). */
export async function mintReferralCode(args: {
  tenantUserId: string;
  venueId: string;
  contactId: string;
  instanceId: string;
  firstName: string | null;
  mode: 'test' | 'live';
  friendOffer: FriendOffer | null;
  now: number;
  random?: () => number;
}): Promise<string> {
  const existing = await db.collection(COL.referralCodes).where('instanceId', '==', args.instanceId).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeReferralCode(args.firstName, args.random);
    const created = await db.runTransaction(async (tx) => {
      const [taken, mine] = await Promise.all([
        tx.get(codeRef(code)),
        tx.get(db.collection(COL.referralCodes).where('instanceId', '==', args.instanceId).limit(1)),
      ]);
      // Another try of this same send got there first: use its code.
      if (!mine.empty) return mine.docs[0].id;
      if (taken.exists) return null;
      const doc: ReferralCodeDoc = {
        code,
        tenantUserId: args.tenantUserId,
        venueId: args.venueId,
        contactId: args.contactId,
        instanceId: args.instanceId,
        mode: args.mode,
        friendOffer: args.friendOffer,
        createdAt: new Date(args.now),
        expiresAt: new Date(args.now + REFERRAL_CODE_DAYS * DAY_MS),
        friendsCredited: 0,
        maxFriends: REFERRAL_MAX_FRIENDS,
        friendContactIds: [],
        lastFriendAt: null,
        expireAt: retentionFrom(args.now),
      };
      tx.create(codeRef(code), doc);
      return code;
    });
    if (created) return created;
  }
  throw new Error('could not find a free referral code');
}

/**
 * On the splash: is this a code a friend can use here now? The friend's offer label comes with a
 * yes. Never says whose code it is.
 */
export async function checkFriendCode(venueId: string, raw: unknown, now: number): Promise<{ ok: boolean; code: string | null; friendOffer: FriendOffer | null }> {
  const code = normalizeFriendCode(raw);
  if (!code) return { ok: false, code: null, friendOffer: null };
  const snap = await codeRef(code).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
  if (checkCodeForVenue(factsOf(data), venueId, now) !== 'ok') return { ok: false, code, friendOffer: null };
  const offer = data?.friendOffer as ReferralCodeDoc['friendOffer'];
  return { ok: true, code, friendOffer: offer ?? null };
}

/**
 * The friend's sign-up, handled by the worker once the friend is a known contact. Counts the friend
 * on the code and writes `referral.joined` for the regular (with its `event_route` task, which
 * starts their friend reward) in one transaction. Always records on the friend's timeline what
 * happened with the code they typed.
 */
export async function attributeReferral(args: {
  raw: unknown;
  tenantUserId: string;
  venueId: string;
  friendContactId: string;
  friendGuestId: string;
  isFirstVisit: boolean;
  visitId: string;
  at: number;
  mode: 'test' | 'live';
}): Promise<ReferralDecision | 'bad_code'> {
  const code = normalizeFriendCode(args.raw);
  const enteredId = eventIdFor('engine', `referral:entered:${args.visitId}`);
  if (!code) {
    return 'bad_code';
  }
  return db.runTransaction(async (tx) => {
    const [snap, entered] = await Promise.all([tx.get(codeRef(code)), tx.get(eventRef(enteredId))]);
    // A retried connect task: this sign-up was already handled — keep what it decided.
    if (entered.exists) return ((entered.get('data') as { result?: ReferralDecision } | undefined)?.result ?? 'unknown') as ReferralDecision;
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
    const decision = decideReferral(factsOf(data), { venueId: args.venueId, contactId: args.friendContactId, isFirstVisit: args.isFirstVisit, at: args.at });
    appendEventInTx(
      tx,
      {
        type: 'referral.code_entered',
        occurredAt: args.at,
        tenantUserId: args.tenantUserId,
        venueId: args.venueId,
        contactId: args.friendContactId,
        guestId: args.friendGuestId,
        mode: args.mode,
        data: { code, result: decision },
      },
      enteredId,
    );
    if (decision !== 'ok' || !data) return decision;
    const friendNumber = Number(data.friendsCredited ?? 0) + 1;
    tx.update(codeRef(code), {
      friendsCredited: FieldValue.increment(1),
      friendContactIds: FieldValue.arrayUnion(args.friendContactId),
      lastFriendAt: new Date(args.at),
    });
    // For the regular: their friend came. Starts (or queues) their reward.
    const joinedId = eventIdFor('engine', `referral:joined:${code}:${args.friendContactId}`);
    appendEventInTx(
      tx,
      {
        type: 'referral.joined',
        occurredAt: args.at,
        tenantUserId: args.tenantUserId,
        venueId: args.venueId,
        contactId: String(data.contactId),
        mode: args.mode,
        source: 'engine',
        data: { code, friendNumber, friendGuestId: args.friendGuestId },
      },
      joinedId,
    );
    firestoreScheduler.scheduleInTx(tx, {
      dedupeKey: `event:${joinedId}`,
      kind: 'event_route',
      dueAt: args.at,
      payload: { eventId: joinedId },
      tenantUserId: args.tenantUserId,
      venueId: args.venueId,
    });
    return decision;
  });
}

const OPEN_TTL_MS = 60_000;
const openCache = new Map<string, { open: boolean; at: number }>();

/**
 * Does the splash show "Code from a friend" at this venue? While the venue runs Bring a friend:
 * Adaptive on, its active playbook has the invite switched on, and the account isn't off. Cached
 * for a minute per venue (the splash asks on every page load).
 */
export async function referralOpenAt(venueId: string, now = Date.now()): Promise<boolean> {
  const hit = openCache.get(venueId);
  if (hit && now - hit.at < OPEN_TTL_MS) return hit.open;
  let open = false;
  try {
    const ctx = await loadVenueContext(venueId);
    const invite = ctx?.marketing?.doc.journeys?.bring_a_friend;
    if (ctx && invite?.enabled) open = venueModeFor(await cachedEngineSettings(), ctx.adaptive, now) !== 'off';
  } catch {
    open = false; // the splash works without the field
  }
  openCache.set(venueId, { open, at: now });
  if (openCache.size > 2000) openCache.clear();
  return open;
}

/**
 * Has this person been a guest at this venue before (Adaptive's own record: a contact of this
 * account, by email or phone, with a ContactVenues doc here)? The splash shows a friend's offer
 * only to someone new — whichever access point, email or number they used before. Unknown (no
 * identity key) → false; the worker's first-visit check still decides whether the code counts.
 */
export async function knownAtVenue(args: { tenantUserId: string | null; venueId: string; email: string | null; phoneE164: string | null }): Promise<boolean> {
  if (!args.tenantUserId || !identityReady()) return false;
  const points = [
    ...(args.email ? [contactPointId('email', args.email)] : []),
    ...(args.phoneE164 ? [contactPointId('phone', args.phoneE164)] : []),
  ];
  for (const id of points) {
    const cp = await db.collection(COL.contactPoints).doc(id).get();
    const contactId = (cp.get('tenantContacts') as Record<string, string> | undefined)?.[args.tenantUserId];
    if (contactId && (await db.collection(COL.contactVenues).doc(contactVenueId(contactId, args.venueId)).get()).exists) return true;
  }
  return false;
}
