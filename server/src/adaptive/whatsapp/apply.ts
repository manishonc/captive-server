/**
 * Turning what Meta says into a change of one template (PR W1) — shared by the submit, the sync
 * and the stuck-submit repair. Decides only (the store writes it in one transaction): the new Meta
 * state, the log row in words, and the alerts the change brings. No Meta client here.
 */

import type { MetaTemplateFacts } from '../core/whatsapp/template';
import { contentKey, parseOurName, type WaUse } from '../core/whatsapp/template';
import { alertsForChange, displayStatus, rejectionWords, type AlertView, type WaDisplay } from '../core/whatsapp/status';
import type { PoolRow } from '../core/whatsapp/pools';
import { HINT_COALESCE_MS, META, type StoredTemplate, type TemplateChange, type WaLogLevel, type WaMetaState, type WaTemplateDoc } from './store';
import { poolFor } from './context';
import { tsMs } from '../store/time';

const up = (s: string | null | undefined) => String(s ?? '').toUpperCase();

export function metaStateFrom(f: MetaTemplateFacts, prev: WaMetaState | null, now: Date): WaMetaState {
  const prevCategory = prev?.category ?? null;
  return {
    id: f.id,
    status: f.status,
    category: f.category,
    previousCategory: f.previousCategory ?? (prevCategory && f.category && prevCategory !== f.category ? prevCategory : prev?.previousCategory ?? null),
    rejectedReason: f.rejectedReason,
    quality: f.quality,
    parameterFormat: f.parameterFormat,
    headerText: f.headerText,
    bodyText: f.bodyText,
    footerText: f.footerText,
    buttons: f.buttons,
    otherComponents: f.otherComponents,
    // Approved before (also an import we never saw approved, null): unchanged; newly approved: now.
    approvedAt: up(f.status) === 'APPROVED' ? (up(prev?.status) === 'APPROVED' ? prev?.approvedAt ?? null : now) : prev?.approvedAt ?? null,
    lastChangedAt: now,
  };
}

/** Which message an imported template serves: the OTP one, one of ours by its name, or legacy. */
export function inferUse(name: string, pools: PoolRow[], otpName: string): WaUse {
  if (name === otpName) return { kind: 'otp' };
  const ours = parseOurName(name);
  if (ours) {
    const pool = pools.find((p) => p.poolKey === ours.poolKey);
    if (pool) return { kind: 'adaptive', journeyKey: pool.journeyKey, poolKey: pool.poolKey };
  }
  return { kind: 'legacy' };
}

function viewOf(d: Pick<WaTemplateDoc, 'stage' | 'meta' | 'dismissed' | 'use' | 'name' | 'language'>, pools: PoolRow[]): AlertView & { display: WaDisplay } {
  const pool = poolFor(pools, d.use);
  return {
    display: displayStatus({
      stage: d.stage,
      metaStatus: d.meta?.status ?? null,
      metaCategory: d.meta?.category ?? null,
      dismissed: false, // a dismissed template still alerts: it may be in use elsewhere (legacy, OTP)
      checksOk: true,
      poolCategory: pool?.whatsappCategory ?? null,
      adaptive: d.use?.kind === 'adaptive',
    }),
    name: d.name,
    language: d.language,
    otp: d.use?.kind === 'otp',
    metaCategory: d.meta?.category ?? null,
    quality: d.meta?.quality ?? null,
    rejectedReason: d.meta?.rejectedReason ?? null,
  };
}

const PROBLEM: ReadonlySet<WaDisplay> = new Set(['rejected', 'paused', 'disabled', 'deleted', 'archived', 'blocked', 'attention']);

function statusSentence(label: string, after: WaDisplay, f: { rejectedReason: string | null; category: string | null }): string {
  switch (after) {
    case 'approved':
      return `Meta approved ${label} as ${f.category ?? 'its category'}`;
    case 'blocked':
      return `Meta approved ${label} but files it as ${f.category ?? '?'}, which doesn't fit this service message: it isn't used`;
    case 'in_review':
      return `${label} is in review at Meta`;
    case 'rejected':
      return `Meta rejected ${label}: ${rejectionWords(f.rejectedReason)}`;
    case 'paused':
      return `Meta paused ${label}`;
    case 'disabled':
      return `Meta disabled ${label}`;
    case 'deleted':
      return `${label} no longer exists at Meta`;
    case 'archived':
      return `Meta archived ${label} (unused for a long time): unarchive it in WhatsApp Manager within 28 days, or Meta deletes it`;
    default:
      return `Meta reports an unusual state for ${label}`;
  }
}

