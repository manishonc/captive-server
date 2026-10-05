/**
 * The AI template writer's side of the WhatsApp registry (PR W2), run by the worker (the job in
 * brain/jobs/waTemplateWriter.ts calls these; the API loads them through the registry but never
 * runs them). Never reaches a Meta client or whatsapp/context.ts (it reaches services/optOut.ts):
 * everything the checks need came in the run's `local` part, built by the API.
 *
 *  - `precheckWriter`: before the model is called, is the run still wanted (the cell may be filled,
 *    the template edited, the English one gone)? A skip writes no run record, one log row here.
 *  - `applyWriterAnswer`: inside the run's own transaction (store/agents.ts `applyRunOnce`) — every
 *    read first, then the draft (or the fix) with its log row, the cell's pending mark cleared. A
 *    conflict (the language exists, no free name, edited meanwhile) is a decision, never a retry.
 *  - `reportWriterRun`: a run that wasn't applied (skipped, rejected, failed) → one log row, the
 *    pending mark cleared, and for the daily gap-fill a cell rejected 3 times in a row waits 7 days.
 */

import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL, WHATSAPP_DOC_ID } from '../store/collections';
import { tsMs } from '../store/time';
import { whatsappTemplateIdFor } from '../core/runtime/ids';
import { compileTemplate, metaLanguageFor } from '../core/whatsapp/template';
import { displayStatus, type WaDisplay } from '../core/whatsapp/status';
import {
  aiFixUnsentOf,
  cellKeyOf,
  MAX_AI_FIXES,
  parseWriterParams,
  writerLocalSchema,
  sourceFromAnswer,
  stillNeeded,
  writerCodeWords,
  type WriterAnswer,
  type WriterLocal,
  type WriterTemplateView,
} from '../core/whatsapp/aiBrief';
import type { PoolInfo } from '../core/whatsapp/checks';
import type { ApplyDecision, RunReport } from '../brain/types';
import {
  AI_ACTOR,
  aiInfoOf,
  changeTemplateInTx,
  createDraftInTx,
  listTemplates,
  logInTx,
  opsInTx,
  readOpsInTx,
  templatesOfMessageInTx,
  writeLog,
  type StoredTemplate,
  type WaAiInfo,
} from './store';

const DAY = 86_400_000;
/** A gap-fill cell rejected this many runs in a row waits REJECT_COOLDOWN_MS. */
const REJECTS_BEFORE_COOLDOWN = 3;
const REJECT_COOLDOWN_MS = 7 * DAY;

/** A template as the writer's rules see it (a draft counts as filling its cell whatever its checks say). */
export function writerViewOf(d: StoredTemplate, display: WaDisplay): WriterTemplateView {
  const ai = aiInfoOf(d);
  const changedAtMs = tsMs(d.meta?.lastChangedAt) ?? tsMs(d.updatedAt) ?? 0;
  return {
    id: d.id,
    name: d.name,
    lang: d.lang,
    origin: d.origin,
    display,
    dismissed: d.dismissed === true,
    version: d.version,
    stage: d.stage,
    metaStatus: d.meta?.status ?? null,
    rejectedReason: d.meta?.rejectedReason ?? null,
    source: d.source,
    changedAtMs,
    aiFixes: ai?.fixes ?? 0,
    dismissedAtMs: d.dismissed && d.origin === 'ai' ? tsMs(d.updatedAt) : null,
    category: d.meta?.category ?? d.requestedCategory ?? null,
    aiFixUnsent: aiFixUnsentOf(
      ai ? { kind: ai.kind, appliedVersion: ai.appliedVersion, atMs: Number.isFinite(Date.parse(ai.at)) ? Date.parse(ai.at) : null, ...(ai.sentVersion !== undefined ? { sentVersion: ai.sentVersion } : {}) } : null,
      d.version,
      tsMs(d.meta?.lastChangedAt),
    ),
  };
}

/** The display without the template checks (the worker can't build their context): enough for the writer's rules. */
export function displayForWriter(d: StoredTemplate, pool: PoolInfo | null): WaDisplay {
  return displayStatus({
    stage: d.stage,
    metaStatus: d.meta?.status ?? null,
    metaCategory: d.meta?.category ?? null,
    dismissed: d.dismissed === true,
    checksOk: true,
    poolCategory: pool?.whatsappCategory ?? null,
    adaptive: d.use?.kind === 'adaptive',
  });
}

