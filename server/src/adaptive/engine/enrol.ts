/**
 * Starting journeys (04-engine-runtime §2.4), idempotent:
 *
 *   instanceId = ji_ + hash(venue : contact : journey : entryKey)
 *   one transaction on ContactVenues + the instance:
 *     - already enrolled (same id)            → nothing
 *     - already in this journey (one at a time) → nothing
 *     - re-entry rule forbids (never / cooldown) → nothing
 *     - else create the instance (pinned template + config version, frozen test/live
 *       mode), mark the journey on ContactVenues, queue the first step.
 *
 * Only guests who connect after the venue was switched on start journeys — the
 * owner was promised "past guests aren't messaged out of the blue".
 */

import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactDoc, ContactVenueDoc } from '../store/engineTypes';
import { instanceIdFor } from '../core/runtime/ids';
import { entryKeyFor, triggerMatches } from '../core/runtime/triggers';
import { evaluateCondition, factsFrom } from '../core/runtime/conditions';
import { freshState, type EngineEvent, type RunMode } from '../core/runtime/types';
import { durationMs } from '../core/runtime/time';
import { phoneCountry } from '../core/runtime/phoneCountry';
import type { Lang } from '../core/constants';
import { consentFor } from '../identity/resolve';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { appendEventInTx } from './events';
import { enabledJourneys, type JourneyRef, type VenueContext } from './context';
import { instanceRef, newInstanceDoc, type InstanceMeta } from './instanceStore';
import { channelAdapters } from './sendPath';
import { tsMs } from '../store/time';

export interface EnrolWho {
  contactId: string;
  networkId: string;
  contact: ContactDoc;
}

export interface VisitFacts {
  visitId: string;
  visitNumber: number;
  isFirstVisit: boolean;
  isRevisit: boolean;
}

export function journeyFacts(ctx: VenueContext, contact: ContactDoc | null, visit: Partial<VisitFacts> | null, extra: Record<string, unknown> = {}) {
  return factsFrom({
    contact: {
      lang: contact?.lang ?? null,
      phoneCountry: contact?.phoneCountry ?? null,
      emailVerified: Boolean(contact?.emailVerified),
      phoneVerified: Boolean(contact?.phoneVerified),
      hasEmail: Boolean(contact?.email),
      hasPhone: Boolean(contact?.phoneE164),
    },
    visit: visit ? { isFirst: visit.isFirstVisit, number: visit.visitNumber, isRevisit: visit.isRevisit } : {},
    venue: { type: ctx.venueType, timezone: ctx.tz },
    ...extra,
  });
}

function hasMarketingConsent(contact: ContactDoc, venueId: string): boolean {
  return Object.values(consentFor(contact, venueId)).some((c) => c?.state === 'granted');
}

/** Enrol the guest in every switched-on journey this event starts. Returns the new instance ids. */
export async function enrolForEvent(args: {
  ctx: VenueContext;
  who: EnrolWho;
  event: EngineEvent;
  mode: RunMode;
  visit: VisitFacts | null;
  now: number;
  /** Only these journeys (stay moments name one). */
  onlyJourney?: string;
  stayId?: string | null;
}): Promise<string[]> {
  const { ctx, who, event } = args;
  const created: string[] = [];
  // Until sending ships (PR B) no channel adapter is registered: a live journey could
  // only be blocked and used up. Start none, so these guests keep their journeys.
  if (args.mode === 'live' && !Object.values(channelAdapters).some((c) => c?.ready())) {
    console.warn('[ADAPTIVE] account is live but no sending channel is set up — no journeys started');
    return created;
  }
  for (const j of await enabledJourneys(ctx)) {
    if (args.onlyJourney && j.journeyKey !== args.onlyJourney) continue;
    if (!triggerMatches(j.definition.entry.trigger, event, j.journeyKey)) continue;
    // "Only new Wi-Fi guests from today": nothing before this install went live.
    if (j.install.liveSince !== null && event.occurredAt < j.install.liveSince) continue;
    if (j.definition.entry.requires.includes('consent:venue:marketing') && !hasMarketingConsent(who.contact, ctx.venueId)) continue;
    if (j.definition.entry.when && !evaluateCondition(j.definition.entry.when, journeyFacts(ctx, who.contact, args.visit))) continue;
    const id = await enrolOne({ ...args, journey: j });
    if (id) created.push(id);
  }
  return created;
}

