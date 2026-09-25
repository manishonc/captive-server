/**
 * Engine routes under `/internal/adaptive` (same x-internal-secret guard, mounted
 * by router.ts before its 404):
 *
 *   GET  /admin/engine        workers, versions, identity-key check, queue, index check
 *   POST /dev/clock           sandbox only — move the fake clock ({ advance: '48h' } | { at: ISO } | { reset: true })
 *   POST /dev/launch          sandbox only — set launch modes / the pause
 *   GET  /dev/guest-log       sandbox only — ?email= | ?phone= — events, sends, "why" sentences
 *   POST /dev/rollup          sandbox only — { venueId? } — the daily numbers now (no 2-min lag)
 *   POST /dev/provider-event  sandbox only — { sendKey, event: delivered|failed|opened|bounce|spam|
 *                             unsubscribe|click|rating|stop|start|reply, stars?, text? }
 *   PUT  /dev/calendar/:name  sandbox only — the calendar a `sandbox:calendar/<name>` feed reads:
 *                             { ics } or { venueId?, stays: [{ checkIn: today|+Nd|date, checkOut: date|+Nd|Nn }] }
 *   GET  /dev/calendar/:name  sandbox only — that calendar as text/calendar
 *   POST /dev/stay-feed       sandbox only — { venueId, url } → save the venue's calendar link
 *   POST /dev/stay-sync       sandbox only — { venueId } → poll the feed now (same lease as the worker)
 *   POST /dev/stay-check      sandbox only — { venueId, url } → "Check link" (fetch + parse, store nothing)
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
router.post('/dev/rollup', handle(async (req) => engine.devRollup(req.body ?? {})));
router.put('/dev/calendar/:name', handle(async (req) => engine.devPutCalendar(String(req.params.name ?? ''), req.body ?? {})));
router.get('/dev/calendar/:name', async (req: Request, res: Response) => {
  try {
    const ics = await engine.devGetCalendar(String(req.params.name ?? ''));
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    if (err instanceof ApiError) {
      res.status(err.status).json({ ok: false, error: err.message, code: err.code });
      return;
    }
    console.error('[ADAPTIVE ENGINE API]', (err as Error)?.message ?? err);
    res.status(500).json({ ok: false, error: 'Something went wrong', code: 'internal' });
  }
});
router.post('/dev/stay-feed', handle(async (req) => engine.devStayFeed(req.body ?? {})));
router.post('/dev/stay-sync', handle(async (req) => engine.devStaySync(req.body ?? {})));
router.post('/dev/stay-check', handle(async (req) => engine.devStayCheck(req.body ?? {})));

const clickSchema = z.object({ shortCode: z.string().min(1).max(64) });
const ratingSchema = z.object({ shortCode: z.string().min(1).max(64), stars: z.number().int().min(1).max(5), feedback: z.string().max(1000).optional().nullable() });
router.post('/ingest/click', handle(async (req) => ingestClick(clickSchema.parse(req.body ?? {}))));
router.post('/ingest/rating', handle(async (req) => ingestRating(ratingSchema.parse(req.body ?? {}))));

router.get('/dev/guest-log', handle(async (req) => engine.devGuestLog({ email: req.query.email as string, phone: req.query.phone as string, lang: req.query.lang as string })));

export default router;
