/**
 * `/internal/adaptive/*` — the one API for Adaptive Campaigns playbooks.
 *
 * Called server-to-server by the CMS (after it has authenticated the user and
 * checked their role) and by the MCP tools (after resolving the tenant from the
 * OAuth token). Same shared-secret guard as the rest of `/internal`.
 *
 *   /admin/…                        platform authoring (SUPER_ADMIN in the CMS)
 *   /tenants/:tenantUserId/…        one account's gallery, setups and switches
 *
 * Every response is `{ ok: true, … }` or `{ ok: false, error, code, issues? }`.
 * Writes carry `actor: { uid, kind, role? }` in the body, recorded on the docs.
 * The full reference is in captive-server/docs/adaptive-api.md.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './errors';
import { zodIssues } from '../core/issues';
import { actorSchema, setAvailabilityInputSchema, setListedInputSchema, venueActionInputSchema, type Actor } from '../core/schemas';
import * as admin from '../service/admin';
import * as tenant from '../service/tenant';
import engineRoutes from './engineRoutes';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  const secret = req.header('x-internal-secret');
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    res.status(401).json({ ok: false, error: 'Unauthorized', code: 'unauthorized' });
    return;
  }
  next();
});

function actorOf(req: Request): Actor {
  const parsed = actorSchema.safeParse(req.body?.actor);
  if (!parsed.success) throw new ApiError('bad_request', 'Writes must say who is acting (actor.uid, actor.kind)');
  return parsed.data;
}

function tenantOf(req: Request): string {
  const id = String(req.params.tenantUserId || '');
  if (!id || id.length > 128) throw new ApiError('bad_request', 'tenantUserId is required');
  return id;
}

function intParam(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError('bad_request', `${label} must be a positive whole number`);
  return n;
}

function sendError(res: Response, err: unknown) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.issues ? { issues: err.issues } : {}) });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'The request is not in the expected shape', code: 'bad_request', issues: zodIssues(err) });
    return;
  }
  console.error('[ADAPTIVE API]', err);
  res.status(500).json({ ok: false, error: 'Something went wrong', code: 'internal' });
}

type Handler = (req: Request) => Promise<Record<string, unknown>>;
const handle = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (err) {
    sendError(res, err);
  }
};

// ── Admin: playbooks ─────────────────────────────────────────────────────────

router.get('/admin/playbooks', handle(async () => ({ playbooks: await admin.listPlaybooks() })));
router.post('/admin/playbooks', handle(async (req) => admin.createPlaybook(req.body, actorOf(req))));
router.get('/admin/playbooks/:key', handle(async (req) => admin.getPlaybookDetail(req.params.key)));
router.patch(
  '/admin/playbooks/:key',
  handle(async (req) => admin.setListed(req.params.key, setListedInputSchema.parse(req.body).listed, actorOf(req))),
);
router.delete('/admin/playbooks/:key', handle(async (req) => {
  actorOf(req);
  return admin.deletePlaybook(req.params.key);
}));
router.put('/admin/playbooks/:key/draft', handle(async (req) => admin.saveDraft(req.params.key, req.body, actorOf(req))));
router.delete('/admin/playbooks/:key/draft', handle(async (req) => admin.discardDraft(req.params.key, actorOf(req))));
router.post('/admin/playbooks/:key/check', handle(async (req) => admin.checkPlaybook(req.params.key)));
router.post('/admin/playbooks/:key/publish', handle(async (req) => admin.publishPlaybook(req.params.key, req.body, actorOf(req))));
router.get(
  '/admin/playbooks/:key/versions/:version',
  handle(async (req) => ({ version: await admin.getVersion(req.params.key, intParam(req.params.version, 'version')) })),
);
router.post(
  '/admin/playbooks/:key/versions/:version/restore',
  handle(async (req) => admin.restoreVersion(req.params.key, intParam(req.params.version, 'version'), actorOf(req))),
);
router.get(
  '/admin/playbooks/:key/diff',
  handle(async (req) => admin.diffVersions(req.params.key, String(req.query.from ?? 'live'), String(req.query.to ?? 'draft'))),
);

// ── Admin: journeys, questions, rules ────────────────────────────────────────

router.get('/admin/journey-templates', handle(async () => ({ journeyTemplates: await admin.listJourneyTemplates() })));
router.get(
  '/admin/journey-templates/:key',
  handle(async (req) => admin.getJourneyTemplateDetail(req.params.key, req.query.version ? intParam(req.query.version, 'version') : undefined)),
);
router.patch(
  '/admin/journey-templates/:key',
  handle(async (req) => admin.setAvailability(req.params.key, setAvailabilityInputSchema.parse(req.body).availability, actorOf(req))),
);
router.get('/admin/question-bank', handle(async () => ({ questions: await admin.listQuestionBank() })));
router.get('/admin/config', handle(async () => admin.getRules()));

// ── Tenant ───────────────────────────────────────────────────────────────────

router.get('/tenants/:tenantUserId/gallery', handle(async (req) => tenant.getGallery(tenantOf(req))));
router.get('/tenants/:tenantUserId/overview', handle(async (req) => tenant.getOverview(tenantOf(req))));
router.get(
  '/tenants/:tenantUserId/venues/:venueId/setups/:playbookKey',
  handle(async (req) => tenant.getSetup(tenantOf(req), req.params.venueId, req.params.playbookKey)),
);
router.post('/tenants/:tenantUserId/setups/validate', handle(async (req) => tenant.validateSetupInput(tenantOf(req), req.body)));
router.post('/tenants/:tenantUserId/setups/estimate', handle(async (req) => ({ estimate: await tenant.estimate(tenantOf(req), req.body) })));
router.post('/tenants/:tenantUserId/setups/preview', handle(async (req) => tenant.preview(tenantOf(req), req.body)));
router.put('/tenants/:tenantUserId/setups', handle(async (req) => tenant.saveSetups(tenantOf(req), req.body, actorOf(req))));
router.post(
  '/tenants/:tenantUserId/venues/:venueId/activate',
  handle(async (req) => tenant.activateVenue(tenantOf(req), req.params.venueId, venueActionInputSchema.parse(req.body ?? {}), actorOf(req))),
);
router.post('/tenants/:tenantUserId/venues/:venueId/pause', handle(async (req) => tenant.pauseVenue(tenantOf(req), req.params.venueId, actorOf(req))));
router.post('/tenants/:tenantUserId/venues/:venueId/resume', handle(async (req) => tenant.resumeVenue(tenantOf(req), req.params.venueId, actorOf(req))));
router.post(
  '/tenants/:tenantUserId/venues/:venueId/guest-info',
  handle(async (req) => {
    const { enabled } = venueActionInputSchema.parse(req.body ?? {});
    if (typeof enabled !== 'boolean') throw new ApiError('bad_request', 'Say whether Guest info should be on (enabled: true/false)');
    return tenant.setGuestInfo(tenantOf(req), req.params.venueId, enabled, actorOf(req));
  }),
);

// ── Engine (status; sandbox-only dev helpers) ────────────────────────────────

router.use(engineRoutes);

// Anything else under /internal/adaptive is a JSON 404, not Express's HTML page.
router.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'Not found', code: 'not_found' });
});

export default router;
