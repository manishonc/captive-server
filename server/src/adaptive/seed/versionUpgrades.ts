/**
 * PR S: publishes later seed versions next to the existing ones at boot — the runnable v2 of the
 * four restaurant scan journeys, then Restaurant growth v2 and Local business v2 that pin them.
 * Publishing never changes a published version (AU-3): a new version doc is created and the
 * header's `latestVersion` / `publishedVersion` move to it. A journey's header also takes the
 * version's name and description (Slow-time filler), and its availability (Available) only while
 * the header is still the seed's own — an admin's switch is left as it is.
 *
 * Only when the database is exactly one step behind: the version doc is missing and the header's
 * latest and published version are the one before. Anything else — an admin's draft, a version an
 * admin published, a header the create pass couldn't make — is left alone and reported. A
 * playbook version is published only when every template version it pins exists. Idempotent:
 * the next boot finds the version doc and does nothing.
 */

import { db } from '../../firebase';
import { VERSIONS } from '../store/collections';
import { journeyTemplateRef, playbookRef } from '../store/definitions';
import { stripUndefined } from '../store/serialize';
import { SEED_ACTOR, versionDecision, type SeedPlan, type VersionDecision, type VersionTarget } from './buildSeed';

export { versionDecision } from './buildSeed';

export interface VersionUpgradeResult {
  published: string[];
  current: string[];
  kept: string[];
  failed: Array<{ label: string; error: string }>;
}

type Decision = VersionDecision;

const headerRefOf = (t: VersionTarget) => (t.kind === 'journey' ? journeyTemplateRef(t.key) : playbookRef(t.key));

export async function applyVersionUpgrades(plan: Pick<SeedPlan, 'versions'>, opts: { dryRun?: boolean; now?: Date } = {}): Promise<VersionUpgradeResult> {
  const now = opts.now ?? new Date();
  const result: VersionUpgradeResult = { published: [], current: [], kept: [], failed: [] };
  for (const target of plan.versions) {
    try {
      const decision = await db.runTransaction(async (tx): Promise<Decision | 'pins_missing'> => {
        const headerRef = headerRefOf(target);
        const versionRef = headerRef.collection(VERSIONS).doc(String(target.version));
        const pinRefs = (target.pins ?? []).map((p) => journeyTemplateRef(p.journeyKey).collection(VERSIONS).doc(String(p.templateVersion)));
        const [headSnap, versionSnap, ...pinSnaps] = await Promise.all([tx.get(headerRef), tx.get(versionRef), ...pinRefs.map((r) => tx.get(r))]);
        const d = versionDecision(headSnap.exists ? (headSnap.data() as Record<string, unknown>) : null, versionSnap.exists, target);
        if (d !== 'publish') return d;
        if (pinSnaps.some((s) => !s.exists)) return 'pins_missing';
        if (opts.dryRun) return 'publish';
        tx.create(versionRef, stripUndefined({ ...target.doc, createdAt: now, createdBy: SEED_ACTOR, updatedAt: now, updatedBy: SEED_ACTOR, publishedAt: now, publishedBy: SEED_ACTOR }));
        // A journey's availability is the admin's switch: the seed only sets it while nobody else
        // has touched the header (a fresh database); an admin's "coming soon" stays.
        const header = { ...target.header };
        if ('availability' in header && headSnap.get('updatedBy') !== SEED_ACTOR) delete header.availability;
        tx.update(headerRef, stripUndefined({ ...header, latestVersion: target.version, publishedVersion: target.version, updatedAt: now, updatedBy: SEED_ACTOR }));
        return 'publish';
      });
      if (decision === 'publish') result.published.push(target.label);
      else if (decision === 'current') result.current.push(target.label);
      else if (decision === 'pins_missing') result.kept.push(`${target.label} (a journey version it needs is missing)`);
      else if (decision === 'kept') result.kept.push(`${target.label} (the stored versions moved on: an admin's draft or version)`);
      // 'missing': the create pass couldn't make the header (reported there).
    } catch (err) {
      result.failed.push({ label: target.label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
