/**
 * Per-guest engagement tools — "which guests are behind this analytics number?"
 *
 * These proxy the CMS's internal drill-down endpoint rather than querying
 * Firestore here. That is deliberate, and it is the same call get_splash_config
 * makes: the CMS owns the derivation.
 *
 * The aggregation carries a set of rules that each exist because they were once
 * gotten wrong — `openCounted` not `openCount` (an open increments the raw counter
 * twice), read-implies-delivered, the exact-status vs delivered-or-read split, the
 * `channel:event:messageId` bucket key, the archived-guest asymmetry.
 * Reimplementing them here guarantees drift, and drift means the agent contradicts
 * the dashboard the tenant is looking at.
 *
 * Scoping: the CMS route re-derives the access-point set from the tenantUserId we
 * send and never trusts a caller-supplied venueId. The local ownership check below
 * exists to give a clean error before the hop, not as the security boundary.
 * Deliberately narrower than the UI route — no SUPER_ADMIN cross-tenant scope and
 * no cross-account linked-venue path.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addTool, errorResult, jsonResult, tenantFrom, NO_TENANT, getOwnedVenue } from '../shared';
import { callCmsInternal, cmsErrorMessage } from '../../cmsClient';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const DRILLDOWN_PATH = '/api/captive-portal/internal/analytics-drilldown';

const METRICS = [
  'guests.total',
  'guests.optIn',
  'guests.optOut',
  'sessions.total',
  'messages.sent',
  'messages.delivered',
  'messages.status',
  'messages.opened',
  'messages.clicked',
  'messages.visited',
  'messages.rated',
  'links.clicks',
] as const;

/** Metrics the CMS route requires a venueId for. */
const VENUE_REQUIRED = new Set([
  'messages.sent',
  'messages.delivered',
  'messages.status',
  'messages.opened',
  'messages.clicked',
  'messages.visited',
  'messages.rated',
  'links.clicks',
]);

interface EngagementArgs {
  metric?: string;
  venueId?: string;
  guestId?: string;
  channel?: string;
  status?: string;
  wifiEvent?: string;
  messageId?: string;
  lineageId?: string;
  trackedLinkTemplateId?: string;
  startDate?: string;
  endDate?: string;
  sort?: string;
  limit?: number;
}

/**
 * `messageKey` is deliberately absent from these schemas — it is an opaque token
 * the dashboard echoes back from a row it rendered. An agent should use
 * `messageId` or `lineageId`, which are the ids get_venue_marketing_config already
 * returns.
 */
