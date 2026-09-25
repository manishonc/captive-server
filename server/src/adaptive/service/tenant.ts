/**
 * Owner-side operations: the playbook gallery, a venue's setups, the checks,
 * the estimate, the guest preview, and saving / turning on / switching /
 * pausing. The CMS (tenant routes) and the MCP tools both call these through
 * `/internal/adaptive/tenants/:tenantUserId/*`; every venue is re-checked
 * against the tenant here, whatever the caller already checked.
 *
 * Nothing here sends a message: there is no engine yet, and the platform kill
 * switch (`AdaptiveConfig/global.killSwitch.sendingPaused`) starts on.
 */

import { getPlaybookHeader, getPlaybookVersion, listPlaybookHeaders } from '../store/definitions';
import {
  applyVenueChanges,
  getAdaptiveVenue,
  getVenuePlaybook,
  GUEST_INFO_KEY,
  listAdaptiveVenues,
  listVenuePlaybooks,
  VenueChangeError,
  type VenueChange,
} from '../store/venueSetups';
import { detectOverlap, getVenues, listTenantVenues, recentCaptureStats, type TenantVenue } from '../store/tenantData';
import { toJson } from '../store/serialize';
import type { AdaptiveVenueDoc, PlaybookHeaderDoc, PlaybookVersionDoc, VenueJourneyConfigDoc } from '../store/types';
import {
  estimateInputSchema,
  pickLang,
  previewInputSchema,
  setupInputSchema,
  type Actor,
  type ChannelContent,
  type SetupInput,
} from '../core/schemas';
import {
  isValidTimeZone,
  preflightTurnOn,
  resolveSetupJourneys,
  validateSetup,
  type PreflightVenue,
  type SetupVenue,
} from '../core/validateSetup';
import { error as issueError, makeReport, type Issue, type ValidationReport } from '../core/issues';
import { estimateMonthly, type EstimateResult } from '../core/estimate';
import { renderText, sampleValues } from '../core/render';
import type { Channel, Lang, VenueType } from '../core/constants';
import { VENUE_TYPES } from '../core/constants';
import { ApiError, conflict, notFound, validationFailed } from '../api/errors';
import {
  loadCatalogue,
  ownerPlaybookView,
  setupPlaybook,
  setupTemplates,
  templateVersion,
  versionContent,
  type Catalogue,
  type OwnerPlaybookView,
} from './catalogue';
import { getCreditConfig } from '../../services/credits';
import { isLapsedForSending } from '../../services/entitlements';

function asVenueType(t: string | null): VenueType {
  return (VENUE_TYPES as readonly string[]).includes(t ?? '') ? (t as VenueType) : 'other';
}

function setupVenue(v: TenantVenue): SetupVenue {
  return { venueId: v.venueId, tenantUserId: v.tenantUserId, venueType: v.venueType, name: v.name };
}

/** Venues of this tenant only; anything else is reported as not found. */
async function ownedVenues(tenantUserId: string, venueIds: string[]): Promise<Map<string, TenantVenue>> {
  const venues = await getVenues([...new Set(venueIds)]);
  const out = new Map<string, TenantVenue>();
  for (const [id, v] of venues) {
    if (!v || v.tenantUserId !== tenantUserId) throw new ApiError('forbidden', `Venue ${id} was not found in this account`);
    out.set(id, v);
  }
  return out;
}

