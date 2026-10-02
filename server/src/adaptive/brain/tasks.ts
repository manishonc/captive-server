/**
 * The AI agents' queue tasks (PR F2a). Pure: the API schedules them (the admin's Test
 * connection, the sandbox's dev route) without loading anything that calls a model; the
 * worker's AI lane runs them.
 *
 * `maxAttempts: 3`: a run whose worker died is handed out again — the next attempt closes the
 * dead run (brain/run.ts) and never calls the model itself, so one spare attempt remains for a
 * worker that walked away before its run started; a model call is never repeated in a loop (the
 * run itself tries the fallback model at most once).
 */

import type { ClaimedTask, TaskSpec } from '../queue/firestoreQueue';
import type { AgentKey, RunTrigger } from './types';

/** What the AI lane needs from a claimed task (brain/run.ts `RunRequest`). */
export interface AgentTaskRequest {
  agentKey: string;
  trigger: RunTrigger;
  taskId: string;
  attempt: number;
  tenantUserId: string | null;
  venueId: string | null;
  params: Record<string, unknown>;
}

const TRIGGERS: readonly RunTrigger[] = ['test', 'schedule', 'manual', 'dev'];

/** The run a claimed task asks for (an unreadable trigger gets the strictest gates: `schedule`). */
export function requestOf(task: ClaimedTask): AgentTaskRequest {
  const p = task.payload ?? {};
  const trigger = TRIGGERS.includes(p.trigger as RunTrigger) ? (p.trigger as RunTrigger) : 'schedule';
  const params = p.params && typeof p.params === 'object' && !Array.isArray(p.params) ? (p.params as Record<string, unknown>) : {};
  return { agentKey: String(p.agentKey ?? ''), trigger, taskId: task.id, attempt: task.attempts, tenantUserId: task.tenantUserId, venueId: task.venueId, params };
}

export interface AgentTaskInput {
  agentKey: AgentKey;
  trigger: RunTrigger;
  /** Unique per run to make: the same key twice is one task. */
  dedupeKey: string;
  /** Engine clock (the queue compares due times with it). */
  dueAt: number;
  tenantUserId?: string | null;
  venueId?: string | null;
  params?: Record<string, unknown>;
}

export function agentRunTask(i: AgentTaskInput): TaskSpec {
  return {
    dedupeKey: `agent:${i.dedupeKey}`,
    kind: 'agent_run',
    dueAt: i.dueAt,
    payload: { agentKey: i.agentKey, trigger: i.trigger, params: i.params ?? {} },
    tenantUserId: i.tenantUserId ?? null,
    venueId: i.venueId ?? null,
    maxAttempts: 3,
  };
}

/** The admin's Test connection: one per real minute at most (a double click queues one run). */
export function testConnectionTask(realNow: number, engineNow: number): TaskSpec {
  return agentRunTask({ agentKey: 'ping', trigger: 'test', dedupeKey: `ping:test:${Math.floor(realNow / 60_000)}`, dueAt: engineNow });
}
