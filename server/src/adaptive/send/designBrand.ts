/**
 * Loads the venue's look for an email: the account's Branding doc (`CaptivePortal_TenantBranding/
 * {tenantUserId}`, written by the cms Branding page) plus what the venue doc says. Cached for a few
 * minutes per account, so a busy worker doesn't read the same doc for every email. A read that
 * fails gives the no-branding look rather than holding the send.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { designBrandFrom, type DesignBrand } from './design/brand';

const BRANDING = 'CaptivePortal_TenantBranding';
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; doc: Record<string, unknown> | null }>();

async function brandingDoc(tenantUserId: string, fresh: boolean): Promise<Record<string, unknown> | null> {
  const hit = cache.get(tenantUserId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.doc;
  try {
    const snap = await db.collection(BRANDING).doc(tenantUserId).get();
    const doc = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    cache.set(tenantUserId, { at: Date.now(), doc });
    return doc;
  } catch (err) {
    console.error('[ADAPTIVE] branding unreadable; the email uses the no-branding look', (err as Error)?.name ?? 'Error');
    return null;
  }
}

/**
 * `fresh`: the owner's own screens (preview, Send test) read the doc now, so a Branding change shows at
 * once; the worker's sends use the cache.
 */
export async function loadDesignBrand(
  tenantUserId: string,
  venue: { name: string; address?: unknown; logoUrl?: unknown },
  opts: { fresh?: boolean } = {},
): Promise<DesignBrand> {
  return designBrandFrom(await brandingDoc(tenantUserId, opts.fresh === true), venue);
}

/** The owner's preview: the venue doc's address and own logo, and the branding read now. */
export async function loadPreviewBrand(tenantUserId: string, venueId: string | undefined, venueName: string): Promise<DesignBrand> {
  let venue: Record<string, unknown> = {};
  if (venueId) {
    try {
      venue = (await db.collection(COL.venues).doc(venueId).get()).data() ?? {};
    } catch {
      venue = {};
    }
  }
  return loadDesignBrand(tenantUserId, { name: venueName, address: venue.address, logoUrl: venue.logoUrl }, { fresh: true });
}

/** Tests only. */
export function clearDesignBrandCache(): void {
  cache.clear();
}
