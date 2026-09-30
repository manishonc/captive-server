/**
 * `GET /admin/journeys/:key/bandit` (PR F1): the admin Journeys view's numbers. Per marketing
 * send step of the journey's published version, every wording and slot arm summed over all
 * venues — live, from the venue docs (the pooled docs lag up to a day) — matched to today's
 * wordings by their content (an arm whose text no longer exists shows as an earlier text), with
 * the chance of being best (the pooled data from the pick's start for a new arm, 2,000 seeded draws) and
 * the venues where a wording retired. Counts only: no guest data. Read only.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { notFound } from '../api/errors';
import { loadCatalogue } from './catalogue';
import { readEngineSettings } from '../store/engineSettings';
import { FLAT_PRIOR, fallbackPrior, probabilityBest, SLOT_NAMES, stepMean, POOL_MIN_CLOSED, type ArmBlock, type ArmData, type Segment } from '../core/runtime/bandit';
import { variantArmKey } from '../core/runtime/banditKeys';
import { poolFrom } from '../core/runtime/banditLearn';
import { toJson } from '../store/serialize';
import { publishedDefinition } from '../bandit/steps';

interface ArmRow {
  arm: string;
  variantId: string | null;
  letter: string | null;
  status: string | null;
  /** The arm's text is no longer any active wording's (edited since). */
  earlierText: boolean;
  pulls: number;
  closed: number;
  clicks: number;
  visits: number;
  ratings: number;
  unsubs: number;
  /** a / (a + b) of the pooled data with the flat prior (null before the first finished send). */
  rate: number | null;
  chanceBest: number | null;
  /** Venues where the learner retired this wording (it is no longer sent there). */
  retiredAt: number;
}

function row(arm: string, d: ArmData | undefined, extra: Partial<ArmRow>): ArmRow {
  const a = Number(d?.a) || 0;
  const b = Number(d?.b) || 0;
  const closed = Number(d?.closed) || 0;
  return {
    arm,
    variantId: null,
    letter: null,
    status: null,
    earlierText: false,
    pulls: Number(d?.pulls) || 0,
    closed,
    clicks: Number(d?.rewards?.click) || 0,
    visits: Number(d?.rewards?.visit) || 0,
    ratings: Number(d?.rewards?.rating) || 0,
    unsubs: Number(d?.penalties?.unsub) || 0,
    rate: closed ? Math.round(((a + FLAT_PRIOR.a0) / (a + b + FLAT_PRIOR.a0 + FLAT_PRIOR.b0)) * 1000) / 1000 : null,
    chanceBest: null,
    retiredAt: 0,
    ...extra,
  };
}

function withChance(rows: ArmRow[], data: Record<string, ArmData> | undefined, seed: string): ArmRow[] {
  // Only what a pick can choose: today's active wordings (slots have no status), not a paused one with old sends.
  const live = rows.filter((r) => !r.earlierText && (r.status === null || r.status === 'active'));
  // Nothing sent at this step yet: a chance would be noise around an even split.
  if (live.length < 2 || live.every((r) => r.pulls === 0)) return rows;
  // Every arm starts where the pick starts a new one (today's wordings' mean, else flat 5 %), plus its pooled data.
  const prior = fallbackPrior(stepMean(data, POOL_MIN_CLOSED, live.map((r) => r.arm)));
  const best = probabilityBest(
    live.map((r) => ({ key: r.arm, a: prior.a0 + (Number(data?.[r.arm]?.a) || 0), b: prior.b0 + (Number(data?.[r.arm]?.b) || 0) })),
    2000,
    seed,
  );
  return rows.map((r) => (r.arm in best ? { ...r, chanceBest: best[r.arm] } : r));
}

export async function journeyBanditNumbers(journeyKey: string) {
  const cat = await loadCatalogue();
  if (!cat.templates.get(journeyKey)) throw notFound('No journey with that key.');
  // The published version (a draft may have steps no guest is in).
  const definition = publishedDefinition(cat, journeyKey);
  if (!definition) throw notFound('That journey has no published version.');
  const [snap, settings] = await Promise.all([db.collection(COL.banditArms).where('journeyKey', '==', journeyKey).get(), readEngineSettings()]);
  const venueDocs = snap.docs
    .filter((d) => d.get('scope') === 'venue')
    .map((d) => ({ journeyKey, nodeId: String(d.get('nodeId')), segments: (d.get('segments') ?? {}) as Partial<Record<Segment | 'all', ArmBlock>>, updatedAt: d.get('updatedAt') }));
  const pools = poolFrom(venueDocs);
  // Per step and wording arm: the venues where it is retired.
  const retired = new Map<string, number>();
  for (const d of venueDocs) {
    for (const [arm, v] of Object.entries(d.segments.all?.variant ?? {})) {
      if (v?.retired === true) retired.set(`${d.nodeId}\u0000${arm}`, (retired.get(`${d.nodeId}\u0000${arm}`) ?? 0) + 1);
    }
  }
  const lastLearned = venueDocs.map((d) => toJson(d.updatedAt) as string | null).filter(Boolean).sort().pop() ?? null;

  const steps = Object.entries(definition.nodes as Record<string, { type?: string; config?: { purpose?: string; pool?: string; timing?: { mode?: string; default?: string } } }>)
    .filter(([, n]) => n.type === 'send' && n.config?.purpose === 'marketing' && typeof n.config.pool === 'string')
    .map(([nodeId, n]) => {
      const pool = pools.get(`${journeyKey}\u0000${nodeId}`);
      const all = pool?.segments.all;
      const wordings = cat.variants.filter((v) => v.poolKey === n.config!.pool).sort((x, y) => x.letter.localeCompare(y.letter));
      const known = new Set<string>();
      const rows: ArmRow[] = wordings.map((v) => {
        const arm = variantArmKey(v);
        known.add(arm);
        return row(arm, all?.variant?.[arm], { variantId: v.id, letter: v.letter, status: v.status, retiredAt: retired.get(`${nodeId}\u0000${arm}`) ?? 0 });
      });
      for (const [arm, d] of Object.entries(all?.variant ?? {})) if (!known.has(arm)) rows.push(row(arm, d, { earlierText: true, retiredAt: retired.get(`${nodeId}\u0000${arm}`) ?? 0 }));
      const slotRows = n.config!.timing?.mode === 'slot' ? SLOT_NAMES.map((slot) => row(slot, all?.slot?.[slot], {})) : [];
      return {
        nodeId,
        pool: n.config!.pool!,
        timing: n.config!.timing?.mode ?? 'now',
        defaultSlot: n.config!.timing?.default ?? null,
        venues: pool?.venues ?? 0,
        wordings: withChance(rows.filter((r) => r.status === 'active' || r.earlierText || r.pulls > 0), all?.variant, `admin:${journeyKey}:${nodeId}:v`),
        slots: withChance(slotRows, all?.slot, `admin:${journeyKey}:${nodeId}:s`),
      };
    });

  const b = settings.bandit ?? { mode: 'off', accounts: {} };
  return {
    journeyKey,
    bandit: { mode: b.mode, accountsOn: Object.values(b.accounts).filter((m) => m === 'on').length, accountsOff: Object.values(b.accounts).filter((m) => m === 'off').length },
    lastLearnedAt: lastLearned,
    steps,
  };
}
