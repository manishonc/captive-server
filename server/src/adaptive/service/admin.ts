/**
 * Platform-admin operations on playbooks and journey templates. The CMS admin
 * screens call these through `/internal/adaptive/admin/*`; nothing here trusts
 * the caller's copy of a draft when it matters (checks and publishing always
 * re-read what is stored).
 */

import {
  getJourneyTemplate,
  getPlaybookHeader,
  getPlaybookVersion,
  listPlaybookHeaders,
  listPlaybookVersions,
} from '../store/definitions';
import {
  DefinitionError,
  createPlaybookDocs,
  deleteUnpublishedTx,
  discardDraftTx,
  hasDraft,
  publishTx,
  restoreTx,
  saveDraftTx,
  setAvailabilityTx,
  setListedTx,
  updatedAtMs,
} from '../store/playbookWrites';
import { countSetupsByPlaybook } from '../store/venueSetups';
import { toJson } from '../store/serialize';
import type { PlaybookHeaderDoc, PlaybookVersionDoc } from '../store/types';
import {
  createPlaybookInputSchema,
  journeyDefinitionSchema,
  pickLang,
  playbookContentSchema,
  publishInputSchema,
  saveDraftInputSchema,
  type Actor,
  type PlaybookContent,
} from '../core/schemas';
import { validatePlaybook } from '../core/validatePlaybook';
import { contentChecksum } from '../core/checksum';
import { diffPlaybookContent, type DiffLine } from '../core/diff';
import { describeJourneySteps } from '../core/describeJourney';
import { describeTrigger } from '../core/registry';
import { describeDuration, type ValidationReport } from '../core/issues';
import { PLAYBOOK_KEY_PATTERN, type PlaybookKind } from '../core/constants';
import { ApiError, conflict, notFound, validationFailed } from '../api/errors';
import { checkContext, invalidateCatalogue, loadCatalogue, rulesOf, versionContent, type Catalogue } from './catalogue';
import type { z } from 'zod';

function rethrow(err: unknown): never {
  if (err instanceof DefinitionError) {
    if (err.code === 'not_found') throw notFound(err.message);
    if (err.code === 'conflict') throw conflict(err.message);
    throw new ApiError('validation_failed', err.message);
  }
  throw err;
}

function stamp(report: ValidationReport, now: Date) {
  return { ...report, checkedAt: now };
}