async function livePlaybook(key: string, version?: number): Promise<{ header: PlaybookHeaderDoc; version: PlaybookVersionDoc }> {
  const header = await getPlaybookHeader(key);
  if (!header || !header.publishedVersion) throw notFound('This playbook is not available');
  const n = version ?? header.publishedVersion;
  const v = await getPlaybookVersion(key, n);
  if (!v || v.state !== 'published') throw notFound(`Version ${n} of this playbook is not available`);
  return { header, version: v };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface GalleryPlaybook extends OwnerPlaybookView {
  fitsVenueIds: string[];
}

export async function getGallery(tenantUserId: string): Promise<{ playbooks: GalleryPlaybook[]; guestInfo: OwnerPlaybookView | null }> {
  const [venues, headers, cat] = await Promise.all([listTenantVenues(tenantUserId), listPlaybookHeaders(), loadCatalogue()]);
  const offered = headers.filter((h) => h.status === 'published' && h.publishedVersion).sort((a, b) => a.sortOrder - b.sortOrder);
  const versions = await Promise.all(offered.map((h) => getPlaybookVersion(h.key, h.publishedVersion as number)));

  const playbooks: GalleryPlaybook[] = [];
  let guestInfo: OwnerPlaybookView | null = null;
  offered.forEach((h, i) => {
    const v = versions[i];
    if (!v) return;
    const view = ownerPlaybookView(h.key, v.version, versionContent(v), cat);
    if (h.kind === 'utility') {
      if (!guestInfo || h.key === GUEST_INFO_KEY) guestInfo = view;
      return;
    }
    const fits = venues.filter((venue) => view.venueTypes.includes(asVenueType(venue.venueType))).map((venue) => venue.venueId);
    playbooks.push({ ...view, fitsVenueIds: fits });
  });
  return { playbooks, guestInfo };
}

export async function getOverview(tenantUserId: string) {
  const [venues, adaptive, setups, headers, cat] = await Promise.all([
    listTenantVenues(tenantUserId),
    listAdaptiveVenues(tenantUserId),
    listVenuePlaybooks(tenantUserId),
    listPlaybookHeaders(),
    loadCatalogue(),
  ]);
  const overlap = await detectOverlap(tenantUserId, venues.map((v) => v.venueId));
  const byVenue = new Map(adaptive.map((a) => [a.venueId, a]));
  const headerOf = new Map(headers.map((h) => [h.key, h]));

  const out = venues.map((v) => {
    const av = byVenue.get(v.venueId) ?? null;
    const venueSetups = setups
      .filter((s) => s.venueId === v.venueId)
      .map((s) => {
        const h = headerOf.get(s.playbookKey);
        return {
          playbookKey: s.playbookKey,
          name: h?.name ?? { en: s.playbookKey },
          icon: h?.icon ?? 'layers',
          kind: s.kind,
          state: s.state,
          playbookVersion: s.playbookVersion,
          latestPublishedVersion: h?.publishedVersion ?? null,
          configVersion: s.configVersion,
          journeysOn: Object.entries(s.journeys)
            .filter(([, j]) => j.enabled)
            .map(([key]) => ({ journeyKey: key, name: cat.templates.get(key)?.header.name ?? { en: key } })),
          lastEditedAt: toJson(s.lastEditedAt),
        };
      });
    return {
      venueId: v.venueId,
      name: v.name,
      venueType: asVenueType(v.venueType),
      address: v.address,
      venueTimezone: v.timezone,
      timezone: av?.timezone ?? v.timezone,
      adaptive: av
        ? {
            status: av.status,
            activePlaybookKey: av.activePlaybookKey,
            activatedAt: toJson(av.activatedAt),
            guestInfo: { enabled: Boolean(av.utility?.enabled) },
            overlapAcknowledgedAt: toJson(av.overlap?.acknowledgedAt ?? null),
            estimate: av.estimate ? toJson(av.estimate) : null,
          }
        : null,
      setups: venueSetups,
      overlap: overlap.get(v.venueId) ?? { legacyOnConnectChannels: [], automations: [] },
    };
  });
  return {
    accountOn: adaptive.some((a) => a.status === 'on' || a.status === 'paused'),
    sendingLive: !cat.config.killSwitch.sendingPaused,
    venues: out,
  };
}

export async function getSetup(tenantUserId: string, venueId: string, playbookKey: string) {
  await ownedVenues(tenantUserId, [venueId]);
  const setup = await getVenuePlaybook(venueId, playbookKey);
  if (!setup || setup.tenantUserId !== tenantUserId) throw notFound('This venue has no setup for that playbook');
  const [{ version }, cat] = await Promise.all([livePlaybook(playbookKey, setup.playbookVersion), loadCatalogue()]);
  return { setup: toJson(setup), playbook: ownerPlaybookView(playbookKey, version.version, versionContent(version), cat) };
}

// ── Checks, estimate, preview ────────────────────────────────────────────────

async function resolveInput(tenantUserId: string, input: SetupInput) {
  const venueIds = [...new Set(input.venueIds)];
  const [{ header, version }, cat, venues, existing] = await Promise.all([
    livePlaybook(input.playbookKey, input.playbookVersion),
    loadCatalogue(),
    getVenues(venueIds),
    Promise.all(venueIds.map((id) => getVenuePlaybook(id, input.playbookKey))),
  ]);
  const playbook = setupPlaybook(header, version);
  const templates = setupTemplates(cat, playbook.content);
  const venueMap = new Map<string, SetupVenue | null>([...venues].map(([id, v]) => [id, v ? setupVenue(v) : null]));
  const existingSetups = existing.every((s) => s && s.tenantUserId === tenantUserId);
  const result = validateSetup({ tenantUserId, venueIds: input.venueIds, journeys: input.journeys, playbook, templates, venues: venueMap, existingSetups });
  return { header, version, playbook, templates, venues, cat, ...result };
}

export async function validateSetupInput(tenantUserId: string, body: unknown): Promise<{ report: ValidationReport }> {
  const input = setupInputSchema.parse(body);
  const { report } = await resolveInput(tenantUserId, input);
  return { report };
}

export async function estimate(tenantUserId: string, body: unknown): Promise<EstimateResult & { basis: string; returnRate: number; avgSpendMinor: number }> {
  const input = estimateInputSchema.parse(body);
  const venues = await ownedVenues(tenantUserId, input.venueIds);
  const [{ header, version }, cat, stats, rateCard] = await Promise.all([
    livePlaybook(input.playbookKey, input.playbookVersion),
    loadCatalogue(),
    recentCaptureStats(tenantUserId, [...venues.keys()]),
    getCreditConfig(),
  ]);
  const playbook = setupPlaybook(header, version);
  const templates = setupTemplates(cat, playbook.content);
  const { journeys } = resolveSetupJourneys(input.journeys, playbook, templates);
  const hints = playbook.content.estimateHints;
  const journeyInputs = Object.entries(journeys)
    .filter(([, j]) => j.enabled)
    .map(([key]) => {
      const t = templates.get(key);
      return {
        journeyKey: key,
        purpose: t?.header.purpose ?? 'marketing',
        avgTouchesPerGuest: hints.avgTouchesPerGuest[key] ?? 1,
        ladder: t?.definition.channelLadder ?? (['email'] as Channel[]),
      };
    });
  const currency = rateCard.defaultCurrency || 'CHF';
  const result = estimateMonthly(
    [...venues.keys()].map((id) => ({ venueId: id, ...(stats.get(id) ?? { captures30d: 0, optedIn30d: 0, withPhone: 0, emailOnly: 0 }) })),
    journeyInputs,
    {
      email: rateCard.channelRates.email.creditsPerMessage,
      sms: rateCard.channelRates.sms.creditsPerSegment,
      creditsPerUnit: rateCard.currencies[currency]?.creditsPerUnit ?? 100,
      currency,
    },
    { returnRate: hints.returnRate, avgSpendMinor: hints.avgSpend.amountMinor },
  );
  return { ...result, basis: 'Guests who said yes to messages in the last 30 days', returnRate: hints.returnRate, avgSpendMinor: hints.avgSpend.amountMinor };
}

export interface PreviewMessage {
  nodeId: string;
  channel: 'sms' | 'email' | 'whatsapp' | 'page';
  when: string;
  why: string;
  variantName: string | null;
  subject?: string;
  preheader?: string;
  text: string;
  unknown: string[];
}

function contentFor(channels: ChannelContent, locales: Record<string, Partial<ChannelContent> | undefined>, lang: Lang, channel: 'sms' | 'email') {
  return locales[lang]?.[channel] ?? channels[channel];
}

export async function preview(tenantUserId: string, body: unknown): Promise<{ journeyKey: string; lang: Lang; venueName: string; messages: PreviewMessage[] }> {
  const input = previewInputSchema.parse(body);
  let venueName = 'Your venue';
  if (input.venueId) venueName = (await ownedVenues(tenantUserId, [input.venueId])).get(input.venueId)?.name ?? venueName;
  const [{ header, version }, cat] = await Promise.all([livePlaybook(input.playbookKey, input.playbookVersion), loadCatalogue()]);
  const content = versionContent(version);
  const entry = content.journeys.find((j) => j.journeyKey === input.journeyKey);
  if (!entry) throw notFound('That journey is not part of this playbook');
  const found = templateVersion(cat, input.journeyKey, entry.templateVersion);
  if (!found) throw notFound('Journey not found');
  const playbook = setupPlaybook(header, version);
  const { journeys } = resolveSetupJourneys({ [input.journeyKey]: { enabled: true, slots: input.slots } }, playbook, setupTemplates(cat, content));
  const slots = journeys[input.journeyKey]?.slots ?? {};
  const values = sampleValues({ lang: input.lang, venueName, slots, offers: content.offerMenuDefaults });

  const messages: PreviewMessage[] = found.definition.previewSteps.map((step) => {
    const base = { nodeId: step.nodeId, channel: step.channel, when: pickLang(step.when, input.lang), why: pickLang(step.why, input.lang) };
    if (step.channel === 'page' || !step.pool) {
      const staff = typeof slots.staff_name === 'string' ? slots.staff_name : '';
      return { ...base, channel: 'page' as const, variantName: null, text: staff, unknown: [] };
    }
    const variant = cat.variants
      .filter((v) => v.poolKey === step.pool && v.status === 'active')
      .sort((a, b) => a.letter.localeCompare(b.letter))[0];
    if (!variant) return { ...base, variantName: null, text: '', unknown: [] };
    const wanted = step.channel === 'whatsapp' ? 'email' : step.channel;
    const channel = contentFor(variant.channels, variant.locales as Record<string, Partial<ChannelContent>>, input.lang, wanted)
      ? wanted
      : wanted === 'sms'
        ? 'email'
        : 'sms';
    const c = contentFor(variant.channels, variant.locales as Record<string, Partial<ChannelContent>>, input.lang, channel);
    if (!c) return { ...base, variantName: variant.name, text: '', unknown: [] };
    if (channel === 'email') {
      const email = c as NonNullable<ChannelContent['email']>;
      const subject = renderText(email.subject, values);
      const pre = renderText(email.preheader || '', values);
      const bodyText = renderText(email.body, values);
      return {
        ...base,
        channel: 'email' as const,
        variantName: variant.name,
        subject: subject.text,
        preheader: pre.text,
        text: bodyText.text,
        unknown: [...new Set([...subject.unknown, ...pre.unknown, ...bodyText.unknown])],
      };
    }
    const sms = renderText((c as NonNullable<ChannelContent['sms']>).text, values);
    return { ...base, channel: 'sms' as const, variantName: variant.name, text: sms.text, unknown: sms.unknown };
  });
  return { journeyKey: input.journeyKey, lang: input.lang, venueName, messages };
}

// ── Writes ───────────────────────────────────────────────────────────────────

function guestInfoJourneys(view: OwnerPlaybookView): Record<string, VenueJourneyConfigDoc> {
  const out: Record<string, VenueJourneyConfigDoc> = {};
  for (const j of view.journeys) {
    out[j.journeyKey] = {
      enabled: j.defaultEnabled,
      templateVersion: j.templateVersion,
      slots: Object.fromEntries(j.slots.map((s) => [s.key, s.default])),
    };
  }
  return out;
}

async function guestInfoWrite(cat: Catalogue, enabled: boolean) {
  const header = await getPlaybookHeader(GUEST_INFO_KEY);
  if (!header || !header.publishedVersion) throw notFound('Guest info is not available yet');
  const version = await getPlaybookVersion(GUEST_INFO_KEY, header.publishedVersion);
  if (!version) throw notFound('Guest info is not available yet');
  const view = ownerPlaybookView(GUEST_INFO_KEY, version.version, versionContent(version), cat);
  return { enabled, playbookVersion: version.version, journeys: guestInfoJourneys(view) };
}

function preflightVenue(v: TenantVenue, av: AdaptiveVenueDoc | null, tz: string | null, lapsed: boolean, overlap: { legacyOnConnectChannels: Channel[]; automations: Array<{ campaignId: string; name: string }> }, ack: boolean): PreflightVenue {
  const previouslyAcked = Boolean(av?.overlap?.acknowledgedAt);
  return { venueId: v.venueId, name: v.name, timezone: tz, lapsed, overlap, overlapAcknowledged: ack || previouslyAcked };
}

function mapVenueError(err: unknown): never {
  if (err instanceof VenueChangeError) throw err.code === 'not_found' ? notFound(err.message) : conflict(err.message);
  throw err;
}

/**
 * Save the owner's setup for one or more venues, and — when `activate` is set —
 * run the pre-flight and turn it on in the same transaction.
 */
export async function saveSetups(tenantUserId: string, body: unknown, actor: Actor) {
  const input = setupInputSchema.parse(body);
  const venueIds = [...new Set(input.venueIds)];
  const resolved = await resolveInput(tenantUserId, { ...input, venueIds });
  if (!resolved.report.ok) throw validationFailed('Some settings need fixing before saving', resolved.report.issues);

  const owned = await ownedVenues(tenantUserId, venueIds);
  const [overlaps, existing] = await Promise.all([detectOverlap(tenantUserId, venueIds), Promise.all(venueIds.map((id) => getAdaptiveVenue(id)))]);
  const avOf = new Map(venueIds.map((id, i) => [id, existing[i]]));

  const issues: Issue[] = [...resolved.report.issues];

  // Resolve per venue: blanks the owner didn't send keep that venue's current values.
  const current = await Promise.all(venueIds.map((id) => getVenuePlaybook(id, input.playbookKey)));
  const journeysOf = new Map<string, Record<string, VenueJourneyConfigDoc>>();
  venueIds.forEach((id, i) => {
    const per = resolveSetupJourneys(input.journeys, resolved.playbook, resolved.templates, current[i]?.journeys);
    for (const issue of per.issues) {
      if (issue.severity === 'error') issues.push({ ...issue, message: `${owned.get(id)!.name}: ${issue.message}` });
    }
    journeysOf.set(id, per.journeys);
  });

  const tzOf = new Map<string, string | null>();
  for (const id of venueIds) {
    const given = input.timezones[id];
    if (given !== undefined && given !== '' && !isValidTimeZone(given)) {
      issues.push(issueError('F01', `${owned.get(id)!.name}: “${given}” isn't a time zone`, `venues.${id}.timezone`));
    }
    tzOf.set(id, given ? given : avOf.get(id)?.timezone ?? owned.get(id)!.timezone);
  }
  if (issues.some((i) => i.severity === 'error')) throw validationFailed('Some settings need fixing before saving', issues);

  let estimateByVenue = new Map<string, { creditsPerMonth: number; revenuePerMonthMinor: number; currency: string }>();
  if (input.activate) {
    const lapsed = await isLapsedForSending(tenantUserId);
    const preflight = preflightTurnOn(
      venueIds.map((id) => preflightVenue(owned.get(id)!, avOf.get(id) ?? null, tzOf.get(id) ?? null, lapsed, overlaps.get(id)!, input.overlapAck[id] === true)),
      {
        enabledLadders: Object.entries(resolved.journeys).filter(([, j]) => j.enabled).map(([k]) => resolved.templates.get(k)?.definition.channelLadder ?? []),
        needsStayCalendar: [...owned.values()].some((v) => asVenueType(v.venueType) === 'airbnb') && ownerPlaybookView(input.playbookKey, resolved.version.version, resolved.playbook.content, resolved.cat).needsStayCalendar,
      },
    );
    issues.push(...preflight);
    if (preflight.some((i) => i.severity === 'error')) throw validationFailed('A few things are needed before turning on', preflight);
    try {
      const est = await estimate(tenantUserId, { playbookKey: input.playbookKey, playbookVersion: resolved.version.version, venueIds, journeys: input.journeys });
      estimateByVenue = new Map(
        est.perVenue.map((p) => [p.venueId, { creditsPerMonth: p.credits, revenuePerMonthMinor: p.revenueMinor, currency: est.currency }]),
      );
    } catch (err) {
      console.error('[ADAPTIVE] estimate at turn-on failed (continuing):', err);
    }
  }

  const gi = input.guestInfo === undefined ? undefined : await guestInfoWrite(resolved.cat, input.guestInfo);
  const offerMenu = resolved.playbook.content.offerMenuDefaults;
  const hints = resolved.playbook.content.estimateHints;
  const changes: VenueChange[] = venueIds.map((id) => {
    const venue = owned.get(id)!;
    const overlap = overlaps.get(id)!;
    return {
      venueId: id,
      tenantUserId,
      businessType: asVenueType(venue.venueType),
      timezone: tzOf.get(id) ?? null,
      overlap: { ...overlap, acknowledged: input.overlapAck[id] === true },
      avgSpendPerVisit: hints.avgSpend.amountMinor ? hints.avgSpend : null,
      estimate: estimateByVenue.get(id) ?? null,
      setup: { playbookKey: input.playbookKey, playbookVersion: resolved.version.version, journeys: journeysOf.get(id) ?? resolved.journeys, offerMenu },
      activateKey: input.activate ? input.playbookKey : undefined,
      guestInfo: gi,
    };
  });

  // Guests already in these journeys move to the new values at their next step (plan §3.10).
  if (input.applyToInFlight === true) for (const c of changes) if (c.setup) c.setup.applyToInFlight = true;
  const results = await applyVenueChanges(changes, actor).catch(mapVenueError);
  return { ok: true, results, report: makeReport(issues.filter((i) => i.severity !== 'error')) };
}

/** Turn on (or switch back to) a playbook this venue already has set up. */
export async function activateVenue(tenantUserId: string, venueId: string, body: { playbookKey?: string; overlapAck?: boolean }, actor: Actor) {
  if (!body.playbookKey) throw new ApiError('bad_request', 'Say which playbook to turn on');
  const owned = await ownedVenues(tenantUserId, [venueId]);
  const venue = owned.get(venueId)!;
  const [setup, av, overlaps, lapsed] = await Promise.all([
    getVenuePlaybook(venueId, body.playbookKey),
    getAdaptiveVenue(venueId),
    detectOverlap(tenantUserId, [venueId]),
    isLapsedForSending(tenantUserId),
  ]);
  if (!setup || setup.tenantUserId !== tenantUserId || setup.kind !== 'marketing') throw notFound('This venue has no setup for that playbook');
  const overlap = overlaps.get(venueId)!;
  const preflight = preflightTurnOn([preflightVenue(venue, av, av?.timezone ?? venue.timezone, lapsed, overlap, body.overlapAck === true)], {
    enabledLadders: [],
    needsStayCalendar: false,
  });
  if (preflight.some((i) => i.severity === 'error')) throw validationFailed('A few things are needed before turning on', preflight);
  const results = await applyVenueChanges(
    [
      {
        venueId,
        tenantUserId,
        businessType: asVenueType(venue.venueType),
        overlap: { ...overlap, acknowledged: body.overlapAck === true },
        activateKey: body.playbookKey,
      },
    ],
    actor,
  ).catch(mapVenueError);
  return { ok: true, results };
}

export async function pauseVenue(tenantUserId: string, venueId: string, actor: Actor) {
  const venue = (await ownedVenues(tenantUserId, [venueId])).get(venueId)!;
  const results = await applyVenueChanges([{ venueId, tenantUserId, businessType: asVenueType(venue.venueType), status: 'paused' }], actor).catch(mapVenueError);
  return { ok: true, results };
}

export async function resumeVenue(tenantUserId: string, venueId: string, actor: Actor) {
  const venue = (await ownedVenues(tenantUserId, [venueId])).get(venueId)!;
  const [av, lapsed] = await Promise.all([getAdaptiveVenue(venueId), isLapsedForSending(tenantUserId)]);
  const preflight = preflightTurnOn(
    [{ venueId, name: venue.name, timezone: av?.timezone ?? venue.timezone, lapsed, overlap: { legacyOnConnectChannels: [], automations: [] }, overlapAcknowledged: true }],
    { enabledLadders: [], needsStayCalendar: false },
  );
  if (preflight.some((i) => i.severity === 'error')) throw validationFailed('A few things are needed before resuming', preflight);
  const results = await applyVenueChanges([{ venueId, tenantUserId, businessType: asVenueType(venue.venueType), status: 'on' }], actor).catch(mapVenueError);
  return { ok: true, results };
}

export async function setGuestInfo(tenantUserId: string, venueId: string, enabled: boolean, actor: Actor) {
  const venue = (await ownedVenues(tenantUserId, [venueId])).get(venueId)!;
  const cat = await loadCatalogue();
  const gi = await guestInfoWrite(cat, enabled);
  const results = await applyVenueChanges([{ venueId, tenantUserId, businessType: asVenueType(venue.venueType), guestInfo: gi }], actor).catch(mapVenueError);
  return { ok: true, results };
}
