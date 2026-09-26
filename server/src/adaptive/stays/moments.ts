/**
 * Stay moments (plan §3.3 item 5, brief §4): once a guest is linked, each stay journey
 * starts at its moment — arrival day 17:00, day 2 10:00, checkout day 15:00, … — as a
 * `stay_trigger` task that re-checks everything when it runs and then delivers a
 * `stay.moment` event naming the journey (core/runtime/triggers.ts matches it).
 *
 *  - Scheduled for every `stay.window` journey the venue could run — its installs' journeys
 *    (a paused playbook and Guest info switched off included) and the catalogue's other
 *    stay journeys (a playbook turned on after the link) — on or off; "switched on" is
 *    checked when the moment comes (D-C17, a refinement of the plan). So a guest linked
 *    during a short pause, or before the stay playbook was turned on, still gets the
 *    moments that come while it is on.
 *  - A moment up to 12 h past runs at once; later it is skipped and recorded as
 *    `stay.moment_skipped` — never typed `stay.moment`, which would enrol (D-C14).
 *  - A guest who checked out before the journey's install went live gets none of its
 *    moments ("past guests aren't messaged"): recorded once as `moment.passed` — not a
 *    `stay.*` event, those are the stay numbers — so "why" can still say it.
 *  - After a date change only journeys with no instance for this stay are (re)scheduled:
 *    one that started only hears `stay.changed`, one that ended doesn't restart.
 *  - Task keys carry the stay's `datesVersion`, so dates going A → B → A still get a
 *    task (a done task blocks its key for 7 days); a task from older dates does nothing.
 */

import { db } from '../../firebase';
import { COL, venuePlaybookId } from '../store/collections';
import type { VenuePlaybookDoc } from '../store/types';
import { GUEST_INFO_KEY } from '../store/venueSetups';
import { getTriggerContract } from '../core/registry';
import { eventIdFor, instanceIdFor } from '../core/runtime/ids';
import { MINUTE_MS } from '../core/runtime/time';
import { tsMs } from '../store/time';
import type { RunMode } from '../core/runtime/types';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { loadCatalogue, templateVersion } from '../service/catalogue';
import { readEngineSettings, startedSendingAt, venueModeFor, type EngineSettings } from '../store/engineSettings';
import { appendEvent } from '../engine/events';
import { enabledJourneys, journeyOnState, loadContact, loadVenueContext, type VenueContext } from '../engine/context';
import { enrolForEvent } from '../engine/enrol';
import { instanceRef, loadInstance } from '../engine/instanceStore';
import { loadStay, type LoadedStay } from './store';
import { checkedOutBeforeLive, guideStillSends, stayFacts } from './plan';
import { MOMENT_GRACE_MS, linkSeqSuffix, momentFor, planMoment, stayTriggerKey } from './times';

export interface StayTriggerPayload {
  stayId: string;
  journeyKey: string;
  installId: string;
  momentAt: number;
  datesVersion: number;
  contactId: string;
  /** The link generation the moment was scheduled for (absent = 0, the first link). */
  linkSeq?: number;
}

const STAY_GUIDE = 'stay_guide';
const CHECKOUT_REMINDER = 'checkout_reminder';

/** "Not started for this stay": a direct get of the journey's instance for this stay, any status. */
async function hasInstance(venueId: string, contactId: string, journeyKey: string, stayId: string): Promise<boolean> {
  return (await instanceRef(instanceIdFor(venueId, contactId, journeyKey, `stay:${stayId}`)).get()).exists;
}

async function recordSkipped(stay: LoadedStay, journeyKey: string, momentAt: number, reason: 'too_late' | 'switched_off', now: number): Promise<void> {
  // At most once per stay and journey (no datesVersion in the id); appendEvent keeps an existing one.
  await appendEvent(
    {
      type: 'stay.moment_skipped',
      occurredAt: now,
      tenantUserId: stay.tenantUserId,
      venueId: stay.venueId,
      contactId: stay.contactId,
      data: { stayId: stay.id, journeyKey, momentAt, reason },
    },
    eventIdFor('engine', `stay:${stay.id}:${journeyKey}:skipped${linkSeqSuffix(stay.linkSeq)}`),
  );
}

