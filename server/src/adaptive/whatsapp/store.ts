/**
 * Storage of the WhatsApp templates (PR W1) — the only file that reads or writes these:
 *
 *  - `CaptivePortal_WhatsAppTemplates/{wt_…}`: one template (name × Meta language). Our step
 *    (`stage`), Meta's state (`meta`), our text (`source`/`compiled`), two counters (`version`:
 *    content edits, what `baseVersion` is compared to; `seq`: every change, Meta's too) and alerts
 *    waiting to be emailed (`pendingAlerts`, written in the same transaction as the change, so a
 *    crash can't lose one). Its timeline is `history/{seq}`.
 *  - `CaptivePortal_WhatsAppLog/{auto}`: the activity log — every step, every actor, Meta's exact
 *    answer. A change writes its log row and its timeline entry in the same transaction.
 *    `expireAt` +13 months (a TTL policy can be added later; none is needed).
 *  - `CaptivePortal_AdaptiveConfig/whatsapp`: the Meta connection (WABA id), the last sync, the
 *    limits, the number counters, the tick's lease, the summary's last day.
 *
 * Never imports a Meta client (tests/adaptiveWhatsAppBoundary.test.ts): what Meta says comes in
 * as arguments. Reads are by id, the whole (small) registry, or newest-first single-field queries:
 * no composite index.
 */

import { FieldValue, type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, HISTORY, WHATSAPP_DOC_ID } from '../store/collections';
import { stripUndefined, toJson } from '../store/serialize';
import { tsMs } from '../store/time';
import { hashId } from '../core/checksum';
import { ApiError, conflict, notFound } from '../api/errors';
import { HttpError } from '../api/http';
import type { Lang } from '../core/constants';
import type { MetaButton, WaCompiled, WaRequestable, WaSource, WaUse } from '../core/whatsapp/template';
import type { PendingAlert, WaStage } from '../core/whatsapp/status';

const DAY_MS = 86_400_000;
export const LOG_KEEP_MS = 396 * DAY_MS; // 13 months
const DETAIL_MAX = 4000;
const MAX_PENDING_ALERTS = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export type WaActorKind = 'admin' | 'ai' | 'auto' | 'meta' | 'system';
export interface WaActor {
  kind: WaActorKind;
  uid: string | null;
  /** Shown in the log (an admin's email, "Meta", "Auto"…). */
  label: string | null;
}
export const SYSTEM: WaActor = { kind: 'system', uid: null, label: 'HeidiFi' };
export const META: WaActor = { kind: 'meta', uid: null, label: 'Meta' };

export type WaLogLevel = 'info' | 'warn' | 'error' | 'routine';

export interface WaLogInput {
  kind: string;
  level: WaLogLevel;
  actor: WaActor;
  summary: string;
  from?: string | null;
  to?: string | null;
  detail?: Record<string, unknown> | null;
  runId?: string | null;
}

export interface WaMetaState {
  id: string | null;
  status: string | null;
  category: string | null;
  previousCategory: string | null;
  rejectedReason: string | null;
  quality: string | null;
  parameterFormat: string | null;
  headerText: string | null;
  bodyText: string | null;
  footerText: string | null;
  buttons: MetaButton[];
  otherComponents: string[];
  /** When Meta's status became APPROVED (for the summary). */
  approvedAt: unknown;
  lastChangedAt: unknown;
}

export interface WaSubmitState {
  kind: 'create' | 'edit';
  prevStage: 'draft' | 'submitted';
  /** Engine-clock ms (the tick's 10-minute rule; tests move the fake clock). */
  startedAtMs: number;
  by: WaActor;
}

export interface WaSubmitError {
  code: string;
  message: string;
  metaCode: number | null;
  metaSubcode: number | null;
  fbtraceId: string | null;
  at: unknown;
}

