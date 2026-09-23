/**
 * Checks for a playbook version — the admin "Check" dialog, the publish gate
 * and the seed all run this one function.
 *
 *  K01  shape errors;  K02  kind changed after first publish
 *  P01  has an English name
 *  P02  has at least one journey
 *  P03  required journeys are on by default
 *  P04  journeys pinned to their newest version (warning)
 *  P05  questions exist, are switched on and fit the venue types (warning)
 *  P06  every pinned journey version exists and is published
 *  P07  coming-soon journeys are off by default and not required
 *  V04  offers within the platform bounds; offer blanks have an offer to pick; defaults in bounds
 *  V07  wording exists in the required languages (warning; WhatsApp is info)
 *  V09  venue types set, and every journey supports every one of them
 *  V10  no two marketing journeys start on the same trigger (warning)
 *  V14  an info (utility) playbook holds only info journeys and no offers
 */

import {
  pickLang,
  playbookContentSchema,
  type JourneyDefinition,
  type JourneyTemplateHeader,
  type PlaybookContent,
  type Question,
} from './schemas';
import { VENUE_TYPE_LABELS, type Channel, type Lang, type PlaybookKind } from './constants';
import { error, info, makeReport, warning, zodIssues, type Issue, type ValidationReport } from './issues';
import { canonicalJson } from './checksum';
import { checkSlotValue } from './registry';

export interface TemplateVersionInfo {
  state: 'draft' | 'published';
  definition: JourneyDefinition;
}

export interface TemplateInfo {
  header: JourneyTemplateHeader & { publishedVersion: number | null };
  versions: Map<number, TemplateVersionInfo>;
}

/** Active wording per pool: which languages exist for each channel. */
export type WordingIndex = Map<string, Partial<Record<Channel, Set<Lang>>>>;

export interface PlaybookCheckContext {
  templates: Map<string, TemplateInfo>;
  wording: WordingIndex;
  questions: Map<string, Question>;
  rules: { maxDiscountPct: number; offerExpiryDays: [number, number] };
  /** Kind of the published playbook, when there is one — kind can't change afterwards. */
  publishedKind?: PlaybookKind | null;
}

export function validatePlaybook(input: unknown, ctx: PlaybookCheckContext): ValidationReport {
  const parsed = playbookContentSchema.safeParse(input);
  if (!parsed.success) return makeReport(zodIssues(parsed.error));
  return makeReport(checkPlaybook(parsed.data, ctx));
}

