/**
 * Does this event start this journey? (03-playbook-format §3.1–§3.2)
 *
 * Event-driven triggers this round: visit.started, visit.ended, visit.revisit and
 * the generic `event`; stay.window arrives with stays (its moments are scheduled
 * per stay, then delivered as a `stay.moment` event naming the journey).
 */

import { getTriggerContract } from '../registry';
import { matchesWhere } from './conditions';
import type { EngineEvent } from './types';

export interface TriggerDef {
  type: string;
  config?: Record<string, unknown>;
}

export function triggerMatches(trigger: TriggerDef, event: EngineEvent, journeyKey: string): boolean {
  const contract = getTriggerContract(trigger.type);
  if (!contract) return false;
  const parsed = contract.configSchema.safeParse(trigger.config ?? {});
  if (!parsed.success) return false;
  const c = parsed.data as Record<string, any>;
  const d = event.data ?? {};

  switch (trigger.type) {
    case 'visit.started': {
      if (event.type !== 'visit.started') return false;
      if (c.firstVisit && d.isFirstVisit !== true) return false;
      const n = Number(d.visitNumber);
      if (c.visitNumber?.eq !== undefined && n !== c.visitNumber.eq) return false;
      if (c.visitNumber?.gte !== undefined && !(n >= c.visitNumber.gte)) return false;
      return true;
    }
    case 'visit.revisit':
      return event.type === 'visit.started' && d.isRevisit === true;
    case 'visit.ended': {
      if (event.type !== 'visit.ended') return false;
      // With a real "left the venue" signal, the minimum stay filters walk-ins. The
      // timeout fallback has no dwell, so it doesn't apply there (PRD VI-2).
      if (typeof d.dwellMinutes === 'number' && c.minDwellMinutes !== undefined) return d.dwellMinutes >= c.minDwellMinutes;
      return true;
    }
    case 'stay.window':
      return event.type === 'stay.moment' && d.journeyKey === journeyKey;
    case 'event':
      return event.type === c.type && matchesWhere(c.where, event);
    default:
      // Scan triggers (days_since_visit, date_field, …) are not fired by events.
      return false;
  }
}

/**
 * The part of the instance id that makes one entry unique (02 §6.1): `once` for
 * journeys a guest does only once, otherwise the visit or stay that started it.
 */
export function entryKeyFor(reentryMode: 'never' | 'after_exit' | 'cooldown', event: EngineEvent): string {
  if (reentryMode === 'never') return 'once';
  const d = event.data ?? {};
  if (typeof d.stayId === 'string') return `stay:${d.stayId}`;
  if (typeof d.visitId === 'string') return `visit:${d.visitId}`;
  return `event:${event.id}`;
}