export interface WaTemplateDoc {
  name: string;
  language: string;
  lang: Lang | null;
  use: WaUse | null;
  origin: 'imported' | 'manual' | 'ai';
  requestedCategory: WaRequestable | null;
  source: WaSource | null;
  compiled: WaCompiled | null;
  meta: WaMetaState | null;
  stage: WaStage;
  submit: WaSubmitState | null;
  lastSubmitError: WaSubmitError | null;
  dismissed: boolean;
  useEnabled: boolean;
  version: number;
  seq: number;
  hint: { at: unknown; field: string; event: string | null } | null;
  pendingAlerts: PendingAlert[];
  /** PR W2: the AI run that wrote it. */
  ai: Record<string, unknown> | null;
  /** The WhatsApp Business Account Meta holds it in (set when Meta has it): only that account's sync may call it deleted. */
  wabaId?: string | null;
  createdAt: unknown;
  createdBy: string;
  updatedAt: unknown;
  updatedBy: string;
}

export type StoredTemplate = WaTemplateDoc & { id: string };

// ── Collections ──────────────────────────────────────────────────────────────

const templates = () => db.collection(COL.whatsappTemplates);
const logCol = () => db.collection(COL.whatsappLog);
const opsRef = () => db.collection(COL.config).doc(WHATSAPP_DOC_ID);

export function templateRef(id: string) {
  return templates().doc(id);
}


// ── Firestore shape ──────────────────────────────────────────────────────────
// Firestore refuses nested arrays, and Meta's body example is one (`body_text: [[…]]`): the exact
// components are stored as JSON text (`componentsJson`) and turned back on every read.

function encode<T extends Partial<WaTemplateDoc>>(doc: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  if (doc.compiled) {
    const { components, ...rest } = doc.compiled;
    out.compiled = { ...rest, componentsJson: JSON.stringify(components ?? []) };
  }
  return stripUndefined(out);
}

function decode(id: string, data: Record<string, unknown>): StoredTemplate {
  const compiled = data.compiled as (Record<string, unknown> & { componentsJson?: string }) | null | undefined;
  let decoded: unknown = compiled ?? null;
  if (compiled) {
    const { componentsJson, ...rest } = compiled;
    let components: unknown[] = [];
    try {
      components = typeof componentsJson === 'string' ? (JSON.parse(componentsJson) as unknown[]) : [];
    } catch {
      components = [];
    }
    decoded = { ...rest, components };
  }
  return { id, ...(data as unknown as WaTemplateDoc), compiled: decoded as WaCompiled | null } as StoredTemplate;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getTemplate(id: string): Promise<StoredTemplate | null> {
  const snap = await templates().doc(id).get();
  return snap.exists ? decode(id, snap.data() as Record<string, unknown>) : null;
}

/** The whole registry (a few hundred docs at most). */
export async function listTemplates(): Promise<StoredTemplate[]> {
  const snap = await templates().get();
  return snap.docs.map((d) => decode(d.id, d.data() as Record<string, unknown>));
}

// ── The log ──────────────────────────────────────────────────────────────────

function capDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const clean = stripUndefined(detail);
  const text = JSON.stringify(clean);
  if (text.length <= DETAIL_MAX) return clean;
  return { truncated: true, preview: text.slice(0, DETAIL_MAX - 100) };
}

interface LogPlace {
  templateId?: string | null;
  name?: string | null;
  language?: string | null;
  poolKey?: string | null;
  /** The template's `seq` after this change: its timeline entry id. */
  seq?: number | null;
}

function logRow(entry: WaLogInput, place: LogPlace) {
  return {
    at: FieldValue.serverTimestamp(),
    kind: entry.kind,
    level: entry.level,
    actor: { kind: entry.actor.kind, uid: entry.actor.uid ?? null, label: entry.actor.label ?? null },
    summary: entry.summary.slice(0, 500),
    from: entry.from ?? null,
    to: entry.to ?? null,
    detail: capDetail(entry.detail),
    runId: entry.runId ?? null,
    templateId: place.templateId ?? null,
    name: place.name ?? null,
    language: place.language ?? null,
    poolKey: place.poolKey ?? null,
    seq: place.seq ?? null,
    expireAt: new Date(Date.now() + LOG_KEEP_MS),
  };
}

