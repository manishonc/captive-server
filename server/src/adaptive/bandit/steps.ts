/**
 * The bandit's send steps as the catalogue has them today (PR F1): a journey's newest published
 * definition, and a step's arm keys (its pool's active wordings, keyed on their content like the
 * send path). Used by the learner (only today's texts retire) and the admin numbers.
 */

import type { Catalogue } from '../service/catalogue';
import { journeyDefinitionSchema, type JourneyDefinition } from '../core/schemas';
import { variantArmKey } from '../core/runtime/banditKeys';

/** The newest published version's definition (never a draft), or null. */
export function publishedDefinition(cat: Catalogue, journeyKey: string): JourneyDefinition | null {
  const version = cat.templates.get(journeyKey)?.versions.find((v) => v.state === 'published');
  if (!version) return null;
  const parsed = journeyDefinitionSchema.safeParse(version.definition);
  return parsed.success ? parsed.data : null;
}

/** The wording pool of a send step, or null. */
export function stepPool(definition: JourneyDefinition, nodeId: string): string | null {
  const pool = (definition.nodes as Record<string, { type?: string; config?: { pool?: unknown } }>)[nodeId]?.config?.pool;
  return typeof pool === 'string' ? pool : null;
}

/** Today's arm keys of a step, or null when the step isn't in the published journey. */
export function currentArmKeys(cat: Catalogue, journeyKey: string, nodeId: string): string[] | null {
  const definition = publishedDefinition(cat, journeyKey);
  const pool = definition ? stepPool(definition, nodeId) : null;
  if (!pool) return null;
  return [...new Set(cat.variants.filter((v) => v.poolKey === pool && v.status === 'active').map((v) => variantArmKey(v)))];
}