function publishedKindOf(header: PlaybookHeaderDoc): PlaybookKind | null {
  return header.publishedVersion ? header.kind : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface PlaybookSummary {
  key: string;
  kind: PlaybookKind;
  status: PlaybookHeaderDoc['status'];
  name: PlaybookHeaderDoc['name'];
  summary: PlaybookHeaderDoc['summary'];
  icon: string;
  venueTypes: PlaybookHeaderDoc['venueTypes'];
  sortOrder: number;
  latestVersion: number;
  publishedVersion: number | null;
  draftVersion: number | null;
  versionCount: number;
  journeys: Array<{ journeyKey: string; name: PlaybookHeaderDoc['name']; purpose: string; comingSoon: boolean; defaultEnabled: boolean; required: boolean }>;
  offerCount: number;
  questionCount: number;
  venues: { setUp: number; active: number };
  updatedAt: string | null;
}

async function summarize(header: PlaybookHeaderDoc, cat: Catalogue): Promise<PlaybookSummary> {
  const draftVersion = hasDraft(header) ? header.latestVersion : null;
  const shownVersion = draftVersion ?? header.publishedVersion ?? header.latestVersion;
  const [version, venues] = await Promise.all([getPlaybookVersion(header.key, shownVersion), countSetupsByPlaybook(header.key)]);
  const content = version ? versionContent(version) : null;
  return {
    key: header.key,
    kind: header.kind,
    status: header.status,
    name: content?.name ?? header.name,
    summary: content?.summary ?? header.summary,
    icon: content?.icon ?? header.icon,
    venueTypes: content?.venueTypes ?? header.venueTypes,
    sortOrder: header.sortOrder,
    latestVersion: header.latestVersion,
    publishedVersion: header.publishedVersion,
    draftVersion,
    versionCount: header.publishedVersion ?? 0,
    journeys: (content?.journeys ?? []).map((j) => {
      const t = cat.templates.get(j.journeyKey)?.header;
      return {
        journeyKey: j.journeyKey,
        name: t?.name ?? { en: j.journeyKey },
        purpose: t?.purpose ?? 'marketing',
        comingSoon: t?.availability === 'coming_soon',
        defaultEnabled: j.defaultEnabled,
        required: j.required,
      };
    }),
    offerCount: content?.offerMenuDefaults.length ?? 0,
    questionCount: content?.questionKeys.length ?? 0,
    venues,
    updatedAt: toJson(header.updatedAt) as unknown as string | null,
  };
}

export async function listPlaybooks(): Promise<PlaybookSummary[]> {
  const [headers, cat] = await Promise.all([listPlaybookHeaders(), loadCatalogue({ fresh: true })]);
  const out = await Promise.all(headers.map((h) => summarize(h, cat)));
  return out.sort((a, b) => a.sortOrder - b.sortOrder || pickLang(a.name).localeCompare(pickLang(b.name)));
}

export async function getPlaybookDetail(key: string) {
  const header = await getPlaybookHeader(key);
  if (!header) throw notFound('Playbook not found');
  const [versions, venues, cat] = await Promise.all([listPlaybookVersions(key), countSetupsByPlaybook(key), loadCatalogue({ fresh: true })]);
  const draft = hasDraft(header) ? versions.find((v) => v.version === header.latestVersion) ?? null : null;
  const published = header.publishedVersion ? versions.find((v) => v.version === header.publishedVersion) ?? null : null;
  return {
    playbook: toJson(header),
    draft: draft ? toJson(draft) : null,
    published: published ? toJson(published) : null,
    versions: versions.map((v) => ({
      version: v.version,
      state: v.state,
      isLive: v.version === header.publishedVersion,
      changelog: v.changelog,
      basedOnVersion: v.basedOnVersion,
      checksum: v.checksum,
      createdAt: toJson(v.createdAt),
      createdBy: v.createdBy,
      publishedAt: toJson(v.publishedAt),
      publishedBy: v.publishedBy,
    })),
    venues,
    rules: rulesOf(cat.config),
  };
}

export async function getVersion(key: string, version: number) {
  const v = await getPlaybookVersion(key, version);
  if (!v) throw notFound(`Version ${version} doesn't exist`);
  return toJson(v);
}

/** `from` / `to` are version numbers, "live" or "draft". */
export async function diffVersions(key: string, from: string, to: string): Promise<{ from: number; to: number; changes: DiffLine[] }> {
  const header = await getPlaybookHeader(key);
  if (!header) throw notFound('Playbook not found');
  const resolve = (ref: string): number | null => {
    if (ref === 'draft') return hasDraft(header) ? header.latestVersion : null;
    if (ref === 'live') return header.publishedVersion;
    const n = Number(ref);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const a = resolve(from);
  const b = resolve(to);
  if (b === null) throw notFound('Nothing to compare with');
  const [va, vb, cat] = await Promise.all([a ? getPlaybookVersion(key, a) : Promise.resolve(null), getPlaybookVersion(key, b), loadCatalogue()]);
  if (!vb) throw notFound(`Version ${b} doesn't exist`);
  const names = {
    journey: (k: string) => pickLang(cat.templates.get(k)?.header.name) || k,
    question: (k: string) => pickLang(cat.questions.find((q) => q.key === k)?.prompt) || k,
  };
  return { from: a ?? 0, to: b, changes: diffPlaybookContent(va ? versionContent(va) : null, versionContent(vb), names) };
}

// ── Writes ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34);
  const key = /^[a-z]/.test(base) ? base : `pb_${base}`;
  return key.length >= 3 ? key : `${key}_playbook`.slice(0, 34);
}

function emptyContent(input: z.infer<typeof createPlaybookInputSchema>): PlaybookContent {
  return playbookContentSchema.parse({
    kind: input.kind ?? 'marketing',
    name: { en: input.name },
    summary: { en: '' },
    icon: input.kind === 'utility' ? 'key' : 'layers',
    venueTypes: input.venueTypes,
    journeys: [],
  });
}

export async function createPlaybook(body: unknown, actor: Actor) {
  const input = createPlaybookInputSchema.parse(body);
  const [headers, cat] = await Promise.all([listPlaybookHeaders(), loadCatalogue({ fresh: true })]);
  const taken = new Set(headers.map((h) => h.key));
  const base = slugify(input.name);
  let key = base;
  for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
  if (!PLAYBOOK_KEY_PATTERN.test(key)) throw new ApiError('bad_request', 'Pick a name with at least a few letters');

  let content: PlaybookContent;
  let basedOnVersion: number | null = null;
  if (input.mode === 'copy') {
    if (!input.copyFrom) throw new ApiError('bad_request', 'Pick a playbook to copy');
    const source = await getPlaybookHeader(input.copyFrom);
    if (!source) throw notFound('The playbook to copy was not found');
    const sourceVersion = await getPlaybookVersion(source.key, source.publishedVersion ?? source.latestVersion);
    if (!sourceVersion) throw notFound('The playbook to copy has no version yet');
    content = { ...versionContent(sourceVersion), name: { en: input.name } };
  } else {
    content = emptyContent(input);
  }

  const now = new Date();
  const report = validatePlaybook(content, checkContext(cat, null));
  const maxSort = headers.reduce((m, h) => Math.max(m, h.sortOrder || 0), 0);
  await createPlaybookDocs({ key, content, sortOrder: maxSort + 10, basedOnVersion, validation: stamp(report, now), actorUid: actor.uid, now }).catch(rethrow);
  return getPlaybookDetail(key);
}

export async function saveDraft(key: string, body: unknown, actor: Actor) {
  const input = saveDraftInputSchema.parse(body);
  const header = await getPlaybookHeader(key);
  if (!header) throw notFound('Playbook not found');
  const cat = await loadCatalogue({ fresh: true });
  const report = validatePlaybook(input.content, checkContext(cat, publishedKindOf(header)));
  const locked = report.issues.filter((i) => i.code === 'K02');
  if (locked.length) throw validationFailed(locked[0].message, locked);
  const now = new Date();
  await saveDraftTx({ key, baseVersion: input.baseVersion, content: input.content, validation: stamp(report, now), actorUid: actor.uid, now }).catch(rethrow);
  return { ...(await getPlaybookDetail(key)), validation: report };
}

export async function discardDraft(key: string, actor: Actor) {
  await discardDraftTx(key, actor.uid, new Date()).catch(rethrow);
  return getPlaybookDetail(key);
}

export async function deletePlaybook(key: string) {
  await deleteUnpublishedTx(key).catch(rethrow);
  invalidateCatalogue();
  return { deleted: key };
}

/** Run the checks on the draft (or on the live version when there is no draft). */
export async function checkPlaybook(key: string): Promise<{ version: number; report: ValidationReport }> {
  const header = await getPlaybookHeader(key);
  if (!header) throw notFound('Playbook not found');
  const version = hasDraft(header) ? header.latestVersion : (header.publishedVersion as number);
  const v = await getPlaybookVersion(key, version);
  if (!v) throw notFound('Nothing to check yet');
  const cat = await loadCatalogue({ fresh: true });
  return { version, report: validatePlaybook(versionContent(v), checkContext(cat, publishedKindOf(header))) };
}

export async function publishPlaybook(key: string, body: unknown, actor: Actor) {
  const input = publishInputSchema.parse(body);
  const header = await getPlaybookHeader(key);
  if (!header) throw notFound('Playbook not found');
  if (!hasDraft(header)) throw new ApiError('no_changes', 'There is no draft to publish');
  if (header.latestVersion !== input.draftVersion) throw conflict('The draft changed — reload before publishing');
  const draft = await getPlaybookVersion(key, input.draftVersion);
  if (!draft || draft.state !== 'draft') throw conflict('The draft changed — reload before publishing');

  const content = versionContent(draft);
  const cat = await loadCatalogue({ fresh: true });
  const report = validatePlaybook(content, checkContext(cat, publishedKindOf(header)));
  if (!report.ok) throw validationFailed('Fix the problems the check found before publishing', report.issues);

  const checksum = contentChecksum(content);
  if (header.publishedVersion) {
    const live = await getPlaybookVersion(key, header.publishedVersion);
    if (live?.checksum === checksum) throw new ApiError('no_changes', 'Nothing changed since the live version');
  }
  const now = new Date();
  await publishTx({
    key,
    draftVersion: input.draftVersion,
    expectUpdatedAtMs: updatedAtMs(draft),
    changelog: input.changelog,
    checksum,
    validation: stamp(report, now),
    actorUid: actor.uid,
    now,
  }).catch(rethrow);
  invalidateCatalogue();
  return getPlaybookDetail(key);
}

export async function restoreVersion(key: string, version: number, actor: Actor) {
  const [header, source, cat] = await Promise.all([getPlaybookHeader(key), getPlaybookVersion(key, version), loadCatalogue({ fresh: true })]);
  if (!header) throw notFound('Playbook not found');
  if (!source) throw notFound(`Version ${version} doesn't exist`);
  const now = new Date();
  const report = validatePlaybook(versionContent(source), checkContext(cat, publishedKindOf(header)));
  await restoreTx({ key, fromVersion: version, actorUid: actor.uid, now, validation: stamp(report, now) }).catch(rethrow);
  return getPlaybookDetail(key);
}

export async function setListed(key: string, listed: boolean, actor: Actor) {
  await setListedTx(key, listed, actor.uid, new Date()).catch(rethrow);
  invalidateCatalogue();
  return getPlaybookDetail(key);
}

// ── Journey templates (read-only in this release, plus availability) ─────────

export async function listJourneyTemplates() {
  const [cat, headers] = await Promise.all([loadCatalogue({ fresh: true }), listPlaybookHeaders()]);
  const versions = await Promise.all(
    headers.map(async (h) => {
      const nums = [h.publishedVersion, hasDraft(h) ? h.latestVersion : null].filter((n): n is number => Boolean(n));
      const docs = await Promise.all(nums.map((n) => getPlaybookVersion(h.key, n)));
      return { header: h, docs: docs.filter((d): d is PlaybookVersionDoc => Boolean(d)) };
    }),
  );
  const usedIn = new Map<string, Array<{ key: string; name: string; version: number }>>();
  for (const { header, docs } of versions) {
    for (const doc of docs) {
      for (const j of doc.journeys) {
        const list = usedIn.get(j.journeyKey) ?? [];
        if (!list.some((u) => u.key === header.key)) list.push({ key: header.key, name: pickLang(doc.name) || header.key, version: j.templateVersion });
        usedIn.set(j.journeyKey, list);
      }
    }
  }
  return [...cat.templates.values()]
    .map(({ header, versions: vs }) => {
      const live = vs.find((v) => v.version === header.publishedVersion) ?? vs[0];
      const def = live ? journeyDefinitionSchema.parse(live.definition) : null;
      return {
        ...toJson(header),
        startsWhen: def ? describeTrigger(def.entry.trigger) : '',
        channels: def?.channelLadder ?? [],
        slots: def ? Object.entries(def.slots).map(([k, s]) => ({ key: k, type: s.type, label: s.label, required: s.required })) : [],
        usedIn: usedIn.get(header.key) ?? [],
        versions: vs.map((v) => ({ version: v.version, state: v.state, changelog: v.changelog, publishedAt: toJson(v.publishedAt) })),
      };
    })
    .sort((a, b) => pickLang(a.name).localeCompare(pickLang(b.name)));
}

export async function getJourneyTemplateDetail(key: string, version?: number) {
  const [rec, cat] = await Promise.all([getJourneyTemplate(key), loadCatalogue({ fresh: true })]);
  if (!rec) throw notFound('Journey not found');
  const wanted = version ?? rec.header.publishedVersion ?? rec.header.latestVersion;
  const v = rec.versions.find((x) => x.version === wanted);
  if (!v) throw notFound(`Version ${wanted} doesn't exist`);
  const def = journeyDefinitionSchema.parse(v.definition);
  const wording = cat.variants.filter((w) => Object.keys(def.pools).includes(w.poolKey));
  return {
    journey: toJson(rec.header),
    version: { version: v.version, state: v.state, changelog: v.changelog, checksum: v.checksum, publishedAt: toJson(v.publishedAt), definition: def },
    versions: rec.versions.map((x) => ({ version: x.version, state: x.state, changelog: x.changelog, publishedAt: toJson(x.publishedAt) })),
    steps: describeJourneySteps(def),
    summary: {
      startsWhen: describeTrigger(def.entry.trigger),
      needsConsent: def.entry.requires.includes('consent:venue:marketing'),
      reentry: def.entry.reentry.mode === 'cooldown' ? `After a pause of ${describeDuration(def.entry.reentry.cooldown)}` : def.entry.reentry.mode === 'never' ? 'Never' : 'After the last one ended',
      goal: def.goal ? { event: def.goal.event, within: describeDuration(def.goal.within) } : null,
      exitOn: def.exitOn.map((e) => e.event),
      caps: def.caps ?? null,
      channelLadder: def.channelLadder,
      slots: Object.entries(def.slots).map(([k, s]) => ({ key: k, ...s })),
      pools: Object.entries(def.pools).map(([k, p]) => ({
        key: k,
        ...p,
        wording: wording.filter((w) => w.poolKey === k).map((w) => ({
          id: w.id,
          letter: w.letter,
          name: w.name,
          status: w.status,
          channels: Object.keys(w.channels),
          locales: ['en', ...Object.keys(w.locales ?? {})],
        })),
      })),
      autonomy: def.autonomy?.allowed ?? [],
    },
  };
}

export async function setAvailability(key: string, availability: 'available' | 'coming_soon', actor: Actor) {
  await setAvailabilityTx(key, availability, actor.uid, new Date()).catch(rethrow);
  invalidateCatalogue();
  return getJourneyTemplateDetail(key);
}

export async function listQuestionBank() {
  const cat = await loadCatalogue({ fresh: true });
  return cat.questions;
}

export async function getRules() {
  const cat = await loadCatalogue({ fresh: true });
  return { config: cat.config, rules: rulesOf(cat.config) };
}
