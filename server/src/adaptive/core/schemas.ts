/**
 * Adaptive Campaigns — Zod schemas for every document shape the platform authors
 * and every body the internal API accepts.
 *
 * Shape errors are reported as `K01` issues (see validatePlaybook); the semantic
 * rules (P01…, V04…, S01…) live in the validate* modules. Keeping the two apart
 * means a draft can be half-finished and still be saved, while publishing and
 * turning on stay strict.
 */

import { z } from 'zod';
import {
  CHANNELS,
  KEY_PATTERN,
  LANGS,
  OFFER_KINDS,
  PLAYBOOK_ICONS,
  PLAYBOOK_KEY_PATTERN,
  PLAYBOOK_KINDS,
  VENUE_TYPES,
  type Lang,
} from './constants';

// ── Primitives ───────────────────────────────────────────────────────────────

export const keySchema = z.string().regex(KEY_PATTERN, 'Use lowercase letters, digits and _ (start with a letter)');
export const playbookKeySchema = z.string().regex(PLAYBOOK_KEY_PATTERN, 'Use 3–40 lowercase letters, digits and _');

/** Text per language. English is the fallback, so it is always present (may be empty in a draft). */
export const i18nSchema = z.object({
  en: z.string().max(500),
  de: z.string().max(500).optional(),
  it: z.string().max(500).optional(),
  fr: z.string().max(500).optional(),
});
export type I18n = z.infer<typeof i18nSchema>;

/** "15m", "48h", "3d". */
export const durationSchema = z.string().regex(/^\d{1,4}(m|h|d)$/, 'Durations look like 15m, 48h or 3d');
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times look like 09:00');

export const venueTypeSchema = z.enum(VENUE_TYPES);
export const channelSchema = z.enum(CHANNELS);
export const langSchema = z.enum(LANGS);

// ── Conditions (no code, no eval — 03-playbook-format §5) ────────────────────

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      fact: string;
      eq?: unknown;
      ne?: unknown;
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
      in?: unknown[];
      exists?: boolean;
    };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
    z.object({
      fact: z.string().min(1),
      eq: z.unknown().optional(),
      ne: z.unknown().optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
      in: z.array(z.unknown()).optional(),
      exists: z.boolean().optional(),
    }),
  ]),
);

// ── Offers and slots ─────────────────────────────────────────────────────────

/**
 * One offer an owner can approve. `value` means: percent → 1–50, amount/upsell →
 * minor units of `currency`, free_item → 0. `label` is guest-facing and used
 * mid-sentence ("Come back for {{offer.label}}").
 */
export const offerSchema = z.object({
  offerKey: keySchema,
  name: z.string().max(60).default(''),
  label: i18nSchema,
  kind: z.enum(OFFER_KINDS),
  value: z.number().min(0),
  currency: z.string().length(3).optional(),
  expiryDays: z.number().int(),
});
export type Offer = z.infer<typeof offerSchema>;

const slotBase = {
  label: i18nSchema,
  help: i18nSchema.optional(),
  required: z.boolean().default(false),
};

/** A blank the owner fills in. Every type has bounds the editor and the checks both enforce. */
export const slotDefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    ...slotBase,
    placeholder: i18nSchema.optional(),
    maxLength: z.number().int().min(1).max(500),
    i18n: z.boolean().default(false),
    default: z.union([z.string(), i18nSchema]).nullable().optional(),
  }),
  z.object({
    type: z.literal('int'),
    ...slotBase,
    unit: z.string().max(12).optional(),
    min: z.number().int(),
    max: z.number().int(),
    default: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('days'),
    ...slotBase,
    min: z.number().int().min(1).default(1),
    max: z.number().int().max(365).default(90),
    default: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('url'),
    ...slotBase,
    placeholder: i18nSchema.optional(),
    default: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('offer'),
    ...slotBase,
    kinds: z.array(z.enum(OFFER_KINDS)).optional(),
  }),
  z.object({
    type: z.literal('time'),
    ...slotBase,
    default: hhmmSchema.optional(),
  }),
]);
export type SlotDef = z.infer<typeof slotDefSchema>;

