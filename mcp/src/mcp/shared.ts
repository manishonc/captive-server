/**
 * Shared helpers for the captive-portal MCP tools.
 *
 * Every tool is tenant-scoped: the `tenantUserId` is resolved from the OAuth access
 * token (extra.authInfo.extra.tenantUserId) and all Firestore reads are filtered by it,
 * mirroring the CMS dashboard's own queries (cms/app/api/captive-portal/**).
 */

import type { ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../firebase';

/** Minimal shape of the MCP tool-handler `extra` argument we depend on. */
export interface ToolExtra {
  authInfo?: { extra?: Record<string, unknown> | undefined } | undefined;
}

/** Human-readable message returned when no tenant is bound to the session. */
export const NO_TENANT = 'No tenant account is bound to this MCP session.';

/** Resolve the tenant account bound to this MCP session, or null. */
export function tenantFrom(extra: ToolExtra | undefined): string | null {
  const authExtra = extra?.authInfo?.extra as Record<string, unknown> | undefined;
  const tenantUserId = authExtra?.tenantUserId as string | undefined;
  return tenantUserId ?? null;
}

/** Build a JSON success result (pretty-printed text content). */
export function jsonResult(payload: unknown) {
  return {
    isError: false as const,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Build an error result with a human-readable message. */
export function errorResult(text: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text }],
  };
}

/** The result shape returned by jsonResult / errorResult. */
type ToolResult = ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>;

/**
 * Register a tool that takes an input schema.
 *
 * `shape` is typed as `ZodRawShape` (not the literal), which keeps the SDK's
 * `tool()` generic shallow and avoids TS2589 ("type instantiation is excessively
 * deep") under zod 3.25. Runtime validation against `shape` is unchanged; the
 * caller declares the validated argument type via the `A` type parameter.
 */
export function addTool<A>(
  server: McpServer,
  name: string,
  description: string,
  shape: ZodRawShape,
  handler: (args: A, extra: ToolExtra) => ToolResult | Promise<ToolResult>,
): void {
  // Erase the SDK's `ToolCallback<Args>` generic at this single call site. Its
  // `z.objectOutputType` mapping over zod 3.25 instantiates excessively deep (TS2589);
  // the cast affects types only — registration and runtime validation are unchanged.
  const register = (server as { tool: (...args: unknown[]) => unknown }).tool.bind(server);
  register(name, description, shape, handler);
}

/** Convert a Firestore Timestamp (or anything else) to an ISO string, else null. */
export function tsToIso(value: unknown): string | null {
  const ts = value as { toDate?: () => Date } | null | undefined;
  return ts?.toDate?.()?.toISOString() ?? null;
}

/** Split an array into chunks of `size` (Firestore `in` queries cap at 30 values). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A tenant's access point, with the venue context the dashboard inherits onto it. */
export interface TenantAccessPoint {
  id: string;
  name: string;
  venueId: string;
  venueName: string;
}

/**
 * All access points owned by a tenant.
 * Mirrors the CMS access-points route's `tenantUserId` branch — `tenantUserId` is
 * denormalized onto each AP from its owning venue.
 */
export async function getTenantAccessPoints(tenantUserId: string): Promise<TenantAccessPoint[]> {
  const snap = await db
    .collection('CaptivePortal_AccessPoints')
    .where('tenantUserId', '==', tenantUserId)
    .get();
  return snap.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      name: (d.name as string) ?? '',
      venueId: (d.venueId as string) ?? '',
      venueName: (d.venueName as string) ?? '',
    };
  });
}

/** A captured guest document with its Firestore id. */
export interface GuestDoc {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Fetch guests across a set of access-point ids, chunked to respect Firestore's
 * 30-value `in` limit. Guests are keyed by `captivePortalAccessPointId` (not tenant),
 * so callers resolve venues → APs → guests first.
 */
export async function getGuestsForApIds(apIds: string[]): Promise<GuestDoc[]> {
  if (apIds.length === 0) return [];
  const out: GuestDoc[] = [];
  for (const ids of chunk(apIds, 30)) {
    const snap = await db
      .collection('CaptivePortal_Users')
      .where('captivePortalAccessPointId', 'in', ids)
      .get();
    for (const doc of snap.docs) out.push({ id: doc.id, data: doc.data() as Record<string, unknown> });
  }
  return out;
}

/**
 * Fetch a venue and verify it belongs to the tenant.
 * Returns the venue data, or null if it does not exist or is owned by someone else.
 */
export async function getOwnedVenue(
  tenantUserId: string,
  venueId: string,
): Promise<Record<string, unknown> | null> {
  if (!venueId) return null;
  const snap = await db.collection('CaptivePortal_Venues').doc(venueId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  if (data.tenantUserId !== tenantUserId) return null;
  return data;
}
