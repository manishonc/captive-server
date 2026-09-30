/**
 * The fake model for the local emulator stack and the tests (PR F2a) — used whenever the sandbox
 * is on (ADAPTIVE_SANDBOX=1 + FIRESTORE_EMULATOR_HOST, engine/clock.ts), exactly like the sandbox
 * send adapters: it replaces the real client, it never sits beside it.
 *
 *  - Every request is written to `CaptivePortal_AdaptiveSandboxModelCalls/{runId}_{n}` — the
 *    system text, the user turn (instructions + package) and the settings — so a test or a person
 *    in the Emulator UI can check that no personal data would have left.
 *  - It answers with the job's valid answer, unless an answer is queued for the agent
 *    (`POST /dev/model-answer`): a given JSON or text, or a fault — refusal, max_tokens (cut-off
 *    JSON), bad_json, rate_limit (429), server_error (500), timeout, unauthorized (401),
 *    unknown_model (404), or slow (answers after `ms` — or times out at the call's `timeoutMs`,
 *    like the real client).
 *  - Token counts are made up from the text lengths (so costs and budgets can be exercised).
 */

import { logSandboxCall, takeSandboxAnswer, type SandboxAnswer } from '../store/agents';
import { ModelError, type ModelClient, type ModelReply, type ModelRequest } from './modelClient';

const tokensOf = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function reply(req: ModelRequest, stopReason: string, text: string, refusalCategory: string | null = null): ModelReply {
  return {
    stopReason,
    text,
    // Thinking is billed as output: a flat 40 tokens of it on top of the text.
    usage: { inputTokens: tokensOf(req.system) + tokensOf(req.user), outputTokens: tokensOf(text) + 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
    refusalCategory,
    model: req.model,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(t);
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

let calls = 0;

export function sandboxModel(): ModelClient {
  return {
    name: 'sandbox',
    async call(req, signal) {
      calls += 1;
      await logSandboxCall(`${req.runId}_${calls}`, {
        runId: req.runId,
        agentKey: req.agentKey,
        model: req.model,
        effort: req.effort,
        maxOutputTokens: req.maxOutputTokens,
        system: req.system,
        user: req.user,
        // The JSON schema the real client would send (what the model is held to).
        schema: JSON.stringify(req.format.schema),
      });
      const queued: SandboxAnswer | null = await takeSandboxAnswer(req.agentKey);
      const valid = () => JSON.stringify(req.sandboxAnswer ? req.sandboxAnswer() : {});
      if (!queued) return reply(req, 'end_turn', valid());
      switch (queued.fault) {
        case 'refusal':
          return reply(req, 'refusal', '', 'sandbox');
        case 'max_tokens':
          return reply(req, 'max_tokens', valid().slice(0, 12));
        case 'bad_json':
          return reply(req, 'end_turn', 'Sure! Here is what you asked for.');
        case 'rate_limit':
          throw new ModelError('retryable', 'rate_limited', 'sandbox: rate limited', 429, true);
        case 'server_error':
          throw new ModelError('retryable', 'server_error', 'sandbox: server error', 500, true);
        case 'timeout':
          throw new ModelError('retryable', 'timeout', 'sandbox: timed out', null, true);
        case 'unauthorized':
          throw new ModelError('setup', 'unauthorized', 'sandbox: credentials refused', 401, true);
        case 'unknown_model':
          throw new ModelError('setup', 'not_found', 'sandbox: unknown model', 404, true);
        case 'slow': {
          const ms = Math.max(0, Math.min(Number(queued.ms) || 1000, 600_000));
          // Like the real client: past the call's timeout it gives up (a retryable timeout).
          if (ms > req.timeoutMs) {
            await sleep(req.timeoutMs, signal);
            throw new ModelError('retryable', 'timeout', 'sandbox: timed out', null, true);
          }
          await sleep(ms, signal);
          return reply(req, 'end_turn', valid());
        }
        default:
          break;
      }
      if (queued.answer === undefined) return reply(req, 'end_turn', valid());
      return reply(req, 'end_turn', typeof queued.answer === 'string' ? queued.answer : JSON.stringify(queued.answer));
    },
  };
}
