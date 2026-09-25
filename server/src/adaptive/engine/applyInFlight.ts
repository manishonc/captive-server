/**
 * "Apply to guests already in these journeys" (plan §3.10).
 *
 * The owner's save creates config version n and — in the same transaction — this
 * task. The worker then marks every running guest of that install at the venue
 * with `pendingConfigVersion = n` and `pendingConfigAt = the save time`; `advance`
 * moves each one to version n at its next step (core/runtime/configSwap.ts). It
 * doesn't bump `rev`: `advance` never writes these fields except when it swaps,
 * and it re-reads them in its commit.
 *
 * Every journey of the install gets the new version (D-11), in pages of ≤ 200
 * guests, one transaction each — so two saves handled out of order can't move a
 * guest back to the older one. A guest stays on the template version they started
 * with, so only guests on the template version the save configured are marked (a
 * config written for another version could miss the blanks their steps use).
 */

import { FieldPath, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { TaskSpec } from '../queue/firestoreQueue';

const PAGE = 200;

export interface ApplyInFlightPayload {
  installId: string;
  venueId: string;
  configVersion: number;
  /** The save time (engine clock, epoch ms): the freeze window counts from here. */
  savedAt: number;
  journeyKeys: string[];
  /** The template version each journey's saved values were written for. */
  templateVersions?: Record<string, number>;
}

export function applyInFlightTask(p: {
  tenantUserId: string;
  venueId: string;
  installId: string;
  configVersion: number;
  savedAt: number;
  journeys: Record<string, { templateVersion: number }>;
}): TaskSpec {
  const templateVersions: Record<string, number> = {};
  for (const [key, j] of Object.entries(p.journeys)) templateVersions[key] = j.templateVersion;
  return {
    dedupeKey: `apply:${p.installId}:${p.configVersion}`,
    kind: 'apply_config_inflight',
    dueAt: p.savedAt,
    payload: { installId: p.installId, venueId: p.venueId, configVersion: p.configVersion, savedAt: p.savedAt, journeyKeys: Object.keys(p.journeys), templateVersions },
    tenantUserId: p.tenantUserId,
    venueId: p.venueId,
  };
}

/** The active guests of one journey at a venue, a page at a time (index venueId↑ journeyKey↑ status↑). */
export function activeInstancesQuery(venueId: string, journeyKey: string) {
  return db
    .collection(COL.journeyInstances)
    .where('venueId', '==', venueId)
    .where('journeyKey', '==', journeyKey)
    .where('status', '==', 'active')
    .orderBy(FieldPath.documentId());
}

export async function applyConfigInFlight(p: ApplyInFlightPayload): Promise<{ marked: number }> {
  const n = Number(p.configVersion);
  if (!p.installId || !p.venueId || !Number.isInteger(n) || n < 1 || !Array.isArray(p.journeyKeys)) return { marked: 0 };
  const savedAt = new Date(Number(p.savedAt) || Date.now());
  let marked = 0;
  for (const journeyKey of p.journeyKeys) {
    const templateVersion = p.templateVersions?.[journeyKey];
    let last: QueryDocumentSnapshot | null = null;
    for (;;) {
      let q = activeInstancesQuery(p.venueId, journeyKey).select().limit(PAGE);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      marked += await db.runTransaction(async (tx) => {
        const snaps = await tx.getAll(...page.docs.map((d) => d.ref));
        let count = 0;
        for (const s of snaps) {
          if (!s.exists || s.get('status') !== 'active' || s.get('installId') !== p.installId) continue;
          if (typeof templateVersion === 'number' && Number(s.get('templateVersion')) !== templateVersion) continue;
          if (Number(s.get('configVersion')) >= n) continue;
          const pending = s.get('pendingConfigVersion');
          if (typeof pending === 'number' && pending >= n) continue;
          tx.update(s.ref, { pendingConfigVersion: n, pendingConfigAt: savedAt });
          count += 1;
        }
        return count;
      });
      if (page.size < PAGE) break;
      last = page.docs[page.docs.length - 1];
    }
  }
  return { marked };
}
