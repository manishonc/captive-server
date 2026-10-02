/**
 * Whether an agent run may start (PR F2a; DF8). Pure — reads the engine settings object, never
 * Firestore.
 *
 *  - One run a person asked for (the admin's Test connection, the sandbox's dev route) runs while
 *    the AI switch is off; the budget still applies (brain/run.ts).
 *  - A scheduled run needs the agent on and the AI switch on: the global switch for a platform
 *    job, the account's (its override, else the global one) for an account's job — and that
 *    account live (never a test run or an account that's off).
 */

import type { EngineSettings } from '../store/engineSettings';
import type { AgentJob, AgentSettings, RunTrigger } from './types';

export type GateReason = 'agent_off' | 'agents_off' | 'no_account' | 'not_live';

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function gateFor(
  job: Pick<AgentJob, 'scope'>,
  req: { trigger: RunTrigger; tenantUserId: string | null },
  engine: EngineSettings,
  settings: Pick<AgentSettings, 'enabled'>,
): GateReason | null {
  if (req.trigger === 'test' || req.trigger === 'dev') return null;
  if (!settings.enabled) return 'agent_off';
  const agents = engine.agents ?? { mode: 'off' as const, accounts: {} as Record<string, 'off' | 'on'> };
  if (job.scope === 'platform') return agents.mode === 'on' ? null : 'agents_off';
  const tenant = req.tenantUserId;
  if (!tenant) return 'no_account';
  const aiMode = has(agents.accounts, tenant) ? agents.accounts[tenant] : agents.mode;
  if (aiMode !== 'on') return 'agents_off';
  const launch = has(engine.launch.accounts, tenant) ? engine.launch.accounts[tenant] : engine.launch.default;
  if (launch !== 'live') return 'not_live';
  return null;
}
