import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../firebase';
import {
  GuestDoc,
  NO_TENANT,
  TenantAccessPoint,
  addTool,
  errorResult,
  getGuestsForApIds,
  getOwnedVenue,
  getTenantAccessPoints,
  jsonResult,
  tenantFrom,
  tsToIso,
} from '../shared';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Lean guest projection for list/search results (excludes raw device + consent blobs). */
function leanGuest(g: GuestDoc, apMap: Map<string, TenantAccessPoint>) {
  const d = g.data;
  const ap = apMap.get((d.captivePortalAccessPointId as string) ?? '');
  return {
    id: g.id,
    firstName: (d.firstName as string) ?? null,
    lastName: (d.lastName as string) ?? null,
    email: (d.email as string) ?? null,
    phone: (d.phone as string) ?? null,
    phoneCountryCode: (d.phoneCountryCode as string) ?? null,
    marketingOptIn: Boolean(d.marketingOptIn),
    connectionCount: (d.connectionCount as number) ?? null,
    accessPointId: (d.captivePortalAccessPointId as string) ?? null,
    accessPointName: ap?.name ?? null,
    venueId: ap?.venueId ?? null,
    venueName: ap?.venueName ?? null,
    timestamp: typeof d.timestamp === 'string' ? d.timestamp : tsToIso(d.timestamp),
  };
}

/** ISO timestamp of a guest for sorting/filtering (string field or Firestore Timestamp). */
function guestTime(d: Record<string, unknown>): string | null {
  return typeof d.timestamp === 'string' ? d.timestamp : tsToIso(d.timestamp);
}

/** Sort guests newest-first by signup timestamp. */
function byNewest(a: GuestDoc, b: GuestDoc): number {
  return (guestTime(b.data) ?? '').localeCompare(guestTime(a.data) ?? '');
}

