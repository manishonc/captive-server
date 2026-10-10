/**
 * Trigger type contracts (03-playbook-format §3.2).
 *
 * Two families: event-driven (a guest connects, a visit ends) and time-driven
 * scans (daily, weekly, stay moments). Like the node contracts, PR 1 registers
 * the config schema and a plain-words description; matching logic arrives with
 * the engine.
 */

import { z } from 'zod';
import { durationSchema, hhmmSchema } from '../schemas';

export interface TriggerContract<C = any> {
  type: string;
  typeVersion: number;
  source: 'event' | 'scan';
  configSchema: z.ZodType<C>;
  /** Short "Starts when" text for the admin catalogue. */
  describe(config: C): string;
}

const visitStarted: TriggerContract<{ firstVisit?: boolean; visitNumber?: { eq?: number; gte?: number } }> = {
  type: 'visit.started',
  typeVersion: 1,
  source: 'event',
  configSchema: z.object({
    firstVisit: z.boolean().optional(),
    visitNumber: z
      .object({ eq: z.number().int().min(1).optional(), gte: z.number().int().min(1).optional() })
      .optional(),
  }),
  describe: (c) => {
    if (c.firstVisit || c.visitNumber?.eq === 1) return 'First visit';
    if (c.visitNumber?.eq) return `Visit number ${c.visitNumber.eq}`;
    if (c.visitNumber?.gte) return `Visit number ${c.visitNumber.gte} or later`;
    return 'Any visit';
  },
};

const visitEnded: TriggerContract<{ minDwellMinutes?: number; fallbackAfterConnect?: string }> = {
  type: 'visit.ended',
  typeVersion: 1,
  source: 'event',
  configSchema: z.object({
    minDwellMinutes: z.number().int().min(0).max(600).optional(),
    fallbackAfterConnect: durationSchema.optional(),
  }),
  describe: (c) => (c.minDwellMinutes ? `Visit ended (stayed ${c.minDwellMinutes}+ min)` : 'Visit ended'),
};

const visitRevisit: TriggerContract<Record<string, never>> = {
  type: 'visit.revisit',
  typeVersion: 1,
  source: 'event',
  configSchema: z.object({}),
  describe: () => 'Comes back',
};

// PR S: the scan triggers run (core/scans, scans/). New config keys are optional, so the v1
// placeholders still parse; `catchUpDays` etc. have defaults in scans/finders.ts.
const daysSinceVisit: TriggerContract<{ days: number[]; catchUpDays?: number }> = {
  type: 'days_since_visit',
  typeVersion: 1,
  source: 'scan',
  configSchema: z.object({ days: z.array(z.number().int().min(1).max(365)).min(1).max(6), catchUpDays: z.number().int().min(0).max(7).optional() }),
  describe: (c) => `${c.days.join('/')} days since last visit`,
};

const dateField: TriggerContract<{ field: 'birthdayMonth' | 'firstVisitAt'; day?: number; at?: string; offset?: string; lateUntilDay?: number }> = {
  type: 'date_field',
  typeVersion: 1,
  source: 'scan',
  configSchema: z.object({
    field: z.enum(['birthdayMonth', 'firstVisitAt']),
    day: z.number().int().min(1).max(28).optional(),
    at: hhmmSchema.optional(),
    offset: z.string().regex(/^[+-]?\d{1,3}(d|mo|y)$/).optional(),
    // PR S: a guest who tells us their month later in that month still gets the gift until this day.
    lateUntilDay: z.number().int().min(1).max(28).optional(),
  }),
  describe: (c) =>
    c.field === 'birthdayMonth' ? `Birthday month${c.day ? `, day ${c.day}` : ''}${c.at ? ` at ${c.at}` : ''}` : 'First-visit anniversary',
};

