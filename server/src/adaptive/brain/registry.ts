/**
 * Every AI agent there is (PR F2a: the Test connection; PR W2: the WhatsApp template writer).
 * The admin API imports this for labels and defaults without loading the model client — so no job
 * module may import brain/run.ts, lane.ts, modelClient.ts or sandboxModel.ts.
 */

import type { AgentJob, AgentKey } from './types';
import { pingJob } from './jobs/ping';
import { waTemplateWriterJob } from './jobs/waTemplateWriter';

const JOBS: Readonly<Record<AgentKey, AgentJob<any, any>>> = Object.freeze({
  ping: pingJob,
  wa_template_writer: waTemplateWriterJob,
});

export const AGENT_KEYS = Object.freeze(Object.keys(JOBS) as AgentKey[]);

export function jobFor(key: unknown): AgentJob<any, any> | null {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(JOBS, key) ? JOBS[key as AgentKey] : null;
}
