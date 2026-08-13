/**
 * Campaign scheduler — fires scheduled broadcasts when their send time arrives.
 *
 * The CMS owns no cron; this is the single home for campaign scheduling. Runs
 * every minute, finds broadcasts parked in "scheduled" whose `schedule.sendAt`
 * has passed, and hands each to the campaign dispatcher (which atomically claims
 * it, so overlapping ticks can't double-send). Each due broadcast is re-gated on
 * the tenant's subscription at dispatch time (`isLapsedForSending`) — the CMS
 * gate only ran when the tenant clicked schedule, which can be weeks earlier.
 */

import cron from 'node-cron';
import { runDueScheduledCampaigns, sweepStaleReservations } from '../services/campaigns';

export function startCampaignScheduler(): void {
  cron.schedule('* * * * *', () => {
    runDueScheduledCampaigns().catch((err) => console.error('[CAMPAIGN SCHEDULER ERROR]', err));
  });
  // Credit reservation-leak sweeper (spec §9): hourly is plenty — it only
  // matters after a dispatch crashed between reserve and settle.
  cron.schedule('17 * * * *', () => {
    sweepStaleReservations().catch((err) => console.error('[CAMPAIGN SWEEPER ERROR]', err));
  });
  console.log('[CAMPAIGN SCHEDULER] Started — checking every minute for due broadcasts');
}