/** Register guest read tools: `list_guests`, `get_guest`, `search_guests`. */
export function registerGuestTools(server: McpServer): void {
  addTool<{
    venueId?: string;
    accessPointId?: string;
    marketingOptIn?: boolean;
    signedUpAfter?: string;
    signedUpBefore?: string;
    includeArchived?: boolean;
    limit?: number;
  }>(
    server,
    'list_guests',
    'List WiFi guests (captured leads) for the authenticated tenant. By default returns guests across all of the tenant\'s venues; narrow with venueId or accessPointId. Optional filters: marketingOptIn, signedUpAfter/signedUpBefore (ISO dates), includeArchived. Newest first.',
    {
      venueId: z.string().optional().describe('Limit to guests captured at this venue (from list_venues).'),
      accessPointId: z.string().optional().describe('Limit to guests captured at this access point.'),
      marketingOptIn: z.boolean().optional().describe('Only guests who opted in (true) or out (false).'),
      signedUpAfter: z.string().optional().describe('ISO timestamp — only guests who signed up on/after this.'),
      signedUpBefore: z.string().optional().describe('ISO timestamp — only guests who signed up on/before this.'),
      includeArchived: z.boolean().optional().describe('Include archived guests (default false).'),
      limit: z.number().int().positive().max(MAX_LIMIT).optional().describe(`Max guests to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const aps = await getTenantAccessPoints(tenantUserId);
      const apMap = new Map(aps.map((ap) => [ap.id, ap]));

      // Resolve the target access-point ids from the scoping filters.
      let targetApIds = aps.map((ap) => ap.id);
      if (args.accessPointId) {
        if (!apMap.has(args.accessPointId)) {
          return errorResult('Access point not found or not owned by this account.');
        }
        targetApIds = [args.accessPointId];
      } else if (args.venueId) {
        const venue = await getOwnedVenue(tenantUserId, args.venueId);
        if (!venue) return errorResult('Venue not found or not owned by this account.');
        targetApIds = aps.filter((ap) => ap.venueId === args.venueId).map((ap) => ap.id);
      }

      let guests = await getGuestsForApIds(targetApIds);

      // In-memory filters (Firestore can't combine these with the `in` query).
      if (!args.includeArchived) guests = guests.filter((g) => g.data.status !== 'archived');
      if (args.marketingOptIn !== undefined) {
        guests = guests.filter((g) => Boolean(g.data.marketingOptIn) === args.marketingOptIn);
      }
      if (args.signedUpAfter) guests = guests.filter((g) => (guestTime(g.data) ?? '') >= args.signedUpAfter!);
      if (args.signedUpBefore) guests = guests.filter((g) => (guestTime(g.data) ?? '') <= args.signedUpBefore!);

      const total = guests.length;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const page = guests.sort(byNewest).slice(0, limit);

      return jsonResult({
        count: page.length,
        total,
        truncated: total > page.length,
        guests: page.map((g) => leanGuest(g, apMap)),
      });
    },
  );

  addTool<{ guestId: string }>(
    server,
    'get_guest',
    'Get a single WiFi guest by id, including consent records (privacy policy, terms, marketing) and reconnect count. Only returns guests captured at an access point owned by the authenticated tenant.',
    { guestId: z.string().describe('The guest id (from list_guests / search_guests).') },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection('CaptivePortal_Users').doc(args.guestId).get();
      if (!snap.exists) return errorResult('Guest not found.');
      const d = snap.data() as Record<string, unknown>;

      // Verify the guest's access point is owned by this tenant. Authorize via
      // venue ownership (the source of truth) as well as the AP's denormalized
      // tenantUserId, which can be missing/stale — otherwise guests captured at
      // such APs are invisible here even though they own the venue.
      const apId = (d.captivePortalAccessPointId as string) ?? '';
      const apSnap = apId ? await db.collection('CaptivePortal_AccessPoints').doc(apId).get() : null;
      const apData = apSnap?.exists ? (apSnap.data() as Record<string, unknown>) : null;
      const apVenueId = apData?.venueId as string | undefined;
      const owned =
        apData != null &&
        (apData.tenantUserId === tenantUserId ||
          (apVenueId ? (await getOwnedVenue(tenantUserId, apVenueId)) !== null : false));
      if (!owned) {
        return errorResult('Guest not found or not owned by this account.');
      }

      return jsonResult({
        guest: {
          id: snap.id,
          firstName: (d.firstName as string) ?? null,
          lastName: (d.lastName as string) ?? null,
          email: (d.email as string) ?? null,
          phone: (d.phone as string) ?? null,
          phoneCountryCode: (d.phoneCountryCode as string) ?? null,
          marketingOptIn: Boolean(d.marketingOptIn),
          connectionCount: (d.connectionCount as number) ?? null,
          accessPointId: apId || null,
          accessPointName: (apData.name as string) ?? null,
          venueId: (apData.venueId as string) ?? null,
          venueName: (apData.venueName as string) ?? null,
          timestamp: guestTime(d),
          createdAt: tsToIso(d.createdAt),
          consent: {
            privacyPolicy: d.privacyPolicyConsent ?? null,
            terms: d.termsConsent ?? null,
            marketing: d.marketingConsent ?? null,
          },
        },
      });
    },
  );

  addTool<{ query: string; limit?: number }>(
    server,
    'search_guests',
    'Search the authenticated tenant\'s WiFi guests by a free-text query matched against name, email, and phone. Returns newest-first matches across all owned venues.',
    {
      query: z.string().min(1).describe('Text to match against guest name, email, or phone.'),
      limit: z.number().int().positive().max(MAX_LIMIT).optional().describe(`Max matches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const aps = await getTenantAccessPoints(tenantUserId);
      const apMap = new Map(aps.map((ap) => [ap.id, ap]));
      const guests = await getGuestsForApIds(aps.map((ap) => ap.id));

      const q = args.query.toLowerCase().trim();
      const matches = guests.filter((g) => {
        const d = g.data;
        const haystack = [
          d.firstName,
          d.lastName,
          `${(d.firstName as string) ?? ''} ${(d.lastName as string) ?? ''}`,
          d.email,
          d.phone,
          `${(d.phoneCountryCode as string) ?? ''}${(d.phone as string) ?? ''}`,
        ]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });

      const limit = args.limit ?? DEFAULT_LIMIT;
      const page = matches.sort(byNewest).slice(0, limit);

      return jsonResult({
        query: args.query,
        count: page.length,
        total: matches.length,
        truncated: matches.length > page.length,
        guests: page.map((g) => leanGuest(g, apMap)),
      });
    },
  );
}
