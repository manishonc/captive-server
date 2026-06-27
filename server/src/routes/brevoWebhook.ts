/**
 * Brevo (email) event webhook.
 *
 *   POST /webhook/brevo — delivery + engagement events for transactional emails.
 *
 * Brevo posts events like delivered / hard_bounce / soft_bounce / blocked /
 * spam / opened / unique_opened / click, each carrying the `message-id` we stored
 * on the send record. We map those to CaptivePortal_CampaignSends so campaign
 * email funnels reflect real delivery + engagement (Brevo has no native delay
 * tracking, but it does report these post-send).
 *
 * Configure the webhook URL in Brevo → Transactional → Settings → Webhooks.
 */

import { Router, Request, Response } from 'express';
import {
  recordDeliveryStatus,
  recordOpenByMessageId,
  recordClickByMessageId,
} from '../services/campaignTracking';

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
        } else if (event === 'click' || event === 'clicks') {
          await recordClickByMessageId(messageId, typeof ev.link === 'string' ? ev.link : undefined);
        } else {
          await recordDeliveryStatus('messageId', messageId, event, ev.reason);
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