async function recordPassed(
  stay: LoadedStay,
  journeyKey: string,
  momentAt: number,
  liveSince: number,
  now: number,
  reason: 'checked_out_before_live' | 'checked_out_before_start_sending' = 'checked_out_before_live',
): Promise<void> {
  // Uncounted (the rollups ignore the type), at most once per stay and journey. The journey key
  // is on the event itself so a guest's timeline says which message it was.
  await appendEvent(
    {
      type: 'moment.passed',
      occurredAt: now,
      tenantUserId: stay.tenantUserId,
      venueId: stay.venueId,
      contactId: stay.contactId,
      journeyKey,
      data: { stayId: stay.id, journeyKey, momentAt, reason, checkOutAt: stay.checkOutAt, liveSince },
    },
    // Per link generation (PR D): a guest linked after an unlink gets their own record.
    eventIdFor('engine', `stay:${stay.id}:${journeyKey}:passed${linkSeqSuffix(stay.linkSeq)}`),
  );
}

/**
 * The venue's installs a stay journey can come from, running or not: the marketing playbook
 * (also while the venue is paused) and Guest info (also while switched off).
 */
async function venueInstalls(ctx: VenueContext): Promise<Array<{ installId: string; doc: VenuePlaybookDoc; liveSince: number | null }>> {
  const out: Array<{ installId: string; doc: VenuePlaybookDoc; liveSince: number | null }> = [];
  if (ctx.marketing) out.push({ installId: ctx.marketing.installId, doc: ctx.marketing.doc, liveSince: ctx.marketing.liveSince });
  else if (ctx.adaptive.activeInstallId) {
    const doc = (await db.collection(COL.venuePlaybooks).doc(ctx.adaptive.activeInstallId).get()).data() as VenuePlaybookDoc | undefined;
    if (doc && doc.state === 'active') out.push({ installId: ctx.adaptive.activeInstallId, doc, liveSince: tsMs(ctx.adaptive.activatedAt) });
  }
  if (ctx.utility) out.push({ installId: ctx.utility.installId, doc: ctx.utility.doc, liveSince: ctx.utility.liveSince });
  else {
    const installId = ctx.adaptive.utility?.installId ?? venuePlaybookId(ctx.venueId, GUEST_INFO_KEY);
    const doc = (await db.collection(COL.venuePlaybooks).doc(installId).get()).data() as VenuePlaybookDoc | undefined;
    if (doc) out.push({ installId, doc, liveSince: tsMs(ctx.adaptive.utility?.enabledAt) });
  }
  return out;
}

/** The install of this venue that has the journey (on or off), if any: only then is a moment it misses worth recording. */
async function installWith(ctx: VenueContext, journeyKey: string): Promise<{ installId: string; liveSince: number | null } | null> {
  return (await venueInstalls(ctx)).find((i) => Boolean(i.doc.journeys?.[journeyKey])) ?? null;
}

/**
 * Schedules the linked guest's stay moments at the stay's current `datesVersion`, for the
 * journeys that have no instance for this stay yet. Safe to run again (create-only keys).
 * A journey an install has keeps that install's template version; any other stay journey
 * of the catalogue (for the venue's type) uses its published version.
 */
