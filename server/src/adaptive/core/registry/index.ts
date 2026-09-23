/**
 * The registries: where new step types, triggers, slot types and merge fields
 * plug in (architecture v4 §3). Adding one is a new entry in the matching file;
 * the validators and the engine read these maps and never name concrete types.
 */

export { NODE_CONTRACTS, getNodeContract } from './nodes';
export type { NodeContract, NodeDescribeContext, NodeDescription } from './nodes';
export { TRIGGER_CONTRACTS, getTriggerContract, describeTrigger, KNOWN_EVENTS } from './triggers';
export type { TriggerContract } from './triggers';
export { checkSlotValue, slotStartValue } from './slots';
export type { SlotCheckContext } from './slots';
export { parseMergeExpressions, checkMergeField, canonicalField, LEGACY_ALIASES, KNOWN_FILTERS } from './mergeFields';
export type { MergeExpression, MergeFilter } from './mergeFields';
