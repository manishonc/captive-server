/**
 * Adaptive Campaigns read tools: `list_playbooks`, `get_playbook`,
 * `list_playbook_setups`.
 *
 * These proxy captive-server's `/internal/adaptive/tenants/:id/*` API, which owns
 * every playbook rule — nothing is read from Firestore or re-derived here, so the
 * answers always match what the CMS shows the owner. Tenant-scoped via the
 * OAuth token. Read-only: setting up or turning on a playbook stays in the CMS.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NO_TENANT, addTool, errorResult, jsonResult, tenantFrom } from '../shared';
import { callServerInternalGet } from '../../serverClient';

type I18n = { en?: string; de?: string; it?: string; fr?: string };
type Lang = 'en' | 'de' | 'it' | 'fr';

function tr(text: unknown, lang: Lang): string {
  const t = (text ?? {}) as I18n;
  return (t[lang] && t[lang]!.trim()) || t.en || '';
}

async function adaptiveGet(tenantUserId: string, path: string) {
  const { status, data } = await callServerInternalGet(`/internal/adaptive/tenants/${encodeURIComponent(tenantUserId)}/${path}`);
  if (status >= 400 || data.ok === false) {
    return { error: String(data.error || `Adaptive Campaigns request failed (${status})`) };
  }
  return { data };
}

/** Owner-facing journey, in the chosen language. */
function journeyView(j: Record<string, any>, lang: Lang) {
  return {
    journeyKey: j.journeyKey,
    name: tr(j.name, lang),
    whatItDoes: tr(j.description, lang),
    when: tr(j.when, lang),
    channels: j.channels,
    type: j.purpose === 'service' ? 'info (free)' : 'marketing',
    onByDefault: j.defaultEnabled,
    required: j.required,
    comingSoon: j.comingSoon,
    blanks: (j.slots ?? []).map((s: Record<string, any>) => ({
      key: s.key,
      label: tr(s.label, lang),
      type: s.type,
      required: s.required,
      default: s.default && typeof s.default === 'object' ? tr(s.default, lang) : s.default,
      ...(s.min !== undefined ? { min: s.min, max: s.max } : {}),
      ...(s.maxLength ? { maxLength: s.maxLength } : {}),
      ...(s.options ? { options: s.options.map((o: Record<string, any>) => ({ value: o.value, label: tr(o.label, lang) })) } : {}),
    })),
  };
}

function playbookView(p: Record<string, any>, lang: Lang, detailed: boolean) {
  const base = {
    playbookKey: p.key,
    name: tr(p.name, lang),
    summary: tr(p.summary, lang),
    forVenues: p.fitLabel,
    version: p.version,
    fitsVenueIds: p.fitsVenueIds ?? [],
  };
  if (!detailed) {
    return {
      ...base,
      journeys: (p.journeys ?? []).map((j: Record<string, any>) => ({
        journeyKey: j.journeyKey,
        name: tr(j.name, lang),
        onByDefault: j.defaultEnabled,
        comingSoon: j.comingSoon,
      })),
    };
  }
  return {
    ...base,
    journeys: (p.journeys ?? []).map((j: Record<string, any>) => journeyView(j, lang)),
    offers: (p.offers ?? []).map((o: Record<string, any>) => ({ offerKey: o.offerKey, text: tr(o.label, lang), kind: o.kind, value: o.value, validForDays: o.expiryDays })),
    needsBookingCalendar: Boolean(p.needsStayCalendar),
  };
}

const langSchema = z.enum(['en', 'de', 'it', 'fr']).optional().describe('Language for names and descriptions (default en).');

export function registerPlaybookTools(server: McpServer): void {
  addTool<{ lang?: Lang }>(
    server,
    'list_playbooks',
    'List the Adaptive Campaigns playbooks this account can set up — ready-made bundles of automatic guest journeys (e.g. "Restaurant growth": welcome offer after the first visit, review ask after the visit). Shows which venues each one fits and which journeys are on by default or coming soon. Adaptive Campaigns is separate from normal campaigns; nothing is sent until HeidiFi launches sending.',
    { lang: langSchema },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const res = await adaptiveGet(tenantUserId, 'gallery');
      if (res.error) return errorResult(res.error);
      const lang = args.lang ?? 'en';
      const playbooks = (res.data!.playbooks as Record<string, any>[]) ?? [];
      const guestInfo = res.data!.guestInfo as Record<string, any> | null;
      return jsonResult({
        count: playbooks.length,
        playbooks: playbooks.map((p) => playbookView(p, lang, false)),
        guestInfo: guestInfo ? { name: tr(guestInfo.name, lang), summary: tr(guestInfo.summary, lang), note: 'A separate, free switch per venue (Wi-Fi details and house info).' } : null,
      });
    },
  );

  addTool<{ playbookKey: string; lang?: Lang }>(
    server,
    'get_playbook',
    'Get one Adaptive Campaigns playbook in detail: every journey with what it does, when it runs, its channels, and the blanks the owner fills in (offer, days, staff name) with their bounds and defaults, plus the offers owners can pick. Discover keys via list_playbooks.',
    { playbookKey: z.string().describe('The playbook key (from list_playbooks), e.g. restaurant_growth.'), lang: langSchema },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const res = await adaptiveGet(tenantUserId, 'gallery');
      if (res.error) return errorResult(res.error);
      const all = [...((res.data!.playbooks as Record<string, any>[]) ?? [])];
      if (res.data!.guestInfo) all.push(res.data!.guestInfo as Record<string, any>);
      const found = all.find((p) => p.key === args.playbookKey);
      if (!found) return errorResult('Playbook not found. Use list_playbooks to see the available keys.');
      return jsonResult({ playbook: playbookView(found, args.lang ?? 'en', true) });
    },
  );

  addTool<{ venueId?: string; lang?: Lang }>(
    server,
    'list_playbook_setups',
    'Show how each venue of this account uses Adaptive Campaigns: whether it is on, paused or off, which playbook is active, which journeys are switched on, Guest info on/off, and any other playbooks set up there. Optionally for one venue.',
    { venueId: z.string().optional().describe('Limit to one venue (from list_venues).'), lang: langSchema },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      const res = await adaptiveGet(tenantUserId, 'overview');
      if (res.error) return errorResult(res.error);
      const lang = args.lang ?? 'en';
      let venues = (res.data!.venues as Record<string, any>[]) ?? [];
      if (args.venueId) {
        venues = venues.filter((v) => v.venueId === args.venueId);
        if (!venues.length) return errorResult('Venue not found or not owned by this account.');
      }
      return jsonResult({
        accountOn: res.data!.accountOn,
        sendingLive: res.data!.sendingLive,
        venues: venues.map((v) => ({
          venueId: v.venueId,
          name: v.name,
          venueType: v.venueType,
          timezone: v.timezone,
          status: v.adaptive?.status ?? 'off',
          activePlaybookKey: v.adaptive?.activePlaybookKey ?? null,
          guestInfo: Boolean(v.adaptive?.guestInfo?.enabled),
          setups: (v.setups ?? []).map((s: Record<string, any>) => ({
            playbookKey: s.playbookKey,
            name: tr(s.name, lang),
            state: s.state,
            playbookVersion: s.playbookVersion,
            configVersion: s.configVersion,
            journeysOn: (s.journeysOn ?? []).map((j: Record<string, any>) => tr(j.name, lang)),
          })),
          alsoMessagingOnConnect: {
            marketingTab: v.overlap?.legacyOnConnectChannels ?? [],
            automations: (v.overlap?.automations ?? []).map((a: Record<string, any>) => a.name),
          },
        })),
      });
    },
  );
}
