/**
 * Platform definitions: playbooks, journey templates, wording, questions and
 * platform rules. Small collections authored by HeidiFi — full reads are fine.
 */

import { db } from '../../firebase';
import { COL, CONFIG_DOC_ID, VERSIONS } from './collections';
import type {
  JourneyTemplateHeaderDoc,
  JourneyTemplateVersionDoc,
  PlaybookHeaderDoc,
  PlaybookVersionDoc,
  VariantDoc,
} from './types';
import { adaptiveConfigSchema, type AdaptiveConfig, type Question } from '../core/schemas';
import { ADAPTIVE_CONFIG_V1 } from '../seed/definitions/config';

// ── Playbooks ────────────────────────────────────────────────────────────────

export const playbooksCol = () => db.collection(COL.playbooks);
export const playbookRef = (key: string) => playbooksCol().doc(key);
export const playbookVersionRef = (key: string, version: number) =>
  playbookRef(key).collection(VERSIONS).doc(String(version));

export async function listPlaybookHeaders(): Promise<PlaybookHeaderDoc[]> {
  const snap = await playbooksCol().get();
  return snap.docs.map((d) => d.data() as PlaybookHeaderDoc);
}

export async function getPlaybookHeader(key: string): Promise<PlaybookHeaderDoc | null> {
  const snap = await playbookRef(key).get();
  return snap.exists ? (snap.data() as PlaybookHeaderDoc) : null;
}

export async function getPlaybookVersion(key: string, version: number): Promise<PlaybookVersionDoc | null> {
  const snap = await playbookVersionRef(key, version).get();
  return snap.exists ? (snap.data() as PlaybookVersionDoc) : null;
}

/** Newest first. */
export async function listPlaybookVersions(key: string): Promise<PlaybookVersionDoc[]> {
  const snap = await playbookRef(key).collection(VERSIONS).get();
  return snap.docs.map((d) => d.data() as PlaybookVersionDoc).sort((a, b) => b.version - a.version);
}

// ── Journey templates ────────────────────────────────────────────────────────

export const journeyTemplatesCol = () => db.collection(COL.journeyTemplates);
export const journeyTemplateRef = (key: string) => journeyTemplatesCol().doc(key);

export interface TemplateRecord {
  header: JourneyTemplateHeaderDoc;
  /** Newest first. */
  versions: JourneyTemplateVersionDoc[];
}

export async function getJourneyTemplate(key: string): Promise<TemplateRecord | null> {
  const [head, versions] = await Promise.all([
    journeyTemplateRef(key).get(),
    journeyTemplateRef(key).collection(VERSIONS).get(),
  ]);
  if (!head.exists) return null;
  return {
    header: head.data() as JourneyTemplateHeaderDoc,
    versions: versions.docs.map((d) => d.data() as JourneyTemplateVersionDoc).sort((a, b) => b.version - a.version),
  };
}

/** Every journey template with all its versions (a dozen small docs today). */
export async function loadTemplateCatalogue(): Promise<Map<string, TemplateRecord>> {
  const heads = await journeyTemplatesCol().get();
  const records = await Promise.all(
    heads.docs.map(async (doc) => {
      const versions = await doc.ref.collection(VERSIONS).get();
      return {
        header: doc.data() as JourneyTemplateHeaderDoc,
        versions: versions.docs.map((d) => d.data() as JourneyTemplateVersionDoc).sort((a, b) => b.version - a.version),
      };
    }),
  );
  return new Map(records.map((r) => [r.header.key, r]));
}

// ── Wording, questions, rules ────────────────────────────────────────────────

export async function listPlatformVariants(): Promise<Array<VariantDoc & { id: string }>> {
  const snap = await db.collection(COL.variants).where('scope', '==', 'platform').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as VariantDoc) }));
}

export async function listQuestions(): Promise<Question[]> {
  const snap = await db.collection(COL.questionBank).get();
  return snap.docs.map((d) => d.data() as Question).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Platform rules. Falls back to the seeded v1 values (never looser) when the doc
 * is missing or malformed, so a bad write can't loosen a bound.
 */
export async function getAdaptiveConfig(): Promise<AdaptiveConfig & { version: number | null }> {
  try {
    const snap = await db.collection(COL.config).doc(CONFIG_DOC_ID).get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const parsed = adaptiveConfigSchema.safeParse(data);
      if (parsed.success) return { ...parsed.data, version: Number(data.version) || null };
      console.error('[ADAPTIVE] AdaptiveConfig/global is malformed; using the seeded defaults');
    }
  } catch (err) {
    console.error('[ADAPTIVE] AdaptiveConfig read failed; using the seeded defaults:', err);
  }
  return { ...ADAPTIVE_CONFIG_V1, version: null };
}
