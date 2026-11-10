/**
 * HeidiFi admin access for the MCP (the WhatsApp admin tools).
 *
 * The MCP acts as one owner account. A SUPER_ADMIN can connect too (they pick the account on the
 * cms consent screen, which records them as `approvedBy`); such a connection also carries the
 * admin's uid (`adminUid` on the code and tokens), and only then are the WhatsApp admin tools
 * listed and callable. Every request checks again that the person is still a SUPER_ADMIN, so
 * taking the role away takes the tools away from connections already made.
 *
 * Owners and the cms in-app AI (`/internal/mint-token`) never get it.
 */

import { db } from './firebase';

/** `uid` when that Users doc is a SUPER_ADMIN (as the cms normalises `accountType`), else null. */
export async function superAdminUid(uid: unknown): Promise<string | null> {
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 128 || uid.includes('/')) return null;
  const snap = await db.collection('Users').doc(uid).get();
  if (!snap.exists) return null;
  const type = String(snap.get('accountType') ?? '').trim().toUpperCase();
  return type === 'SUPER_ADMIN' ? uid : null;
}

/** For a request: the uid while still a SUPER_ADMIN; null when not, or when the read fails (fails closed). */
export async function stillSuperAdmin(uid: string | null | undefined): Promise<string | null> {
  if (!uid) return null;
  try {
    return await superAdminUid(uid);
  } catch (err) {
    console.error('[MCP] admin role lookup failed; admin tools off for this request:', (err as Error)?.name ?? 'Error');
    return null;
  }
}
