/**
 * Adaptive Campaigns result tools (PR D): `get_adaptive_results`, `list_adaptive_messages`,
 * `explain_adaptive_guest`.
 *
 * Like playbooks.ts, these proxy captive-server's `/internal/adaptive/tenants/:id/*` owner API,
 * which owns every rule and checks that each venue and guest belongs to the account — nothing
 * is read from Firestore here. The tenant comes only from the OAuth token (`tenantFrom`), never
 * from an input; no `/admin/*` path is ever called. Read-only: stopping marketing to a guest,
 * setting up or turning on a playbook stays in the CMS.
 *
 * The shaping lives in the pure `adaptiveResultsView.ts` (tested without firebase): small,
 * masked output with no message bodies and no Guest info, because the cms AI stores every tool
 * result in `CaptivePortal_AiChatSessions`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom } from '../shared';
import { callServerInternal, callServerInternalGet, type ServerCallResult } from '../../serverClient';
import {
  errorText,
  explainInputSchema,
  explainInputShape,
  explainNoVenueView,
  explainView,
  EXPLAIN_NEEDS_ONE,
  findBody,
  findPath,
  foundVenues,
  guestPath,
  messagesInputShape,
  messagesPath,
  messagesView,
  notFoundView,
  pickVenue,
  resultsInputShape,
  resultsPath,
  resultsView,
  type ExplainInput,
  type MessagesInput,
  type ResultsInput,
} from './adaptiveResultsView';

const UNREACHABLE = 'Adaptive Campaigns is not reachable right now. Try again in a moment.';

/** One server call; a network failure becomes a clean error instead of a thrown one. */
async function call(fn: () => Promise<ServerCallResult>): Promise<ServerCallResult> {
  try {
    return await fn();
  } catch {
    return { status: 502, data: { ok: false, error: UNREACHABLE } };
  }
}

function failed(res: ServerCallResult): boolean {
  return res.status >= 400 || res.data.ok === false;
}

export function registerAdaptiveResultTools(server: McpServer): void {
  addTool<ResultsInput>(
    server,
    'get_adaptive_results',
    "How Adaptive Campaigns is doing at this account's venues: guests who started a journey, guests who came back, messages sent (per channel; free info messages included), credits used, an estimated revenue (guests who came back × the venue's saved average spend per visit — an estimate, not measured takings), visits, stays synced from the booking calendar (new in the period, and upcoming), and whether sending is waiting for credits. Test-run numbers (nothing sent or charged) come in a separate testRun block and are never added in. One venue or all; venue-local dates YYYY-MM-DD, default the last 30 days, at most 92; byJourney adds each journey's numbers. Numbers come from the daily rollups, so they can be up to ~15 minutes behind. Read-only.",
    resultsInputShape,
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const res = await call(() => callServerInternalGet(resultsPath(tenantUserId, args)));
      if (failed(res)) return errorResult(errorText(res.status, res.data));
      return jsonResult(resultsView(res.data, { byJourney: args.byJourney, venueId: args.venueId }));
    },
  );

  addTool<MessagesInput>(
    server,
    'list_adaptive_messages',
    "The recent Adaptive Campaigns messages at one venue, newest first: what went out and what was held back or not sent, each with a one-line reason in plain words (e.g. \"Held back until Tue 09:07 because it was quiet hours.\"), the guest's short name, the masked recipient, the delivery status and the credits used. Never the message text. kind=sends or kind=skips narrows it; days 1–92 (default 7); up to 50 rows, then page with cursor = nextCursor. Read straight from the event log, so it is current. Use a row's contactId with explain_adaptive_guest for the whole story. Read-only.",
    messagesInputShape,
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const res = await call(() => callServerInternalGet(messagesPath(tenantUserId, args)));
      if (failed(res)) return errorResult(errorText(res.status, res.data));
      return jsonResult(messagesView(res.data, args));
    },
  );

  addTool<ExplainInput>(
    server,
    'explain_adaptive_guest',
    "Explain what Adaptive Campaigns did with one guest and why: their masked details, marketing consent at the venue, their journeys and what's next, and the history as plain sentences (newest first, up to 40 lines; says when older lines are left out) — sent, held back, not sent, and the reason for each. Find the guest by guestId (from list_guests / search_guests), contactId (from list_adaptive_messages), email, or phone (+41…). Explains the venue given, else the one the guest visited last. Never shows message text, Guest info or another account's data. Read-only.",
    explainInputShape,
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const parsed = explainInputSchema.safeParse(args);
      if (!parsed.success) return errorResult(EXPLAIN_NEEDS_ONE);
      const input = parsed.data;

      // POST, so an email or phone never goes into a URL.
      const found = await call(() => callServerInternal(findPath(tenantUserId), findBody(input)));
      if (found.status === 404) return jsonResult(notFoundView());
      if (failed(found)) return errorResult(errorText(found.status, found.data));

      const picked = pickVenue(input.venueId, foundVenues(found.data));
      if ('none' in picked) return jsonResult(explainNoVenueView(found.data, picked.none));

      let path: string;
      try {
        path = guestPath(tenantUserId, picked.venueId, String(found.data.contactId ?? ''), input.lang ?? 'en');
      } catch {
        return errorResult('Adaptive Campaigns returned a guest this tool cannot read.');
      }
      const guest = await call(() => callServerInternalGet(path));
      if (failed(guest)) return errorResult(errorText(guest.status, guest.data));
      return jsonResult(explainView(found.data, guest.data, picked.venueId));
    },
  );
}
