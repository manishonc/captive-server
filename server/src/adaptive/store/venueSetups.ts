/**
 * Venue setup documents: `CaptivePortal_AdaptiveVenues/venue_{id}` (the switch)
 * and `CaptivePortal_VenuePlaybooks/{venueId}_{playbookKey}` (+ `versions`).
 *
 * Every change goes through `applyVenueChanges`, one Firestore transaction, so
 * "only one marketing playbook is active per venue" (PRD PB-3) is enforced in a
 * single place: turning a playbook on sets the previous one to `inactive` in the
 * same transaction that moves `activeInstallId`.
 */

import { db } from '../../firebase';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { COL, VERSIONS, adaptiveVenueId, venuePlaybookId } from './collections';
import { stripUndefined } from './serialize';
import type { AdaptiveVenueDoc, VenueJourneyConfigDoc, VenuePlaybookDoc, VenuePlaybookVersionDoc } from './types';
import type { Actor, Offer } from '../core/schemas';
import type { VenueType } from '../core/constants';
import { SCHEMA_VERSION } from '../core/constants';
import type { OverlapFlags } from './tenantData';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { now as engineNow, refreshClock, sandboxEnabled } from '../engine/clock';
import { applyInFlightTask } from '../engine/applyInFlight';

export const GUEST_INFO_KEY = 'guest_info';

export const adaptiveVenueRef = (venueId: string) => db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId));
export const venuePlaybookRef = (venueId: string, playbookKey: string) =>
  db.collection(COL.venuePlaybooks).doc(venuePlaybookId(venueId, playbookKey));

export async function listAdaptiveVenues(tenantUserId: string): Promise<AdaptiveVenueDoc[]> {
  const snap = await db.collection(COL.adaptiveVenues).where('tenantUserId', '==', tenantUserId).get();
  return snap.docs.map((d) => d.data() as AdaptiveVenueDoc);
}

export async function listVenuePlaybooks(tenantUserId: string): Promise<VenuePlaybookDoc[]> {
  const snap = await db.collection(COL.venuePlaybooks).where('tenantUserId', '==', tenantUserId).get();
  return snap.docs.map((d) => d.data() as VenuePlaybookDoc);
}

/** Setups of one playbook across all tenants — for the admin "on N venues" counts. */
export async function countSetupsByPlaybook(playbookKey: string): Promise<{ setUp: number; active: number }> {
  const snap = await db.collection(COL.venuePlaybooks).where('playbookKey', '==', playbookKey).select('state').get();
  let active = 0;
  for (const d of snap.docs) if (d.get('state') === 'active') active += 1;
  return { setUp: snap.size, active };
}

export async function getVenuePlaybook(venueId: string, playbookKey: string): Promise<VenuePlaybookDoc | null> {
  const snap = await venuePlaybookRef(venueId, playbookKey).get();
  return snap.exists ? (snap.data() as VenuePlaybookDoc) : null;
}

export async function getAdaptiveVenue(venueId: string): Promise<AdaptiveVenueDoc | null> {
  const snap = await adaptiveVenueRef(venueId).get();
  return snap.exists ? (snap.data() as AdaptiveVenueDoc) : null;
}

// ── The one write path ───────────────────────────────────────────────────────

export interface SetupWrite {
  playbookKey: string;
  playbookVersion: number;
  journeys: Record<string, VenueJourneyConfigDoc>;
  offerMenu: Offer[];
  note?: string;
  /** "Apply to guests already in these journeys" (plan §3.10): they move to this version at their next step. */
  applyToInFlight?: boolean;
}

export interface GuestInfoWrite {
  enabled: boolean;
  playbookVersion: number;
  journeys: Record<string, VenueJourneyConfigDoc>;
}

export interface VenueChange {
  venueId: string;
  tenantUserId: string;
  businessType: VenueType;
  /** New IANA time zone; undefined keeps the stored one. */
  timezone?: string | null;
  overlap?: OverlapFlags & { acknowledged: boolean };
  avgSpendPerVisit?: { amountMinor: number; currency: string } | null;
  estimate?: { creditsPerMonth: number; revenuePerMonthMinor: number; currency: string } | null;
  /** Save (or update) the owner's marketing setup: +1 config version. */
  setup?: SetupWrite;
  /** Turn this marketing playbook on (it must be set up, here or in `setup`). */
  activateKey?: string;
  /** Owner pause/resume of the active playbook. */
  status?: 'paused' | 'on';
  guestInfo?: GuestInfoWrite;
}

