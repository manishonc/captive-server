/**
 * Campaign scheduler — fires scheduled broadcasts when their send time arrives.
 *
 * The CMS owns no cron; this is the single home for campaign scheduling. Runs
 * every minute, finds broadcasts parked in "scheduled" whose `schedule.sendAt`
 * has passed, and hands each to the campaign dispatcher (which atomically claims
 * it, so overlapping ticks can't double-send).
 */

import cron from 'node-cron';
import { runDueScheduledCampaigns } from '../services/campaigns';

export function startCampaignScheduler(): void {
  cron.schedule('* * * * *', () => {
    runDueScheduledCampaigns().catch((err) => console.error('[CAMPAIGN SCHEDULER ERROR]', err));
  });
  console.log('[CAMPAIGN SCHEDULER] Started — checking every minute for due broadcasts');
}