const SCOPE_SHAPE = {
  venueId: z
    .string()
    .optional()
    .describe('Venue id (from list_venues). Required for every messages.* and links.* metric.'),
  guestId: z.string().optional().describe('Narrow to a single guest (from list_guests / search_guests).'),
  channel: z.enum(['sms', 'email', 'whatsapp']).optional().describe('Only this channel.'),
  wifiEvent: z
    .enum(['onConnect', 'onReconnect', 'onDisconnect'])
    .optional()
    .describe('Only sends/sessions for this wifi event.'),
  messageId: z.string().optional().describe('One exact message version (a templateMessageId).'),
  lineageId: z.string().optional().describe('Every version of one message.'),
  startDate: z.string().optional().describe('ISO date lower bound (inclusive).'),
  endDate: z.string().optional().describe('ISO date upper bound (inclusive).'),
  sort: z
    .enum(['count', 'recent', 'rating', 'name'])
    .optional()
    .describe('Result order (default count). "name" is limited to 1000 matching guests.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max guests to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
};

/**
 * Shared handler. `forcedMetric` is set for the per-metric aliases so they share
 * one implementation rather than duplicating the proxy logic five times.
 */
function makeHandler(forcedMetric?: string) {
  return async (args: EngagementArgs, extra: Parameters<typeof tenantFrom>[0]) => {
    const tenantUserId = tenantFrom(extra);
    if (!tenantUserId) return errorResult(NO_TENANT);

    const metric = forcedMetric ?? args.metric;
    if (!metric) return errorResult('A metric is required.');

    if (VENUE_REQUIRED.has(metric) && !args.venueId) {
      return errorResult(
        `The "${metric}" metric is per-venue — pass a venueId (see list_venues). ` +
          'Message and tracked-link numbers only exist within a venue.',
      );
    }

    // Fail fast with a clear message rather than letting the CMS return an empty
    // list for a venue this account does not own. The CMS re-checks regardless.
    if (args.venueId) {
      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');
    }

    const result = await callCmsInternal(DRILLDOWN_PATH, {
      tenantUserId,
      mode: 'drilldown',
      metric,
      venueId: args.venueId,
      guestId: args.guestId,
      channel: args.channel,
      status: args.status,
      wifiEvent: args.wifiEvent,
      messageId: args.messageId,
      lineageId: args.lineageId,
      trackedLinkTemplateId: args.trackedLinkTemplateId,
      startDate: args.startDate,
      endDate: args.endDate,
      sort: args.sort,
      limit: args.limit ?? DEFAULT_LIMIT,
    });

    if (result.status < 200 || result.status >= 300) {
      return errorResult(cmsErrorMessage(result));
    }

    const guests = Array.isArray(result.data.guests) ? result.data.guests : [];
    const total = (result.data.total as number) ?? guests.length;

    // Envelope matches list_guests: count is this page, total the full match set.
    return jsonResult({
      metric,
      scope: result.data.scope ?? null,
      summary: result.data.summary ?? null,
      count: guests.length,
      total,
      truncated: Boolean(result.data.truncated),
      scanCapped: Boolean(result.data.scanCapped),
      guests,
    });
  };
}

/**
 * Per-metric convenience tools. Five, not eleven — session and guest counts are
 * already served by list_guests / get_capture_stats, and every tool costs context
 * on every MCP request. Generated from one config array (same shape as the
 * pause/resume/cancel loop in campaignWrites) so there is exactly one handler.
 */
const ALIASES = [
  {
    name: 'list_guests_who_clicked',
    metric: 'messages.clicked',
    desc: 'List the guests who clicked a link in a venue-automation message. Optionally narrow to one channel, message version (messageId) or whole message (lineageId).',
  },
  {
    name: 'list_guests_who_opened',
    metric: 'messages.opened',
    desc: 'List the guests who opened a venue-automation email. Email only — SMS has no open signal and WhatsApp reports reads as a delivery status (use list_guests_messaged with status filtering for those).',
  },
  {
    name: 'list_guests_who_visited',
    metric: 'messages.visited',
    desc: 'List the guests who reached the rate page after a venue-automation message.',
  },
  {
    name: 'list_guests_who_rated',
    metric: 'messages.rated',
    desc: 'List the guests who submitted a star rating after a venue-automation message. Each guest row carries their rating, and the summary carries the average.',
  },
  {
    name: 'list_guests_messaged',
    metric: 'messages.sent',
    desc: 'List the guests a venue-automation message was sent to.',
  },
] as const;

export function registerGuestEngagementTools(server: McpServer): void {
  addTool<EngagementArgs>(
    server,
    'get_guest_engagement',
    'Drill into any venue-automation analytics number and get the individual guests behind it — who was messaged, who opened, clicked, visited the rate page, or left a rating, and who a message failed for. Returns the same guests the CMS dashboard shows for that number. `summary.events` is the underlying record count (equal to the dashboard figure) and `total` is the distinct guest count, which is usually smaller because one guest can receive several sends.',
    {
      metric: z
        .enum(METRICS)
        .describe(
          'Which number to drill into. messages.status needs a `status`; links.clicks needs a `trackedLinkTemplateId`. Note messages.delivered counts delivered-or-read (matching the dashboard\'s Delivered column) while messages.status with status="delivered" counts only the exact status.',
        ),
      status: z
        .enum(['scheduled', 'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered'])
        .optional()
        .describe('Required when metric is messages.status. Use "failed"/"undelivered" to find who did not receive a message, or "read" for WhatsApp read receipts.'),
      trackedLinkTemplateId: z
        .string()
        .optional()
        .describe('Required when metric is links.clicks.'),
      ...SCOPE_SHAPE,
    },
    makeHandler(),
  );

  for (const alias of ALIASES) {
    addTool<EngagementArgs>(server, alias.name, alias.desc, SCOPE_SHAPE, makeHandler(alias.metric));
  }
}