/**
 * The change Meta's current facts bring to a doc we have (null: nothing changed). A doc that was
 * still `submitting` (or a draft Meta already holds — made in WhatsApp Manager) is adopted.
 */
export interface FromMetaOpts {
  /** The (real) time the list these facts came from was started: a hint newer than it is kept. */
  listStartedMs?: number;
  /** The account Meta holds it in. */
  wabaId?: string | null;
  /** Read with the basic fields only: keep what we had for quality, rejection reason, previous category. */
  partial?: boolean;
}

export function decideFromMeta(
  cur: StoredTemplate,
  facts: MetaTemplateFacts,
  pools: PoolRow[],
  now: Date,
  how: 'sync' | 'submit' | 'repair' | 'adopt',
  opts: FromMetaOpts = {},
): TemplateChange | null {
  const adopting = cur.stage !== 'submitted';
  const m = cur.meta;
  const f: MetaTemplateFacts = opts.partial && m
    ? { ...facts, quality: m.quality, rejectedReason: m.rejectedReason, previousCategory: m.previousCategory, parameterFormat: m.parameterFormat }
    : facts;
  // A notice that came after the list was read is about something this list can't show yet: keep it.
  const hintAt = tsMs(cur.hint?.at) ?? 0;
  // (A notice within HINT_COALESCE_MS of the mark doesn't move it: only a list started that long after the mark covers it.)
  const clearHint = Boolean(cur.hint) && (opts.listStartedMs === undefined || hintAt < opts.listStartedMs - HINT_COALESCE_MS);
  const wabaSet = opts.wabaId && cur.wabaId !== opts.wabaId ? { wabaId: opts.wabaId } : {};
  const statusChanged = up(m?.status) !== up(f.status);
  const categoryChanged = (m?.category ?? null) !== f.category;
  const qualityChanged = (m?.quality ?? null) !== f.quality && !(m?.quality == null && (f.quality === 'UNKNOWN' || f.quality === null));
  const reasonChanged = (m?.rejectedReason ?? null) !== f.rejectedReason && up(f.status) === 'REJECTED';
  // A header or media added (or removed) at Meta counts too: T24 depends on it.
  const partsChanged = Boolean(m) && ((m!.headerText ?? null) !== (f.headerText ?? null) || JSON.stringify(m!.otherComponents ?? []) !== JSON.stringify(f.otherComponents ?? []));
  const contentChanged = Boolean(m) && (contentKey({ bodyText: m!.bodyText, footerText: m!.footerText, buttons: m!.buttons }) !== contentKey(f) || partsChanged);
  const idChanged = (m?.id ?? null) !== f.id;
  if (!adopting && !statusChanged && !categoryChanged && !qualityChanged && !reasonChanged && !contentChanged && !idChanged) {
    if (!clearHint) return null;
    return {
      set: { hint: null, updatedBy: 'meta', ...wabaSet },
      log: { kind: 'webhook.hint_checked', level: 'routine', actor: META, summary: `Re-read ${cur.name} (${cur.language}) after Meta's notice: nothing changed` },
    };
  }
  const meta = metaStateFrom(f, m, now);
  const before = viewOf(cur, pools);
  const afterDoc = { ...cur, stage: 'submitted' as const, meta };
  const after = viewOf(afterDoc, pools);
  const label = `${cur.name} (${cur.language})`;
  const alerts = alertsForChange(adopting && !m ? { ...before, display: before.display } : before, after, `wa:${cur.id}:${cur.seq + 1}`);

  let kind = 'meta.content_changed';
  let summary = `Meta's copy of ${label} changed`;
  let level: WaLogLevel = 'info';
  if (adopting) {
    kind = how === 'submit' ? 'submit.done' : 'submit.adopted';
    summary = how === 'submit' ? `Meta accepted ${label} for review` : `Found ${label} at Meta and took it over (${statusSentence(label, after.display, f).replace(/^Meta /, '')})`;
    if (how === 'submit' && after.display !== 'in_review') summary = `Meta accepted ${label}: ${statusSentence(label, after.display, f)}`;
  } else if (statusChanged) {
    kind = 'meta.status_changed';
    summary = statusSentence(label, after.display, f);
  } else if (categoryChanged) {
    kind = 'meta.category_changed';
    summary = `Meta moved ${label} from ${m?.category ?? '—'} to ${f.category ?? '—'}${after.display === 'blocked' ? ': it no longer fits this service message and isn’t used' : ''}`;
  } else if (qualityChanged) {
    kind = 'meta.quality_changed';
    summary = `Meta rates ${label} quality ${f.quality ?? 'unknown'}`;
  } else if (reasonChanged) {
    kind = 'meta.status_changed';
    summary = statusSentence(label, after.display, f);
  }
  if (PROBLEM.has(after.display) && (statusChanged || categoryChanged || adopting)) level = 'warn';
  if (qualityChanged && (f.quality === 'RED' || f.quality === 'YELLOW')) level = 'warn';

  return {
    set: {
      meta,
      stage: 'submitted',
      submit: null,
      ...(clearHint ? { hint: null } : {}),
      ...(adopting ? { lastSubmitError: null } : {}),
      ...wabaSet,
      updatedBy: 'meta',
    },
    log: {
      kind,
      level,
      actor: META,
      summary,
      from: adopting ? cur.stage : before.display,
      to: after.display,
      detail: { metaId: f.id, status: f.status, category: f.category, previousCategory: meta.previousCategory, rejectedReason: f.rejectedReason, quality: f.quality, via: how },
    },
    alerts,
  };
}

