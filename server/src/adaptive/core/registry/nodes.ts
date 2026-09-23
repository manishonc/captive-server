/**
 * Node type contracts (03-playbook-format §4).
 *
 * PR 1 registers the *contract* of every P0 step type: its config schema, the
 * outcomes (edge names) it can produce, and a plain-words description for the
 * admin's read-only journey view. The runtime handlers (onEnter/onEvent/onTimeout)
 * are added next to these contracts when the engine ships — the validator already
 * rejects anything the engine will not know (V16).
 */

import { z } from 'zod';
import { conditionSchema, durationSchema, hhmmSchema } from '../schemas';
import { describeDuration } from '../issues';
import { CHANNELS } from '../constants';

export interface NodeDescribeContext {
  /** Human name of a wording pool ("Welcome offer"). */
  poolName(poolKey: string): string;
  /** "step 7" for a node id, or "End". */
  stepLabel(nodeId: string): string;
}

export interface NodeDescription {
  title: string;
  detail: string;
  /** Outcome → where it goes, in words ("Clicked → step 7"). */
  branches?: Array<{ outcome: string; label: string; to: string }>;
}

export interface NodeContract<C = any> {
  type: string;
  typeVersion: number;
  /** What the admin UI calls this kind of step. */
  label: string;
  configSchema: z.ZodType<C>;
  outcomes(config: C): string[];
  describe(config: C, ctx: NodeDescribeContext, edges: Record<string, string>): NodeDescription;
  /** Only `exit` ends a path. */
  terminal?: boolean;
  /** Only `send` reaches a guest; the checks look for marketing vs service sends. */
  sends?: boolean;
}

const offsetSchema = z.string().regex(/^[+-]\d{1,3}(m|h|d)$/, 'Offsets look like +1d or -1d');
const channelRuleSchema = z.union([
  z.enum(['auto', 'next_on_ladder', 'same_as_last_click', 'same_as_last']),
  z.object({ fixed: z.enum(CHANNELS) }),
]);

const CHANNEL_RULE_WORDS: Record<string, string> = {
  auto: 'best channel for this guest',
  next_on_ladder: 'next channel in the order',
  same_as_last_click: 'the channel the guest clicked',
  same_as_last: 'same channel as last time',
};

const SLOT_WORDS: Record<string, string> = {
  morning: 'morning (09–11)',
  afternoon: 'afternoon (14–17)',
  evening: 'evening (18–20)',
};

const ANCHOR_WORDS: Record<string, string> = {
  'stay.checkInAt': 'arrival day',
  'stay.checkOutAt': 'checkout day',
};

function outcomeWords(outcome: string): string {
  return outcome.charAt(0).toUpperCase() + outcome.slice(1).replace(/_/g, ' ');
}

function branchesFor(edges: Record<string, string>, ctx: NodeDescribeContext) {
  return Object.entries(edges).map(([outcome, to]) => ({ outcome, label: outcomeWords(outcome), to: ctx.stepLabel(to) }));
}

const delay: NodeContract<{ for: string }> = {
  type: 'delay',
  typeVersion: 1,
  label: 'Wait',
  configSchema: z.object({ for: durationSchema }),
  outcomes: () => ['done'],
  describe: (c) => ({ title: 'Wait', detail: describeDuration(c.for) }),
};

type WaitUntilConfig = { at?: string; day?: 'same_or_next' | 'next'; anchor?: string; offset?: string };
const waitUntil: NodeContract<WaitUntilConfig> = {
  type: 'wait_until',
  typeVersion: 1,
  label: 'Wait until',
  configSchema: z.object({
    at: hhmmSchema.optional(),
    day: z.enum(['same_or_next', 'next']).optional(),
    anchor: z.enum(['stay.checkInAt', 'stay.checkOutAt']).optional(),
    offset: offsetSchema.optional(),
  }),
  outcomes: () => ['done', 'past'],
  describe: (c) => {
    const when = c.anchor
      ? `${c.offset ? `${c.offset} from ` : ''}${ANCHOR_WORDS[c.anchor] ?? c.anchor}`
      : c.day === 'next'
        ? 'the next day'
        : 'today or the next day';
    return { title: 'Wait until', detail: `${c.at ? `${c.at} guest time, ` : ''}${when}` };
  },
};

type WaitForConfig = { events: Array<{ key: string; event: string; where?: Record<string, unknown> }>; timeout: string };
const waitFor: NodeContract<WaitForConfig> = {
  type: 'wait_for',
  typeVersion: 1,
  label: 'Wait for a reaction',
  configSchema: z.object({
    events: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]*$/),
          event: z.string().min(1),
          where: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1),
    timeout: durationSchema,
  }),
  outcomes: (c) => [...c.events.map((e) => e.key), 'timeout'],
  describe: (c, ctx, edges) => ({
    title: 'Wait for a reaction',
    detail: `Up to ${describeDuration(c.timeout)}`,
    branches: branchesFor(edges, ctx).map((b) => (b.outcome === 'timeout' ? { ...b, label: 'Nothing' } : b)),
  }),
};