/** Values an owner (or a playbook default) can put into a slot. */
export const slotValueSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), i18nSchema]);
export type SlotValue = z.infer<typeof slotValueSchema>;

// ── Journey templates (03-playbook-format §2) ────────────────────────────────

export const poolDefSchema = z.object({
  name: i18nSchema.optional(),
  purpose: z.enum(['marketing', 'service']),
  channels: z.array(channelSchema).min(1),
  requiredLocales: z.array(langSchema).default(['en']),
  whatsappCategory: z.enum(['marketing', 'utility']).optional(),
});
export type PoolDef = z.infer<typeof poolDefSchema>;

export const nodeSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  edges: z.record(z.string(), z.string()).default({}),
});
export type JourneyNode = z.infer<typeof nodeSchema>;

/** Drives "See what guests get": which messages to show, in order, and why. */
export const previewStepSchema = z.object({
  nodeId: z.string().min(1),
  pool: z.string().optional(),
  channel: z.enum(['sms', 'email', 'whatsapp', 'page']),
  when: i18nSchema,
  why: i18nSchema,
});
export type PreviewStep = z.infer<typeof previewStepSchema>;

export const journeyDefinitionSchema = z.object({
  entry: z.object({
    trigger: z.object({
      type: z.string().min(1),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
    requires: z.array(z.string()).default([]),
    when: conditionSchema.optional(),
    reentry: z.object({
      mode: z.enum(['never', 'after_exit', 'cooldown']),
      cooldown: durationSchema.optional(),
    }),
  }),
  exitOn: z
    .array(z.object({ event: z.string().min(1), where: z.record(z.string(), z.unknown()).optional() }))
    .default([]),
  goal: z
    .object({
      event: z.string().min(1),
      within: durationSchema,
      onReach: z.string().optional(),
      exit: z.enum(['converted', 'completed']).default('converted'),
    })
    .optional(),
  caps: z.object({ maxTouches: z.number().int().min(1), stopAfterClicks: z.number().int().min(1) }).optional(),
  channelLadder: z.array(channelSchema).min(1),
  slots: z.record(keySchema, slotDefSchema).default({}),
  pools: z.record(keySchema, poolDefSchema).default({}),
  autonomy: z
    .object({
      allowed: z.array(z.string()).default([]),
      bounds: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  start: z.string().min(1),
  nodes: z.record(z.string().min(1), nodeSchema),
  previewSteps: z.array(previewStepSchema).default([]),
});
export type JourneyDefinition = z.infer<typeof journeyDefinitionSchema>;

/** Header of a journey template: what playbooks, owners and the checks read. */
export const journeyTemplateHeaderSchema = z.object({
  key: keySchema,
  name: i18nSchema,
  description: i18nSchema,
  purpose: z.enum(['marketing', 'service', 'mixed']),
  venueTypes: z.array(venueTypeSchema).min(1),
  availability: z.enum(['available', 'coming_soon']),
  kpi: z.string().nullable().default(null),
  requiredCapabilities: z.array(z.string()).default([]),
  display: z.object({ icon: z.string().max(30), when: i18nSchema }),
});
export type JourneyTemplateHeader = z.infer<typeof journeyTemplateHeaderSchema>;

// ── Playbooks (03-playbook-format §9, 02-firestore-schema §3.1) ──────────────

export const playbookJourneySchema = z.object({
  journeyKey: keySchema,
  templateVersion: z.number().int().min(1),
  defaultEnabled: z.boolean(),
  required: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).default(50),
  slotDefaults: z.record(z.string(), slotValueSchema).default({}),
});
export type PlaybookJourney = z.infer<typeof playbookJourneySchema>;

export const estimateHintsSchema = z.object({
  avgTouchesPerGuest: z.record(z.string(), z.number().min(0).max(20)).default({}),
  returnRate: z.number().min(0).max(1).default(0),
  avgSpend: z
    .object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) })
    .default({ amountMinor: 0, currency: 'CHF' }),
});
export type EstimateHints = z.infer<typeof estimateHintsSchema>;

