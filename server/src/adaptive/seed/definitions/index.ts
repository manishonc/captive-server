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
import { welcomeSecondVisitV2 } from './journeysWelcomeV2';
import { PLAYBOOK_VERSIONS_V3 } from './playbooksV3';
import { REFERRAL_JOURNEYS } from './journeysReferral';
import { VARIANTS_REFERRAL } from './variantsReferral';
import { PLAYBOOK_VERSIONS_V4 } from './playbooksV4';

export const SEED = {
  config: ADAPTIVE_CONFIG_V1,
  questions: QUESTIONS_V1,
  // PR A7: Bring a friend and the Friend reward, new templates (v1).
  journeys: [...RESTAURANT_JOURNEYS, ...STAY_JOURNEYS, ...GUEST_INFO_JOURNEYS, ...REFERRAL_JOURNEYS],
  variants: [...VARIANTS_V1, ...VARIANTS_SCAN, ...VARIANTS_REFERRAL],
  playbooks: PLAYBOOKS_V1,
  // PR S: later versions the seed publishes next to the v1s (seed/versionUpgrades.ts), in order:
  // a playbook version comes after the one before it and after the journey versions it pins.
  // Then Welcome → come back v2 and the v3 playbooks that pin it (open until the offer ends).
  journeyVersions: [...RESTAURANT_SCAN_JOURNEYS_V2, welcomeSecondVisitV2],
  // PR A7: Restaurant growth v4 adds Bring a friend.
  playbookVersions: [...PLAYBOOK_VERSIONS, ...PLAYBOOK_VERSIONS_V3, ...PLAYBOOK_VERSIONS_V4],
};

export type { JourneySeed, PlaybookSeed, VariantSeedInput } from './types';
export type { JourneyVersionSeed } from './journeysRestaurantV2';
export type { PlaybookVersionSeed } from './playbooksV2';