function viewsOf(docs: StoredTemplate[], local: WriterLocal): WriterTemplateView[] {
  return docs.map((d) => writerViewOf(d, displayForWriter(d, local.checkCtx.pool)));
}

const label = (local: WriterLocal) => `${local.use.poolKey} (${local.lang.toUpperCase()})`;

// ── Before the model ─────────────────────────────────────────────────────────

export async function precheckWriter(params: Record<string, unknown>): Promise<{ skip: string; detail?: string } | null> {
  const p = parseWriterParams(params);
  if (!p) return { skip: 'bad_params', detail: writerCodeWords('bad_params') };
  const docs = (await listTemplates()).filter((d) => d.use?.kind === 'adaptive' && d.use.journeyKey === p.local.use.journeyKey && d.use.poolKey === p.local.use.poolKey);
  const why = stillNeeded(p.local, viewsOf(docs, p.local));
  return why ? { skip: why, detail: writerCodeWords(why) } : null;
}

// ── The answer, applied once ─────────────────────────────────────────────────

export async function applyWriterAnswer(
  tx: Transaction,
  args: { runId: string; taskId: string | null; out: WriterAnswer; local: WriterLocal; model: string | null; promptVersion: string | null },
): Promise<ApplyDecision> {
  const { out, local, runId } = args;
  const cell = cellKeyOf(local.use.journeyKey, local.use.poolKey, local.lang);
  // Reads first.
  const docs = await templatesOfMessageInTx(tx, local.use);
  const ops = await readOpsInTx(tx);
  // The cell's pending mark only when it is this run's (a newer run may have marked it since).
  const mine = args.taskId !== null && ops.aiPending[cell]?.taskId === args.taskId;
  const opsPatch = {
    ...(mine ? { aiPending: { [cell]: FieldValue.delete() } } : {}),
    aiGapFill: { rejects: { [cell]: FieldValue.delete() } },
  };
  const placeOf = (d?: StoredTemplate | null) => (d ? { templateId: d.id, name: d.name, language: d.language, poolKey: local.use.poolKey } : { poolKey: local.use.poolKey, language: metaLanguageFor(local.lang) });

  const superseded = (code: string, d?: StoredTemplate | null): ApplyDecision => {
    opsInTx(tx, opsPatch);
    logInTx(
      tx,
      {
        kind: 'ai.superseded',
        level: 'info',
        actor: AI_ACTOR,
        runId,
        summary: `The AI’s ${local.kind} for ${label(local)} wasn’t used: ${writerCodeWords(code)}`,
        detail: { code, kind: local.kind, requestedBy: local.requestedBy },
      },
      placeOf(d),
    );
    return { state: 'superseded', code, detail: writerCodeWords(code), ref: d ? { templateId: d.id, name: d.name } : null };
  };

  const why = stillNeeded(local, viewsOf(docs, local));
  if (why) return superseded(why, local.targetTemplateId ? docs.find((d) => d.id === local.targetTemplateId) : null);

  const source = sourceFromAnswer(out, local);
  const compiled = compileTemplate(source, { lang: local.lang, visitorBaseUrl: local.checkCtx.visitorBaseUrl });
  const at = new Date().toISOString();
  const aiBase: Omit<WaAiInfo, 'appliedVersion' | 'fixes'> = {
    runId,
    kind: local.kind,
    requestedBy: local.requestedBy,
    model: args.model,
    promptVersion: args.promptVersion,
    reasoning: out.reasoning.slice(0, 1200),
    categoryReason: out.categoryReason.slice(0, 300),
    at,
  };

  if (local.kind === 'fix') {
    const cur = docs.find((d) => d.id === local.targetTemplateId);
    if (!cur) return superseded('no_target');
    const prev = aiInfoOf(cur);
    const fixes = (prev?.fixes ?? 0) + 1;
    const version = cur.version + 1;
    // What the AI first wrote it as stays (an "alternative" stays one: Auto never sends it).
    const writtenAs = prev?.writtenAs ?? (prev && prev.kind !== 'fix' ? prev.kind : null);
    // Not sent yet (Meta saw an older version).
    const ai: WaAiInfo = { ...aiBase, appliedVersion: version, fixes, writtenAs, sentVersion: null };
    changeTemplateInTx(tx, cur, {
      set: { source, compiled, requestedCategory: out.category, version, ai: ai as unknown as Record<string, unknown>, lastSubmitError: null, updatedBy: 'ai' },
      log: {
        kind: 'ai.fix_written',
        level: 'info',
        actor: AI_ACTOR,
        runId,
        summary: `The AI rewrote ${cur.name} (${cur.language}) for Meta’s ${cur.meta?.rejectedReason ? `“${cur.meta.rejectedReason}”` : 'decision'} — AI fix ${fixes} of ${MAX_AI_FIXES}; send it again to Meta`,
        from: 'rejected',
        to: 'rejected',
        detail: { kind: 'fix', requestedBy: local.requestedBy, category: out.category, model: args.model, fixes },
      },
    });
    opsInTx(tx, opsPatch);
    return { state: 'applied', code: null, detail: null, ref: { templateId: cur.id, name: cur.name } };
  }

  const language = metaLanguageFor(local.lang);
  const res = await createDraftInTx(
    tx,
    {
      poolKey: local.use.poolKey,
      lang: local.lang,
      existingName: local.kind === 'translation' ? local.existingName : null,
      ops,
      extraOps: opsPatch,
      build: (name) => ({
        create: {
          name,
          language,
          lang: local.lang,
          use: { kind: 'adaptive', ...local.use },
          origin: 'ai',
          requestedCategory: out.category,
          source,
          compiled,
          meta: null,
          stage: 'draft',
          submit: null,
          lastSubmitError: null,
          dismissed: false,
          // Used as soon as Meta approves it (Manish, 2026-10-04); one click pauses it.
          useEnabled: true,
          version: 1,
          hint: null,
          ai: { ...aiBase, appliedVersion: 1, fixes: 0, writtenAs: local.kind === 'fix' ? null : local.kind, sentVersion: null } as unknown as Record<string, unknown>,
          createdBy: 'ai',
          updatedBy: 'ai',
        },
        log: {
          kind: 'ai.draft_written',
          level: 'info',
          actor: AI_ACTOR,
          runId,
          summary: `The AI wrote ${name} (${language}) for “${local.use.poolKey}” as ${out.category}${local.kind === 'translation' ? ' (a translation of the English one)' : local.kind === 'alternative' ? ' (an alternative)' : ''}`,
          to: 'draft',
          detail: { kind: local.kind, requestedBy: local.requestedBy, category: out.category, categoryReason: out.categoryReason.slice(0, 300), model: args.model, withheld: local.withheld },
        },
      }),
    },
    whatsappTemplateIdFor,
  );
  if (!res.ok) return superseded(res.code);
  return { state: 'applied', code: null, detail: null, ref: { templateId: res.doc.id, name: res.doc.name } };
}

