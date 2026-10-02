/**
 * The models the AI agents may use (PR F2a): the allow-list the admin picks from and the price
 * table each run's cost is worked out with. Pure.
 *
 * Ids are the Vercel AI Gateway's (the cms relay forwards to its Anthropic-compatible
 * `/v1/messages`); the cms relay keeps the same allow-list. Prices are Anthropic's list prices
 * in USD per million tokens; cache writes are the 5-minute kind (1.25 × input). A run stores
 * the cost it was charged at, so a price change here never rewrites old runs.
 */

export interface ModelInfo {
  id: string;
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

export const MODELS: Readonly<Record<string, ModelInfo>> = Object.freeze({
  'anthropic/claude-opus-5.5': {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5',
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 5,
  },
  'anthropic/claude-sonnet-5.5': {
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5',
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
  },
});

export const MODEL_IDS: readonly string[] = Object.freeze(Object.keys(MODELS));

export function isKnownModel(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODELS, id);
}

/** Token counts as the API reports them: `input` excludes the cached parts. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: ModelUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/**
 * The cost of one call in micro-USD (1 USD per million tokens = 1 micro-USD per token), rounded
 * up so many small calls never add up to less than they cost. Thinking is billed as output.
 */
export function costMicroUsd(usage: ModelUsage, model: ModelInfo): number {
  const raw =
    count(usage.inputTokens) * model.inputUsdPerMTok +
    count(usage.outputTokens) * model.outputUsdPerMTok +
    count(usage.cacheReadTokens) * model.cacheReadUsdPerMTok +
    count(usage.cacheWriteTokens) * model.cacheWriteUsdPerMTok;
  return Math.ceil(raw - 1e-9);
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** USD to the micro-dollar (a Test connection costs a fraction of a cent); screens format it. */
export function microToUsd(micro: number): number {
  return Math.round(Number(micro) || 0) / 1_000_000;
}

/** The prices a run was charged at (stored on the run). */
export function priceOf(model: ModelInfo): Omit<ModelInfo, 'label'> {
  const { label: _label, ...price } = model;
  return price;
}