export async function scheduleStayMoments(stay: LoadedStay, ctx: VenueContext, now: number): Promise<{ scheduled: number; skipped: number }> {
  const out = { scheduled: 0, skipped: 0 };
  if (!stay.contactId || stay.status === 'cancelled') return out;
  // A venue that waited for its owner's Start sending (PR D): a guest who had left before the click
  // gets nothing from it, and nothing of theirs counts as missed.
  const startedAt = startedSendingAt(await readEngineSettings(), ctx.adaptive);
  const cat = await loadCatalogue();
  const contract = getTriggerContract('stay.window');
  if (!contract) return out;
  const pinned = new Map<string, { installId: string; templateVersion: number; liveSince: number | null }>();
  for (const install of await venueInstalls(ctx)) {
    for (const [journeyKey, jc] of Object.entries(install.doc.journeys ?? {})) {
      if (!pinned.has(journeyKey)) pinned.set(journeyKey, { installId: install.installId, templateVersion: jc.templateVersion, liveSince: install.liveSince });
    }
  }
  for (const [journeyKey, record] of cat.templates) {
    const pin = pinned.get(journeyKey);
    if (!pin && Array.isArray(record.header.venueTypes) && !record.header.venueTypes.includes(ctx.venueType as never)) continue;
    const version = pin?.templateVersion ?? record.header.publishedVersion;
    const found = version ? templateVersion(cat, journeyKey, version) : null;
    const trigger = found?.definition.entry.trigger;
    if (!trigger || trigger.type !== 'stay.window') continue;
    const parsed = contract.configSchema.safeParse(trigger.config ?? {});
    if (!parsed.success) continue;
    const cfg = parsed.data as { anchor: 'checkInAt' | 'checkOutAt'; offsetDays: number; at: string };
    if (await hasInstance(ctx.venueId, stay.contactId, journeyKey, stay.id)) continue;
    const momentAt = momentFor(cfg.anchor === 'checkInAt' ? stay.checkInAt : stay.checkOutAt, ctx.tz, cfg.at, cfg.offsetDays);
    const plan = planMoment(momentAt, now);
    if (plan.kind === 'too_late') {
      // Only for a journey the venue has: a moment of a playbook it never set up isn't "missed",
      // nor one of a guest who had left before it went live (dates re-read after a turn-on) or
      // before the venue's Start sending.
      if (pin && !checkedOutBeforeLive(stay, pin.liveSince) && !checkedOutBeforeLive(stay, startedAt)) {
        await recordSkipped(stay, journeyKey, momentAt, 'too_late', now);
        out.skipped += 1;
      }
      continue;
    }
    const payload: StayTriggerPayload = { stayId: stay.id, journeyKey, installId: pin?.installId ?? '', momentAt, datesVersion: stay.datesVersion, contactId: stay.contactId, linkSeq: stay.linkSeq ?? 0 };
    await firestoreScheduler.schedule({
      dedupeKey: stayTriggerKey(stay.id, journeyKey, stay.datesVersion, momentAt, stay.linkSeq),
      kind: 'stay_trigger',
      dueAt: plan.kind === 'later' ? plan.at : now,
      payload: { ...payload },
      tenantUserId: stay.tenantUserId,
      venueId: stay.venueId,
    });
    out.scheduled += 1;
  }
  return out;
}

/** The stricter of two modes: a guest linked in a test run stays a test run (D-C13). */
function stricter(linkMode: RunMode | null, current: RunMode): RunMode {
  return linkMode === 'test' || current === 'test' ? 'test' : 'live';
}

/**
 * The checkout overlap rule (plan §3.2, D-C16): the Checkout reminder doesn't start when
 * this stay's Stay guide covers the guest, i.e. at the reminder's moment
 *  - the stay has 2+ nights (for 1 night Stay guide's checkout step is already past), and
 *  - Stay guide is on by the gate's own rule (on, or switched off / paused within the
 *    freeze window before the moment — then the gate still sends its checkout message; with
 *    a 15 min margin for the worker's lag, so near the edge the reminder goes too), and
 *  - this stay's Stay guide instance is active or completed.
 * Read from the Stay and the instance docs — never from "has the other task run yet"
 * (both fire at the same moment, 4 tasks run at a time).
 */
export async function stayGuideCovers(ctx: VenueContext, stay: LoadedStay, momentAt: number): Promise<boolean> {
  if (stay.nights < 2 || !stay.contactId) return false;
  const inst = await loadInstance(instanceIdFor(ctx.venueId, stay.contactId, STAY_GUIDE, `stay:${stay.id}`));
  if (!inst || (inst.state.status !== 'active' && inst.state.status !== 'completed')) return false;
  const on = await journeyOnState(ctx, inst.meta.installId, STAY_GUIDE);
  if (on.venueOn && on.journeyOn) return true;
  const cat = await loadCatalogue();
  const freezeMs = (Number.isFinite(cat.config.freezeWindowMinutes) ? cat.config.freezeWindowMinutes : 60) * MINUTE_MS;
  return guideStillSends(momentAt, on.offSinceAt, freezeMs);
}

export type StayTriggerOutcome =
  | 'gone'
  | 'stale'
  | 'too_late'
  | 'off'
  | 'switched_off'
  | 'not_installed'
  | 'checked_out_before_live'
  | 'covered'
  | 'enrolled'
  | 'not_enrolled';

