/**
 * `CaptivePortal_AdaptiveConfig/global` v1 — the platform rules (02-firestore-schema §3.4).
 *
 * `killSwitch.sendingPaused` starts ON: venues can be turned on before the engine
 * exists, and nothing may go out until HeidiFi deliberately launches sending.
 */

import type { AdaptiveConfig } from '../../core/schemas';

export const ADAPTIVE_CONFIG_V1: AdaptiveConfig = {
  quietHours: { start: '21:00', end: '09:00' },
  utilityQuietHours: { start: '22:00', end: '08:00' },
  slots: { morning: ['09:00', '11:00'], afternoon: ['14:00', '17:00'], evening: ['18:00', '20:00'] },
  caps: { maxTouchesPerJourney: 5, stopAfterClicks: 3, globalMarketingPer7Days: 3 },
  creditQueueHours: 72,
  freezeWindowMinutes: 60,
  offerBounds: { maxDiscountPct: 50, expiryDays: [1, 90] },
  reviewDwellMinutes: 25,
  replyNoticeCooldownDays: 30,
  utilityFairUsePerVenuePerMonth: 300,
  deferJitterMinutes: [0, 20],
  retention: { eventsMonths: 25, anonymizeAfterMonths: 24, anonymizeFloorMonths: 12 },
  killSwitch: { sendingPaused: true, reason: 'Engine not launched yet' },
};
