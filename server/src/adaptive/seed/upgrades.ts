/**
 * Seed upgrades (PR F0): carry a wording fix into a database where the seed already ran.
 *
 * The seed only creates missing docs, so an edited text in `definitions/variants.ts` never
 * reaches a database that already has the doc — until now that took a hand edit in the
 * Firestore console. An upgrade names one platform wording (pool + letter) and the exact
 * earlier seed texts it replaces, as the hash of `{ channels, locales }` (the same formula as
 * the stored `contentHash`). At boot, after the create-only pass, each stored doc's text is
 * hashed again — the stored `contentHash` field is never trusted, a hand edit leaves it
 * stale — and the doc gets the current seed text only when it still holds one of those
 * earlier seed texts:
 *
 *   stored text = an earlier seed text → rewritten (channels, locales, mergeFieldsUsed,
 *                                        contentHash), the old text kept in `history/` —
 *                                        unless it is there already (put back on purpose)
 *   stored text = the current seed text → nothing to do
 *   anything else (edited by hand)      → left alone, reported
 *
 * The variant id stays the same (ids come from pool + letter), so running journeys keep
 * pointing at it and pick up the new text within the catalogue's 30 s cache.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, HISTORY } from '../store/collections';
import { stripUndefined } from '../store/serialize';
import { SEED_ACTOR, type SeedPlan } from './buildSeed';
import { upgradeDecision, upgradeTargets } from './wordingUpgrades';

export { WORDING_UPGRADES, upgradeDecision, upgradeTargets, wordingHash, type UpgradeDecision, type UpgradeTarget, type WordingUpgrade } from './wordingUpgrades';

export interface UpgradeResult {
  upgraded: string[];
  current: string[];
  keptEdited: string[];
  failed: Array<{ label: string; error: string }>;
  problems: string[];
}

export async function applyWordingUpgrades(plan: SeedPlan, opts: { dryRun?: boolean; now?: Date } = {}): Promise<UpgradeResult> {
  const now = opts.now ?? new Date();
  const result: UpgradeResult = { upgraded: [], current: [], keptEdited: [], failed: [], problems: [] };
  const { targets, problems } = upgradeTargets(plan);
  result.problems.push(...problems);
  for (const [id, target] of targets) {
    const label = `Wording ${target.poolKey}/${target.letter}`;
    const targetHash = String(target.data.contentHash);
    try {
      const d = await db.runTransaction(async (tx) => {
        const ref = db.collection(COL.variants).doc(id);
        const snap = await tx.get(ref);
        const stored = snap.exists ? (snap.data() as Record<string, unknown>) : null;
        let decision = upgradeDecision(stored, target, targetHash);
        const historyRef = decision.storedHash ? ref.collection(HISTORY).doc(decision.storedHash.slice(0, 32)) : null;
        // This text was replaced on this doc once already: someone put it back on purpose. It stays.
        if (decision.decision === 'upgrade' && historyRef && (await tx.get(historyRef)).exists) {
          decision = { ...decision, decision: 'edited', upgradeId: null };
        }
        if (decision.decision === 'upgrade' && !opts.dryRun) {
          tx.set(historyRef!, {
            channels: stored!.channels ?? {},
            locales: stored!.locales ?? {},
            contentHash: decision.storedHash,
            replacedBy: decision.upgradeId,
            replacedAt: now,
          });
          tx.update(ref, {
            channels: stripUndefined(target.data.channels as Record<string, unknown>),
            locales: stripUndefined((target.data.locales ?? {}) as Record<string, unknown>),
            mergeFieldsUsed: target.data.mergeFieldsUsed,
            contentHash: targetHash,
            seedUpgrades: FieldValue.arrayUnion(decision.upgradeId),
            updatedAt: now,
            updatedBy: SEED_ACTOR,
          });
        }
        return decision;
      });
      if (d.decision === 'upgrade') result.upgraded.push(`${label} (${d.upgradeId})`);
      else if (d.decision === 'current') result.current.push(label);
      else if (d.decision === 'edited') result.keptEdited.push(`${label} (stored text ${d.storedHash ? d.storedHash.slice(0, 12) : 'not this wording'})`);
      // 'missing': the create-only pass just made it from the current text, or it failed there (reported).
    } catch (err) {
      result.failed.push({ label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
