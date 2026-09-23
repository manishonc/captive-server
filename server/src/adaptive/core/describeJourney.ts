/**
 * Plain-words steps for a journey template — what the admin's read-only view,
 * the MCP and (later) the journey editor show instead of raw JSON.
 *
 * Steps are numbered in the order a guest meets them (breadth-first from the
 * start), then the goal's own branch (e.g. "Thank-you when she comes back"), so
 * "→ go to step 7" in one step matches the numbering of the list.
 */

import { pickLang, type JourneyDefinition } from './schemas';
import type { Lang } from './constants';
import { getNodeContract } from './registry';

export interface DescribedStep {
  nodeId: string;
  number: number;
  type: string;
  typeLabel: string;
  title: string;
  detail: string;
  branches: Array<{ outcome: string; label: string; to: string }>;
  /** True for steps only reached through the goal ("when she comes back"). */
  viaGoal: boolean;
}

export function orderSteps(def: JourneyDefinition): Array<{ nodeId: string; viaGoal: boolean }> {
  // 1. Discovery order: breadth-first from the start, then from the goal's step.
  const discovered: Array<{ nodeId: string; viaGoal: boolean }> = [];
  const seen = new Set<string>();
  const walk = (root: string, viaGoal: boolean) => {
    const queue = [root];
    while (queue.length) {
      const id = queue.shift() as string;
      if (seen.has(id) || !def.nodes[id]) continue;
      seen.add(id);
      discovered.push({ nodeId: id, viaGoal });
      queue.push(...Object.values(def.nodes[id].edges));
    }
  };
  walk(def.start, false);
  if (def.goal?.onReach) walk(def.goal.onReach, true);
  for (const id of Object.keys(def.nodes)) if (!seen.has(id)) discovered.push({ nodeId: id, viaGoal: false });

  // 2. Topological order (a step comes after every step that leads to it), ties
  //    broken by discovery order — so every "→ step N" points forward.
  const rank = new Map(discovered.map((s, i) => [s.nodeId, i]));
  const indegree = new Map(discovered.map((s) => [s.nodeId, 0]));
  for (const { nodeId } of discovered) {
    for (const t of Object.values(def.nodes[nodeId].edges)) if (indegree.has(t)) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  const ready = discovered.filter((s) => indegree.get(s.nodeId) === 0).map((s) => s.nodeId);
  const ordered: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const id = ready.shift() as string;
    ordered.push(id);
    for (const t of Object.values(def.nodes[id].edges)) {
      if (!indegree.has(t)) continue;
      indegree.set(t, (indegree.get(t) ?? 0) - 1);
      if (indegree.get(t) === 0) ready.push(t);
    }
  }
  // A loop (rejected by V01 anyway) leaves steps unplaced; list them in discovery order.
  for (const s of discovered) if (!ordered.includes(s.nodeId)) ordered.push(s.nodeId);

  const viaGoal = new Map(discovered.map((s) => [s.nodeId, s.viaGoal]));
  const steps = ordered.map((nodeId) => ({ nodeId, viaGoal: viaGoal.get(nodeId) ?? false }));
  // Every End step at the bottom.
  return [...steps.filter((s) => def.nodes[s.nodeId].type !== 'exit'), ...steps.filter((s) => def.nodes[s.nodeId].type === 'exit')];
}

export function describeJourneySteps(def: JourneyDefinition, lang: Lang = 'en'): DescribedStep[] {
  const order = orderSteps(def);
  const numberOf = new Map(order.map((s, i) => [s.nodeId, i + 1]));
  const ctx = {
    poolName: (poolKey: string) => {
      const name = def.pools[poolKey]?.name;
      return name ? pickLang(name, lang) : humanize(poolKey);
    },
    stepLabel: (nodeId: string) => {
      const node = def.nodes[nodeId];
      if (!node) return nodeId;
      return node.type === 'exit' ? 'End' : `step ${numberOf.get(nodeId) ?? '?'}`;
    },
  };

  return order.map(({ nodeId, viaGoal }) => {
    const node = def.nodes[nodeId];
    const contract = getNodeContract(node.type);
    const number = numberOf.get(nodeId) ?? 0;
    if (!contract) {
      return { nodeId, number, type: node.type, typeLabel: node.type, title: node.type, detail: 'Unknown step type', branches: [], viaGoal };
    }
    const cfg = contract.configSchema.safeParse(node.config);
    const described = cfg.success
      ? contract.describe(cfg.data, ctx, node.edges)
      : { title: contract.label, detail: 'Step settings are incomplete' };
    const branches =
      described.branches ??
      (Object.keys(node.edges).length > 1
        ? Object.entries(node.edges).map(([outcome, to]) => ({ outcome, label: humanize(outcome), to: ctx.stepLabel(to) }))
        : []);
    return { nodeId, number, type: node.type, typeLabel: contract.label, title: described.title, detail: described.detail, branches, viaGoal };
  });
}

function humanize(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
