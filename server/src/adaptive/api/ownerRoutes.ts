/**
 * Owner routes of PR D under `/internal/adaptive/tenants/:tenantUserId/…` (plan §5), mounted by
 * router.ts before its 404 (the shared-secret guard there runs first). The cms checks the user
 * and the permission (adaptive.read / adaptive.configure / adaptive.activate /
 * adaptive.guestinfo.write) and audits writes; every venue, stay and guest is checked against
 * the tenant here again. Reference: docs/adaptive-api.md.
 *
 *   stay-feed      GET · PUT {url} · DELETE · POST check {url} · POST sync
 *   stays/:id      POST unlink {expectContactId} · POST link {contactId, expectContactId?}
 *   guest-info     GET · PUT {locales, baseVersion}          (the on/off switch stays PR 1's POST)
 *   audience       GET · PUT {sms, email}
 *   test-send      POST {journeyKey, nodeId?, channel, lang?, recipientId}
 *   results        GET ?venueId&from&to&journeys
 *   guests         GET ?cursor&limit&lang · GET /:contactId?lang · POST /:contactId/marketing {action, scope}
 *   messages       GET ?kind&days&cursor&limit&lang
 *   start-sending  POST
 *   guests/find    POST {guestId | contactId | email | phone}   (the MCP's lookup; a read)
 *
 * No catch-all here: a path nobody matches falls through to router.ts's JSON 404.
 */

import { Router, type Request } from 'express';
import { idParam, makeHandle, ownerActorOf, rateLimiter, tenantOf, tooManyRequests } from './http';
import { checkStayFeed, deleteStayFeed, getStayFeed, linkStayByOwner, saveStayFeed, syncStayFeedNow, unlinkStay } from '../service/stays';
import { getGuestInfoContent, saveGuestInfoContent } from '../service/guestInfo';
import { getAudience, putAudience } from '../service/audience';
import { testSend } from '../service/testSend';
import { getResults } from '../service/results';
import { findGuest, getGuest, listGuests, listMessages, setGuestMarketing } from '../service/guests';
import { startSending } from '../service/startSending';

const router = Router();
const handle = makeHandle('ADAPTIVE OWNER API');
const T = '/tenants/:tenantUserId';
const V = `${T}/venues/:venueId`;

const venueOf = (req: Request) => idParam(req.params.venueId, 'venueId');

// "Check link" and "Sync now" make the server do real outbound work: a few per hour per account.
const checkLimit = rateLimiter(20, 60 * 60_000);
const syncLimit = rateLimiter(30, 60 * 60_000);

// ── Calendar link (PR C's service) + stay link / unlink ──────────────────────

router.get(`${V}/stay-feed`, handle(async (req) => getStayFeed(tenantOf(req), venueOf(req))));
// The link is passed on as it came (never checked with a schema that could echo it).
router.put(`${V}/stay-feed`, handle(async (req) => saveStayFeed(tenantOf(req), venueOf(req), req.body?.url as unknown, ownerActorOf(req))));
router.delete(`${V}/stay-feed`, handle(async (req) => deleteStayFeed(tenantOf(req), venueOf(req), ownerActorOf(req))));
router.post(
  `${V}/stay-feed/check`,
  handle(async (req) => {
    ownerActorOf(req);
    const t = tenantOf(req);
    if (!checkLimit(t)) throw tooManyRequests('Too many link checks — try again in a while');
    // Wrapped: the check's own `ok` would be shadowed by the answer's `ok: true`.
    return { check: await checkStayFeed(t, venueOf(req), req.body?.url as unknown) };
  }),
);
router.post(
  `${V}/stay-feed/sync`,
  handle(async (req) => {
    ownerActorOf(req);
    const t = tenantOf(req);
    if (!syncLimit(t)) throw tooManyRequests('Too many syncs — try again in a while');
    return syncStayFeedNow(t, venueOf(req));
  }),
);
router.post(`${V}/stays/:stayId/unlink`, handle(async (req) => unlinkStay(tenantOf(req), venueOf(req), idParam(req.params.stayId, 'stayId'), req.body, ownerActorOf(req))));
router.post(`${V}/stays/:stayId/link`, handle(async (req) => linkStayByOwner(tenantOf(req), venueOf(req), idParam(req.params.stayId, 'stayId'), req.body, ownerActorOf(req))));

// ── Guest info content ───────────────────────────────────────────────────────

router.get(`${V}/guest-info`, handle(async (req) => getGuestInfoContent(tenantOf(req), venueOf(req))));
router.put(`${V}/guest-info`, handle(async (req) => saveGuestInfoContent(tenantOf(req), venueOf(req), req.body, ownerActorOf(req))));

// ── Who gets messages ────────────────────────────────────────────────────────

router.get(`${V}/audience`, handle(async (req) => getAudience(tenantOf(req), venueOf(req))));
router.put(`${V}/audience`, handle(async (req) => putAudience(tenantOf(req), venueOf(req), req.body, ownerActorOf(req))));

// ── Send test, numbers ───────────────────────────────────────────────────────

router.post(`${V}/test-send`, handle(async (req) => testSend(tenantOf(req), venueOf(req), req.body, ownerActorOf(req))));
router.get(`${T}/results`, handle(async (req) => getResults(tenantOf(req), req.query as Record<string, unknown>)));

// ── Guests ───────────────────────────────────────────────────────────────────

router.get(`${V}/guests`, handle(async (req) => listGuests(tenantOf(req), venueOf(req), req.query as Record<string, unknown>)));
router.get(`${V}/guests/:contactId`, handle(async (req) => getGuest(tenantOf(req), venueOf(req), idParam(req.params.contactId, 'contactId'), req.query as Record<string, unknown>)));
router.post(
  `${V}/guests/:contactId/marketing`,
  handle(async (req) => setGuestMarketing(tenantOf(req), venueOf(req), idParam(req.params.contactId, 'contactId'), req.body, ownerActorOf(req))),
);
router.get(`${V}/messages`, handle(async (req) => listMessages(tenantOf(req), venueOf(req), req.query as Record<string, unknown>)));
router.post(`${T}/guests/find`, handle(async (req) => findGuest(tenantOf(req), req.body)));

// ── Start sending ────────────────────────────────────────────────────────────

router.post(`${V}/start-sending`, handle(async (req) => startSending(tenantOf(req), venueOf(req), ownerActorOf(req))));

export default router;