/** The `stay_trigger` task: everything is checked again now, then the journey starts (or not). */
export async function handleStayTrigger(p: StayTriggerPayload, env: { now: number; settings: EngineSettings }): Promise<StayTriggerOutcome> {
  const stay = await loadStay(p.stayId);
  // A linked stay that got flagged as overlapping keeps its moments (D-C10); a cancelled one doesn't.
  if (!stay || stay.status === 'cancelled' || stay.contactId !== p.contactId) return 'gone';
  // Unlinked and linked again since (PR D): this moment belonged to the earlier link.
  if ((stay.linkSeq ?? 0) !== (p.linkSeq ?? 0)) return 'gone';
  if (stay.datesVersion !== p.datesVersion) return 'stale'; // the dates moved: a newer task has the new moment
  const ctx = await loadVenueContext(stay.venueId);
  if (!ctx) return 'gone';
  // Checked out before the journey's install went live (e.g. the stay playbook turned on after
  // they left): not even a moment after the turn-on reaches them, and none counts as missed —
  // also when it is off, paused or late now. Read from the install now, never from the payload's
  // `installId` (a date change re-stamps it with the install of that time).
  const install = await installWith(ctx, p.journeyKey);
  if (install && checkedOutBeforeLive(stay, install.liveSince)) {
    await recordPassed(stay, p.journeyKey, p.momentAt, install.liveSince!, env.now);
    return 'checked_out_before_live';
  }
  // The same for a venue that waited for its owner's Start sending (PR D, D-D1: nobody is
  // backfilled): a guest who checked out before the click gets nothing from it.
  const startedAt = startedSendingAt(env.settings, ctx.adaptive);
  if (install && checkedOutBeforeLive(stay, startedAt)) {
    await recordPassed(stay, p.journeyKey, p.momentAt, startedAt!, env.now, 'checked_out_before_start_sending');
    return 'checked_out_before_live';
  }
  if (env.now - p.momentAt > MOMENT_GRACE_MS) {
    if (install) await recordSkipped(stay, p.journeyKey, p.momentAt, 'too_late', env.now);
    return 'too_late';
  }
  // Launch off — or the venue waits for the owner's Start sending (PR D), judged at the
  // moment's time (the later of the moment and the link, as enrolment is): nothing new starts.
  const current = venueModeFor(env.settings, ctx.adaptive, Math.max(p.momentAt, stay.linkedAt ?? p.momentAt));
  if (current === 'off') return 'off';
  const mode = stricter(stay.linkMode, current);

  // Switched on now? (a paused venue, a journey or template switched off → that moment is lost)
  const journey = (await enabledJourneys(ctx)).find((j) => j.journeyKey === p.journeyKey);
  if (!journey || journey.definition.entry.trigger.type !== 'stay.window') {
    // A journey the venue never set up (e.g. the stay playbook isn't turned on) is quietly passed.
    if (!install) return 'not_installed';
    await recordSkipped(stay, p.journeyKey, p.momentAt, 'switched_off', env.now);
    return 'switched_off';
  }
  if (p.journeyKey === CHECKOUT_REMINDER && (await stayGuideCovers(ctx, stay, p.momentAt))) return 'covered';

  const contact = await loadContact(p.contactId);
  if (!contact) return 'gone';
  // Its time is at least the link time (D-C33): enrolment skips events before the install went
  // live, and a guest linked after that must still get the moment that brought them in.
  const occurredAt = Math.max(p.momentAt, stay.linkedAt ?? p.momentAt);
  const id = eventIdFor('engine', `stay:${stay.id}:${p.journeyKey}:${p.momentAt}${linkSeqSuffix(stay.linkSeq)}`);
  const data = { stayId: stay.id, journeyKey: p.journeyKey, momentAt: p.momentAt, ...(stay.linkedGuestId ? { guestId: stay.linkedGuestId } : {}) };
  await appendEvent({ type: 'stay.moment', occurredAt, tenantUserId: stay.tenantUserId, venueId: stay.venueId, contactId: stay.contactId, guestId: stay.linkedGuestId, data }, id);
  const started = await enrolForEvent({
    ctx,
    who: { contactId: p.contactId, networkId: contact.networkId, contact },
    event: { id, type: 'stay.moment', occurredAt, venueId: stay.venueId, contactId: stay.contactId, data },
    mode,
    visit: null,
    now: env.now,
    onlyJourney: p.journeyKey,
    stayId: stay.id,
    facts: stayFacts(stay),
  });
  return started.length ? 'enrolled' : 'not_enrolled';
}

