/**
 * Subscription expiry job — moves lapsed subscriptions through the grace
 * window and deactivates the ones nobody paid for.
 *
 * Lives here for the same reason the campaign scheduler does: the CMS owns no
 * cron, so this server is the single home for captive-portal scheduled work.
 * The sweep itself is in services/subscriptionExpiry.ts; this file only decides
 * when it runs.
 */

import cron from 'node-cron';
import { runSubscriptionExpirySweep } from '../services/subscriptionExpiry';

export function startSubscriptionExpirySweep(): void {
  // Once a day, early UTC — before the business day in CH/EU, so a tenant who
  // lapsed overnight reads the warning with their morning coffee rather than
  // finding out mid-service.
  cron.schedule('0 5 * * *', () => {
    runSubscriptionExpirySweep().catch((err) => console.error('[EXPIRY SWEEP ERROR]', err));
  });
  console.log('[EXPIRY SWEEP] Started — daily at 05:00 UTC');
}