const seqId = (seq: number) => String(seq).padStart(8, '0');

/** A row's timeline id: the change's `seq` (padded, so ids sort) or, for a row that changes nothing, the log row's own id. */
const historyIdFor = (place: LogPlace, logId: string) => (place.seq ? seqId(place.seq) : `${seqId(0)}_${logId}`);

/** One log row (and, for a template, its timeline entry) inside a transaction or batch. */
export function logInTx(w: Transaction | WriteBatch, entry: WaLogInput, place: LogPlace = {}): void {
  const row = logRow(entry, place);
  const ref = logCol().doc();
  (w as Transaction).set(ref, row);
  if (place.templateId) (w as Transaction).set(templates().doc(place.templateId).collection(HISTORY).doc(historyIdFor(place, ref.id)), row);
}

/** One log row outside a change (connection checks, syncs, the tick, refusals, alerts): also on the template's timeline. Never throws. */
export async function writeLog(entry: WaLogInput, place: LogPlace = {}): Promise<void> {
  try {
    const batch = db.batch();
    logInTx(batch, entry, place);
    await batch.commit();
  } catch (err) {
    console.error('[WA TEMPLATES] log write failed', (err as Error)?.name ?? 'Error');
  }
}

export interface LogQuery {
  templateId?: string | null;
  /** The `nextBefore` of the previous page (a row id): older than that row. */
  before?: string | null;
  limit: number;
  /** Include the routine rows (syncs that changed nothing). */
  routine?: boolean;
}

export interface LogPage {
  rows: Array<Record<string, unknown>>;
  /** Pass back as `before` for the next page (the last row LOOKED AT, shown or not), or null at the end. */
  nextBefore: string | null;
}

/**
 * The activity log newest first, or one template's timeline (also newest first, by time). Paged by
 * the last row looked at — exact, and routine rows hidden in memory never make "Older" vanish.
 */
