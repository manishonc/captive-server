/**
 * Brevo (email) event webhook.
 *
 *   POST /webhook/brevo — delivery + engagement events for transactional emails.
 *
 * Brevo posts events like delivered / hard_bounce / soft_bounce / blocked /
 * spam / opened / unique_opened / click, each carrying the `message-id` we stored
 * on the send record. We map those onto BOTH send collections, since the same
 * message id identifies either:
 *   - CaptivePortal_CampaignSends  — Tenant Campaign Manager broadcasts
 *   - CaptivePortal_Marketing      — venue automation (onConnect etc.)
 * Each write-back is a no-op when the id belongs to the other collection.
 *
 * Configure the webhook URL in Brevo → Transactional → Settings → Webhooks.
 */

import { Router, Request, Response } from 'express';
import {
  recordDeliveryStatus,
  recordOpenByMessageId,
  recordClickByMessageId,
} from '../services/campaignTracking';
import {
  recordMarketingDeliveryStatus,
  recordMarketingOpen,
} from '../services/marketingTracking';
import { normalizeBrevoStatus } from '../services/deliveryStatus';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  // Acknowledge immediately so Brevo doesn't retry while we process.
  res.sendStatus(200);

  try {
    const body = req.body;
    const events: Array<Record<string, unknown>> = Array.isArray(body) ? body : body ? [body] : [];

    for (const ev of events) {
      const messageId = String(ev['message-id'] || ev.messageId || '');
      const event = String(ev.event || '').toLowerCase();
      if (!messageId || !event) continue;

      try {
        if (event === 'opened' || event === 'unique_opened') {
          await recordOpenByMessageId(messageId);
          await recordMarketingOpen(messageId);
        } else if (event === 'click' || event === 'clicks') {
          await recordClickByMessageId(messageId, typeof ev.link === 'string' ? ev.link : undefined);
          // Deliberately NOT mirrored onto Marketing. That collection's
          // `clickCount` is fed by our own short-link resolver, which filters
          // automated scans; Brevo's wrapped links are fetched by the same
          // scanners and would put unfiltered clicks back into a metric we
          // specifically cleaned up. Short links already cover venue
          // automation, so nothing is lost.
        } else {
          await recordDeliveryStatus('messageId', messageId, event, ev.reason);
          // Marketing docs feed the CMS status bars, which bucket by a fixed
          // vocabulary — raw Brevo event names would land in no bucket.
          const status = normalizeBrevoStatus(event);
          if (status) {
            await recordMarketingDeliveryStatus('messageId', messageId, status, ev.reason);
          }
        }
      } catch (err) {
        console.error('[BREVO WEBHOOK] event processing error:', event, err);
      }
    }
  } catch (err) {
    console.error('[BREVO WEBHOOK ERROR]', err);
  }
});

export default router;
