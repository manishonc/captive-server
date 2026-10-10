/**
 * Restaurant growth v4 (PR A7): v3 plus Bring-a-friend — the invite (`bring_a_friend`, off by
 * default) and the regular's reward (`friend_reward`, always on: it only runs when a friend uses
 * a code, so the invite's promise of a reward can't be switched off by mistake). Both offers
 * default to 10% off, as in the spec's example ("they get 10%, you get 10%"). Published next to
 * v3 by the seed (seed/versionUpgrades.ts); a venue on an older version moves to v4 the next time
 * its owner saves. Local business stays at v3 (Playbook C is A1 + A2 + A5 in the spec).
 */

import { restaurantGrowthV3 } from './playbooksV3';
import type { PlaybookVersionSeed } from './playbooksV2';

const v3 = restaurantGrowthV3.content;

export const restaurantGrowthV4: PlaybookVersionSeed = {
  ...restaurantGrowthV3,
  version: 4,
  changelog: 'Bring a friend: regulars get a code to share after their 3rd visit; a friend who signs up with it gets your offer, the regular a reward (up to 3 friends)',
  content: {
    ...v3,
    journeys: [
      ...v3.journeys,
      { journeyKey: 'bring_a_friend', templateVersion: 1, defaultEnabled: false, required: false, priority: 15, slotDefaults: { friend_offer: 'ten_pct' } },
      { journeyKey: 'friend_reward', templateVersion: 1, defaultEnabled: true, required: true, priority: 55, slotDefaults: { offer: 'ten_pct' } },
    ],
    // Messages a month per guest who said yes: few reach a 3rd visit, fewer bring a friend.
    estimateHints: v3.estimateHints
      ? {
          ...v3.estimateHints,
          avgTouchesPerGuest: { ...(v3.estimateHints.avgTouchesPerGuest ?? {}), bring_a_friend: 0.2, friend_reward: 0.02 },
        }
      : undefined,
  },
};

export const PLAYBOOK_VERSIONS_V4: PlaybookVersionSeed[] = [restaurantGrowthV4];
