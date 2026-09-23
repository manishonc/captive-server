/**
 * Loads the platform catalogue (journey templates, wording, questions, rules)
 * and turns it into what the checks and the owner-facing views need.
 *
 * Tenant reads go through a short in-memory cache: definitions change rarely
 * and only through the admin screens, which clear it. Admin reads skip it.
 */

import {
  getAdaptiveConfig,
  listPlatformVariants,
  listQuestions,
  loadTemplateCatalogue,
  type TemplateRecord,
} from '../store/definitions';
import type { PlaybookCheckContext, TemplateInfo } from '../core/validatePlaybook';
import { buildWordingIndex } from '../core/wording';
import {
  journeyDefinitionSchema,
  pickLang,
  type AdaptiveConfig,
  type I18n,
  type JourneyDefinition,
  type Offer,
  type PlaybookContent,
  type Question,
  type SlotValue,
} from '../core/schemas';
import { fitLabel, type Channel, type PlaybookKind, type VenueType } from '../core/constants';
import type { SetupPlaybook, SetupTemplate } from '../core/validateSetup';
import type { PlaybookHeaderDoc, PlaybookVersionDoc, VariantDoc } from '../store/types';
import { slotStartValue } from '../core/registry';

export interface Catalogue {
  templates: Map<string, TemplateRecord>;
  variants: Array<VariantDoc & { id: string }>;
  questions: Question[];
  config: AdaptiveConfig & { version: number | null };
}

const TTL_MS = 30_000;
let cached: { value: Catalogue; expiresAt: number } | null = null;

