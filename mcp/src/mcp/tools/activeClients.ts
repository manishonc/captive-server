import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import { callServerInternal } from '../../serverClient';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom } from '../shared';

/**
 * Live "who is connected right now" tools.
 *
 * All three are READ-only. There is deliberately no `disconnect_device` tool: every other
 * MCP write in this server is either reversible (campaign pause/resume, archive/restore) or
 * preview-gated behind a confirmToken (apply_splash_config). Kicking a named person off the
 * WiFi is irreversible, instantaneous, and lands on a guest who never invoked the model —
 * and the tool's own inputs (hostnames, guest names) are attacker-influenced text, which
 * would make it a prompt-injection primitive with a physical-world effect. If it is ever
 * added it should mirror the splash pattern: a `preview_disconnect_device` that returns who
 * is about to be ejected and mints a short-lived token the write then requires.
 *
 * Tenant scoping is enforced twice, as everywhere else in this feature: `getOwnedVenue`
 * proves the caller owns the venue, and captive-server independently re-derives that
 * venue's own access points and filters the controller's site-wide client list to them.
 */
export function registerActiveClientTools(server: McpServer): void {
  addTool<{ venueId: string; includeIdentity?: boolean }>(
    server,
    'list_active_clients',
    "List the devices connected to a venue's guest WiFi right now, read live from the WiFi controller. Requires a venueId — call list_venues first, or ask the user which venue. Guests are grouped as people: one guest carrying a phone and a laptop appears once, with both devices. Devices nobody has signed in on are returned separately as unidentified — that is normal, not an error, because many phones use a private (randomized) address that can never be matched to a guest. If the WiFi controller cannot be reached the result says so explicitly rather than reporting zero devices; those two situations mean very different things and must not be conflated when answering the user.",
    {
      venueId: z.string().describe('The venue to inspect (from list_venues).'),
      includeIdentity: z
        .boolean()
        .optional()
        .describe('Attach guest names and contact details to each device. Default true.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      const { status, data } = await callServerInternal('/internal/unifi/active-clients', {
        venueId: args.venueId,
        includeClients: true,
        includeIdentity: args.includeIdentity !== false,
      });
      if (status >= 400 || data?.ok === false) {
        return errorResult(
          `Could not read the live client list: ${(data?.error as string) || `HTTP ${status}`}`,
        );
      }

      const v = data.venue as Record<string, unknown>;
      if (v?.vendorSupported === false) {
        return jsonResult({
          venueId: args.venueId,
          venueName: (venue.venue_name as string) ?? null,
          supported: false,
          note: "This venue's routers do not report connected clients, so a live view is not available here. Guests who signed in are still listed by list_guests.",
        });
      }
      if (v?.controllerOk === false) {
        return jsonResult({
          venueId: args.venueId,
          venueName: (venue.venue_name as string) ?? null,
          controllerReachable: false,
          note: 'The WiFi controller could not be reached, so the number of connected devices is UNKNOWN — not zero. Guests are most likely still connected.',
        });
      }

      return jsonResult({
        venueId: args.venueId,
        venueName: (venue.venue_name as string) ?? (v.venueName as string) ?? null,
        controllerReachable: true,
        checkedAt: v.fetchedAt,
        totalDevices: v.total,
        identifiedDevices: v.identified,
        unidentifiedDevices: v.unidentified,
        guests: v.guests,
        devices: v.clients,
        perAccessPoint: Object.values((v.perAp as Record<string, unknown>) ?? {}),
      });
    },
  );

  addTool<{ venueId: string }>(
    server,
    'get_venue_live_count',
    'How many devices are connected to one venue\'s guest WiFi right now, broken down per router. Cheaper than list_active_clients — use this when the question is "how busy is it" rather than "who is here". Returns controllerReachable: false when the WiFi controller cannot be reached, which means the count is unknown rather than zero.',
    { venueId: z.string().describe('The venue to inspect (from list_venues).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const venue = await getOwnedVenue(tenantUserId, args.venueId);
      if (!venue) return errorResult('Venue not found or not owned by this account.');

      const { status, data } = await callServerInternal('/internal/unifi/active-clients', {
        venueId: args.venueId,
        includeClients: false,
        includeIdentity: false,
      });
      if (status >= 400 || data?.ok === false) {
        return errorResult(`Could not read live counts: ${(data?.error as string) || `HTTP ${status}`}`);
      }

      const v = data.venue as Record<string, unknown>;
      return jsonResult({
        venueId: args.venueId,
        venueName: (venue.venue_name as string) ?? null,
        supported: v?.vendorSupported !== false,
        controllerReachable: v?.controllerOk !== false,
        checkedAt: v?.fetchedAt,
        totalDevices: v?.controllerOk === false ? null : v?.total,
        perAccessPoint: Object.values((v?.perAp as Record<string, unknown>) ?? {}),
      });
    },
  );

  addTool<Record<string, never>>(
    server,
    'get_live_counts',
    'Live connected-device counts across every venue this account owns, taken as a single snapshot so the per-venue numbers and the total always agree. Use for "how busy are my venues right now". Venues whose controller cannot be reached are marked unreachable, and their counts are unknown rather than zero.',
    {},
    async (_args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      // This query IS the ownership check — a venue not returned here is never asked about.
      const snap = await db
        .collection('CaptivePortal_Venues')
        .where('tenantUserId', '==', tenantUserId)
        .get();
      const venueIds = snap.docs.map((d) => d.id);
      if (venueIds.length === 0) {
        return jsonResult({ totalDevices: 0, venues: [], note: 'This account has no venues.' });
      }

      const { status, data } = await callServerInternal('/internal/unifi/active-clients/org', { venueIds });
      if (status >= 400 || data?.ok === false) {
        return errorResult(`Could not read live counts: ${(data?.error as string) || `HTTP ${status}`}`);
      }

      const org = data.org as Record<string, unknown>;
      const reachable = org?.controllerOk !== false;
      return jsonResult({
        controllerReachable: reachable,
        checkedAt: org?.fetchedAt,
        totalDevices: reachable ? org?.total : null,
        venues: Object.values((org?.byVenue as Record<string, unknown>) ?? {}),
        ...(reachable
          ? {}
          : {
              note: 'The WiFi controller could not be reached, so these counts are UNKNOWN — not zero. Guests are most likely still connected.',
            }),
      });
    },
  );
}