type SendConfig = {
  purpose: 'marketing' | 'service';
  pool: string;
  channel?: 'auto' | 'next_on_ladder' | 'same_as_last_click' | 'same_as_last' | { fixed: string };
  requireDiff?: Array<'channel' | 'variant' | 'slot'>;
  timing: { mode: 'now' | 'slot' | 'local_time'; default?: 'morning' | 'afternoon' | 'evening'; at?: string };
  expireAfter?: string;
  highValue?: boolean;
  urgent?: boolean;
};
const send: NodeContract<SendConfig> = {
  type: 'send',
  typeVersion: 1,
  label: 'Send a message',
  sends: true,
  configSchema: z.object({
    purpose: z.enum(['marketing', 'service']),
    pool: z.string().min(1),
    channel: channelRuleSchema.default('auto'),
    requireDiff: z.array(z.enum(['channel', 'variant', 'slot'])).optional(),
    timing: z.object({
      mode: z.enum(['now', 'slot', 'local_time']),
      default: z.enum(['morning', 'afternoon', 'evening']).optional(),
      at: hhmmSchema.optional(),
    }),
    expireAfter: durationSchema.optional(),
    highValue: z.boolean().optional(),
    urgent: z.boolean().optional(),
  }),
  outcomes: () => ['sent', 'skipped'],
  describe: (c, ctx) => {
    const rule = c.channel ?? 'auto';
    const channelWords = typeof rule === 'string' ? CHANNEL_RULE_WORDS[rule] ?? rule : `always ${rule.fixed}`;
    const timing =
      c.timing.mode === 'now'
        ? 'right away'
        : c.timing.mode === 'local_time'
          ? `at ${c.timing.at ?? '—'} guest time`
          : SLOT_WORDS[c.timing.default ?? ''] ?? 'in the best time slot';
    const parts = [c.purpose === 'service' ? 'Info message (free)' : 'Marketing', channelWords, timing];
    if (c.requireDiff?.includes('variant')) parts.push('new wording');
    if (c.highValue) parts.push('high value');
    return { title: `Send “${ctx.poolName(c.pool)}”`, detail: parts.join(' · ') };
  },
};

type BranchConfig = { cases: Array<{ when: unknown; edge: string; label?: string }> };
const branch: NodeContract<BranchConfig> = {
  type: 'branch',
  typeVersion: 1,
  label: 'Check a condition',
  configSchema: z.object({
    cases: z.array(z.object({ when: conditionSchema, edge: z.string().min(1), label: z.string().max(60).optional() })).min(1),
  }),
  outcomes: (c) => [...c.cases.map((k) => k.edge), 'default'],
  describe: (c, ctx, edges) => ({
    title: 'Check a condition',
    detail: c.cases.map((k) => k.label || k.edge).join(' / '),
    branches: branchesFor(edges, ctx),
  }),
};

type SplitConfig = { paths: Array<{ edge: string; weight: number }> };
const randomSplit: NodeContract<SplitConfig> = {
  type: 'random_split',
  typeVersion: 1,
  label: 'Random split',
  configSchema: z.object({
    paths: z.array(z.object({ edge: z.string().min(1), weight: z.number().min(0).max(100) })).min(2),
  }),
  outcomes: (c) => c.paths.map((p) => p.edge),
  describe: (c, ctx, edges) => ({
    title: 'Random split',
    detail: c.paths.map((p) => `${p.weight}% ${p.edge}`).join(' · '),
    branches: branchesFor(edges, ctx),
  }),
};

type IssueOfferConfig = { slot: string; expiryDays?: number };
const issueOffer: NodeContract<IssueOfferConfig> = {
  type: 'issue_offer',
  typeVersion: 1,
  label: 'Give an offer',
  configSchema: z.object({ slot: z.string().min(1), expiryDays: z.number().int().min(1).max(90).optional() }),
  outcomes: () => ['done', 'none'],
  describe: (c) => ({ title: 'Give the offer', detail: `Uses the offer the owner picked (“${c.slot}” blank)` }),
};

type NotifyConfig = { template: string; channels: Array<'email' | 'sms'> };
const notifyOwner: NodeContract<NotifyConfig> = {
  type: 'notify_owner',
  typeVersion: 1,
  label: 'Alert the owner',
  configSchema: z.object({ template: z.string().min(1), channels: z.array(z.enum(['email', 'sms'])).min(1) }),
  outcomes: () => ['done'],
  describe: (c) => ({ title: 'Alert the owner', detail: `${c.template.replace(/_/g, ' ')} · ${c.channels.join(', ')}` }),
};

type SetTagConfig = { key: string; value: string | number | boolean };
const setTag: NodeContract<SetTagConfig> = {
  type: 'set_tag',
  typeVersion: 1,
  label: 'Tag the guest',
  configSchema: z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }),
  outcomes: () => ['done'],
  describe: (c) => ({ title: 'Tag the guest', detail: `${c.key} = ${String(c.value)}` }),
};

type ExitConfig = { status: 'completed' | 'exhausted' | 'converted' };
const EXIT_WORDS: Record<ExitConfig['status'], string> = {
  completed: 'Finished',
  exhausted: 'Out of tries',
  converted: 'Came back (converted)',
};
const exit: NodeContract<ExitConfig> = {
  type: 'exit',
  typeVersion: 1,
  label: 'End',
  terminal: true,
  configSchema: z.object({ status: z.enum(['completed', 'exhausted', 'converted']) }),
  outcomes: () => [],
  describe: (c) => ({ title: 'End', detail: EXIT_WORDS[c.status] }),
};

export const NODE_CONTRACTS: Record<string, NodeContract> = Object.fromEntries(
  [delay, waitUntil, waitFor, send, branch, randomSplit, issueOffer, notifyOwner, setTag, exit].map((n) => [n.type, n]),
);

export function getNodeContract(type: string): NodeContract | undefined {
  return NODE_CONTRACTS[type];
}
