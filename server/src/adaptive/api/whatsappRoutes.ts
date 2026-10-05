/**
 * WhatsApp templates (PR W1) under `/internal/adaptive/admin/whatsapp…` (SUPER_ADMIN in the cms;
 * writes also need `actor.kind: 'super_admin'`) and the sandbox-only `/dev/whatsapp/…` helpers.
 * The service file lists every route; docs/adaptive-api.md has the reference.
 *
 * No catch-all here: a path nobody matches falls through to router.ts's JSON 404.
 */

import { Router } from 'express';
import { adminActorOf, makeHandle, rateLimiter, tooManyRequests } from './http';
import * as wa from '../service/whatsappAdmin';

const router = Router();
const handle = makeHandle('ADAPTIVE WHATSAPP API');
/** Calls that make the server talk to Meta, per admin and minute: sends (40 templates one by one), checks and syncs. */
const sends = rateLimiter(30, 60_000);
const metaCalls = rateLimiter(10, 60_000);
/** PR W2: "Suggest with AI" clicks, per admin and minute (each is a billed model call). */
const suggests = rateLimiter(10, 60_000);

const bodyOf = (req: { body?: unknown }) => {
  const { actor: _a, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  return rest;
};

router.get('/admin/whatsapp', handle(async () => wa.getWhatsAppOverview()));
router.get('/admin/whatsapp/log', handle(async (req) => wa.listWhatsAppLog(req.query as Record<string, unknown>)));
router.get('/admin/whatsapp/prefill', handle(async (req) => wa.prefillWhatsAppDraft(req.query as Record<string, unknown>)));
router.get('/admin/whatsapp/templates/:id', handle(async (req) => wa.getWhatsAppTemplate(wa.templateIdParam(req.params.id))));

router.post(
  '/admin/whatsapp/templates/check',
  handle(async (req) => {
    adminActorOf(req);
    return wa.checkWhatsAppDraft(bodyOf(req));
  }),
);
router.post('/admin/whatsapp/templates', handle(async (req) => wa.createWhatsAppDraft(bodyOf(req), adminActorOf(req))));
router.put('/admin/whatsapp/templates/:id', handle(async (req) => wa.saveWhatsAppDraft(wa.templateIdParam(req.params.id), bodyOf(req), adminActorOf(req))));
router.post(
  '/admin/whatsapp/templates/:id/submit',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!sends(`submit:${actor.uid}`)) throw tooManyRequests('Too many sends to Meta in a minute — wait a moment');
    return wa.submitWhatsAppTemplate(wa.templateIdParam(req.params.id), bodyOf(req), actor);
  }),
);
router.post('/admin/whatsapp/templates/:id/dismiss', handle(async (req) => wa.setWhatsAppDismissed(wa.templateIdParam(req.params.id), true, adminActorOf(req))));
router.post('/admin/whatsapp/templates/:id/restore', handle(async (req) => wa.setWhatsAppDismissed(wa.templateIdParam(req.params.id), false, adminActorOf(req))));
router.put('/admin/whatsapp/templates/:id/link', handle(async (req) => wa.linkWhatsAppTemplate(wa.templateIdParam(req.params.id), bodyOf(req), adminActorOf(req))));
router.post('/admin/whatsapp/templates/:id/use', handle(async (req) => wa.setWhatsAppUse(wa.templateIdParam(req.params.id), bodyOf(req), adminActorOf(req))));

router.post(
  '/admin/whatsapp/connection/check',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!metaCalls(`connection:${actor.uid}`)) throw tooManyRequests('Too many checks in a minute — wait a moment');
    return wa.checkWhatsAppConnection(actor);
  }),
);
router.put(
  '/admin/whatsapp/connection',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!metaCalls(`connection:${actor.uid}`)) throw tooManyRequests('Too many checks in a minute — wait a moment');
    return wa.setWhatsAppWaba(bodyOf(req), actor);
  }),
);
router.post(
  '/admin/whatsapp/connection/notices',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!metaCalls(`connection:${actor.uid}`)) throw tooManyRequests('Too many checks in a minute — wait a moment');
    return wa.turnOnWhatsAppNotices(actor);
  }),
);
router.post(
  '/admin/whatsapp/suggest',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!suggests(`suggest:${actor.uid}`)) throw tooManyRequests('Too many AI suggestions in a minute — wait a moment');
    return wa.suggestWhatsAppTemplate(bodyOf(req), actor);
  }),
);
router.post(
  '/admin/whatsapp/sync',
  handle(async (req) => {
    const actor = adminActorOf(req);
    if (!metaCalls(`sync:${actor.uid}`)) throw tooManyRequests('Too many syncs in a minute — wait a moment');
    return wa.syncWhatsAppNow(actor);
  }),
);

// Sandbox only (404 otherwise): Meta's decisions, queued faults, a tick now.
router.post('/dev/whatsapp/review', handle(async (req) => wa.devWhatsAppReview(req.body ?? {})));
router.post('/dev/whatsapp/fault', handle(async (req) => wa.devWhatsAppFault(req.body ?? {})));
router.post('/dev/whatsapp/tick', handle(async () => wa.devWhatsAppTick()));

export default router;
