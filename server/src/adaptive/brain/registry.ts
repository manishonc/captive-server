/**
 * Every AI agent there is (PR F2a: only the Test connection). Pure: the admin API imports this
 * for labels and defaults without loading the model client.
 */

import type { AgentJob, AgentKey } from './types';
import { pingJob } from './jobs/ping';

const JOBS: Readonly<Record<AgentKey, AgentJob<any, any>>> = Object.freeze({
  ping: pingJob,
});

export const AGENT_KEYS = Object.freeze(Object.keys(JOBS) as AgentKey[]);

export function jobFor(key: unknown): AgentJob<any, any> | null {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(JOBS, key) ? JOBS[key as AgentKey] : null;
}
