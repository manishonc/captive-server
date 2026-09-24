/**
 * Engine routes under `/internal/adaptive` (same x-internal-secret guard, mounted
 * by router.ts before its 404):
 *
 *   GET  /admin/engine        workers, versions, identity-key check, queue, index check
 *   POST /dev/clock           sandbox only — move the fake clock ({ advance: '48h' } | { reset: true })
 *   POST /dev/launch          sandbox only — set launch modes / the pause
 *   GET  /dev/guest-log       sandbox only — ?email= | ?phone= — events, sends, "why" sentences
 *
 * The dev routes answer 404 unless ADAPTIVE_SANDBOX=1 runs against the emulator.
 */

import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './errors';
import { zodIssues } from '../core/issues';
import * as engine from '../service/engine';

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
router.get('/dev/guest-log', handle(async (req) => engine.devGuestLog({ email: req.query.email as string, phone: req.query.phone as string, lang: req.query.lang as string })));

export default router;