async function enrolOne(args: {
  ctx: VenueContext;
  who: EnrolWho;
  event: EngineEvent;
  mode: RunMode;
  visit: VisitFacts | null;
  now: number;
  stayId?: string | null;
  journey: JourneyRef;
}): Promise<string | null> {
  const { ctx, who, event, journey: j, now } = args;
  const reentry = j.definition.entry.reentry;
  const entryKey = entryKeyFor(reentry.mode, event);
  const instanceId = instanceIdFor(ctx.venueId, who.contactId, j.journeyKey, entryKey);
  const cvRef = db.collection(COL.contactVenues).doc(contactVenueId(who.contactId, ctx.venueId));

  return db.runTransaction(async (tx) => {
    const [cvSnap, instSnap] = await Promise.all([tx.get(cvRef), tx.get(instanceRef(instanceId))]);
    if (instSnap.exists) return null;
    const cv = cvSnap.exists ? (cvSnap.data() as ContactVenueDoc) : null;
    const cvj = cv?.journeys?.[j.journeyKey];
    if (cvj?.activeInstanceId) return null;
    if (reentry.mode === 'never' && (cvj?.entries ?? 0) > 0) return null;
    if (reentry.mode === 'cooldown' && reentry.cooldown) {
      const last = tsMs(cvj?.lastEnteredAt);
      if (last !== null && now - last < durationMs(reentry.cooldown)) return null;
    }

    const lang = (who.contact.lang ?? 'en') as Lang;
    const meta: InstanceMeta = {
      tenantUserId: ctx.tenantUserId,
      venueId: ctx.venueId,
      contactId: who.contactId,
      networkId: who.networkId,
      playbookKey: j.install.playbookKey,
      installId: j.install.installId,
      journeyKey: j.journeyKey,
      entryKey,
      entryEventId: event.id,
      templateVersion: j.templateVersion,
      configVersion: j.configVersion,
      pendingConfigVersion: null,
      purpose: j.header.purpose,
      mode: args.mode,
      context: {
        lang,
        venueTz: ctx.tz,
        phoneTz: phoneCountry(who.contact.phoneE164)?.tz ?? null,
        isFirstVisit: Boolean(args.visit?.isFirstVisit),
        stayId: args.stayId ?? null,
        guestId: typeof event.data.guestId === 'string' ? event.data.guestId : null,
        visitNumber: args.visit?.visitNumber ?? null,
        isRevisit: args.visit ? args.visit.isRevisit : null,
      },
    };
    const state = freshState(j.definition.start, now);
    // The first step runs through the same token check as every timer.
    state.waiting = { kind: 'timer', nodeId: '__start', token: 'start', untilAt: now };

    tx.set(instanceRef(instanceId), newInstanceDoc(meta, state, now));
    const entry = {
      activeInstanceId: instanceId,
      entries: (cvj?.entries ?? 0) + 1,
      lastEnteredAt: new Date(now),
      lastExitAt: cvj?.lastExitAt ?? null,
      lastExitReason: cvj?.lastExitReason ?? null,
    };
    if (cv) {
      tx.update(cvRef, new FieldPath('journeys', j.journeyKey), entry, new FieldPath('updatedAt'), new Date());
    } else {
      tx.set(cvRef, { tenantUserId: ctx.tenantUserId, venueId: ctx.venueId, contactId: who.contactId, journeys: { [j.journeyKey]: entry }, updatedAt: new Date() }, { merge: true });
    }
    firestoreScheduler.scheduleInTx(tx, {
      dedupeKey: `node:${instanceId}:start`,
      kind: 'node_run',
      dueAt: now,
      payload: { instanceId, input: 'start', token: 'start' },
      tenantUserId: ctx.tenantUserId,
      venueId: ctx.venueId,
    });
    appendEventInTx(tx, {
      type: 'journey.entered',
      occurredAt: now,
      tenantUserId: ctx.tenantUserId,
      venueId: ctx.venueId,
      contactId: who.contactId,
      instanceId,
      journeyKey: j.journeyKey,
      data: { entryKey, entryEventId: event.id, mode: args.mode, templateVersion: j.templateVersion, configVersion: j.configVersion },
    });
    return instanceId;
  });
}
