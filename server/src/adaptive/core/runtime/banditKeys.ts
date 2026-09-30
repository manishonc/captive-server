/**
 * A wording's bandit arm (PR F1): its content as loaded — `v:` + 12 hex of the same hash the
 * seed upgrade uses (`seed/wordingUpgrades.ts` `wordingHash`), never the stored `contentHash`,
 * which a hand edit leaves stale. An edited text is a new arm. Pure (node crypto only).
 */

import { contentChecksum } from '../checksum';

export function variantArmKey(v: { channels?: unknown; locales?: unknown }): string {
  return `v:${contentChecksum({ channels: v.channels ?? {}, locales: v.locales ?? {} }).slice(0, 12)}`;
}
