/**
 * Restaurant growth v3 and Local business v3: v2 with Welcome → come back v2
 * (journeysWelcomeV2.ts), which stays open until its offer ends so a guest who comes back
 * while it is valid counts. Published next to v2 by the seed (seed/versionUpgrades.ts); a
 * venue on an older version moves to v3 the next time its owner saves.
 */

import { localBusinessV2, restaurantGrowthV2, type PlaybookVersionSeed } from './playbooksV2';
import type { PlaybookSeed } from './types';

function withWelcomeV2(content: PlaybookSeed['content']): PlaybookSeed['content'] {
  return {
    ...content,
    journeys: content.journeys.map((j) => (j.journeyKey === 'welcome_second_visit' ? { ...j, templateVersion: 2 } : j)),
  };
}

const CHANGELOG = 'Welcome → come back stays open until its offer ends: a guest who comes back while it is valid counts and gets the thank-you';

export const restaurantGrowthV3: PlaybookVersionSeed = {
  ...restaurantGrowthV2,
  version: 3,
  changelog: CHANGELOG,
  content: withWelcomeV2(restaurantGrowthV2.content),
};

export const localBusinessV3: PlaybookVersionSeed = {
  ...localBusinessV2,
  version: 3,
  changelog: CHANGELOG,
  content: withWelcomeV2(localBusinessV2.content),
};

export const PLAYBOOK_VERSIONS_V3: PlaybookVersionSeed[] = [restaurantGrowthV3, localBusinessV3];
