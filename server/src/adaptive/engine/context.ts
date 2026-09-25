/**
 * What the worker needs to know about a venue, a guest and a journey before it
 * can enrol or advance anyone. Read-only.
 */

import { db } from '../../firebase';
import { COL, VERSIONS, adaptiveVenueId, guestInfoId, venuePlaybookId } from '../store/collections';
import type { AdaptiveVenueDoc, VenuePlaybookDoc, VenuePlaybookVersionDoc } from '../store/types';
import type { ContactDoc } from '../store/engineTypes';
import type { JourneyDefinition, Offer, SlotValue } from '../core/schemas';
import { GUEST_INFO_KEY } from '../store/venueSetups';
import { loadCatalogue, templateVersion } from '../service/catalogue';
import { isValidTimeZone } from '../core/runtime/time';
import type { JourneyTemplateHeaderDoc } from '../store/types';
import { tsMs } from '../store/time';

export interface Install {
  installId: string;
  playbookKey: string;
  kind: 'marketing' | 'utility';
  doc: VenuePlaybookDoc;
  /** When this install started counting guests (activation / Guest info switched on). */
  liveSince: number | null;
}

export interface VenueContext {
  venueId: string;
  tenantUserId: string;
  venueName: string;
  venueType: string;
  tz: string;
  adaptive: AdaptiveVenueDoc;
  /** The one active marketing playbook, when the venue is on. */
  marketing: Install | null;
  /** Guest info, when switched on. */
  utility: Install | null;
  audience: { sms: 'verified' | 'all'; email: 'verified' | 'all' };
}

export async function loadVenueContext(venueId: string): Promise<VenueContext | null> {
  const [avSnap, venueSnap] = await Promise.all([
    db.collection(COL.adaptiveVenues).doc(adaptiveVenueId(venueId)).get(),
    db.collection(COL.venues).doc(venueId).get(),
  ]);
  if (!avSnap.exists) return null;
  const adaptive = avSnap.data() as AdaptiveVenueDoc & { audience?: { sms?: string; email?: string } };
  const venue = (venueSnap.data() ?? {}) as Record<string, unknown>;

  let marketing: Install | null = null;
  if (adaptive.status === 'on' && adaptive.activeInstallId && adaptive.activePlaybookKey) {
    const snap = await db.collection(COL.venuePlaybooks).doc(adaptive.activeInstallId).get();
    const doc = snap.data() as VenuePlaybookDoc | undefined;
    if (doc && doc.state === 'active') {
      marketing = { installId: adaptive.activeInstallId, playbookKey: adaptive.activePlaybookKey, kind: 'marketing', doc, liveSince: tsMs(adaptive.activatedAt) };
    }
  }

  let utility: Install | null = null;
  if (adaptive.utility?.enabled) {
    const installId = adaptive.utility.installId ?? venuePlaybookId(venueId, GUEST_INFO_KEY);
    const snap = await db.collection(COL.venuePlaybooks).doc(installId).get();
    const doc = snap.data() as VenuePlaybookDoc | undefined;
    if (doc) utility = { installId, playbookKey: doc.playbookKey, kind: 'utility', doc, liveSince: tsMs(adaptive.utility.enabledAt) };
  }

  const tz = [adaptive.timezone, venue.timezone].find((z) => isValidTimeZone(z)) as string | undefined;
  return {
    venueId,
    tenantUserId: adaptive.tenantUserId,
    venueName: String(venue.venue_name ?? venue.name ?? ''),
    venueType: String(venue.venue_type ?? adaptive.businessType ?? 'other'),
    tz: tz ?? 'Europe/Zurich',
    adaptive,
    marketing,
    utility,
    audience: {
      sms: adaptive.audience?.sms === 'all' ? 'all' : 'verified',
      email: adaptive.audience?.email === 'verified' ? 'verified' : 'all',
    },
  };
}

export interface JourneyRef {
  install: Install;
  journeyKey: string;
  templateVersion: number;
  configVersion: number;
  definition: JourneyDefinition;
  header: JourneyTemplateHeaderDoc;
}

/** The journeys switched on at this venue (active playbook + Guest info), with their pinned definitions. */
export async function enabledJourneys(ctx: VenueContext): Promise<JourneyRef[]> {
  const cat = await loadCatalogue();
  const out: JourneyRef[] = [];
  for (const install of [ctx.marketing, ctx.utility]) {
    if (!install) continue;
    for (const [journeyKey, jc] of Object.entries(install.doc.journeys ?? {})) {
      if (!jc.enabled) continue;
      const found = templateVersion(cat, journeyKey, jc.templateVersion);
      if (!found || found.record.header.availability !== 'available') continue;
      out.push({
        install,
        journeyKey,
        templateVersion: jc.templateVersion,
        configVersion: install.doc.configVersion,
        definition: found.definition,
        header: found.record.header,
      });
    }
  }
  return out;
}

