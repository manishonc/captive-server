/**
 * Everything the first release seeds (PRD §6.8, both prototypes):
 * 4 playbooks, 12 journey templates, platform wording, 7 questions, platform rules.
 */

import { ADAPTIVE_CONFIG_V1 } from './config';
import { QUESTIONS_V1 } from './questions';
import { RESTAURANT_JOURNEYS } from './journeysRestaurant';
import { STAY_JOURNEYS } from './journeysStay';
import { GUEST_INFO_JOURNEYS } from './journeysGuestInfo';
import { VARIANTS_V1 } from './variants';
import { PLAYBOOKS_V1 } from './playbooks';
import { RESTAURANT_SCAN_JOURNEYS_V2 } from './journeysRestaurantV2';
import { VARIANTS_SCAN } from './variantsScan';
import { PLAYBOOK_VERSIONS } from './playbooksV2';

export const SEED = {
  config: ADAPTIVE_CONFIG_V1,
  questions: QUESTIONS_V1,
  journeys: [...RESTAURANT_JOURNEYS, ...STAY_JOURNEYS, ...GUEST_INFO_JOURNEYS],
  variants: [...VARIANTS_V1, ...VARIANTS_SCAN],
  playbooks: PLAYBOOKS_V1,
  // PR S: later versions the seed publishes next to the v1s (seed/versionUpgrades.ts).
  journeyVersions: RESTAURANT_SCAN_JOURNEYS_V2,
  playbookVersions: PLAYBOOK_VERSIONS,
};

export type { JourneySeed, PlaybookSeed, VariantSeedInput } from './types';
export type { JourneyVersionSeed } from './journeysRestaurantV2';
export type { PlaybookVersionSeed } from './playbooksV2';
