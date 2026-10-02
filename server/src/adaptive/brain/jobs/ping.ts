/**
 * The admin's "Test connection" (PR F2a): one tiny call through the whole path — the worker's
 * lane, the cms relay, the gateway, the model, the typed answer, the checks, the run log and the
 * spend counters. The package is a number to echo back and today's date; nothing about anyone.
 * It runs while the AI switch is off (a person pressed the button); the budget still applies.
 */

import { z } from 'zod';
import { hashId } from '../../core/checksum';
import type { AgentJob } from '../types';

export interface PingPackage {
  test: 'connection';
  nonce: number;
  date: string;
}

export const pingOutputSchema = z
  .object({
    reasoning: z.string().min(1).max(400),
    echo: z.number().int(),
  })
  .strict();

export type PingOutput = z.infer<typeof pingOutputSchema>;

/** A 4-digit number from the run id (so a retried run sends the same package). */
export function pingNonce(runId: string): number {
  return 1000 + (parseInt(hashId('pn', runId).slice(3, 11), 16) % 9000);
}

export const pingJob: AgentJob<PingPackage, PingOutput> = {
  key: 'ping',
  label: 'Test connection',
  description: 'A tiny call (a second model only if the first is busy, down or slow) that checks the worker → cms relay → AI Gateway → model path, the typed answer and the run log.',
  scope: 'platform',
  defaults: {
    enabled: false,
    model: 'anthropic/claude-opus-5.5',
    fallbackModel: 'anthropic/claude-sonnet-5.5',
    effort: 'low',
    maxRunsPerDay: 10,
    maxOutputTokens: 2048,
    promptVersion: 'ping-v1',
  },
  prompts: {
    'ping-v1': {
      system: "You check that HeidiFi's connection to the model works. Answer with the JSON the schema asks for and nothing else.",
      instructions: 'Below is a test package in JSON. Put its "nonce" into "echo", and write one short sentence in "reasoning" that mentions the nonce.',
    },
  },
  outputSchema: pingOutputSchema,
  cacheSystem: false,
  buildInput(ctx) {
    const pkg: PingPackage = { test: 'connection', nonce: pingNonce(ctx.runId), date: new Date(ctx.realNow).toISOString().slice(0, 10) };
    return { pkg, secrets: [], summary: `Connection test (nonce ${pkg.nonce})` };
  },
  check(out, pkg) {
    return [
      out.echo === pkg.nonce
        ? { code: 'echo', ok: true, detail: 'The model echoed the nonce' }
        : { code: 'echo', ok: false, detail: `The model echoed ${out.echo}, not ${pkg.nonce}` },
    ];
  },
  reasoningOf: (out) => out.reasoning,
  sandboxAnswer: (pkg) => ({ reasoning: `The nonce in the test package is ${pkg.nonce}.`, echo: pkg.nonce }),
};
