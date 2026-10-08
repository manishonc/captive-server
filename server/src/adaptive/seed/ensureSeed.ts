/**
 * Creates the seeded playbooks, journeys, wording, questions and platform rules
 * if they are missing. Runs once at boot (non-blocking) and from the CLI.
 *
 * Only ever `create()`s: a unit whose anchor doc exists is skipped, so admin
 * edits are never overwritten, and two replicas booting at once are safe (the
 * second create fails with ALREADY_EXISTS and is counted as skipped).
 * PR F0: after that pass the seed upgrades (seed/upgrades.ts) may rewrite a platform wording
 * doc that still holds one of the earlier seed texts they list; a doc edited by hand never is.
 */

import { db } from '../../firebase';
import { stripUndefined } from '../store/serialize';
import { buildSeedPlan } from './buildSeed';
import { invalidateCatalogue } from '../service/catalogue';
import { applyWordingUpgrades, upgradeTargets } from './upgrades';
import { applyVersionUpgrades } from './versionUpgrades';

export interface SeedResult {
  created: string[];
  skipped: string[];
  failed: Array<{ label: string; error: string }>;
  problems: string[];
  /** PR F0 seed upgrades (seed/upgrades.ts): wording docs rewritten to the current seed text. */
  upgraded?: string[];
  /** …and wording docs left alone because they were edited by hand. */
  keptEdited?: string[];
  /** PR S: later versions published next to the existing ones (seed/versionUpgrades.ts)… */
  versionsPublished?: string[];
  /** …and those left alone (an admin's draft or version). */
  versionsKept?: string[];
}

export async function ensureAdaptiveSeed(opts: { dryRun?: boolean } = {}): Promise<SeedResult> {
  const plan = buildSeedPlan(new Date());
  const result: SeedResult = { created: [], skipped: [], failed: [], problems: plan.problems };
  if (plan.problems.length) return result;
  // PR F0: a broken upgrade entry is a definition problem too: stop before anything is written.
  const upgradeProblems = upgradeTargets(plan).problems;
  if (upgradeProblems.length) {
    result.problems.push(...upgradeProblems);
    return result;
  }

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
  // PR F0: wording fixes for docs an earlier release of the seed created (create-only above
  // skipped them). Only a doc that still holds an earlier seed text is rewritten.
  const upgrades = await applyWordingUpgrades(plan, { dryRun: opts.dryRun });
  result.upgraded = upgrades.upgraded;
  result.keptEdited = upgrades.keptEdited;
  result.failed.push(...upgrades.failed);
  result.problems.push(...upgrades.problems);
  // PR S: the runnable scan journeys (v2) and the playbook versions that pin them.
  const versions = await applyVersionUpgrades(plan, { dryRun: opts.dryRun });
  result.versionsPublished = versions.published;
  result.versionsKept = versions.kept;
  result.failed.push(...versions.failed);
  if (versions.published.length && !opts.dryRun) invalidateCatalogue();
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
      if (r.upgraded?.length) console.log(`[ADAPTIVE SEED] Upgraded ${r.upgraded.length}: ${r.upgraded.join(', ')}`);
      if (r.keptEdited?.length) console.warn(`[ADAPTIVE SEED] Not upgraded (edited by hand): ${r.keptEdited.join(', ')}`);
      if (r.versionsPublished?.length) console.log(`[ADAPTIVE SEED] Published ${r.versionsPublished.length}: ${r.versionsPublished.join(', ')}`);
      if (r.versionsKept?.length) console.warn(`[ADAPTIVE SEED] Not published: ${r.versionsKept.join(', ')}`);
    })
    .catch((err) => console.error('[ADAPTIVE SEED] Seed run failed (the server keeps running):', err));
}
