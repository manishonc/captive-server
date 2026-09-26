/**
 * Read-only views of existing collections (venues, access points, guests, the
 * Marketing tab, the Campaign Manager). Adaptive Campaigns never writes to any
 * of them — it only needs to know what exists and what already sends.
 */

import { db } from '../../firebase';
import { Timestamp } from 'firebase-admin/firestore';
import { COL } from './collections';
import type { Channel } from '../core/constants';
import { classKeyWithCountry } from '../core/owner/audience';
import { phoneCountry } from '../core/runtime/phoneCountry';

export interface TenantVenue {
  venueId: string;
  tenantUserId: string | null;
  name: string;
  venueType: string | null;
  address: string | null;
  timezone: string | null;
  isActive: boolean;
}

function toVenue(id: string, data: Record<string, unknown>): TenantVenue {
  return {
    venueId: id,
    tenantUserId: (data.tenantUserId as string) ?? null,
    name: String(data.venue_name ?? data.name ?? 'Venue'),
    venueType: (data.venue_type as string) ?? null,
    address: (data.address as string) || null,
    timezone: (data.timezone as string) || null,
    isActive: data.isActive !== false,
  };
}

export async function listTenantVenues(tenantUserId: string): Promise<TenantVenue[]> {
  const snap = await db.collection(COL.venues).where('tenantUserId', '==', tenantUserId).get();
  return snap.docs.map((d) => toVenue(d.id, d.data())).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getVenues(venueIds: string[]): Promise<Map<string, TenantVenue | null>> {
  const out = new Map<string, TenantVenue | null>();
  if (!venueIds.length) return out;
  const snaps = await db.getAll(...venueIds.map((id) => db.collection(COL.venues).doc(id)));
  snaps.forEach((snap, i) => out.set(venueIds[i], snap.exists ? toVenue(snap.id, snap.data() ?? {}) : null));
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface OverlapFlags {
  legacyOnConnectChannels: Channel[];
  automations: Array<{ campaignId: string; name: string }>;
}

/**
 * What already messages guests who connect at these venues:
 *  - the Marketing tab's on-connect messages (CaptivePortal_EntityMarketing, as
 *    routes/captive.ts reads them: events.onConnect.<channel>.enabled + messages);
 *  - active Campaign Manager automations whose segment names the venue (the same
 *    test the CMS venue Marketing tab uses).
 */
export async function detectOverlap(tenantUserId: string, venueIds: string[]): Promise<Map<string, OverlapFlags>> {
  const out = new Map<string, OverlapFlags>();
  if (!venueIds.length) return out;

  const marketingSnaps = await db.getAll(...venueIds.map((id) => db.collection(COL.entityMarketing).doc(`venue_${id}`)));
  const campaignsSnap = await db.collection(COL.campaigns).where('tenantUserId', '==', tenantUserId).get();
  const automations = campaignsSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, any> }))
    .filter((c) => c.data.type === 'automation' && c.data.status === 'active');

  venueIds.forEach((venueId, i) => {
    const events = (marketingSnaps[i].data()?.events ?? {}) as Record<string, any>;
    const onConnect = events.onConnect ?? {};
    const channels = (['sms', 'email', 'whatsapp'] as Channel[]).filter(
      (ch) => onConnect?.[ch]?.enabled === true && Array.isArray(onConnect?.[ch]?.messages) && onConnect[ch].messages.length > 0,
    );
    const targeting = automations
      .filter((c) => Array.isArray(c.data.segment?.venueIds) && c.data.segment.venueIds.includes(venueId))
      .map((c) => ({ campaignId: c.id, name: String(c.data.name ?? 'Automation') }));
    out.set(venueId, { legacyOnConnectChannels: channels, automations: targeting });
  });
  return out;
}

export interface CaptureStats {
  captures30d: number;
  optedIn30d: number;
  withPhone: number;
  emailOnly: number;
  /** Opted-in guests by contact details and verification (PR D, core/owner/audience.ts `classKey`). */
  classes?: Record<string, number>;
}

function captureTime(data: Record<string, unknown>): number | null {
  const v = data.createdAt ?? data.timestamp;
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Guests captured at these venues in the last `days` days, counted the way the
 * MCP capture stats count them: venue → its access points → guests on those
 * access points (guest docs carry no venue id), archived guests excluded.
 */
export async function recentCaptureStats(
  tenantUserId: string,
  venueIds: string[],
  days = 30,
): Promise<Map<string, CaptureStats>> {
  const stats = new Map<string, CaptureStats>(venueIds.map((id) => [id, { captures30d: 0, optedIn30d: 0, withPhone: 0, emailOnly: 0 }]));
  if (!venueIds.length) return stats;

  const apToVenue = new Map<string, string>();
  for (const ids of chunk(venueIds, 30)) {
    const snap = await db.collection(COL.accessPoints).where('venueId', 'in', ids).get();
    for (const doc of snap.docs) apToVenue.set(doc.id, String(doc.data().venueId));
  }
  // APs tagged with the tenant but missing from the venue query (older data).
  const byTenant = await db.collection(COL.accessPoints).where('tenantUserId', '==', tenantUserId).get();
  for (const doc of byTenant.docs) {
    const venueId = doc.data().venueId as string | undefined;
    if (venueId && venueIds.includes(venueId)) apToVenue.set(doc.id, venueId);
  }

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const ids of chunk([...apToVenue.keys()], 30)) {
    const snap = await db.collection(COL.guests).where('captivePortalAccessPointId', 'in', ids).get();
    for (const doc of snap.docs) {
      const g = doc.data() as Record<string, any>;
      if (g.status === 'archived') continue;
      const at = captureTime(g);
      if (at === null || at < since) continue;
      const venueId = apToVenue.get(String(g.captivePortalAccessPointId));
      const s = venueId ? stats.get(venueId) : undefined;
      if (!s) continue;
      s.captures30d += 1;
      const optedIn = g.marketingOptIn === true || g.marketingConsent?.given === true;
      if (!optedIn) continue;
      s.optedIn30d += 1;
      const phone = typeof g.phone === 'string' && g.phone.trim() !== '';
      const email = typeof g.email === 'string' && g.email.trim() !== '';
      if (phone) s.withPhone += 1;
      else if (email) s.emailOnly += 1;
      // Who gets messages (PR D): the same guests, by their verified flags (services/verificationGate.ts).
      // With the number's country: the engine texts only the countries in its SMS list.
      const e164 = typeof g.phoneE164 === 'string' ? g.phoneE164 : phone && g.phone.trim().startsWith('+') ? g.phone.trim() : null;
      const cls = classKeyWithCountry(
        { hasPhone: phone, phoneVerified: g.phoneVerified === true, hasEmail: email, emailVerified: g.emailVerified === true },
        phoneCountry(e164)?.country ?? null,
      );
      s.classes = { ...(s.classes ?? {}), [cls]: (s.classes?.[cls] ?? 0) + 1 };
    }
  }
  return stats;
}
