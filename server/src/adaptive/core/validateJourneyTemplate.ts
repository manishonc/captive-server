/**
 * Checks for a journey template (03-playbook-format §11).
 *
 * PR 1 has no journey editor, so these run on the seed and in tests (CI): the
 * definitions we ship must be sound before any playbook can pin them.
 *
 *  V01  every edge resolves, every step is reachable from `start` (or the goal's
 *       `onReach` step), every path ends in an exit, no loops
 *  V02  send steps use declared pools with a matching purpose
 *  V03  caps within the platform maxima
 *  V04  offer steps use an offer blank; slot defaults inside their bounds
 *  V06  trigger config complete for its type
 *  V08  "differ in channel" needs a second channel on the ladder
 *  V14  info (service) journeys give no offers and send no marketing
 *  V16  every step and trigger type exists in the registry
 */

import { journeyDefinitionSchema, journeyTemplateHeaderSchema, type JourneyDefinition } from './schemas';
import { DEFAULT_RULES } from './constants';
import { error, info, makeReport, warning, zodIssues, type Issue, type ValidationReport } from './issues';
import { getNodeContract, getTriggerContract, KNOWN_EVENTS, checkSlotValue } from './registry';

export interface TemplateRules {
  maxTouchesPerJourney: number;
  stopAfterClicks: number;
}

export function validateJourneyTemplate(
  input: { header: unknown; definition: unknown },
  rules: TemplateRules = DEFAULT_RULES,
): ValidationReport {
  const issues: Issue[] = [];

  const header = journeyTemplateHeaderSchema.safeParse(input.header);
  if (!header.success) issues.push(...zodIssues(header.error, 'header'));

  const parsed = journeyDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) {
    issues.push(...zodIssues(parsed.error, 'definition'));
    return makeReport(issues);
  }
  const def = parsed.data;
  const purpose = header.success ? header.data.purpose : 'marketing';

  // V16 + V06 — trigger
  const trigger = getTriggerContract(def.entry.trigger.type);
  if (!trigger) {
    issues.push(error('V16', `Unknown trigger type “${def.entry.trigger.type}”`, 'entry.trigger.type'));
  } else {
    const cfg = trigger.configSchema.safeParse(def.entry.trigger.config);
    if (!cfg.success) {
      issues.push(...zodIssues(cfg.error, 'entry.trigger.config').map((i) => ({ ...i, code: 'V06' })));
    }
  }

  for (const [i, rule] of def.exitOn.entries()) {
    if (!KNOWN_EVENTS.has(rule.event)) issues.push(warning('V16', `Exit rule waits for an unknown event “${rule.event}”`, `exitOn.${i}`));
  }
  if (def.goal && !KNOWN_EVENTS.has(def.goal.event)) {
    issues.push(warning('V16', `Goal uses an unknown event “${def.goal.event}”`, 'goal.event'));
  }

  // V16 — step types and their config; collect outcomes per node
  const outcomesByNode = new Map<string, string[]>();
  const parsedConfigs = new Map<string, Record<string, any>>();
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    const contract = getNodeContract(node.type);
    if (!contract) {
      issues.push(error('V16', `Step “${nodeId}” has an unknown type “${node.type}”`, `nodes.${nodeId}.type`));
      continue;
    }
    const cfg = contract.configSchema.safeParse(node.config);
    if (!cfg.success) {
      issues.push(...zodIssues(cfg.error, `nodes.${nodeId}.config`).map((i) => ({ ...i, code: 'V16' })));
      continue;
    }
    parsedConfigs.set(nodeId, cfg.data);
    outcomesByNode.set(nodeId, contract.outcomes(cfg.data));
  }

  issues.push(...checkGraph(def, outcomesByNode));

  // V02 / V14 / V04 / V08 — send and offer steps
  const usedPools = new Set<string>();
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    const cfg = parsedConfigs.get(nodeId);
    if (!cfg) continue;
    if (node.type === 'send') {
      const pool = def.pools[cfg.pool];
      usedPools.add(cfg.pool);
      if (!pool) {
        issues.push(error('V02', `Step “${nodeId}” sends from “${cfg.pool}”, which isn't a declared wording pool`, `nodes.${nodeId}.config.pool`));
      } else if (pool.purpose !== cfg.purpose) {
        issues.push(error('V02', `Step “${nodeId}” is ${cfg.purpose} but its pool “${cfg.pool}” is ${pool.purpose}`, `nodes.${nodeId}.config.purpose`));
      }
      if (purpose === 'service' && cfg.purpose === 'marketing') {
        issues.push(error('V14', `Info journeys can't send marketing (step “${nodeId}”)`, `nodes.${nodeId}.config.purpose`));
      }
      if (cfg.requireDiff?.includes('channel') && def.channelLadder.length < 2) {
        issues.push(error('V08', `Step “${nodeId}” must use a different channel, but the channel order has only one`, `nodes.${nodeId}.config.requireDiff`));
      }
      if (cfg.highValue && cfg.purpose !== 'marketing') {
        issues.push(error('V05', `“High value” only applies to marketing steps (step “${nodeId}”)`, `nodes.${nodeId}.config.highValue`));
      }
    }
    if (node.type === 'issue_offer') {
      if (purpose === 'service') issues.push(error('V14', `Info journeys can't give offers (step “${nodeId}”)`, `nodes.${nodeId}`));
      const slot = def.slots[cfg.slot];
      if (!slot || slot.type !== 'offer') {
        issues.push(error('V04', `Step “${nodeId}” gives the offer from “${cfg.slot}”, which isn't an offer blank`, `nodes.${nodeId}.config.slot`));
      }
    }
  }
  for (const poolKey of Object.keys(def.pools)) {
    if (!usedPools.has(poolKey)) issues.push(warning('V02', `Wording pool “${poolKey}” isn't used by any step`, `pools.${poolKey}`));
  }

  // V03 — caps
  if (def.caps) {
    if (def.caps.maxTouches > rules.maxTouchesPerJourney) {
      issues.push(error('V03', `Asks for ${def.caps.maxTouches} messages per guest; the platform allows ${rules.maxTouchesPerJourney}`, 'caps.maxTouches'));
    }
    if (def.caps.stopAfterClicks > rules.stopAfterClicks) {
      issues.push(error('V03', `Stops after ${def.caps.stopAfterClicks} clicks; the platform allows ${rules.stopAfterClicks}`, 'caps.stopAfterClicks'));
    }
  } else if (purpose !== 'service') {
    issues.push(info('V03', 'No journey caps set — the platform maxima apply', 'caps'));
  }

  // V04 — slot definitions and defaults
  for (const [slotKey, slot] of Object.entries(def.slots)) {
    if ((slot.type === 'int' || slot.type === 'days') && slot.min > slot.max) {
      issues.push(error('V04', `Blank “${slotKey}” has min above max`, `slots.${slotKey}`));
    }
    if (slot.type !== 'offer' && 'default' in slot && slot.default !== undefined && slot.default !== null) {
      const reason = checkSlotValue(slot, slot.default as never, { offers: [] });
      if (reason) issues.push(error('V04', `Default for blank “${slotKey}” ${reason}`, `slots.${slotKey}.default`));
    }
  }

  // Preview steps must point at real steps and pools
  for (const [i, step] of def.previewSteps.entries()) {
    if (!def.nodes[step.nodeId]) issues.push(warning('V02', `Preview step ${i + 1} points at a missing step “${step.nodeId}”`, `previewSteps.${i}`));
    if (step.channel !== 'page' && (!step.pool || !def.pools[step.pool])) {
      issues.push(warning('V02', `Preview step ${i + 1} uses an undeclared pool “${step.pool ?? ''}”`, `previewSteps.${i}`));
    }
  }

  return makeReport(issues);
}

