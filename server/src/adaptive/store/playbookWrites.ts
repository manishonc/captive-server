/**
 * Writes for platform definitions. Each is one transaction that re-reads the
 * header, so two admins editing at once get a clean "conflict" instead of one
 * silently overwriting the other.
 *
 * Version rules (03-playbook-format §10):
 *  - a published version is never edited again;
 *  - the first edit after a publish creates draft v(n+1); later edits update it;
 *  - restoring an old version copies its content into the draft;
 *  - "Live" is simply `publishedVersion` — older versions are never rewritten.
 */

import { db } from '../../firebase';
import { playbookRef, playbookVersionRef, journeyTemplateRef } from './definitions';
import { VERSIONS } from './collections';
import { stripUndefined } from './serialize';
import type { PlaybookHeaderDoc, PlaybookVersionDoc, StoredValidation } from './types';
import type { PlaybookContent } from '../core/schemas';
import { ENGINE_RANGE, SCHEMA_VERSION } from '../core/constants';

export class DefinitionError extends Error {
  constructor(public code: 'not_found' | 'conflict' | 'validation_failed', message: string) {
    super(message);
  }
}

function contentFields(content: PlaybookContent) {
  return {
    kind: content.kind,
    name: content.name,
    summary: content.summary,
    icon: content.icon,
    venueTypes: content.venueTypes,
    journeys: content.journeys,
    offerMenuDefaults: content.offerMenuDefaults,
    questionKeys: content.questionKeys,
    estimateHints: content.estimateHints,
  };
}

function headerMirror(content: PlaybookContent) {
  return { kind: content.kind, name: content.name, summary: content.summary, icon: content.icon, venueTypes: content.venueTypes };
}

export function hasDraft(header: PlaybookHeaderDoc): boolean {
  return header.publishedVersion === null || header.latestVersion > header.publishedVersion;
}

