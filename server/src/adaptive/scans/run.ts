/**
 * The `scan_venue` task (PR S): today's scan of one venue. It arms tomorrow's scan first, then
 * — while the venue's marketing playbook is on and sending isn't off for it — runs each switched-on
 * scan journey's finder (scans/finders.ts) and queues one `scan_trigger` per guest and occasion.
 * Trigger keys are create-only, so a scan run twice (a retry, a caught-up day) queues nothing new.
 */

import { db } from '../../firebase';
import { COL, adaptiveVenueId } from '../store/collections';
import { firestoreScheduler } from '../queue/firestoreQueue';
import { localDateKey } from '../core/runtime/time';
import { getTriggerContract } from '../core/registry';
import { addDays } from '../core/scans/holidays';
import { isScanTrigger, scanJourneyRunnable } from '../core/scans/occasions';
import { venueModeFor, type EngineSettings } from '../store/engineSettings';
import { enabledJourneys, loadVenueContext } from '../engine/context';
import { armScan, type ScanVenuePayload } from './schedule';
import { birthdayCandidates, holidayCandidates, scanTriggerKey, slowTimeCandidates, winbackCandidates, type FinderContext, type ScanCandidate } from './finders';
import type { ScanTriggerPayload } from './trigger';

export interface ScanVenueResult {
  outcome: 'not_on' | 'stale' | 'off' | 'scanned';
  journeys: Record<string, { found: number; note?: string }>;
}

const CHUNK = 25;

export async function handleScanVenue(
  p: ScanVenuePayload,
  env: { now: number; settings: EngineSettings },
  opts: { onProgress?: () => Promise<void> | void } = {},
): Promise<ScanVenueResult> {
  const result: ScanVenueResult = { outcome: 'scanned', journeys: {} };
  const ctx = await loadVenueContext(p.venueId);
  // Nothing on (off, paused, switched away): the chain stops here; the watchdog starts it again.
  if (!ctx || !ctx.marketing) return { ...result, outcome: 'not_on' };
  const today = localDateKey(new Date(env.now), ctx.tz);
  // Tomorrow's scan first, so a failure below never stops the chain.
  await armScan({ venueId: ctx.venueId, tenantUserId: ctx.tenantUserId }, addDays(today > p.date ? today : p.date, 1), ctx.tz);
  // Run on another day (the worker was down): that day's own scan does the work, catching up.
  if (p.date !== today) return { ...result, outcome: 'stale' };
  if (venueModeFor(env.settings, ctx.adaptive, env.now) === 'off') return { ...result, outcome: 'off' };

  const install = ctx.marketing;
  for (const j of await enabledJourneys(ctx)) {
    if (j.install.installId !== install.installId) continue;
    const trigger = j.definition.entry.trigger;
    if (!isScanTrigger(trigger.type) || !scanJourneyRunnable(j.journeyKey, j.templateVersion)) continue;
    const parsed = getTriggerContract(trigger.type)?.configSchema.safeParse(trigger.config ?? {});
    if (!parsed?.success) continue;
    const cfg = parsed.data as any;
    const f: FinderContext = {
      venueId: ctx.venueId,
      tenantUserId: ctx.tenantUserId,
      tz: ctx.tz,
      today,
      now: env.now,
      floorMs: install.liveSince ?? 0,
      slots: install.doc.journeys?.[j.journeyKey]?.slots ?? {},
      onProgress: opts.onProgress,
    };
    let candidates: ScanCandidate[] = [];
    let note: string | undefined;
    if (trigger.type === 'days_since_visit') candidates = await winbackCandidates(f, j.journeyKey, cfg);
    else if (trigger.type === 'date_field') candidates = cfg.field === 'birthdayMonth' ? await birthdayCandidates(f, cfg) : [];
    else if (trigger.type === 'calendar.holiday') candidates = await holidayCandidates(f, cfg);
    else if (trigger.type === 'computed.slow_daypart') {
      const r = await slowTimeCandidates(f, cfg);
      candidates = r.candidates;
      note = r.summary;
    }
    for (let i = 0; i < candidates.length; i += CHUNK) {
      await Promise.all(
        candidates.slice(i, i + CHUNK).map((c) =>
          firestoreScheduler.schedule({
            dedupeKey: scanTriggerKey(ctx.venueId, j.journeyKey, c),
            kind: 'scan_trigger',
            dueAt: c.dueAt,
            payload: { venueId: ctx.venueId, journeyKey: j.journeyKey, contactId: c.contactId, occasion: c.occasion, qualifiedAt: c.qualifiedAt, dueAt: c.dueAt } satisfies ScanTriggerPayload as unknown as Record<string, unknown>,
            tenantUserId: ctx.tenantUserId,
            venueId: ctx.venueId,
          }),
        ),
      );
      if (opts.onProgress) await opts.onProgress();
    }
    result.journeys[j.journeyKey] = { found: candidates.length, ...(note ? { note } : {}) };
  }
  // What today's scan found, for the admin (one field, overwritten daily; never read by the engine).
  await db
    .collection(COL.adaptiveVenues)
    .doc(adaptiveVenueId(ctx.venueId))
    .update({ lastScan: { date: today, at: new Date(env.now), journeys: result.journeys } })
    .catch((err) => console.warn('[ADAPTIVE] scan summary not saved:', (err as Error)?.message || err));
  return result;
}