// ── A run that wasn't applied ────────────────────────────────────────────────

/** Skips that say nothing about the cell (another attempt has the task, the worker is stopping…). */
const QUIET = new Set(['already_called', 'applied_earlier', 'duplicate', 'lease_lost', 'shutdown', 'gone']);
/** The precheck's skips: the run wasn't needed any more (routine). */
const NOT_NEEDED = new Set(['cell_filled', 'language_exists', 'edited_since', 'not_editable', 'fix_limit', 'english_missing', 'no_target', 'other_language', 'bad_params']);

/** PR W2b: run endings that say nothing about the template (Auto may ask for its fix again). */
const PASSING = new Set([
  'aborted',
  'interrupted',
  'finish_failed',
  'agents_off',
  'agent_off',
  'budget',
  'daily_limit',
  'stale',
  'sending_paused',
  'timeout',
  'connection',
  'server_error',
  'rate_limited',
  'unavailable',
  'answer_lost',
  'relay_daily_limit',
  'deadline',
  'api_error',
  'unknown',
]);

/** A run's own reasons (the run's gates and ends) in words; the writer's codes are in writerCodeWords. */
const RUN_WORDS: Readonly<Record<string, string>> = {
  aborted: 'the worker restarted (a deploy) during the run — ask again',
  interrupted: 'the worker stopped during the run',
  agents_off: 'the AI agents are off',
  agent_off: 'the writer’s Scheduled runs are off',
  sending_paused: 'guest sending is paused',
  budget: 'this month’s AI budget is used up',
  daily_limit: 'the writer’s runs for today are used up',
  stale: 'it waited too long',
  bad_stored_answer: 'its stored answer couldn’t be read back',
  apply_gave_up: 'its answer couldn’t be saved for 7 days',
  finish_failed: 'its run record couldn’t be finished',
};
const wordsFor = (reason: string) => RUN_WORDS[reason] ?? writerCodeWords(reason);

