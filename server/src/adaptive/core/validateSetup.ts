/**
 * Checks for an owner's setup of a playbook at one or more venues (PRD JS-1…JS-3),
 * and the extra pre-flight run on "Turn on" (PB-4).
 *
 *  S01  the venue belongs to the tenant and fits the playbook's venue types
 *  S02  at least one journey on; required journeys on; coming-soon journeys off
 *  S03  every blank of an enabled journey has a valid value
 *  S04  the playbook is published and shown in the gallery
 *  F01  the venue has a valid time zone (quiet hours are computed in it)
 *  F02  the account isn't lapsed
 *  F03  overlapping messages (Marketing tab, automations) were acknowledged
 *  W01  info: WhatsApp isn't used yet
 *  W02  warning: stay messages wait for the booking calendar
 */

import { pickLang, type JourneyDefinition, type JourneyTemplateHeader, type PlaybookContent, type SetupJourneyInput, type SlotValue } from './schemas';
import { VENUE_TYPE_LABELS, type Channel, type PlaybookKind, type VenueType } from './constants';
import { error, info, makeReport, warning, type Issue, type ValidationReport } from './issues';
import { checkSlotValue, slotStartValue } from './registry';

export interface SetupPlaybook {
  key: string;
  kind: PlaybookKind;
  status: 'draft' | 'published' | 'deprecated';
  publishedVersion: number | null;
  /** Content of the version the setup pins (the published one for new setups). */
  content: PlaybookContent;
}

export interface SetupTemplate {
  header: JourneyTemplateHeader;
  version: number;
  definition: JourneyDefinition;
}

export interface SetupVenue {
  venueId: string;
  tenantUserId: string | null;
  venueType: string | null;
  name: string;
}

export interface ResolvedJourneyConfig {
  enabled: boolean;
  templateVersion: number;
  slots: Record<string, SlotValue>;
}

/**
 * Merge what the owner sent with what the venue already has (`base`) and the
 * playbook's defaults, in that order. Journeys and blanks the owner didn't
 * mention keep their current values, so an MCP client or a partial form can't
 * accidentally reset or switch everything off. Only what the owner explicitly
 * sent can fail S02 (a stored value is corrected instead: required stays on,
 * coming soon stays off).
 */
export function resolveSetupJourneys(
  input: Record<string, SetupJourneyInput>,
  playbook: SetupPlaybook,
  templates: Map<string, SetupTemplate>,
  base?: Record<string, { enabled: boolean; slots: Record<string, SlotValue> }>,
): { journeys: Record<string, ResolvedJourneyConfig>; issues: Issue[] } {
  const issues: Issue[] = [];
  const journeys: Record<string, ResolvedJourneyConfig> = {};
  const known = new Set(playbook.content.journeys.map((j) => j.journeyKey));

  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push(error('S02', `“${key}” isn't part of this playbook`, `journeys.${key}`));
  }

  for (const j of playbook.content.journeys) {
    const template = templates.get(j.journeyKey);
    if (!template) {
      issues.push(error('S04', `Journey “${j.journeyKey}” is missing from the catalogue`, `journeys.${j.journeyKey}`));
      continue;
    }
    const label = pickLang(template.header.name) || j.journeyKey;
    const given = input[j.journeyKey];
    const current = base?.[j.journeyKey];
    const comingSoon = template.header.availability === 'coming_soon';
    let enabled = given ? given.enabled : current ? current.enabled : j.defaultEnabled;
    if (!given) enabled = (enabled || j.required) && !comingSoon;

    if (comingSoon && enabled) issues.push(error('S02', `${label} is coming soon and can't be switched on yet`, `journeys.${j.journeyKey}.enabled`));
    if (j.required && !enabled) issues.push(error('S02', `${label} is required for this playbook`, `journeys.${j.journeyKey}.enabled`));

    const slots: Record<string, SlotValue> = {};
    for (const [slotKey, def] of Object.entries(template.definition.slots)) {
      const hasGiven = given?.slots && Object.prototype.hasOwnProperty.call(given.slots, slotKey);
      const hasCurrent = current?.slots && Object.prototype.hasOwnProperty.call(current.slots, slotKey);
      const value = hasGiven
        ? (given!.slots[slotKey] as SlotValue)
        : hasCurrent
          ? (current!.slots[slotKey] as SlotValue)
          : (j.slotDefaults?.[slotKey] ?? slotStartValue(def));
      slots[slotKey] = value;
      if (enabled) {
        const reason = checkSlotValue(def, value, { offers: playbook.content.offerMenuDefaults });
        if (reason) {
          issues.push(error('S03', `${label}: “${pickLang(def.label) || slotKey}” ${reason}`, `journeys.${j.journeyKey}.slots.${slotKey}`));
        }
      }
    }
    for (const slotKey of Object.keys(given?.slots ?? {})) {
      if (!template.definition.slots[slotKey]) {
        issues.push(error('S03', `${label}: there is no blank called “${slotKey}”`, `journeys.${j.journeyKey}.slots.${slotKey}`));
      }
    }
    journeys[j.journeyKey] = { enabled, templateVersion: j.templateVersion, slots };
  }

  if (!Object.values(journeys).some((j) => j.enabled)) {
    issues.push(error('S02', 'Turn on at least one journey', 'journeys'));
  }
  return { journeys, issues };
}

