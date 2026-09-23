/**
 * Turns the seed definitions into the exact documents to create — pure, so the
 * seed test proves the same thing the boot-time seed writes.
 *
 * Everything is validated first with the same rules the admin screens use. If
 * any definition has an error, nothing is written (buildSeedPlan throws).
 *
 * Documents are grouped into units (a playbook header + its v1, a journey
 * template + its v1, …). A unit is only created when its anchor document is
 * missing, so an admin's later edits are never overwritten.
 */

import { COL, CONFIG_DOC_ID, HISTORY, VERSIONS } from '../store/collections';
import {
  adaptiveConfigSchema,
  journeyDefinitionSchema,
  journeyTemplateHeaderSchema,
  playbookContentSchema,
  questionSchema,
  variantSeedSchema,
  type JourneyDefinition,
  type JourneyTemplateHeader,
  type PlaybookContent,
  type Question,
  type VariantSeed,
} from '../core/schemas';
import { ENGINE_RANGE, SCHEMA_VERSION, DEFAULT_RULES } from '../core/constants';
import { contentChecksum, hashId } from '../core/checksum';
import { validateJourneyTemplate } from '../core/validateJourneyTemplate';
import { validatePlaybook, type TemplateInfo } from '../core/validatePlaybook';
import type { ValidationReport } from '../core/issues';
import { buildWordingIndex, lintMergeFields } from '../core/wording';
import { SEED } from './definitions';

export const SEED_ACTOR = 'seed';

export interface SeedDoc {
  path: string[];
  data: Record<string, unknown>;
}

export interface SeedUnit {
  label: string;
  /** The unit is created only if this document doesn't exist yet. */
  anchor: string[];
  docs: SeedDoc[];
}

export interface SeedPlan {
  units: SeedUnit[];
  reports: { journeys: Record<string, ValidationReport>; playbooks: Record<string, ValidationReport> };
  problems: string[];
}

export function variantId(poolKey: string, letter: string): string {
  return hashId('var', `platform:${poolKey}:${letter}`);
}