export async function loadCatalogue(opts: { fresh?: boolean } = {}): Promise<Catalogue> {
  if (!opts.fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const [templates, variants, questions, config] = await Promise.all([
    loadTemplateCatalogue(),
    listPlatformVariants(),
    listQuestions(),
    getAdaptiveConfig(),
  ]);
  const value = { templates, variants, questions, config };
  cached = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export function invalidateCatalogue(): void {
  cached = null;
}

export function rulesOf(config: AdaptiveConfig) {
  return {
    maxTouchesPerJourney: config.caps.maxTouchesPerJourney,
    stopAfterClicks: config.caps.stopAfterClicks,
    maxDiscountPct: config.offerBounds.maxDiscountPct,
    offerExpiryDays: config.offerBounds.expiryDays,
  };
}

export function checkContext(cat: Catalogue, publishedKind: PlaybookKind | null): PlaybookCheckContext {
  const templates = new Map<string, TemplateInfo>();
  for (const [key, rec] of cat.templates) {
    templates.set(key, {
      header: rec.header,
      versions: new Map(
        rec.versions.map((v) => [v.version, { state: v.state, definition: journeyDefinitionSchema.parse(v.definition) }]),
      ),
    });
  }
  return {
    templates,
    wording: buildWordingIndex(cat.variants),
    questions: new Map(cat.questions.map((q) => [q.key, q])),
    rules: rulesOf(cat.config),
    publishedKind,
  };
}

export function templateVersion(cat: Catalogue, key: string, version: number): { record: TemplateRecord; definition: JourneyDefinition } | null {
  const record = cat.templates.get(key);
  const v = record?.versions.find((x) => x.version === version);
  if (!record || !v) return null;
  return { record, definition: journeyDefinitionSchema.parse(v.definition) };
}

export function setupTemplates(cat: Catalogue, content: PlaybookContent): Map<string, SetupTemplate> {
  const out = new Map<string, SetupTemplate>();
  for (const j of content.journeys) {
    const found = templateVersion(cat, j.journeyKey, j.templateVersion);
    if (found) out.set(j.journeyKey, { header: found.record.header, version: j.templateVersion, definition: found.definition });
  }
  return out;
}

export function versionContent(v: PlaybookVersionDoc): PlaybookContent {
  return {
    kind: v.kind,
    name: v.name,
    summary: v.summary,
    icon: v.icon,
    venueTypes: v.venueTypes,
    journeys: v.journeys,
    offerMenuDefaults: v.offerMenuDefaults ?? [],
    questionKeys: v.questionKeys ?? [],
    estimateHints: v.estimateHints,
  };
}

export function setupPlaybook(header: PlaybookHeaderDoc, version: PlaybookVersionDoc): SetupPlaybook {
  return {
    key: header.key,
    kind: header.kind,
    status: header.status,
    publishedVersion: header.publishedVersion,
    content: versionContent(version),
  };
}

// ── Owner-facing views ───────────────────────────────────────────────────────

export interface OwnerSlotView {
  key: string;
  type: string;
  label: I18n;
  placeholder?: I18n;
  help?: I18n;
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  i18n?: boolean;
  required: boolean;
  default: SlotValue;
  options?: Array<{ value: string; label: I18n; name: string; kind: Offer['kind'] }>;
}

export interface OwnerJourneyView {
  journeyKey: string;
  templateVersion: number;
  name: I18n;
  description: I18n;
  icon: string;
  when: I18n;
  channels: Channel[];
  purpose: 'marketing' | 'service' | 'mixed';
  comingSoon: boolean;
  defaultEnabled: boolean;
  required: boolean;
  priority: number;
  slots: OwnerSlotView[];
  hasPreview: boolean;
  requiresStays: boolean;
}

export interface OwnerPlaybookView {
  key: string;
  kind: PlaybookKind;
  version: number;
  name: I18n;
  summary: I18n;
  icon: string;
  venueTypes: VenueType[];
  fitLabel: string;
  highlights: I18n[];
  journeys: OwnerJourneyView[];
  offers: Offer[];
  needsStayCalendar: boolean;
  estimateHints: PlaybookContent['estimateHints'];
}

export function ownerPlaybookView(key: string, versionNumber: number, content: PlaybookContent, cat: Catalogue): OwnerPlaybookView {
  const journeys: OwnerJourneyView[] = [];
  for (const j of content.journeys) {
    const found = templateVersion(cat, j.journeyKey, j.templateVersion);
    if (!found) continue;
    const { record, definition } = found;
    const slots: OwnerSlotView[] = Object.entries(definition.slots).map(([slotKey, def]) => {
      const view: OwnerSlotView = {
        key: slotKey,
        type: def.type,
        label: def.label,
        required: def.required,
        default: j.slotDefaults?.[slotKey] ?? slotStartValue(def),
      };
      if (def.help) view.help = def.help;
      if (def.type === 'text') Object.assign(view, { maxLength: def.maxLength, i18n: def.i18n, ...(def.placeholder ? { placeholder: def.placeholder } : {}) });
      if (def.type === 'int' || def.type === 'days') Object.assign(view, { min: def.min, max: def.max, ...('unit' in def && def.unit ? { unit: def.unit } : {}) });
      if (def.type === 'url' && def.placeholder) view.placeholder = def.placeholder;
      if (def.type === 'offer') {
        view.options = content.offerMenuDefaults
          .filter((o) => !def.kinds || def.kinds.includes(o.kind))
          .map((o) => ({ value: o.offerKey, label: o.label, name: o.name || pickLang(o.label), kind: o.kind }));
      }
      return view;
    });
    journeys.push({
      journeyKey: j.journeyKey,
      templateVersion: j.templateVersion,
      name: record.header.name,
      description: record.header.description,
      icon: record.header.display.icon,
      when: record.header.display.when,
      channels: definition.channelLadder,
      purpose: record.header.purpose,
      comingSoon: record.header.availability === 'coming_soon',
      defaultEnabled: j.defaultEnabled && record.header.availability !== 'coming_soon',
      required: j.required,
      priority: j.priority,
      slots,
      hasPreview: definition.previewSteps.length > 0,
      requiresStays: record.header.requiredCapabilities.includes('stays'),
    });
  }
  return {
    key,
    kind: content.kind,
    version: versionNumber,
    name: content.name,
    summary: content.summary,
    icon: content.icon,
    venueTypes: content.venueTypes,
    fitLabel: fitLabel(content.venueTypes),
    highlights: journeys.filter((j) => j.defaultEnabled).slice(0, 4).map((j) => j.name),
    journeys,
    offers: content.offerMenuDefaults,
    needsStayCalendar: journeys.some((j) => j.requiresStays),
    estimateHints: content.estimateHints,
  };
}