export function checkPlaybookIsOffered(
  playbook: SetupPlaybook | null,
  expectKind: PlaybookKind = 'marketing',
  opts: { allowHidden?: boolean } = {},
): Issue[] {
  if (!playbook) return [error('S04', 'This playbook does not exist')];
  // Hidden (deprecated) = no new setups; venues that already run it may still edit it.
  const offered = playbook.status === 'published' || (opts.allowHidden && playbook.status === 'deprecated');
  if (!offered || !playbook.publishedVersion) {
    return [error('S04', `“${pickLang(playbook.content.name) || playbook.key}” isn't available to set up`)];
  }
  if (playbook.kind !== expectKind) {
    return [error('S04', expectKind === 'marketing' ? 'Pick a marketing playbook here — Guest info is its own switch' : 'This is not a Guest info playbook')];
  }
  return [];
}

export function checkVenues(
  venueIds: string[],
  venues: Map<string, SetupVenue | null>,
  tenantUserId: string,
  playbook: SetupPlaybook,
): Issue[] {
  const issues: Issue[] = [];
  const fits = playbook.content.venueTypes;
  for (const venueId of venueIds) {
    const venue = venues.get(venueId);
    if (!venue || venue.tenantUserId !== tenantUserId) {
      issues.push(error('S01', `Venue ${venueId} was not found in this account`, `venues.${venueId}`));
      continue;
    }
    const type = (venue.venueType ?? 'other') as VenueType;
    if (!fits.includes(type)) {
      const forWhat = fits.map((t) => VENUE_TYPE_LABELS[t]).join(', ') || 'no venue type yet';
      issues.push(error('S01', `${venue.name} is ${VENUE_TYPE_LABELS[type] ?? type}; this playbook is for ${forWhat}`, `venues.${venueId}`));
    }
  }
  return issues;
}

export function validateSetup(params: {
  tenantUserId: string;
  venueIds: string[];
  journeys: Record<string, SetupJourneyInput>;
  playbook: SetupPlaybook | null;
  templates: Map<string, SetupTemplate>;
  venues: Map<string, SetupVenue | null>;
  /** Every venue already has a setup of this playbook (editing, not a new setup). */
  existingSetups?: boolean;
}): { report: ValidationReport; journeys: Record<string, ResolvedJourneyConfig> } {
  const offered = checkPlaybookIsOffered(params.playbook, 'marketing', { allowHidden: params.existingSetups });
  if (offered.length || !params.playbook) return { report: makeReport(offered), journeys: {} };
  const venueIssues = checkVenues(params.venueIds, params.venues, params.tenantUserId, params.playbook);
  const resolved = resolveSetupJourneys(params.journeys, params.playbook, params.templates);
  return { report: makeReport([...venueIssues, ...resolved.issues]), journeys: resolved.journeys };
}

// ── Turn-on pre-flight ───────────────────────────────────────────────────────

export interface PreflightVenue {
  venueId: string;
  name: string;
  timezone: string | null;
  lapsed: boolean;
  overlap: { legacyOnConnectChannels: Channel[]; automations: Array<{ campaignId: string; name: string }> };
  overlapAcknowledged: boolean;
}

export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function hasOverlap(v: PreflightVenue): boolean {
  return v.overlap.legacyOnConnectChannels.length > 0 || v.overlap.automations.length > 0;
}

export function preflightTurnOn(
  venues: PreflightVenue[],
  opts: { enabledLadders: Channel[][]; needsStayCalendar: boolean },
): Issue[] {
  const issues: Issue[] = [];
  for (const v of venues) {
    if (!isValidTimeZone(v.timezone)) {
      issues.push(error('F01', `${v.name}: set the time zone, so messages never go out at night`, `venues.${v.venueId}.timezone`));
    }
    if (v.lapsed) {
      issues.push(error('F02', `${v.name}: the subscription isn't active, so nothing could be sent`, `venues.${v.venueId}`));
    }
    if (hasOverlap(v) && !v.overlapAcknowledged) {
      issues.push(error('F03', `${v.name}: confirm you've seen that guests may get two welcome messages`, `venues.${v.venueId}.overlap`));
    }
  }
  if (opts.enabledLadders.some((ladder) => ladder.includes('whatsapp'))) {
    issues.push(info('W01', 'WhatsApp isn’t used yet — SMS and email are used until the WhatsApp templates are approved'));
  }
  if (opts.needsStayCalendar) {
    issues.push(warning('W02', 'Stay messages wait until your booking calendar is linked (coming with stay messages)'));
  }
  return issues;
}
