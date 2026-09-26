/**
 * HeidiFi admin routes of PR D under `/internal/adaptive/admin/…` (plan §5; SUPER_ADMIN in the
 * cms; writes also need `actor.kind: 'super_admin'` here). `GET /admin/engine` stays in
 * engineRoutes.ts (it now also lists dead tasks and failing feeds). Reference: docs/adaptive-api.md.
 *
 *   launch              GET · POST check {change} · PUT {change, baseVersion?, confirm?, note?, pauseReason?}
 *   tasks/:id/retry     POST
 *   guests/search       POST {email | phone}     (POST: addresses never land in URLs or logs)
 *   guests/:contactId   GET ?lang
 *   decisions/replay    POST {sendKey | eventId, lang?}
 *
 * No catch-all here: a path nobody matches falls through to router.ts's JSON 404.
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminActorOf, idParam, makeHandle } from './http';
import { checkLaunch, getLaunch, putLaunch } from '../service/launch';
import { adminGuest, retryTask, searchGuests } from '../service/adminTools';
import { replayDecision } from '../service/replay';

const router = Router();
const handle = makeHandle('ADAPTIVE ADMIN API');

router.get('/admin/launch', handle(async () => getLaunch()));
router.post(
  '/admin/launch/check',
  handle(async (req) => {
    adminActorOf(req);
    return checkLaunch(req.body);
  }),
);
router.put(
  '/admin/launch',
  handle(async (req) => {
    const actor = adminActorOf(req);
    const { actor: _a, ...body } = (req.body ?? {}) as Record<string, unknown>;
    return putLaunch(body, actor);
  }),
);

router.post('/admin/tasks/:taskId/retry', handle(async (req) => retryTask(idParam(req.params.taskId, 'taskId'), adminActorOf(req))));

router.post(
  '/admin/guests/search',
  handle(async (req) => {
    adminActorOf(req);
    const { actor: _a, ...body } = (req.body ?? {}) as Record<string, unknown>;
    return searchGuests(body);
  }),
);
router.get('/admin/guests/:contactId', handle(async (req) => adminGuest(idParam(req.params.contactId, 'contactId'), req.query as Record<string, unknown>)));

const replaySchema = z
  .object({ sendKey: z.string().min(1).max(64).optional(), eventId: z.string().min(1).max(200).optional(), lang: z.enum(['en', 'de']).optional() })
  .refine((b) => Boolean(b.sendKey || b.eventId), 'Give a sendKey or an eventId');
router.post(
  '/admin/decisions/replay',
  handle(async (req) => {
    adminActorOf(req);
    const { actor: _a, ...body } = (req.body ?? {}) as Record<string, unknown>;
    return { replay: await replayDecision(replaySchema.parse(body)) };
  }),
);

export default router;
