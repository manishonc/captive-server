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

export const SEED = {
  config: ADAPTIVE_CONFIG_V1,
  questions: QUESTIONS_V1,
  journeys: [...RESTAURANT_JOURNEYS, ...STAY_JOURNEYS, ...GUEST_INFO_JOURNEYS],
  variants: VARIANTS_V1,
  playbooks: PLAYBOOKS_V1,
};

export type { JourneySeed, PlaybookSeed, VariantSeedInput } from './types';
