/**
 * The `scan_trigger` task (PR S): one guest, one scan journey, one occasion. Like a stay moment
 * (stays/moments.ts) everything is checked again when it runs, then a deterministic `scan.due`
 * event starts the journey:
 *
 *  - too late (> 12 h past its time) → nothing;
 *  - the venue's mode judged at the guest's qualifying visit (S-D1, PR D): launch off, or the
 *    venue waited for its owner's Start sending at that time → nothing; a visit from before the
 *    account went live is a test run (as at a visit's end, engine/route.ts handleVisitEnd);
 *  - the journey still switched on, still a scan journey of this kind, a version that runs;
 *  - the visit came after the marketing playbook went live ("past guests aren't messaged");
 *  - the occasion still holds: no visit since (win-back, slow times), the month unchanged
 *    (birthday), the holiday still picked (holidays); no ≤ 2★ rating here.
 */

import { db } from '../../firebase';
import { COL, contactVenueId } from '../store/collections';
import type { ContactVenueDoc } from '../store/engineTypes';
import { accountLiveSince, venueModeFor, type EngineSettings } from '../store/engineSettings';
import { tsMs } from '../store/time';
import { eventIdFor } from '../core/runtime/ids';
import type { RunMode } from '../core/runtime/types';
import { HOUR_MS, durationMs } from '../core/runtime/time';
import { consentFor } from '../identity/resolve';
import { parseHolidayKeys } from '../core/scans/holidays';
import { OCCASION_TRIGGER, SCAN_EVENT, occasionKey, occasionVars, scanJourneyRunnable, type Occasion } from '../core/scans/occasions';
import { appendEvent } from '../engine/events';
import { enabledJourneys, loadContact, loadVenueContext } from '../engine/context';
import { enrolForEvent } from '../engine/enrol';
import { deliverEvent } from '../engine/advance';
import { loadInstance } from '../engine/instanceStore';
import { mustDeliver } from '../engine/route';

export interface ScanTriggerPayload {
  venueId: string;
  journeyKey: string;
  contactId: string;
  occasion: Occasion;
  qualifiedAt: number;
  dueAt: number;
}

/** A trigger handled more than this late does nothing (the next scan finds the guest again if it still applies). */
export const SCAN_TRIGGER_GRACE_MS = 12 * HOUR_MS;

export type ScanTriggerOutcome =
  | 'gone'
  | 'too_late'
  | 'off'
  | 'switched_off'
  | 'before_start'
  | 'no_longer_applies'
  | 'busy'
  | 'no_consent'
  | 'cooldown'
  | 'enrolled'
  | 'not_enrolled';

/** Does the occasion still hold for this guest now? */
function stillApplies(p: ScanTriggerPayload, cv: ContactVenueDoc | null, contactMonth: unknown, slots: Record<string, unknown>, holidaySlot: string): boolean {
  if (!cv || tsMs(cv.lowRatingAt) !== null) return false;
  const last = tsMs(cv.lastVisitAt);
  switch (p.occasion.kind) {
    case 'winback':
    case 'slow':
      // Came back since the scan: the occasion is gone (a new visit starts its own clock).
      return last === p.qualifiedAt;
    case 'birthday':
      return contactMonth === p.occasion.month;
    case 'holiday':
      return parseHolidayKeys(slots[holidaySlot]).includes(p.occasion.holidayKey);
  }
}