export async function listLog(q: LogQuery): Promise<LogPage> {
  const col = q.templateId ? templates().doc(q.templateId).collection(HISTORY) : logCol();
  let query = col.orderBy('at', 'desc');
  if (q.before) {
    const cursor = await col.doc(q.before).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  // Filtering routine rows in memory keeps this on the single-field index.
  const scan = q.routine ? q.limit : Math.min(q.limit * 4, 400);
  const snap = await query.limit(scan).get();
  const rows: Array<Record<string, unknown>> = [];
  let last: string | null = null;
  for (const d of snap.docs) {
    last = d.id;
    const r = d.data();
    if (!q.routine && r.level === 'routine') continue;
    rows.push({ id: d.id, ...(toJson(r) as Record<string, unknown>) });
    if (rows.length >= q.limit) break;
  }
  const more = rows.length >= q.limit || snap.size >= scan;
  return { rows, nextBefore: more ? last : null };
}

// ── Changing one template ────────────────────────────────────────────────────

export interface TemplateChange {
  /** A new doc (the id must not exist). */
  create?: Omit<WaTemplateDoc, 'seq' | 'createdAt' | 'updatedAt' | 'pendingAlerts'>;
  /** Top-level fields to set on an existing doc (whole sub-objects). */
  set?: Partial<WaTemplateDoc>;
  log: WaLogInput;
  alerts?: PendingAlert[];
}

/**
 * One transaction: read the doc, let `decide` work out the change (pure — it may throw an
 * ApiError to refuse), write it with `seq` + 1, its log row, its timeline entry and its alerts.
 * `decide` returning null changes nothing (no log row).
 */
export async function changeTemplate(
  id: string,
  decide: (current: StoredTemplate | null) => TemplateChange | null,
): Promise<{ doc: StoredTemplate | null; changed: boolean; change: TemplateChange | null }> {
  return db.runTransaction(async (tx) => {
    const ref = templates().doc(id);
    const snap = await tx.get(ref);
    const current = snap.exists ? decode(id, snap.data() as Record<string, unknown>) : null;
    const change = decide(current);
    if (!change) return { doc: current, changed: false, change: null };
    const now = new Date();
    const seq = (current?.seq ?? 0) + 1;
    let next: StoredTemplate;
    if (change.create) {
      if (current) throw conflict('This template already exists');
      const created: WaTemplateDoc = { ...change.create, seq, createdAt: now, updatedAt: now, pendingAlerts: (change.alerts ?? []).slice(-MAX_PENDING_ALERTS) };
      tx.create(ref, encode(created));
      next = { id, ...created };
    } else {
      if (!current) throw notFound('No such template');
      const patch: Partial<WaTemplateDoc> = { ...(change.set ?? {}), seq, updatedAt: now };
      if (change.alerts?.length) patch.pendingAlerts = [...(current.pendingAlerts ?? []), ...change.alerts].slice(-MAX_PENDING_ALERTS);
      tx.update(ref, encode(patch));
      next = { ...current, ...patch };
    }
    logInTx(tx, change.log, { templateId: id, name: next.name, language: next.language, poolKey: next.use?.kind === 'adaptive' ? next.use.poolKey : null, seq });
    return { doc: next, changed: true, change };
  });
}

/** Removes alerts that were emailed (only those keys: one added meanwhile stays). */
export async function dropPendingAlerts(id: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await db.runTransaction(async (tx) => {
    const ref = templates().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const left = ((snap.get('pendingAlerts') as PendingAlert[] | undefined) ?? []).filter((a) => !keys.includes(a.key));
    tx.update(ref, { pendingAlerts: left });
  });
}

// ── The operations doc ───────────────────────────────────────────────────────

export interface WaConnection {
  ok: boolean;
  checkedAt: unknown;
  wabaId: string | null;
  wabaSource: 'token' | 'manual' | null;
  canManage: boolean;
  scopes: string[];
  tokenExpiresAt: number | null;
  phoneNumberId: string | null;
  phoneFound: boolean;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  quality: string | null;
  problems: string[];
  /** The token's app (debug_token); null when Meta didn't say. Absent on checks made before this field. */
  appId?: string | null;
  appName?: string | null;
  /**
   * Whether the app is subscribed to the account's webhooks: `on`, `off` (Meta sends it no template
   * notices, and with W3 no delivery receipts), `unknown` (couldn't tell). Template notices always go
   * to the app's own callback address — Meta allows no override for them.
   */
  notices?: 'on' | 'off' | 'unknown';
  /** Subscribed with another callback address (an override): message webhooks (W3) go there; template notices don't. */
  messagesOverride?: boolean;
  /** Other apps subscribed to the account (names), for the admin's information. */
  otherApps?: string[];
  /** Meta described the token (debug_token answered); false: its expiry is unknown (the last known one is kept). */
  tokenDescribed?: boolean;
}

export interface WaOps {
  wabaId: string | null;
  connection: WaConnection | null;
  /** The connection worked at least once (connection alerts only after that). */
  everWorked: boolean;
  lastSync: { at: unknown; atMs: number | null; engineAtMs: number | null; ok: boolean; complete: boolean; changes: number; imported: number; error: { code: string; message: string } | null; ms: number; pages: number } | null;
  /** A webhook named a template we don't have yet (the tick syncs at once). */
  hintUnknownAtMs: number | null;
  /** Engine-clock ms of the last complete sync. */
  lastFullSyncAtMs: number | null;
  templateLimit: number;
  /** Templates at Meta after the last complete sync (null: unknown). */
  templateCount: number | null;
  createsHour: { key: string; count: number };
  nextNumber: Record<string, number>;
  lease: { owner: string; until: number } | null;
  digest: { lastDay: string | null; lastAtMs: number | null };
  /** Meta asked us to slow down (rate limit): no sync or repair before this (real ms). */
  backoffUntilMs: number | null;
  /** Syncs failed in a row (reset by a good one): a connection alert after 3. */
  syncFailures: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function parseOps(raw: Record<string, unknown> | undefined): WaOps {
  const r = raw ?? {};
  const lease = r.lease as Record<string, unknown> | undefined;
  const digest = (r.digest ?? {}) as Record<string, unknown>;
  const creates = (r.createsHour ?? {}) as Record<string, unknown>;
  const lastSync = r.lastSync as Record<string, unknown> | undefined;
  return {
    wabaId: typeof r.wabaId === 'string' && r.wabaId ? r.wabaId : null,
    connection: (r.connection as WaConnection | undefined) ?? null,
    everWorked: r.everWorked === true,
    lastSync: lastSync
      ? ({ ...(lastSync as object), atMs: tsMs(lastSync.at), engineAtMs: typeof lastSync.engineAtMs === 'number' ? lastSync.engineAtMs : null } as WaOps['lastSync'])
      : null,
    hintUnknownAtMs: tsMs(r.hintUnknownAt),
    lastFullSyncAtMs: typeof r.lastFullSyncAtMs === 'number' ? r.lastFullSyncAtMs : null,
    templateLimit: Math.max(1, num(r.templateLimit, 250)),
    templateCount: typeof r.templateCount === 'number' ? r.templateCount : null,
    createsHour: { key: typeof creates.key === 'string' ? creates.key : '', count: num(creates.count, 0) },
    nextNumber: (r.nextNumber as Record<string, number> | undefined) ?? {},
    lease: lease && typeof lease.owner === 'string' ? { owner: lease.owner, until: tsMs(lease.until) ?? 0 } : null,
    digest: { lastDay: typeof digest.lastDay === 'string' ? digest.lastDay : null, lastAtMs: typeof digest.lastAtMs === 'number' ? digest.lastAtMs : null },
    backoffUntilMs: typeof r.backoffUntilMs === 'number' ? r.backoffUntilMs : null,
    syncFailures: num(r.syncFailures, 0),
  };
}

export async function readOps(): Promise<WaOps> {
  const snap = await opsRef().get();
  return parseOps(snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
}

/** Merges fields into the operations doc. */
export async function updateOps(patch: Record<string, unknown>): Promise<void> {
  await opsRef().set(stripUndefined(patch), { merge: true });
}

export function opsDocRef() {
  return opsRef();
}

/** UTC yyyymmddhh: the hour Meta's 100-creates limit counts in. */
export function hourKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/** Creates counted in this hour (0 in a new hour). */
export function createsThisHour(ops: WaOps, realNow: number): number {
  return ops.createsHour.key === hourKey(realNow) ? ops.createsHour.count : 0;
}

/** The name counters only move up (a sync that read old numbers can't lower one a new draft just raised). */
export async function raiseNextNumbers(next: Record<string, number>): Promise<void> {
  if (!Object.keys(next).length) return;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(opsRef());
    const cur = parseOps(snap.exists ? (snap.data() as Record<string, unknown>) : undefined).nextNumber;
    const up: Record<string, number> = {};
    for (const [pool, n] of Object.entries(next)) if (n > (cur[pool] ?? 1)) up[pool] = n;
    if (Object.keys(up).length) tx.set(opsRef(), { nextNumber: up }, { merge: true });
  });
}

/**
 * Webhook notices within this time of a template's (or the account's) mark don't write it again, so
 * a burst — or a forger — costs at most one write per doc in this time. In exchange a sync clears
 * only marks older than its list's start minus this time: a list that started later covers every
 * notice the mark stood for.
 */
export const HINT_COALESCE_MS = 30_000;

/** Clears "a webhook named a template we don't have" — only a mark older than `beforeMs` (the list's start minus HINT_COALESCE_MS). */
export async function clearHintUnknownIfBefore(beforeMs: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(opsRef());
    const at = tsMs(snap.get('hintUnknownAt'));
    if (at !== null && at < beforeMs) tx.set(opsRef(), { hintUnknownAt: null }, { merge: true });
  });
}

