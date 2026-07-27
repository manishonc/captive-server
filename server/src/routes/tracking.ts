/**
 * Public campaign tracking endpoints (no secret — hit by email clients).
 *
 *   GET /t/o/:sendId   — 1×1 open-tracking pixel. Records an email open against
 *                        whichever send collection owns the id — Campaign
 *                        Manager's CaptivePortal_CampaignSends or venue
 *                        automation's CaptivePortal_Marketing — then returns a
 *                        gif. Both use Firestore auto-ids, so an id belongs to
 *                        exactly one; campaigns are tried first and the venue
 *                        collection only on a miss, capping this at two reads.
 *
 * Click tracking is handled by the existing short-link redirect (visitor app),
 * which records clicks on CaptivePortal_ShortLinks; the dashboard aggregates those.
 */

import { Router, Request, Response } from 'express';
import { recordOpenBySendId } from '../services/campaignTracking';
import { recordMarketingOpenBySendId } from '../services/marketingTracking';

const router = Router();

// 1×1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/o/:sendId', async (req: Request, res: Response) => {
  const sendId = String(req.params.sendId || '');
  // Record best-effort; never let tracking failures affect the pixel response.
  recordOpenBySendId(sendId)
    .then((matched) => (matched ? true : recordMarketingOpenBySendId(sendId)))
    .catch((err) => console.error('[OPEN PIXEL ERROR]', err));

  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res.status(200).send(PIXEL);
});

export default router;