export async function handleScanTrigger(p: ScanTriggerPayload, env: { now: number; settings: EngineSettings; workerId?: string }): Promise<ScanTriggerOutcome> {
  if (env.now - p.dueAt > SCAN_TRIGGER_GRACE_MS) return 'too_late';
  const ctx = await loadVenueContext(p.venueId);
  if (!ctx) return 'gone';
  // Judged at the guest's qualifying visit (S-D1): nobody from before the launch or the Start
  // sending click; a visit from before the account went live stays a test run.
  const qualifiedAt = p.qualifiedAt;
  let mode: RunMode | 'off' = venueModeFor(env.settings, ctx.adaptive, qualifiedAt);
  if (mode === 'off') return 'off';
  if (mode === 'live') {
    const ls = accountLiveSince(env.settings, ctx.tenantUserId);
    if (ls !== null && qualifiedAt < ls) mode = 'test';
  }

  const journey = (await enabledJourneys(ctx)).find((j) => j.journeyKey === p.journeyKey);
  if (!journey || journey.install.kind !== 'marketing') return 'switched_off';
  const trigger = journey.definition.entry.trigger;
  if (trigger.type !== OCCASION_TRIGGER[p.occasion.kind] || !scanJourneyRunnable(p.journeyKey, journey.templateVersion)) return 'switched_off';
  if (journey.install.liveSince !== null && qualifiedAt < journey.install.liveSince) return 'before_start';

  const [cvSnap, contact] = await Promise.all([db.collection(COL.contactVenues).doc(contactVenueId(p.contactId, p.venueId)).get(), loadContact(p.contactId)]);
  if (!contact || contact.status !== 'active') return 'gone';
  const cv = cvSnap.exists ? (cvSnap.data() as ContactVenueDoc) : null;
  const slots = (journey.install.doc.journeys?.[p.journeyKey]?.slots ?? {}) as Record<string, unknown>;
  const holidaySlot = typeof trigger.config?.slot === 'string' ? trigger.config.slot : 'holidays';
  const month = contact.profile?.birthdayMonth;
  if (!stillApplies(p, cv, month, slots, holidaySlot)) return 'no_longer_applies';
  // Who can't start the journey anyway gets no `scan.due` record either (the guest's timeline
  // would name an occasion that never reached them): no yes to marketing here, or a pause
  // between runs (Slow-time filler 21 days, Birthday 300 days) — enrolment checks both again.
  if (!Object.values(consentFor(contact, p.venueId)).some((c) => c?.state === 'granted')) return 'no_consent';
  const reentry = journey.definition.entry.reentry;
  const lastEntered = tsMs(cv?.journeys?.[p.journeyKey]?.lastEnteredAt);
  if (reentry.mode === 'cooldown' && reentry.cooldown && lastEntered !== null && env.now - lastEntered < durationMs(reentry.cooldown)) return 'cooldown';

  const occasion = occasionKey(p.occasion);
  const vars = occasionVars(p.occasion);
  const id = eventIdFor('engine', `scan:${p.venueId}:${p.journeyKey}:${occasion}:${p.contactId}`);
  const data = { journeyKey: p.journeyKey, trigger: trigger.type, occasion, qualifiedAt, ...vars };
  const event = { id, type: SCAN_EVENT, occurredAt: env.now, venueId: p.venueId, contactId: p.contactId, data };

  // An older occasion's run that already sent its message only waits for the guest to come back:
  // the new occasion closes it (its `exitOn: scan.due`), so close holidays (Christmas Eve, then
  // New Year's Eve) each get their reminder. One that hasn't sent yet keeps going; this one waits.
  const openId = cv?.journeys?.[p.journeyKey]?.activeInstanceId ?? null;
  if (openId) {
    const open = await loadInstance(openId);
    if (open && open.state.status === 'active' && open.meta.entryKey !== occasion) {
      const sentAndWaiting = open.state.lastTouch !== null && open.state.waiting?.kind === 'timer';
      if (!sentAndWaiting) return 'busy';
      mustDeliver(await deliverEvent(openId, event, { now: env.now, settings: env.settings, workerId: env.workerId ?? 'scan_trigger' }));
    }
  }

  await appendEvent({ type: SCAN_EVENT, occurredAt: env.now, tenantUserId: ctx.tenantUserId, venueId: p.venueId, contactId: p.contactId, journeyKey: p.journeyKey, mode, source: 'scanner', data }, id);
  const started = await enrolForEvent({
    ctx,
    who: { contactId: p.contactId, networkId: contact.networkId, contact },
    event,
    mode,
    visit: null,
    now: env.now,
    onlyJourney: p.journeyKey,
    vars,
  });
  return started.length ? 'enrolled' : 'not_enrolled';
}