/** Whether an alert with this dedupe key was recorded (`raiseAlert` never throws: a failed write must be retried). */
export async function alertRecorded(dedupeKey: string): Promise<boolean> {
  try {
    return (await db.collection(COL.alerts).doc(hashId('al', dedupeKey)).get()).exists;
  } catch {
    return false;
  }
}

// ── The tick's lease (one run at a time; deploys can overlap two API containers) ──

export async function claimLease(owner: string, ms: number): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(opsRef());
    const lease = snap.get('lease') as { owner?: string; until?: unknown } | undefined;
    const until = tsMs(lease?.until) ?? 0;
    if (lease?.owner && lease.owner !== owner && until > Date.now()) return false;
    tx.set(opsRef(), { lease: { owner, until: new Date(Date.now() + ms) } }, { merge: true });
    return true;
  });
}

export async function renewLease(owner: string, ms: number): Promise<boolean> {
  return db
    .runTransaction(async (tx) => {
      const snap = await tx.get(opsRef());
      if (snap.get('lease.owner') !== owner) return false;
      tx.set(opsRef(), { lease: { owner, until: new Date(Date.now() + ms) } }, { merge: true });
      return true;
    })
    .catch(() => false);
}

export async function releaseLease(owner: string): Promise<void> {
  await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(opsRef());
      if (snap.get('lease.owner') !== owner) return;
      tx.set(opsRef(), { lease: null }, { merge: true });
    })
    .catch(() => undefined);
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * A new draft with a fresh `hf_<pool>_<n>` name (the counter moves past any name already taken),
 * or a new language of an existing name of ours — in one transaction.
 */