/** The editable content of a playbook version. Drafts save this; publishing freezes it. */
export const playbookContentSchema = z.object({
  kind: z.enum(PLAYBOOK_KINDS),
  name: i18nSchema,
  summary: i18nSchema,
  icon: z.enum(PLAYBOOK_ICONS),
  venueTypes: z.array(venueTypeSchema).max(VENUE_TYPES.length),
  journeys: z.array(playbookJourneySchema).max(20),
  offerMenuDefaults: z.array(offerSchema).max(20).default([]),
  questionKeys: z.array(keySchema).max(20).default([]),
  estimateHints: estimateHintsSchema.default({
    avgTouchesPerGuest: {},
    returnRate: 0,
    avgSpend: { amountMinor: 0, currency: 'CHF' },
  }),
});
export type PlaybookContent = z.infer<typeof playbookContentSchema>;

// ── Wording (02-firestore-schema §3.3) ───────────────────────────────────────

export const smsContentSchema = z.object({ text: z.string().min(1).max(1600) });
export const emailContentSchema = z.object({
  subject: z.string().min(1).max(200),
  preheader: z.string().max(200).default(''),
  bodyFormat: z.enum(['text', 'html', 'blocks']).default('text'),
  body: z.string().min(1).max(20000),
});
export const whatsappContentSchema = z.object({
  catalogueId: z.string().min(1),
  templateName: z.string().min(1),
  category: z.enum(['marketing', 'utility']),
  params: z.object({
    body: z.array(z.string()),
    buttons: z
      .array(z.object({ index: z.number().int(), type: z.literal('url'), value: z.string() }))
      .default([]),
  }),
});
export const channelContentSchema = z.object({
  sms: smsContentSchema.optional(),
  email: emailContentSchema.optional(),
  whatsapp: whatsappContentSchema.optional(),
});
export type ChannelContent = z.infer<typeof channelContentSchema>;

export const variantAxesSchema = z.object({
  hook: z.string().max(30),
  length: z.enum(['short', 'medium', 'long']),
  tone: z.string().max(30),
  emoji: z.boolean(),
});

/** Seed-side description of one platform wording; the store adds ids, hashes and timestamps. */
export const variantSeedSchema = z.object({
  poolKey: keySchema,
  journeyKey: keySchema,
  letter: z.string().regex(/^[A-Z]$/),
  name: z.string().min(1).max(60),
  purpose: z.enum(['marketing', 'service']),
  axes: variantAxesSchema,
  channels: channelContentSchema,
  locales: z.partialRecord(langSchema, channelContentSchema).default({}),
  /** Only picked when this holds, read against `slot.*` (PR C: the checkout wording without late checkout). */
  when: conditionSchema.optional(),
});
export type VariantSeed = z.infer<typeof variantSeedSchema>;

// ── Question bank, platform rules ────────────────────────────────────────────

export const questionSchema = z.object({
  key: keySchema,
  status: z.enum(['active', 'draft']),
  prompt: i18nSchema,
  chips: z.array(z.object({ value: keySchema, label: i18nSchema })).min(2).max(12),
  multi: z.boolean(),
  maxPicks: z.number().int().min(1).max(12),
  writesTag: keySchema,
  staleAfterDays: z.number().int().min(1).nullable(),
  venueTypes: z.array(venueTypeSchema).min(1),
  sortOrder: z.number().int(),
});
export type Question = z.infer<typeof questionSchema>;

const hhmmPair = z.tuple([hhmmSchema, hhmmSchema]);

export const adaptiveConfigSchema = z.object({
  quietHours: z.object({ start: hhmmSchema, end: hhmmSchema }),
  utilityQuietHours: z.object({ start: hhmmSchema, end: hhmmSchema }),
  slots: z.object({ morning: hhmmPair, afternoon: hhmmPair, evening: hhmmPair }),
  caps: z.object({
    maxTouchesPerJourney: z.number().int().min(1),
    stopAfterClicks: z.number().int().min(1),
    globalMarketingPer7Days: z.number().int().min(1),
  }),
  creditQueueHours: z.number().int().min(0),
  freezeWindowMinutes: z.number().int().min(0),
  offerBounds: z.object({
    maxDiscountPct: z.number().min(0).max(100),
    expiryDays: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  }),
  reviewDwellMinutes: z.number().int().min(0),
  replyNoticeCooldownDays: z.number().int().min(0),
  utilityFairUsePerVenuePerMonth: z.number().int().min(0),
  deferJitterMinutes: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  retention: z.object({
    eventsMonths: z.number().int().min(1),
    anonymizeAfterMonths: z.number().int().min(1),
    anonymizeFloorMonths: z.number().int().min(1),
  }),
  killSwitch: z.object({ sendingPaused: z.boolean(), reason: z.string().nullable() }),
});
export type AdaptiveConfig = z.infer<typeof adaptiveConfigSchema>;