/** The run's local part: from the task's params, else the one stored on the run. */
function localOf(r: RunReport): WriterLocal | null {
  const fromParams = parseWriterParams(r.params)?.local;
  if (fromParams) return fromParams;
  const stored = writerLocalSchema.safeParse(r.local);
  return stored.success ? (stored.data as unknown as WriterLocal) : null;
}

export async function reportWriterRun(r: RunReport): Promise<void> {
  try {
    if (r.outcome === 'ok' || (r.outcome === 'skipped' && QUIET.has(r.reason ?? ''))) return;
    const local = localOf(r);
    const cell = local ? cellKeyOf(local.use.journeyKey, local.use.poolKey, local.lang) : null;
    const what = local ? `${local.kind} for ${label(local)}` : 'run';
    const reason = r.reason ?? 'unknown';
    // The cell's pending mark (only this run's own: a newer run may have marked it since), and for
    // the gap-fill its rejections in a row.
    if (cell) {
      const ref = db.collection(COL.config).doc(WHATSAPP_DOC_ID);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const patch: Record<string, unknown> = {};
        const mark = (snap.get('aiPending') as Record<string, { taskId?: unknown }> | undefined)?.[cell];
        if (r.taskId !== null && mark?.taskId === r.taskId) patch.aiPending = { [cell]: FieldValue.delete() };
        // PR W2b: an AI fix Auto asked for that ended for a passing reason (a deploy, the gate, the
        // budget, the relay) — Auto may ask again for the same rejection (at most 3 tries). Its own
        // request only (a newer one may stand there).
        const target = local?.requestedBy === 'auto_fix' ? local.targetTemplateId : null;
        const stamp = target ? (snap.get('autoFix') as Record<string, { taskId?: unknown }> | undefined)?.[target] : undefined;
        if (target && stamp && r.taskId !== null && stamp.taskId === r.taskId && PASSING.has(reason)) patch.autoFix = { [target]: { retry: true } };
        if (r.outcome === 'rejected' && local?.requestedBy === 'gap_fill') {
          const rejects = Number(snap.get('aiGapFill')?.rejects?.[cell] ?? 0) + 1;
          patch.aiGapFill =
            rejects >= REJECTS_BEFORE_COOLDOWN
              ? { rejects: { [cell]: FieldValue.delete() }, cooldowns: { [cell]: Date.now() + REJECT_COOLDOWN_MS } }
              : { rejects: { [cell]: rejects } };
        }
        if (Object.keys(patch).length) tx.set(ref, patch, { merge: true });
      });
    }
    const place = local ? { poolKey: local.use.poolKey, language: metaLanguageFor(local.lang), templateId: local.kind === 'fix' ? local.targetTemplateId : null } : {};
    if (r.outcome === 'skipped') {
      const notNeeded = NOT_NEEDED.has(reason);
      await writeLog(
        {
          kind: 'ai.skipped',
          level: notNeeded ? 'routine' : 'warn',
          actor: AI_ACTOR,
          runId: r.runId,
          summary: notNeeded
            ? `The AI’s ${what} wasn’t needed any more: ${wordsFor(reason)}`
            : `The AI’s ${what} ${r.detail && /wasn’t used/.test(r.detail) ? 'wasn’t used' : 'didn’t run'}: ${wordsFor(reason)}`,
          detail: { reason, trigger: r.trigger },
        },
        place,
      );
      return;
    }
    const rejected = r.outcome === 'rejected';
    // A deploy stopping the run is routine; the next Suggest (or tomorrow's gap-fill) asks again.
    const aborted = reason === 'aborted';
    await writeLog(
      {
        kind: rejected ? 'ai.rejected' : 'ai.failed',
        level: rejected ? 'warn' : aborted ? 'info' : 'error',
        actor: AI_ACTOR,
        runId: r.runId,
        summary: rejected
          ? `The AI’s ${what} was rejected (${reason}): ${r.detail ?? 'a check failed'} — nothing was written`
          : `The AI’s ${what} ${aborted ? 'stopped' : 'failed'}: ${RUN_WORDS[reason] ?? reason} — nothing was written`,
        detail: { reason, trigger: r.trigger, model: r.modelUsed, detail: r.detail },
      },
      place,
    );
  } catch (err) {
    console.error('[WA TEMPLATES] AI run report failed', (err as Error)?.name ?? 'Error');
  }
}
