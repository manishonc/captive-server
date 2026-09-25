/**
 * Engine routes under `/internal/adaptive` (same x-internal-secret guard, mounted
 * by router.ts before its 404):
 *
 *   GET  /admin/engine        workers, versions, identity-key check, queue, index check
 *   POST /dev/clock           sandbox only — move the fake clock ({ advance: '48h' } | { reset: true })
 *   POST /dev/launch          sandbox only — set launch modes / the pause
 *   GET  /dev/guest-log       sandbox only — ?email= | ?phone= — events, sends, "why" sentences
 *   POST /dev/provider-event  sandbox only — { sendKey, event: delivered|failed|opened|bounce|spam|
 *                             unsubscribe|click|rating|stop|start|reply, stars?, text? }
 *   POST /ingest/click        the CMS: a counted click on a journey short link { shortCode }
 *   POST /ingest/rating       the CMS: a rating from a journey link { shortCode, stars, feedback? }
 *
 * The dev routes answer 404 unless ADAPTIVE_SANDBOX=1 runs against the emulator.
 */

import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './errors';
import { zodIssues } from '../core/issues';
import * as engine from '../service/engine';
import { z } from 'zod';
import { ingestClick, ingestRating } from '../ingest/signals';

const router = Router();

const handle = (fn: (req: Request) => Promise<Record<string, unknown>>) => async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (err) {
    if (err instanceof ApiError) {
      res.status(err.status).json({ ok: false, error: err.message, code: err.code });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ ok: false, error: 'The request is not in the expected shape', code: 'bad_request', issues: zodIssues(err) });
      return;
    }
    console.error('[ADAPTIVE ENGINE API]', err);
    res.status(500).json({ ok: false, error: 'Something went wrong', code: 'internal' });
  }
};

router.get('/admin/engine', handle(async () => engine.getEngineStatus()));
router.post('/dev/clock', handle(async (req) => engine.devClock(req.body ?? {})));
router.post('/dev/launch', handle(async (req) => engine.devLaunch(req.body ?? {})));
router.post('/dev/provider-event', handle(async (req) => engine.devProviderEvent(req.body ?? {})));

const clickSchema = z.object({ shortCode: z.string().min(1).max(64) });
const ratingSchema = z.object({ shortCode: z.string().min(1).max(64), stars: z.number().int().min(1).max(5), feedback: z.string().max(1000).optional().nullable() });
router.post('/ingest/click', handle(async (req) => ingestClick(clickSchema.parse(req.body ?? {}))));
router.post('/ingest/rating', handle(async (req) => ingestRating(ratingSchema.parse(req.body ?? {}))));

router.get('/dev/guest-log', handle(async (req) => engine.devGuestLog({ email: req.query.email as string, phone: req.query.phone as string, lang: req.query.lang as string })));

export default router;
