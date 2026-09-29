/**
 * Seed upgrades (PR F0) — the pure part: which earlier seed texts each upgrade replaces, and
 * what to do with a stored doc. `seed/upgrades.ts` applies them in Firestore; the reasons and
 * the rules are described there.
 */

import { COL } from '../store/collections';
import { contentChecksum } from '../core/checksum';
import { variantId, type SeedPlan } from './buildSeed';

export interface WordingUpgrade {
  /** Stable id, recorded on the doc once applied (`seedUpgrades`). */
  id: string;
  poolKey: string;
  letter: string;
  /** Hashes of every earlier seed text this replaces (sha256 of canonical `{ channels, locales }`). */
  replaces: string[];
  why: string;
}

/**
 * Earlier texts, from the seed as it was at each release: PR 1 (12dfb4e) and PR C (eecd913)
 * had the same wording; PR E (087ec81) changed only the Wi-Fi card. Checked by
 * tests/adaptiveSeedUpgrade.test.ts, which rebuilds the old texts from the current ones.
 */
export const WORDING_UPGRADES: WordingUpgrade[] = [
  {
    id: 'f0-gsm7-welcome-a',
    poolKey: 'welcome_offer',
    letter: 'A',
    replaces: ['8d3e178793b4d84b01ca206e36d73fd2cb34c0a4c4099ba39413b286cec74ab1'],
    why: 'SMS without 🎁 and "–" (GSM-7): 2 parts instead of 3 (EN) or 4 (DE); the emoji moves to the email',
  },
  {
    id: 'f0-gsm7-welcome-b',
    poolKey: 'welcome_offer',
    letter: 'B',
    replaces: ['79edbc9ea8f39143cf1238356e3deec7e52ba3b18ac66cc7d888c6e1fe27d969'],
    why: 'SMS without "–" (GSM-7), and no "next visit" twice with the 10% offer',
  },
  {
    id: 'f0-gsm7-book-direct',
    poolKey: 'book_direct',
    letter: 'A',
    replaces: ['c81c200c8d0e9f96bfda107c932ec63d51602b909ddca4ce5c662a0b5f777a4c'],
    why: 'German SMS without "–" (GSM-7): 2 parts instead of 3',
  },
  {
    id: 'f0-gsm7-checkout-a',
    poolKey: 'stay_checkout',
    letter: 'A',
    replaces: ['d20587a4143dac00c20b5e879cafefe4000f5a17d1707307ecd06fb454fe2319'],
    why: 'SMS without "–" (GSM-7): 2 parts instead of 3',
  },
  {
    id: 'f0-wifi-card',
    poolKey: 'wifi_info',
    letter: 'A',
    replaces: ['0bbd9ad1fe00a5ea4249a8b0c129f8ef42929c1ccea852cf17d3bbc871953b41', '063cf91f9921fec3dffb7dffe5de221bcc5feb49952d7e9f8e2a858336a9d92f'],
    why: 'the venue-neutral wording from PR E (where it was never hand-edited) and a preheader without "house info"',
  },
];

export type UpgradeDecision = 'upgrade' | 'current' | 'edited' | 'missing';

/** Every upgrade entry for one platform wording, and today's seed doc for it. */
export interface UpgradeTarget {
  poolKey: string;
  letter: string;
  upgrades: WordingUpgrade[];
  data: Record<string, unknown>;
}

/** The hash of a stored (or seed) wording's text, as the seed computes `contentHash`. */
export function wordingHash(doc: { channels?: unknown; locales?: unknown }): string {
  return contentChecksum({ channels: doc.channels ?? {}, locales: doc.locales ?? {} });
}

/**
 * Pure: what to do with one stored doc. The stored text is hashed again (the stored
 * `contentHash` field is never trusted). An earlier seed text that one of the wording's
 * entries replaces → `upgrade`. (The apply step then checks the doc's `history/`: an old text
 * that was already replaced once on this doc was put back on purpose, and stays.)
 */
export function upgradeDecision(
  stored: Record<string, unknown> | null,
  target: Pick<UpgradeTarget, 'poolKey' | 'letter' | 'upgrades'>,
  targetHash: string,
): { decision: UpgradeDecision; storedHash: string | null; upgradeId: string | null } {
  if (!stored) return { decision: 'missing', storedHash: null, upgradeId: null };
  // Only the platform wording this id stands for; a venue's own wording is never touched.
  if (stored.scope !== 'platform' || stored.poolKey !== target.poolKey || stored.letter !== target.letter) {
    return { decision: 'edited', storedHash: null, upgradeId: null };
  }
  const storedHash = wordingHash(stored);
  if (storedHash === targetHash) return { decision: 'current', storedHash, upgradeId: null };
  const entry = target.upgrades.find((u) => u.replaces.includes(storedHash));
  if (!entry) return { decision: 'edited', storedHash, upgradeId: null };
  return { decision: 'upgrade', storedHash, upgradeId: entry.id };
}

/**
 * Today's seed doc for each wording that has upgrade entries (several entries for one wording
 * are grouped: each replaces its own earlier texts), or the problems that stop the seed.
 */
export function upgradeTargets(plan: SeedPlan): { targets: Map<string, UpgradeTarget>; problems: string[] } {
  const docs = new Map(plan.units.flatMap((u) => u.docs).filter((d) => d.path[0] === COL.variants).map((d) => [d.path[1], d.data]));
  const targets = new Map<string, UpgradeTarget>();
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const upgrade of WORDING_UPGRADES) {
    if (ids.has(upgrade.id)) problems.push(`Upgrade ${upgrade.id}: the id is used twice`);
    ids.add(upgrade.id);
    const id = variantId(upgrade.poolKey, upgrade.letter);
    const data = docs.get(id);
    if (!data) {
      problems.push(`Upgrade ${upgrade.id}: the seed has no wording ${upgrade.poolKey}/${upgrade.letter}`);
      continue;
    }
    if (upgrade.replaces.includes(String(data.contentHash))) {
      problems.push(`Upgrade ${upgrade.id}: it would replace the current seed text with itself`);
      continue;
    }
    const target = targets.get(id) ?? { poolKey: upgrade.poolKey, letter: upgrade.letter, upgrades: [], data };
    if (target.upgrades.some((u) => u.replaces.some((h) => upgrade.replaces.includes(h)))) {
      problems.push(`Upgrade ${upgrade.id}: another entry for ${upgrade.poolKey}/${upgrade.letter} already replaces one of its texts`);
      continue;
    }
    target.upgrades.push(upgrade);
    targets.set(id, target);
  }
  return { targets, problems };
}