/** A template Meta no longer has (complete list + a not-found read). */
export function decideDeleted(cur: StoredTemplate, pools: PoolRow[], now: Date, listStartedMs?: number): TemplateChange | null {
  if (up(cur.meta?.status) === 'DELETED') return null;
  // Re-checked inside the transaction: a doc that moved (a submit, an edit) since the list was read is not touched.
  if (cur.stage !== 'submitted') return null;
  if (listStartedMs !== undefined && (tsMs(cur.updatedAt) ?? 0) >= listStartedMs) return null;
  const meta: WaMetaState = { ...(cur.meta as WaMetaState), status: 'DELETED', lastChangedAt: now };
  const before = viewOf(cur, pools);
  const after = viewOf({ ...cur, meta }, pools);
  return {
    set: { meta, stage: 'submitted', submit: null, hint: null, updatedBy: 'meta' },
    log: {
      kind: 'meta.status_changed',
      level: 'warn',
      actor: META,
      summary: `${cur.name} (${cur.language}) no longer exists at Meta`,
      from: before.display,
      to: after.display,
      detail: { metaId: cur.meta?.id ?? null },
    },
    alerts: alertsForChange(before, after, `wa:${cur.id}:${cur.seq + 1}`),
  };
}

/** A doc for a template found at Meta that we don't have yet. */
export function importedDoc(f: MetaTemplateFacts, use: WaUse, now: Date, wabaId: string | null = null): TemplateChange {
  // We didn't see Meta approve it (it was approved before we looked): not "approved since the last summary".
  const meta = { ...metaStateFrom(f, null, now), approvedAt: null };
  const doc = {
    name: f.name,
    language: f.language,
    lang: f.lang,
    use,
    origin: 'imported' as const,
    requestedCategory: null,
    source: null,
    compiled: null,
    meta,
    stage: 'submitted' as const,
    submit: null,
    lastSubmitError: null,
    dismissed: false,
    useEnabled: true,
    version: 1,
    hint: null,
    ai: null,
    wabaId,
    createdBy: 'meta-sync',
    updatedBy: 'meta-sync',
  };
  return {
    create: doc,
    log: {
      kind: 'template.imported',
      level: 'info',
      actor: META,
      summary: `Found ${f.name} (${f.language}) at Meta: ${up(f.status).toLowerCase() || 'no status'}, ${f.category ?? 'no category'}${use.kind === 'otp' ? ' — the guest-login code template' : use.kind === 'legacy' ? ' — used by the old Campaign Manager' : ''}`,
      to: up(f.status).toLowerCase() || null,
      detail: { metaId: f.id, status: f.status, category: f.category, quality: f.quality, use: use.kind },
    },
  };
}

export { viewOf };
