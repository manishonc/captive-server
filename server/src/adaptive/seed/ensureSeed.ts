/**
 * Creates the seeded playbooks, journeys, wording, questions and platform rules
 * if they are missing. Runs once at boot (non-blocking) and from the CLI.
 *
 * Only ever `create()`s: a unit whose anchor doc exists is skipped, so admin
 * edits are never overwritten, and two replicas booting at once are safe (the
 * second create fails with ALREADY_EXISTS and is counted as skipped).
 */

import { db } from '../../firebase';
import { stripUndefined } from '../store/serialize';
import { buildSeedPlan } from './buildSeed';

export interface SeedResult {
  created: string[];
  skipped: string[];
  failed: Array<{ label: string; error: string }>;
  problems: string[];
}

export async function ensureAdaptiveSeed(opts: { dryRun?: boolean } = {}): Promise<SeedResult> {
  const plan = buildSeedPlan(new Date());
  const result: SeedResult = { created: [], skipped: [], failed: [], problems: plan.problems };
  if (plan.problems.length) return result;

  for (const unit of plan.units) {
    try {
      const anchor = await db.doc(unit.anchor.join('/')).get();
      if (anchor.exists) {
        result.skipped.push(unit.label);
        continue;
      }
      if (opts.dryRun) {
        result.created.push(unit.label);
        continue;
      }
      const batch = db.batch();
      for (const doc of unit.docs) batch.create(db.doc(doc.path.join('/')), stripUndefined(doc.data));
      await batch.commit();
      result.created.push(unit.label);
    } catch (err: any) {
      if (err?.code === 6 || /already exists/i.test(String(err?.message))) {
        result.skipped.push(unit.label);
      } else {
        result.failed.push({ label: unit.label, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return result;
}

/** Boot hook: never blocks startup and never throws. */
export function startAdaptiveSeed(): void {
  ensureAdaptiveSeed()
    .then((r) => {
      if (r.problems.length) {
        console.error(`[ADAPTIVE SEED] Not seeding — the definitions have problems:\n  ${r.problems.join('\n  ')}`);
        return;
      }
      if (r.created.length) console.log(`[ADAPTIVE SEED] Created ${r.created.length}: ${r.created.join(', ')}`);
      if (r.failed.length) console.error('[ADAPTIVE SEED] Failed:', r.failed);
    })
    .catch((err) => console.error('[ADAPTIVE SEED] Seed run failed (the server keeps running):', err));
}