export async function createDraftDoc(
  input: { poolKey: string; lang: Lang; existingName: string | null; build: (name: string, id: string) => TemplateChange },
  idFor: (name: string, language: string) => string,
): Promise<StoredTemplate> {
  return db.runTransaction(async (tx) => {
    const opsSnap = await tx.get(opsRef());
    const ops = parseOps(opsSnap.exists ? (opsSnap.data() as Record<string, unknown>) : undefined);
    let name = input.existingName;
    let n = 0;
    if (!name) {
      n = Math.max(1, ops.nextNumber[input.poolKey] ?? 1);
      // A name of this pool already used in any language (say, one created in WhatsApp Manager) is skipped.
      for (let i = 0; i < 50; i += 1) {
        const candidate = `hf_${input.poolKey}_${n}`;
        const taken = await tx.get(templates().where('name', '==', candidate).limit(1));
        if (taken.empty) break;
        n += 1;
        if (i === 49) throw conflict('No free name for this message (50 tried) — sync with Meta and try again');
      }
      name = `hf_${input.poolKey}_${n}`;
    }
    const id = idFor(name, input.lang);
    const ref = templates().doc(id);
    const existing = await tx.get(ref);
    if (existing.exists) throw conflict(`“${name}” already has a ${input.lang.toUpperCase()} version`);
    const change = input.build(name, id);
    if (!change.create) throw new ApiError('internal', 'A draft must be a create');
    const now = new Date();
    const doc: WaTemplateDoc = { ...change.create, seq: 1, createdAt: now, updatedAt: now, pendingAlerts: [] };
    tx.create(ref, encode(doc));
    if (!input.existingName) tx.set(opsRef(), { nextNumber: { [input.poolKey]: n + 1 } }, { merge: true });
    logInTx(tx, change.log, { templateId: id, name, language: doc.language, poolKey: input.poolKey, seq: 1 });
    return { id, ...doc };
  });
}

// ── Submitting (begin: one winner; the Meta call happens outside) ────────────

/**
 * Moves a draft (or a rejected/paused template being edited) to `submitting`, comparing
 * `baseVersion`, counting the create in this hour (Meta allows 100) — one transaction, so of two
 * clicks one wins and the other gets a 409.
 */