// ── API bodies ───────────────────────────────────────────────────────────────

/** Who is asking. The internal API trusts its callers (x-internal-secret) and only records this. */
export const actorSchema = z.object({
  uid: z.string().min(1).max(128),
  kind: z.enum(['super_admin', 'tenant_user', 'mcp', 'seed']),
  role: z.string().max(40).optional(),
});
export type Actor = z.infer<typeof actorSchema>;

export const createPlaybookInputSchema = z.object({
  mode: z.enum(['blank', 'copy']),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(PLAYBOOK_KINDS).optional(),
  venueTypes: z.array(venueTypeSchema).default([]),
  copyFrom: playbookKeySchema.optional(),
});

export const saveDraftInputSchema = z.object({
  content: playbookContentSchema,
  /** The latestVersion the editor loaded; a mismatch means someone else changed it (409). */
  baseVersion: z.number().int().min(0),
});

export const publishInputSchema = z.object({
  changelog: z.string().trim().min(3).max(500),
  draftVersion: z.number().int().min(1),
});

export const setListedInputSchema = z.object({ listed: z.boolean() });
export const restoreInputSchema = z.object({}).optional();
export const venueActionInputSchema = z.object({
  playbookKey: playbookKeySchema.optional(),
  overlapAck: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export const setAvailabilityInputSchema = z.object({ availability: z.enum(['available', 'coming_soon']) });

export const setupJourneyInputSchema = z.object({
  enabled: z.boolean(),
  slots: z.record(z.string(), slotValueSchema).default({}),
});
export type SetupJourneyInput = z.infer<typeof setupJourneyInputSchema>;

export const setupInputSchema = z.object({
  playbookKey: playbookKeySchema,
  /** Pinned playbook version; defaults to the live one. Editing an existing setup sends its pin. */
  playbookVersion: z.number().int().min(1).optional(),
  venueIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  journeys: z.record(keySchema, setupJourneyInputSchema),
  timezones: z.record(z.string(), z.string().max(64)).default({}),
  overlapAck: z.record(z.string(), z.boolean()).default({}),
  guestInfo: z.boolean().optional(),
  activate: z.boolean().default(false),
  /** "Apply to guests already in these journeys?" — they move to the new values at their next step. */
  applyToInFlight: z.boolean().optional(),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const estimateInputSchema = z.object({
  playbookKey: playbookKeySchema,
  playbookVersion: z.number().int().min(1).optional(),
  venueIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  journeys: z.record(keySchema, setupJourneyInputSchema),
});

export const previewInputSchema = z.object({
  playbookKey: playbookKeySchema,
  playbookVersion: z.number().int().min(1).optional(),
  journeyKey: keySchema,
  slots: z.record(z.string(), slotValueSchema).default({}),
  lang: langSchema.default('en'),
  venueId: z.string().min(1).max(128).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** English fallback, as the engine will do for guests (PRD JS-6). */
export function pickLang(text: I18n | null | undefined, lang: Lang = 'en'): string {
  if (!text) return '';
  const value = text[lang];
  return value && value.trim() ? value : text.en || '';
}

/** Trim every language and drop empty optional ones, so '' never shadows the English fallback. */
export function cleanI18n(text: I18n): I18n {
  const out: I18n = { en: (text.en || '').trim() };
  for (const lang of ['de', 'it', 'fr'] as const) {
    const v = text[lang];
    if (typeof v === 'string' && v.trim()) out[lang] = v.trim();
  }
  return out;
}

export function isI18n(value: unknown): value is I18n {
  return Boolean(value) && typeof value === 'object' && typeof (value as I18n).en === 'string';
}