export interface PinnedConfig {
  slots: Record<string, SlotValue>;
  offers: Offer[];
  enabled: boolean;
}

/** The owner's values an instance runs with: its pinned config version (falls back to the live doc). */
export async function pinnedConfig(installId: string, configVersion: number, journeyKey: string): Promise<PinnedConfig> {
  const vSnap = await db.collection(COL.venuePlaybooks).doc(installId).collection(VERSIONS).doc(String(configVersion)).get();
  const v = vSnap.data() as VenuePlaybookVersionDoc | undefined;
  if (v) {
    const jc = v.journeys?.[journeyKey];
    return { slots: jc?.slots ?? {}, offers: v.offerMenu ?? [], enabled: Boolean(jc?.enabled) };
  }
  const live = (await db.collection(COL.venuePlaybooks).doc(installId).get()).data() as VenuePlaybookDoc | undefined;
  const jc = live?.journeys?.[journeyKey];
  return { slots: jc?.slots ?? {}, offers: live?.offerMenu ?? [], enabled: Boolean(jc?.enabled) };
}

export async function loadContact(contactId: string): Promise<ContactDoc | null> {
  const snap = await db.collection(COL.contacts).doc(contactId).get();
  return snap.exists ? (snap.data() as ContactDoc) : null;
}

export async function loadGuestInfo(venueId: string): Promise<Record<string, any> | null> {
  const snap = await db.collection(COL.venueGuestInfo).doc(guestInfoId(venueId)).get();
  return snap.exists ? (snap.data() as Record<string, any>) : null;
}

/**
 * Is this guest's journey still switched on here — and if not, since when? (plan §3.10)
 *
 * "Since when" comes from timestamps written at the moment of the switch
 * (store/venueSetups.ts): `pausedAt` on the venue, `switchedOffAt[installId]` for a
 * playbook switched away or Guest info turned off, `disabledAt` on a journey. So a
 * later, unrelated save can't move it and re-open the freeze window. When several
 * apply, the earliest wins: the journey has been off since then. Older docs without
 * them fall back to their last edit time.
 */
export async function journeyOnState(
  ctx: VenueContext | null,
  installId: string,
  journeyKey: string,
): Promise<{ venueOn: boolean; journeyOn: boolean; offSinceAt: number | null }> {
  if (!ctx) return { venueOn: false, journeyOn: false, offSinceAt: null };
  const live = ctx.marketing?.installId === installId ? ctx.marketing : ctx.utility?.installId === installId ? ctx.utility : null;
  if (live) {
    if (live.doc.journeys?.[journeyKey]?.enabled) return { venueOn: true, journeyOn: true, offSinceAt: null };
    return { venueOn: true, journeyOn: false, offSinceAt: journeyOffSince(live.doc, journeyKey) };
  }

  // The install doesn't run here any more: the venue is paused, another playbook was
  // turned on, or Guest info was switched off.
  const av = ctx.adaptive;
  const times: Array<number | null> = [];
  const utilityId = av.utility?.installId ?? venuePlaybookId(ctx.venueId, GUEST_INFO_KEY);
  const switchedAt = tsMs(av.switchedOffAt?.[installId]);
  const doc = (await db.collection(COL.venuePlaybooks).doc(installId).get()).data() as VenuePlaybookDoc | undefined;
  if (installId === utilityId) times.push(switchedAt ?? tsMs(av.updatedAt));
  else if (av.activeInstallId !== installId) times.push(switchedAt ?? tsMs(av.activatedAt) ?? tsMs(av.updatedAt));
  else if (av.status !== 'on') times.push(tsMs(av.pausedAt) ?? tsMs(av.updatedAt));
  else times.push(tsMs(doc?.updatedAt) ?? tsMs(av.updatedAt)); // on, but its setup isn't active
  // The journey itself may have been switched off even earlier.
  if (doc && !doc.journeys?.[journeyKey]?.enabled) times.push(journeyOffSince(doc, journeyKey));
  const known = times.filter((t): t is number => t !== null);
  return { venueOn: false, journeyOn: false, offSinceAt: known.length ? Math.min(...known) : null };
}

function journeyOffSince(doc: VenuePlaybookDoc, journeyKey: string): number | null {
  return tsMs(doc.journeys?.[journeyKey]?.disabledAt) ?? tsMs(doc.lastEditedAt) ?? tsMs(doc.updatedAt);
}
