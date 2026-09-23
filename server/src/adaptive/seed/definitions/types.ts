/**
 * Shapes the seed definitions are written in. They are the *input* types of the
 * core schemas (defaults may be left out); the seed parses every definition with
 * the same schemas and checks it with the same validators before writing.
 */

import type { z } from 'zod';
import type {
  I18n,
  journeyDefinitionSchema,
  journeyTemplateHeaderSchema,
  playbookContentSchema,
  variantSeedSchema,
} from '../../core/schemas';

export type JourneyDefinitionInput = z.input<typeof journeyDefinitionSchema>;

export interface JourneySeed {
  header: z.input<typeof journeyTemplateHeaderSchema>;
  changelog: string;
  definition: JourneyDefinitionInput;
}

export interface PlaybookSeed {
  key: string;
  sortOrder: number;
  changelog: string;
  content: z.input<typeof playbookContentSchema>;
}

export type VariantSeedInput = z.input<typeof variantSeedSchema>;

/** `t('Hello', 'Hallo')` → `{ en: 'Hello', de: 'Hallo' }`. */
export function t(en: string, de?: string): I18n {
  return de ? { en, de } : { en };
}