type StayConfig = { requireConnect?: boolean; anchor: 'checkInAt' | 'checkOutAt'; offsetDays: number; at: string };
const stayWindow: TriggerContract<StayConfig> = {
  type: 'stay.window',
  typeVersion: 1,
  source: 'scan',
  configSchema: z.object({
    requireConnect: z.boolean().optional(),
    anchor: z.enum(['checkInAt', 'checkOutAt']),
    offsetDays: z.number().int().min(-30).max(60),
    at: hhmmSchema,
  }),
  describe: (c) => {
    const base = c.anchor === 'checkInAt' ? 'arrival' : 'checkout';
    let day: string;
    if (c.offsetDays === 0) day = c.anchor === 'checkInAt' ? 'Arrival day' : 'Checkout day';
    else if (c.anchor === 'checkInAt' && c.offsetDays > 0) day = `Stay day ${c.offsetDays + 1}`;
    else if (c.offsetDays === -1) day = `Day before ${base}`;
    else if (c.offsetDays < 0) day = `${-c.offsetDays} days before ${base}`;
    else day = `${c.offsetDays} day${c.offsetDays === 1 ? '' : 's'} after ${base}`;
    return `${day}, ${c.at}`;
  },
};

const calendarHoliday: TriggerContract<{ leadDays: number; slot?: string; spreadDays?: number; catchUpDays?: number }> = {
  type: 'calendar.holiday',
  typeVersion: 1,
  source: 'scan',
  configSchema: z.object({
    leadDays: z.number().int().min(0).max(60),
    // PR S: the `holidays` blank with the owner's picks; the reminders spread over this many mornings.
    slot: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    spreadDays: z.number().int().min(1).max(5).optional(),
    catchUpDays: z.number().int().min(0).max(5).optional(),
  }),
  describe: (c) => `${c.leadDays} days before the holidays the owner picks`,
};

const slowDaypart: TriggerContract<{ dayparts: number; lookbackWeeks: number; minWeeks?: number; minVisits?: number; recentDays?: number }> = {
  type: 'computed.slow_daypart',
  typeVersion: 1,
  source: 'scan',
  configSchema: z.object({
    dayparts: z.number().int().min(1).max(6),
    lookbackWeeks: z.number().int().min(2).max(26),
    minWeeks: z.number().int().min(1).max(26).optional(),
    minVisits: z.number().int().min(1).max(10_000).optional(),
    recentDays: z.number().int().min(0).max(30).optional(),
  }),
  describe: (c) => `Every Monday: the ${c.dayparts} slowest times of the last ${c.lookbackWeeks} weeks`,
};

const genericEvent: TriggerContract<{ type: string; where?: Record<string, unknown> }> = {
  type: 'event',
  typeVersion: 1,
  source: 'event',
  configSchema: z.object({ type: z.string().min(1), where: z.record(z.string(), z.unknown()).optional() }),
  describe: (c) => `Event: ${c.type}`,
};

export const TRIGGER_CONTRACTS: Record<string, TriggerContract> = Object.fromEntries(
  [visitStarted, visitEnded, visitRevisit, daysSinceVisit, dateField, stayWindow, calendarHoliday, slowDaypart, genericEvent].map(
    (t) => [t.type, t],
  ),
);

export function getTriggerContract(type: string): TriggerContract | undefined {
  return TRIGGER_CONTRACTS[type];
}

/** "Starts when" in words; falls back to the raw type for anything unregistered. */
export function describeTrigger(trigger: { type: string; config?: Record<string, unknown> }): string {
  const contract = getTriggerContract(trigger.type);
  if (!contract) return trigger.type;
  const parsed = contract.configSchema.safeParse(trigger.config ?? {});
  return parsed.success ? contract.describe(parsed.data) : trigger.type;
}

/** Events a journey may wait for, exit on or count as its goal (03 §3–§4). */
export const KNOWN_EVENTS = new Set([
  'wifi.connected',
  'visit.started',
  'visit.ended',
  'visit.revisit',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.opened',
  'message.clicked',
  'message.bounced',
  'message.failed',
  'message.replied',
  'offer.issued',
  'offer.redeemed',
  'rating.submitted',
  'stay.created',
  'stay.changed',
  'stay.cancelled',
  'question.answered',
  'booking.direct',
  // PR S: a scan found a new occasion (a scan journey's next run closes the open one).
  'scan.due',
  // PR A7: a friend signed up with a regular's code (starts the regular's friend reward).
  'referral.joined',
]);
