/**
 * Public campaign tracking endpoints (no secret — hit by email clients).
 *
 *   GET /t/o/:sendId   — 1×1 open-tracking pixel. Records an email open against
 *                        the CaptivePortal_CampaignSends doc, then returns a gif.
 *
 * Click tracking is handled by the existing short-link redirect (visitor app),
 * which records clicks on CaptivePortal_ShortLinks; the dashboard aggregates those.
 */

import { Router, Request, Response } from 'express';
import { recordOpenBySendId } from '../services/campaignTracking';

const router = Router();

// 1×1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/o/:sendId', async (req: Request, res: Response) => {
  const sendId = String(req.params.sendId || '');
  // Record best-effort; never let tracking failures affect the pixel response.
  recordOpenBySendId(sendId).catch((err) => console.error('[OPEN PIXEL ERROR]', err));

  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res.status(200).send(PIXEL);
});

export default router;