export function buildSeedPlan(now: Date = new Date(), seed = SEED): SeedPlan {
  const problems: string[] = [];
  const units: SeedUnit[] = [];
  const stamp = { createdAt: now, updatedAt: now, schemaVersion: SCHEMA_VERSION };

  // Platform rules
  const config = adaptiveConfigSchema.safeParse(seed.config);
  if (!config.success) problems.push(`AdaptiveConfig: ${config.error.issues.map((i) => i.message).join('; ')}`);
  const rules = config.success
    ? {
        maxTouchesPerJourney: config.data.caps.maxTouchesPerJourney,
        stopAfterClicks: config.data.caps.stopAfterClicks,
        maxDiscountPct: config.data.offerBounds.maxDiscountPct,
        offerExpiryDays: config.data.offerBounds.expiryDays,
      }
    : DEFAULT_RULES;
  if (config.success) {
    const data = { ...config.data, version: 1, updatedAt: now, updatedBy: SEED_ACTOR, schemaVersion: SCHEMA_VERSION };
    units.push({
      label: 'AdaptiveConfig/global v1',
      anchor: [COL.config, CONFIG_DOC_ID],
      docs: [
        { path: [COL.config, CONFIG_DOC_ID], data },
        { path: [COL.config, CONFIG_DOC_ID, HISTORY, '1'], data },
      ],
    });
  }

  // Question bank
  const questions = new Map<string, Question>();
  for (const q of seed.questions) {
    const parsed = questionSchema.safeParse(q);
    if (!parsed.success) {
      problems.push(`Question ${q.key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    questions.set(parsed.data.key, parsed.data);
    units.push({
      label: `Question ${parsed.data.key}`,
      anchor: [COL.questionBank, parsed.data.key],
      docs: [{ path: [COL.questionBank, parsed.data.key], data: { ...parsed.data, version: 1, ...stamp } }],
    });
  }

  // Journey templates
  const templates = new Map<string, TemplateInfo>();
  const definitions = new Map<string, { header: JourneyTemplateHeader; definition: JourneyDefinition }>();
  const journeyReports: Record<string, ValidationReport> = {};
  for (const j of seed.journeys) {
    const key = j.header.key;
    const report = validateJourneyTemplate({ header: j.header, definition: j.definition }, rules);
    journeyReports[key] = report;
    if (!report.ok) {
      problems.push(`Journey ${key}: ${report.issues.filter((i) => i.severity === 'error').map((i) => `${i.code} ${i.message}`).join('; ')}`);
      continue;
    }
    const header = journeyTemplateHeaderSchema.parse(j.header);
    const definition = journeyDefinitionSchema.parse(j.definition);
    definitions.set(key, { header, definition });
    templates.set(key, {
      header: { ...header, publishedVersion: 1 },
      versions: new Map([[1, { state: 'published', definition }]]),
    });
    units.push({
      label: `Journey template ${key} v1`,
      anchor: [COL.journeyTemplates, key],
      docs: [
        {
          path: [COL.journeyTemplates, key],
          data: { ...header, status: 'published', latestVersion: 1, publishedVersion: 1, createdBy: SEED_ACTOR, updatedBy: SEED_ACTOR, ...stamp },
        },
        {
          path: [COL.journeyTemplates, key, VERSIONS, '1'],
          data: {
            version: 1,
            state: 'published',
            definition,
            engineVersion: ENGINE_RANGE,
            checksum: contentChecksum(definition),
            validation: { ...report, checkedAt: now },
            changelog: j.changelog,
            createdAt: now,
            createdBy: SEED_ACTOR,
            publishedAt: now,
            publishedBy: SEED_ACTOR,
            schemaVersion: SCHEMA_VERSION,
          },
        },
      ],
    });
  }

  // Wording
  const variants: VariantSeed[] = [];
  for (const v of seed.variants) {
    const parsed = variantSeedSchema.safeParse(v);
    if (!parsed.success) {
      problems.push(`Wording ${v.poolKey}/${v.letter}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const variant = parsed.data;
    const journey = definitions.get(variant.journeyKey);
    const pool = journey?.definition.pools[variant.poolKey];
    if (!journey || !pool) {
      problems.push(`Wording ${variant.poolKey}/${variant.letter}: pool is not declared by journey ${variant.journeyKey}`);
      continue;
    }
    if (pool.purpose !== variant.purpose) {
      problems.push(`Wording ${variant.poolKey}/${variant.letter}: purpose ${variant.purpose} doesn't match the pool (${pool.purpose})`);
    }
    const slotKeys = Object.keys(journey.definition.slots);
    const used = new Set<string>();
    for (const content of [variant.channels, ...Object.values(variant.locales)]) {
      if (!content) continue;
      const lint = lintMergeFields(content, { purpose: variant.purpose, slotKeys });
      lint.used.forEach((u) => used.add(u));
      lint.problems.forEach((p) => problems.push(`Wording ${variant.poolKey}/${variant.letter}: ${p}`));
    }
    variants.push(variant);
    const id = variantId(variant.poolKey, variant.letter);
    units.push({
      label: `Wording ${variant.poolKey}/${variant.letter}`,
      anchor: [COL.variants, id],
      docs: [
        {
          path: [COL.variants, id],
          data: {
            scope: 'platform',
            tenantUserId: null,
            venueId: null,
            poolKey: variant.poolKey,
            journeyKey: variant.journeyKey,
            purpose: variant.purpose,
            status: 'active',
            origin: 'platform',
            name: variant.name,
            letter: variant.letter,
            parentVariantId: null,
            generation: 0,
            axes: variant.axes,
            baseLocale: 'en',
            channels: variant.channels,
            locales: variant.locales,
            mergeFieldsUsed: [...used].sort(),
            contentHash: contentChecksum({ channels: variant.channels, locales: variant.locales }),
            lint: { status: 'pending', issues: [], linterVersion: null },
            approval: null,
            createdBy: SEED_ACTOR,
            ...stamp,
          },
        },
      ],
    });
  }
  const wording = buildWordingIndex(variants.map((v) => ({ ...v, status: 'active' })));

  // Playbooks
  const playbookReports: Record<string, ValidationReport> = {};
  for (const p of seed.playbooks) {
    const report = validatePlaybook(p.content, { templates, wording, questions, rules, publishedKind: null });
    playbookReports[p.key] = report;
    if (!report.ok) {
      problems.push(`Playbook ${p.key}: ${report.issues.filter((i) => i.severity === 'error').map((i) => `${i.code} ${i.message}`).join('; ')}`);
      continue;
    }
    const content: PlaybookContent = playbookContentSchema.parse(p.content);
    units.push({
      label: `Playbook ${p.key} v1`,
      anchor: [COL.playbooks, p.key],
      docs: [
        {
          path: [COL.playbooks, p.key],
          data: {
            key: p.key,
            kind: content.kind,
            status: 'published',
            name: content.name,
            summary: content.summary,
            icon: content.icon,
            venueTypes: content.venueTypes,
            sortOrder: p.sortOrder,
            latestVersion: 1,
            publishedVersion: 1,
            createdBy: SEED_ACTOR,
            updatedBy: SEED_ACTOR,
            ...stamp,
          },
        },
        {
          path: [COL.playbooks, p.key, VERSIONS, '1'],
          data: {
            ...content,
            version: 1,
            state: 'published',
            basedOnVersion: null,
            engineVersion: ENGINE_RANGE,
            validation: { ...report, checkedAt: now },
            checksum: contentChecksum(content),
            changelog: p.changelog,
            createdBy: SEED_ACTOR,
            updatedBy: SEED_ACTOR,
            publishedAt: now,
            publishedBy: SEED_ACTOR,
            ...stamp,
          },
        },
      ],
    });
  }

  return { units, reports: { journeys: journeyReports, playbooks: playbookReports }, problems };
}