export interface VenueChangeResult {
  venueId: string;
  status: AdaptiveVenueDoc['status'];
  activePlaybookKey: string | null;
  setup?: { playbookKey: string; state: VenuePlaybookDoc['state']; configVersion: number };
  guestInfo?: { enabled: boolean };
}

export class VenueChangeError extends Error {
  constructor(public code: 'not_found' | 'conflict', message: string) {
    super(message);
  }
}

function newAdaptiveVenue(change: VenueChange, now: Date): AdaptiveVenueDoc {
  return {
    tenantUserId: change.tenantUserId,
    venueId: change.venueId,
    status: 'off',
    activePlaybookKey: null,
    activeInstallId: null,
    activatedAt: null,
    activatedBy: null,
    utility: { enabled: false, installId: null, enabledAt: null, enabledBy: null },
    businessType: change.businessType,
    timezone: change.timezone ?? null,
    avgSpendPerVisit: change.avgSpendPerVisit ?? null,
    overlap: { legacyOnConnectChannels: [], automations: [], acknowledgedAt: null, acknowledgedBy: null },
    estimate: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
}

export async function applyVenueChanges(changes: VenueChange[], actor: Actor, now = new Date()): Promise<VenueChangeResult[]> {
  const authorKind = actor.kind === 'super_admin' ? 'platform' : 'owner';
  // Off-times and the in-flight save time are compared with send times, so they use the
  // engine's clock: the real `now`, or the local sandbox's fake clock where journeys run.
  if (sandboxEnabled()) await refreshClock();
  const offAt = sandboxEnabled() ? new Date(engineNow()) : now;

  return db.runTransaction(async (tx) => {
    // ── Reads (all before any write) ──
    const refs: DocumentReference[] = [];
    const index = new Map<string, number>();
    const want = (ref: DocumentReference) => {
      if (!index.has(ref.path)) {
        index.set(ref.path, refs.length);
        refs.push(ref);
      }
    };
    for (const c of changes) {
      want(adaptiveVenueRef(c.venueId));
      if (c.setup) want(venuePlaybookRef(c.venueId, c.setup.playbookKey));
      if (c.activateKey) want(venuePlaybookRef(c.venueId, c.activateKey));
      if (c.guestInfo) want(venuePlaybookRef(c.venueId, GUEST_INFO_KEY));
    }
    const snaps = refs.length ? await tx.getAll(...refs) : [];
    const snapOf = (ref: DocumentReference): DocumentSnapshot => snaps[index.get(ref.path) as number];

    // The currently active installs we may have to switch off need a read too.
    const extraRefs: DocumentReference[] = [];
    for (const c of changes) {
      const av = snapOf(adaptiveVenueRef(c.venueId));
      const current = av.exists ? ((av.data() as AdaptiveVenueDoc).activePlaybookKey ?? null) : null;
      if (c.activateKey && current && current !== c.activateKey) {
        const ref = venuePlaybookRef(c.venueId, current);
        if (!index.has(ref.path)) extraRefs.push(ref);
      }
    }
    const extraSnaps = extraRefs.length ? await tx.getAll(...extraRefs) : [];
    extraRefs.forEach((ref, i) => {
      index.set(ref.path, snaps.length + i);
    });
    const allSnaps = [...snaps, ...extraSnaps];
    const read = (ref: DocumentReference) => allSnaps[index.get(ref.path) as number];

    // ── Writes ──
    const results: VenueChangeResult[] = [];
    for (const c of changes) {
      const avRef = adaptiveVenueRef(c.venueId);
      const avSnap = read(avRef);
      const av: AdaptiveVenueDoc = avSnap.exists ? (avSnap.data() as AdaptiveVenueDoc) : newAdaptiveVenue(c, now);
      const result: VenueChangeResult = { venueId: c.venueId, status: av.status, activePlaybookKey: av.activePlaybookKey };

      if (c.timezone !== undefined) av.timezone = c.timezone;
      av.businessType = c.businessType;
      if (c.overlap) {
        av.overlap = {
          legacyOnConnectChannels: c.overlap.legacyOnConnectChannels,
          automations: c.overlap.automations,
          acknowledgedAt: c.overlap.acknowledged ? now : av.overlap?.acknowledgedAt ?? null,
          acknowledgedBy: c.overlap.acknowledged ? actor.uid : av.overlap?.acknowledgedBy ?? null,
        };
      }
      if (c.avgSpendPerVisit && !av.avgSpendPerVisit) av.avgSpendPerVisit = c.avgSpendPerVisit;
      if (c.estimate) av.estimate = { ...c.estimate, computedAt: now };

      // Marketing setup (+1 config version)
      if (c.setup) {
        const ref = venuePlaybookRef(c.venueId, c.setup.playbookKey);
        const snap = read(ref);
        const existing = snap.exists ? (snap.data() as VenuePlaybookDoc) : null;
        const configVersion = (existing?.configVersion ?? 0) + 1;
        const state: VenuePlaybookDoc['state'] = c.activateKey === c.setup.playbookKey ? 'active' : existing?.state ?? 'setup';
        const doc: VenuePlaybookDoc = {
          tenantUserId: c.tenantUserId,
          venueId: c.venueId,
          playbookKey: c.setup.playbookKey,
          kind: 'marketing',
          playbookVersion: c.setup.playbookVersion,
          state,
          configVersion,
          journeys: c.setup.journeys,
          offerMenu: c.setup.offerMenu,
          lastEditedBy: actor.uid,
          lastEditedAt: now,
          lastEditSource: authorKind,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        };
        const version: VenuePlaybookVersionDoc = {
          playbookVersion: c.setup.playbookVersion,
          journeys: c.setup.journeys,
          offerMenu: c.setup.offerMenu,
          author: { kind: authorKind, uid: actor.uid },
          applyToInFlight: false,
          note: c.setup.note ?? (state === 'active' ? 'Saved and turned on' : 'Saved'),
          createdAt: now,
          schemaVersion: SCHEMA_VERSION,
        };
        // When each journey was switched off, kept across later saves (the version keeps the owner's values only).
        doc.journeys = journeysWithOffTimes(existing, c.setup.journeys, offAt);
        if (c.setup.applyToInFlight) {
          version.applyToInFlight = true;
          firestoreScheduler.scheduleInTx(
            tx,
            applyInFlightTask({ tenantUserId: c.tenantUserId, venueId: c.venueId, installId: ref.id, configVersion, savedAt: offAt.getTime(), journeys: c.setup.journeys }),
          );
        }
        tx.set(ref, stripUndefined(doc));
        tx.create(ref.collection(VERSIONS).doc(String(configVersion)), stripUndefined(version));
        result.setup = { playbookKey: c.setup.playbookKey, state, configVersion };
      }

      // Turn a marketing playbook on — and the previous one off.
      if (c.activateKey) {
        const ref = venuePlaybookRef(c.venueId, c.activateKey);
        if (!c.setup || c.setup.playbookKey !== c.activateKey) {
          const snap = read(ref);
          if (!snap.exists) throw new VenueChangeError('not_found', `This venue has no setup for “${c.activateKey}” yet`);
          tx.update(ref, { state: 'active', updatedAt: now });
          result.setup = { playbookKey: c.activateKey, state: 'active', configVersion: (snap.data() as VenuePlaybookDoc).configVersion };
        }
        if (av.activePlaybookKey && av.activePlaybookKey !== c.activateKey) {
          const oldRef = venuePlaybookRef(c.venueId, av.activePlaybookKey);
          if (read(oldRef)?.exists) tx.update(oldRef, { state: 'inactive', updatedAt: now });
          // Its guests stop at their next send; one planned within the freeze window of this still goes.
          av.switchedOffAt = { ...(av.switchedOffAt ?? {}), [oldRef.id]: av.status === 'paused' && av.pausedAt ? av.pausedAt : offAt };
        }
        av.status = 'on';
        av.activePlaybookKey = c.activateKey;
        av.activeInstallId = venuePlaybookId(c.venueId, c.activateKey);
        av.activatedAt = now;
        av.activatedBy = actor.uid;
        if (av.switchedOffAt) delete av.switchedOffAt[av.activeInstallId];
        av.pausedAt = null;
      }

      if (c.status) {
        if (c.status === 'paused' && av.status !== 'on') throw new VenueChangeError('conflict', 'Only a running venue can be paused');
        if (c.status === 'on' && (av.status !== 'paused' || !av.activePlaybookKey)) {
          throw new VenueChangeError('conflict', 'Only a paused venue can be resumed');
        }
        av.status = c.status;
        av.pausedAt = c.status === 'paused' ? offAt : null;
      }

      // Guest info switch (independent of the marketing playbook)
      if (c.guestInfo) {
        const ref = venuePlaybookRef(c.venueId, GUEST_INFO_KEY);
        const snap = read(ref);
        const state: VenuePlaybookDoc['state'] = c.guestInfo.enabled ? 'active' : 'inactive';
        if (!snap.exists) {
          const doc: VenuePlaybookDoc = {
            tenantUserId: c.tenantUserId,
            venueId: c.venueId,
            playbookKey: GUEST_INFO_KEY,
            kind: 'utility',
            playbookVersion: c.guestInfo.playbookVersion,
            state,
            configVersion: 1,
            journeys: c.guestInfo.journeys,
            offerMenu: [],
            lastEditedBy: actor.uid,
            lastEditedAt: now,
            lastEditSource: authorKind,
            createdAt: now,
            updatedAt: now,
            schemaVersion: SCHEMA_VERSION,
          };
          tx.set(ref, stripUndefined(doc));
          tx.create(
            ref.collection(VERSIONS).doc('1'),
            stripUndefined({
              playbookVersion: c.guestInfo.playbookVersion,
              journeys: c.guestInfo.journeys,
              offerMenu: [],
              author: { kind: authorKind, uid: actor.uid },
              applyToInFlight: false,
              note: 'Guest info set up',
              createdAt: now,
              schemaVersion: SCHEMA_VERSION,
            } satisfies VenuePlaybookVersionDoc),
          );
        } else if ((snap.data() as VenuePlaybookDoc).state !== state) {
          tx.update(ref, { state, updatedAt: now, lastEditedBy: actor.uid, lastEditedAt: now });
        }
        const utilityWasOn = av.utility?.enabled === true;
        av.utility = {
          enabled: c.guestInfo.enabled,
          installId: venuePlaybookId(c.venueId, GUEST_INFO_KEY),
          enabledAt: c.guestInfo.enabled ? now : av.utility?.enabledAt ?? null,
          enabledBy: c.guestInfo.enabled ? actor.uid : av.utility?.enabledBy ?? null,
        };
        if (c.guestInfo.enabled && av.switchedOffAt) delete av.switchedOffAt[ref.id];
        if (!c.guestInfo.enabled && utilityWasOn) av.switchedOffAt = { ...(av.switchedOffAt ?? {}), [ref.id]: offAt };
        result.guestInfo = { enabled: c.guestInfo.enabled };
      }

      av.updatedAt = now;
      tx.set(avRef, stripUndefined(av));
      result.status = av.status;
      result.activePlaybookKey = av.activePlaybookKey;
      results.push(result);
    }
    return results;
  });
}

/**
 * The saved journeys with `disabledAt` (plan §3.10): set when a journey goes from on to
 * off, kept while it stays off (an older doc without it keeps its last edit time), and
 * dropped when it's on — so an unrelated later save never moves "switched off since".
 */
export function journeysWithOffTimes(
  existing: VenuePlaybookDoc | null,
  next: Record<string, VenueJourneyConfigDoc>,
  at: Date,
): Record<string, VenueJourneyConfigDoc> {
  const out: Record<string, VenueJourneyConfigDoc> = {};
  for (const [key, jc] of Object.entries(next)) {
    const { disabledAt: _drop, ...values } = jc;
    if (jc.enabled) {
      out[key] = values;
      continue;
    }
    const prev = existing?.journeys?.[key];
    const since = prev && !prev.enabled ? prev.disabledAt ?? existing?.lastEditedAt ?? at : at;
    out[key] = { ...values, disabledAt: since };
  }
  return out;
}