export async function beginSubmit(
  id: string,
  args: { baseVersion: number; by: WaActor; engineNow: number; realNow: number; maxCreatesPerHour: number },
): Promise<{ doc: StoredTemplate; kind: 'create' | 'edit' }> {
  return db.runTransaction(async (tx) => {
    const ref = templates().doc(id);
    const [snap, opsSnap] = await Promise.all([tx.get(ref), tx.get(opsRef())]);
    if (!snap.exists) throw notFound('No such template');
    const cur = decode(id, snap.data() as Record<string, unknown>);
    const ops = parseOps(opsSnap.exists ? (opsSnap.data() as Record<string, unknown>) : undefined);
    if (cur.version !== args.baseVersion) throw staleTemplate();
    if (cur.dismissed) throw conflict('This template is dismissed — restore it first');
    const metaStatus = String(cur.meta?.status ?? '').toUpperCase();
    let kind: 'create' | 'edit';
    if (cur.stage === 'draft') kind = 'create';
    else if (cur.stage === 'submitted' && (metaStatus === 'REJECTED' || metaStatus === 'PAUSED') && cur.meta?.id) kind = 'edit';
    else throw conflict(cur.stage === 'submitting' ? 'It is being sent to Meta already' : 'Only a draft, or a rejected or paused template, can be sent to Meta');
    if (!cur.source || !cur.compiled || !cur.requestedCategory) throw conflict('This template has no text of ours to send');
    const key = hourKey(args.realNow);
    const used = ops.createsHour.key === key ? ops.createsHour.count : 0;
    if (kind === 'create' && used >= args.maxCreatesPerHour) throw new HttpLikeTooMany();
    const seq = cur.seq + 1;
    const submit: WaSubmitState = { kind, prevStage: cur.stage === 'draft' ? 'draft' : 'submitted', startedAtMs: args.engineNow, by: args.by };
    tx.update(ref, { stage: 'submitting', submit, lastSubmitError: null, seq, updatedAt: new Date(), updatedBy: args.by.uid ?? args.by.kind });
    if (kind === 'create') tx.set(opsRef(), { createsHour: { key, count: used + 1 } }, { merge: true });
    logInTx(
      tx,
      {
        kind: 'submit.started',
        level: 'info',
        actor: args.by,
        summary: kind === 'create' ? `Sending ${cur.name} (${cur.language}) to Meta for review` : `Sending the edited ${cur.name} (${cur.language}) to Meta for review`,
        from: cur.stage === 'draft' ? 'draft' : metaStatus.toLowerCase(),
        to: 'submitting',
        detail: { category: cur.requestedCategory, kind },
      },
      { templateId: id, name: cur.name, language: cur.language, poolKey: cur.use?.kind === 'adaptive' ? cur.use.poolKey : null, seq },
    );
    return { doc: { ...cur, stage: 'submitting', submit, seq }, kind };
  });
}

/** 429 for the hourly limit (the API maps it). */
export class HttpLikeTooMany extends Error {
  constructor() {
    super('Meta allows 100 new templates an hour; try again in the next hour');
    this.name = 'HttpLikeTooMany';
  }
}

/** 409 `stale`: the screen's `baseVersion` is behind (the cms reloads); other 409s keep their own words. */
export function staleTemplate(): HttpError {
  return new HttpError(409, 'stale', 'This template changed meanwhile — reload and check');
}

// ── Who acted ────────────────────────────────────────────────────────────────

const labels = new Map<string, { label: string | null; at: number }>();

/** An admin as the log shows them (their email from `Users/{uid}`, cached 10 minutes). */
export async function adminActor(uid: string): Promise<WaActor> {
  const hit = labels.get(uid);
  if (hit && Date.now() - hit.at < 10 * 60_000) return { kind: 'admin', uid, label: hit.label };
  let label: string | null = null;
  try {
    const snap = await db.collection(COL.tenantUsers).doc(uid).get();
    const email = snap.get('email');
    const name = snap.get('displayName') ?? snap.get('name');
    label = typeof email === 'string' && email ? email : typeof name === 'string' && name ? name : null;
  } catch {
    label = null;
  }
  labels.set(uid, { label, at: Date.now() });
  if (labels.size > 500) labels.clear();
  return { kind: 'admin', uid, label };
}