function millis(value: unknown): number | null {
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') return (value as { toMillis: () => number }).toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

export async function createPlaybookDocs(params: {
  key: string;
  content: PlaybookContent;
  sortOrder: number;
  basedOnVersion: number | null;
  validation: StoredValidation;
  actorUid: string;
  now: Date;
}): Promise<void> {
  const { key, content, now, actorUid } = params;
  const header: PlaybookHeaderDoc = {
    key,
    ...headerMirror(content),
    status: 'draft',
    sortOrder: params.sortOrder,
    latestVersion: 1,
    publishedVersion: null,
    createdAt: now,
    createdBy: actorUid,
    updatedAt: now,
    updatedBy: actorUid,
    schemaVersion: SCHEMA_VERSION,
  };
  const version: PlaybookVersionDoc = {
    ...contentFields(content),
    version: 1,
    state: 'draft',
    basedOnVersion: params.basedOnVersion,
    engineVersion: ENGINE_RANGE,
    validation: params.validation,
    checksum: null,
    changelog: '',
    createdAt: now,
    createdBy: actorUid,
    updatedAt: now,
    updatedBy: actorUid,
    publishedAt: null,
    publishedBy: null,
    schemaVersion: SCHEMA_VERSION,
  };
  try {
    await db.runTransaction(async (tx) => {
      tx.create(playbookRef(key), stripUndefined(header));
      tx.create(playbookVersionRef(key, 1), stripUndefined(version));
    });
  } catch (err: any) {
    if (err?.code === 6 || /already exists/i.test(String(err?.message))) {
      throw new DefinitionError('conflict', `A playbook with the key “${key}” already exists`);
    }
    throw err;
  }
}

/** Save the draft; the first edit after a publish opens draft v(n+1). */
export async function saveDraftTx(params: {
  key: string;
  baseVersion: number;
  content: PlaybookContent;
  validation: StoredValidation;
  actorUid: string;
  now: Date;
}): Promise<{ version: number; created: boolean }> {
  const { key, content, now, actorUid } = params;
  return db.runTransaction(async (tx) => {
    const headSnap = await tx.get(playbookRef(key));
    if (!headSnap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = headSnap.data() as PlaybookHeaderDoc;
    if (header.latestVersion !== params.baseVersion) {
      throw new DefinitionError('conflict', 'Someone else changed this playbook since you opened it — reload to see their changes');
    }
    if (hasDraft(header)) {
      const ref = playbookVersionRef(key, header.latestVersion);
      const draft = await tx.get(ref);
      if (!draft.exists || (draft.data() as PlaybookVersionDoc).state !== 'draft') {
        throw new DefinitionError('conflict', 'The draft is no longer a draft — reload');
      }
      tx.update(ref, stripUndefined({ ...contentFields(content), validation: params.validation, updatedAt: now, updatedBy: actorUid }));
      const headerUpdate: Record<string, unknown> = { updatedAt: now, updatedBy: actorUid };
      if (header.publishedVersion === null) Object.assign(headerUpdate, headerMirror(content));
      tx.update(playbookRef(key), stripUndefined(headerUpdate));
      return { version: header.latestVersion, created: false };
    }
    const next = header.latestVersion + 1;
    const version: PlaybookVersionDoc = {
      ...contentFields(content),
      version: next,
      state: 'draft',
      basedOnVersion: header.publishedVersion,
      engineVersion: ENGINE_RANGE,
      validation: params.validation,
      checksum: null,
      changelog: '',
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
      updatedBy: actorUid,
      publishedAt: null,
      publishedBy: null,
      schemaVersion: SCHEMA_VERSION,
    };
    tx.create(playbookVersionRef(key, next), stripUndefined(version));
    tx.update(playbookRef(key), { latestVersion: next, updatedAt: now, updatedBy: actorUid });
    return { version: next, created: true };
  });
}

export async function discardDraftTx(key: string, actorUid: string, now: Date): Promise<void> {
  await db.runTransaction(async (tx) => {
    const headSnap = await tx.get(playbookRef(key));
    if (!headSnap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = headSnap.data() as PlaybookHeaderDoc;
    if (header.publishedVersion === null) {
      throw new DefinitionError('conflict', 'This playbook was never published — delete it instead');
    }
    if (!hasDraft(header)) throw new DefinitionError('not_found', 'There is no draft to discard');
    const ref = playbookVersionRef(key, header.latestVersion);
    const draft = await tx.get(ref);
    if (draft.exists && (draft.data() as PlaybookVersionDoc).state !== 'draft') {
      throw new DefinitionError('conflict', 'That version is already published');
    }
    tx.delete(ref);
    tx.update(playbookRef(key), { latestVersion: header.publishedVersion, updatedAt: now, updatedBy: actorUid });
  });
}

export async function deleteUnpublishedTx(key: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const headSnap = await tx.get(playbookRef(key));
    if (!headSnap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = headSnap.data() as PlaybookHeaderDoc;
    if (header.publishedVersion !== null) {
      throw new DefinitionError('conflict', 'Published playbooks are never deleted — hide it from the gallery instead');
    }
    const versions = await tx.get(playbookRef(key).collection(VERSIONS));
    for (const doc of versions.docs) tx.delete(doc.ref);
    tx.delete(playbookRef(key));
  });
}

/** Freeze the draft as the live version. `expectUpdatedAt` guards against edits made while checking. */
export async function publishTx(params: {
  key: string;
  draftVersion: number;
  expectUpdatedAtMs: number | null;
  changelog: string;
  checksum: string;
  validation: StoredValidation;
  actorUid: string;
  now: Date;
}): Promise<PlaybookHeaderDoc> {
  const { key, now, actorUid } = params;
  return db.runTransaction(async (tx) => {
    const headSnap = await tx.get(playbookRef(key));
    if (!headSnap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = headSnap.data() as PlaybookHeaderDoc;
    const ref = playbookVersionRef(key, params.draftVersion);
    const draftSnap = await tx.get(ref);
    if (header.latestVersion !== params.draftVersion || !hasDraft(header) || !draftSnap.exists) {
      throw new DefinitionError('conflict', 'The draft changed — reload before publishing');
    }
    const draft = draftSnap.data() as PlaybookVersionDoc;
    if (draft.state !== 'draft') throw new DefinitionError('conflict', 'This version is already published');
    if (params.expectUpdatedAtMs !== null && millis(draft.updatedAt) !== params.expectUpdatedAtMs) {
      throw new DefinitionError('conflict', 'The draft was edited while you were publishing — check it again');
    }
    tx.update(ref, {
      state: 'published',
      checksum: params.checksum,
      changelog: params.changelog,
      validation: stripUndefined(params.validation),
      publishedAt: now,
      publishedBy: actorUid,
      updatedAt: now,
      updatedBy: actorUid,
    });
    const next: PlaybookHeaderDoc = {
      ...header,
      kind: draft.kind,
      name: draft.name,
      summary: draft.summary,
      icon: draft.icon,
      venueTypes: draft.venueTypes,
      publishedVersion: params.draftVersion,
      status: header.status === 'deprecated' ? 'deprecated' : 'published',
      updatedAt: now,
      updatedBy: actorUid,
    };
    tx.set(playbookRef(key), stripUndefined(next));
    return next;
  });
}

/** Copy a published version's content into the draft (opening one if needed). */
export async function restoreTx(params: { key: string; fromVersion: number; actorUid: string; now: Date; validation: StoredValidation }): Promise<number> {
  const { key, fromVersion, now, actorUid } = params;
  return db.runTransaction(async (tx) => {
    const headSnap = await tx.get(playbookRef(key));
    if (!headSnap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = headSnap.data() as PlaybookHeaderDoc;
    const sourceSnap = await tx.get(playbookVersionRef(key, fromVersion));
    if (!sourceSnap.exists) throw new DefinitionError('not_found', `Version ${fromVersion} doesn't exist`);
    const source = sourceSnap.data() as PlaybookVersionDoc;
    if (source.state !== 'published') throw new DefinitionError('conflict', 'Only published versions can be restored');
    const content = contentFields(source as PlaybookContent);

    if (hasDraft(header)) {
      const ref = playbookVersionRef(key, header.latestVersion);
      tx.update(ref, stripUndefined({ ...content, basedOnVersion: fromVersion, validation: params.validation, updatedAt: now, updatedBy: actorUid }));
      tx.update(playbookRef(key), { updatedAt: now, updatedBy: actorUid });
      return header.latestVersion;
    }
    const next = header.latestVersion + 1;
    const version: PlaybookVersionDoc = {
      ...content,
      version: next,
      state: 'draft',
      basedOnVersion: fromVersion,
      engineVersion: ENGINE_RANGE,
      validation: params.validation,
      checksum: null,
      changelog: '',
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
      updatedBy: actorUid,
      publishedAt: null,
      publishedBy: null,
      schemaVersion: SCHEMA_VERSION,
    };
    tx.create(playbookVersionRef(key, next), stripUndefined(version));
    tx.update(playbookRef(key), { latestVersion: next, updatedAt: now, updatedBy: actorUid });
    return next;
  });
}

/** Show or hide in the owners' gallery. Header-only: no version bump. */
export async function setListedTx(key: string, listed: boolean, actorUid: string, now: Date): Promise<PlaybookHeaderDoc> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(playbookRef(key));
    if (!snap.exists) throw new DefinitionError('not_found', 'Playbook not found');
    const header = snap.data() as PlaybookHeaderDoc;
    if (header.publishedVersion === null) throw new DefinitionError('conflict', 'Publish the playbook before showing it to owners');
    const next = { ...header, status: listed ? 'published' : 'deprecated', updatedAt: now, updatedBy: actorUid } as PlaybookHeaderDoc;
    tx.update(playbookRef(key), { status: next.status, updatedAt: now, updatedBy: actorUid });
    return next;
  });
}

export async function setAvailabilityTx(key: string, availability: 'available' | 'coming_soon', actorUid: string, now: Date): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(journeyTemplateRef(key));
    if (!snap.exists) throw new DefinitionError('not_found', 'Journey not found');
    tx.update(journeyTemplateRef(key), { availability, updatedAt: now, updatedBy: actorUid });
  });
}

export function updatedAtMs(version: PlaybookVersionDoc): number | null {
  return millis(version.updatedAt);
}
