/**
 * Data for the guest pages the cms serves (plan §5 `GET /public/offer|info/:shortCode`, PR D;
 * `GET /public/rating/:shortCode`, PR E follow-up): mounted at `/internal/adaptive/public/…`,
 * behind the shared secret — the cms page calls it server-side (a top-level `/public` is the
 * unauthenticated pricing feed). Never cached. Anything that isn't a live journey link of the
 * right kind at `?venueId` is the same 404; an expired offer or info link is a 410 (a rating
 * link never expires).
 */

import { Router } from 'express';
import { makeHandle } from './http';
import { publicInfo, publicOffer, publicRating } from '../service/publicPages';

const router = Router();
const handle = makeHandle('ADAPTIVE PUBLIC API');

router.get(
  '/public/offer/:shortCode',
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return publicOffer(String(req.params.shortCode ?? ''), req.query.venueId, req.query.lang);
  }),
);
router.get(
  '/public/info/:shortCode',
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return publicInfo(String(req.params.shortCode ?? ''), req.query.venueId, req.query.lang);
  }),
);
router.get(
  '/public/rating/:shortCode',
  handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return publicRating(String(req.params.shortCode ?? ''), req.query.venueId, req.query.lang);
  }),
);

export default router;