export function checkPlaybook(content: PlaybookContent, ctx: PlaybookCheckContext): Issue[] {
  const issues: Issue[] = [];
  const types = content.venueTypes;

  if (ctx.publishedKind && ctx.publishedKind !== content.kind) {
    issues.push(error('K02', `The kind is fixed after the first publish (it is ${ctx.publishedKind})`, 'kind'));
  }

  // P01
  const name = content.name.en.trim();
  if (!name) issues.push(error('P01', 'Give the playbook a name owners understand', 'name.en'));
  else if (name.length > 60) issues.push(error('P01', 'Keep the name to 60 characters', 'name.en'));

  // P02
  if (content.journeys.length === 0) issues.push(error('P02', 'Add at least one journey', 'journeys'));

  // V09 — venue types
  if (types.length === 0) issues.push(error('V09', 'Pick at least one venue type', 'venueTypes'));

  const seenKeys = new Set<string>();
  const marketingTriggers = new Map<string, string>();
  let offerBlanks = 0;
  let whatsappMissing = false;

  content.journeys.forEach((j, index) => {
    const path = `journeys.${index}`;
    if (seenKeys.has(j.journeyKey)) {
      issues.push(error('K01', `“${j.journeyKey}” is listed twice`, path));
      return;
    }
    seenKeys.add(j.journeyKey);

    const template = ctx.templates.get(j.journeyKey);
    if (!template) {
      issues.push(error('P06', `Journey “${j.journeyKey}” doesn't exist`, path));
      return;
    }
    const label = pickLang(template.header.name) || j.journeyKey;
    const version = template.versions.get(j.templateVersion);

    // P06
    if (!version) {
      issues.push(error('P06', `${label}: version ${j.templateVersion} doesn't exist`, `${path}.templateVersion`));
      return;
    }
    if (version.state !== 'published') {
      issues.push(error('P06', `${label}: version ${j.templateVersion} isn't published yet`, `${path}.templateVersion`));
    }

    // P04
    const newest = template.header.publishedVersion;
    if (newest && j.templateVersion < newest) {
      issues.push(warning('P04', `${label}: pinned to v${j.templateVersion} (newest is v${newest})`, `${path}.templateVersion`));
    }

    // V09 — every journey supports every venue type of the playbook
    const unsupported = types.filter((t) => !template.header.venueTypes.includes(t));
    if (unsupported.length) {
      issues.push(error('V09', `${label} doesn't support ${unsupported.map((t) => VENUE_TYPE_LABELS[t]).join(', ')}`, path));
    }

    // P03 / P07
    const comingSoon = template.header.availability === 'coming_soon';
    if (j.required && !j.defaultEnabled) {
      issues.push(error('P03', `${label} is required, so it must be on by default`, `${path}.defaultEnabled`));
    }
    if (comingSoon && (j.defaultEnabled || j.required)) {
      issues.push(error('P07', `${label} is coming soon — it can't be on by default or required yet`, path));
    }

    // V14 — info playbooks
    if (content.kind === 'utility' && template.header.purpose !== 'service') {
      issues.push(error('V14', `An info playbook can only hold info journeys (${label} is ${template.header.purpose})`, path));
    }

    const def = version.definition;

    // V04 — slot defaults must fit their blanks
    for (const [slotKey, value] of Object.entries(j.slotDefaults ?? {})) {
      const slot = def.slots[slotKey];
      if (!slot) {
        issues.push(error('V04', `${label}: default for an unknown blank “${slotKey}”`, `${path}.slotDefaults.${slotKey}`));
        continue;
      }
      const reason = checkSlotValue(slot, value, { offers: content.offerMenuDefaults });
      if (reason) issues.push(error('V04', `${label}: default “${pickLang(slot.label) || slotKey}” ${reason}`, `${path}.slotDefaults.${slotKey}`));
    }
    const hasOfferBlank = Object.values(def.slots).some((s) => s.type === 'offer');
    if (hasOfferBlank && !comingSoon) offerBlanks += 1;

    // V07 — wording for available journeys
    if (!comingSoon) {
      for (const [poolKey, pool] of Object.entries(def.pools)) {
        const have = ctx.wording.get(poolKey) ?? {};
        const poolLabel = pool.name ? pickLang(pool.name) : poolKey;
        for (const channel of pool.channels) {
          if (channel === 'whatsapp') {
            if (!have.whatsapp?.size) whatsappMissing = true;
            continue;
          }
          const langs = have[channel];
          if (!langs || !langs.has('en')) {
            issues.push(warning('V07', `${label} · ${poolLabel} · ${channel.toUpperCase()}: no English wording yet`, `${path}`));
            continue;
          }
          for (const lang of pool.requiredLocales) {
            if (!langs.has(lang)) {
              issues.push(warning('V07', `${label} · ${poolLabel} · ${channel.toUpperCase()}: missing ${lang.toUpperCase()} — English would be sent instead`, path));
            }
          }
        }
      }
    }

    // V10 — marketing journeys competing for the same moment
    if (!comingSoon && template.header.purpose !== 'service') {
      const triggerKey = canonicalJson(def.entry.trigger);
      const other = marketingTriggers.get(triggerKey);
      if (other) issues.push(warning('V10', `${other} and ${label} start on the same trigger and compete for the weekly limit`, path));
      else marketingTriggers.set(triggerKey, label);
    }
  });

  // V04 — offers
  const offerKeys = new Set<string>();
  const [minDays, maxDays] = ctx.rules.offerExpiryDays;
  content.offerMenuDefaults.forEach((offer, index) => {
    const path = `offerMenuDefaults.${index}`;
    const label = offer.name || pickLang(offer.label) || offer.offerKey;
    if (offerKeys.has(offer.offerKey)) issues.push(error('K01', `Offer “${offer.offerKey}” is listed twice`, path));
    offerKeys.add(offer.offerKey);
    if (!offer.label.en.trim()) issues.push(error('V04', `${label}: needs the text guests see`, `${path}.label.en`));
    if (offer.kind === 'percent' && (offer.value < 1 || offer.value > ctx.rules.maxDiscountPct)) {
      issues.push(error('V04', `${label}: discounts must be 1–${ctx.rules.maxDiscountPct}%`, `${path}.value`));
    }
    if ((offer.kind === 'amount' || offer.kind === 'upsell') && offer.value <= 0) {
      issues.push(error('V04', `${label}: needs an amount`, `${path}.value`));
    }
    if (offer.expiryDays < minDays || offer.expiryDays > maxDays) {
      issues.push(error('V04', `${label}: “valid for” must be ${minDays}–${maxDays} days`, `${path}.expiryDays`));
    }
  });
  if (offerBlanks > 0 && content.offerMenuDefaults.length === 0) {
    issues.push(error('V04', 'A journey here gives an offer — add at least one default offer', 'offerMenuDefaults'));
  }
  if (content.kind === 'utility' && content.offerMenuDefaults.length > 0) {
    issues.push(error('V14', "Info playbooks can't carry offers", 'offerMenuDefaults'));
  }

  // P05 — questions
  const seenQuestions = new Set<string>();
  content.questionKeys.forEach((key, index) => {
    const path = `questionKeys.${index}`;
    if (seenQuestions.has(key)) {
      issues.push(error('K01', `Question “${key}” is listed twice`, path));
      return;
    }
    seenQuestions.add(key);
    const q = ctx.questions.get(key);
    if (!q) {
      issues.push(warning('P05', `Question “${key}” isn't in the question bank`, path));
      return;
    }
    const prompt = pickLang(q.prompt);
    if (q.status !== 'active') issues.push(warning('P05', `“${prompt}” is switched off in the question bank`, path));
    const misfit = types.filter((t) => !q.venueTypes.includes(t));
    if (misfit.length) issues.push(warning('P05', `“${prompt}” isn't asked at ${misfit.map((t) => VENUE_TYPE_LABELS[t]).join(', ')}`, path));
  });

  if (whatsappMissing) {
    issues.push(info('V07', 'WhatsApp isn’t used yet — it starts once the catalogue templates are approved by Meta'));
  }

  return issues;
}