/** V01 — edges, reachability, endings, loops. */
function checkGraph(def: JourneyDefinition, outcomesByNode: Map<string, string[]>): Issue[] {
  const issues: Issue[] = [];
  const nodes = def.nodes;

  if (!nodes[def.start]) issues.push(error('V01', `The first step “${def.start}” doesn't exist`, 'start'));
  if (def.goal?.onReach && !nodes[def.goal.onReach]) {
    issues.push(error('V01', `The goal's step “${def.goal.onReach}” doesn't exist`, 'goal.onReach'));
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    const outcomes = outcomesByNode.get(nodeId);
    for (const [outcome, target] of Object.entries(node.edges)) {
      if (!nodes[target]) issues.push(error('V01', `Step “${nodeId}” goes to a missing step “${target}” on “${outcome}”`, `nodes.${nodeId}.edges.${outcome}`));
      if (outcomes && !outcomes.includes(outcome)) {
        issues.push(error('V01', `Step “${nodeId}” has a path for “${outcome}”, which a ${node.type} step never produces`, `nodes.${nodeId}.edges.${outcome}`));
      }
    }
    if (outcomes) {
      for (const outcome of outcomes) {
        if (!node.edges[outcome]) issues.push(error('V01', `Step “${nodeId}” has no path for “${outcome}”`, `nodes.${nodeId}.edges`));
      }
    }
  }

  // Reachability from the start and from the goal's step.
  const roots = [def.start, def.goal?.onReach].filter((id): id is string => Boolean(id && nodes[id]));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const target of Object.values(nodes[id]?.edges ?? {})) if (nodes[target]) queue.push(target);
  }
  for (const nodeId of Object.keys(nodes)) {
    if (!seen.has(nodeId)) issues.push(error('V01', `Step “${nodeId}” can't be reached`, `nodes.${nodeId}`));
  }

  // Loops, and paths that stop on a step that isn't an exit.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      issues.push(error('V01', `Steps loop back to “${id}” — loops aren't allowed`, `nodes.${id}`));
      return;
    }
    state.set(id, 'visiting');
    const node = nodes[id];
    const targets = Object.values(node?.edges ?? {}).filter((t) => nodes[t]);
    if (node && node.type !== 'exit' && targets.length === 0) {
      issues.push(error('V01', `Step “${id}” is a dead end — every path must finish with an End step`, `nodes.${id}`));
    }
    for (const t of targets) visit(t);
    state.set(id, 'done');
  };
  for (const root of roots) visit(root);

  return dedupe(issues);
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
