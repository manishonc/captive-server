/**
 * "Send to Meta" (PR W1; W2's Auto uses the same path). One click, synchronous, well under the
 * cms proxy's 60 s:
 *
 *  1. The checks again, against the current registry and rules (errors → 422, logged).
 *  2. A transaction moves the doc to `submitting`, comparing `baseVersion` and counting Meta's
 *     100-creates-an-hour — of two clicks one wins, the other gets a 409.
 *  3. Meta create (a draft) or edit (a rejected or paused template), then a read of the template
 *     for its real status and category (Meta may approve a UTILITY submission as MARKETING).
 *  4. The outcome, always logged:
 *     - accepted → `submitted` (in review, or already decided);
 *     - "already exists" → found by name and language and adopted; not found → Meta is still
 *       deleting that name ("name locked", T17) → back to draft;
 *     - no answer (timeout, 5xx) → stays `submitting`, never retried here: the tick looks it up
 *       after 10 minutes and adopts or reverts it;
 *     - any other refusal → back where it was, with Meta's words (`lastSubmitError`).
 */

import { parseMetaTemplate } from '../core/whatsapp/template';
import { META_CREATES_PER_HOUR } from '../core/whatsapp/checks';
import { conflict, validationFailed } from '../api/errors';
import { HttpError, unavailable } from '../api/http';
import { now as engineNow, refreshClock } from '../engine/clock';
import { raiseAlert, dayKey } from '../engine/alerts';
import { MetaError } from './metaError';
import { metaClient } from './source';
import { checkContext, draftForCheck, loadPools, reportFor } from './context';
import { decideFromMeta } from './apply';
import {
  beginSubmit,
  changeTemplate,
  getTemplate,
  HttpLikeTooMany,
  listTemplates,
  readOps,
  updateOps,
  writeLog,
  type StoredTemplate,
  type WaActor,
} from './store';

export type SubmitOutcome = 'submitted' | 'adopted' | 'refused' | 'locked' | 'unknown';

export interface SubmitResult {
  outcome: SubmitOutcome;
  doc: StoredTemplate | null;
  error: { kind: string; message: string; code: number | null; subcode: number | null; fbtraceId: string | null } | null;
}

const ERR_WORDS: Record<string, string> = {
  setup: 'The WhatsApp access token doesn’t work (expired or revoked)',
  permission: 'The token may not manage templates (whatsapp_business_management)',
  rate_limited: 'Meta asks us to slow down; try again in a few minutes',
  invalid: 'Meta refused the template',
  unavailable: 'Meta could not be reached',
};

export async function submitTemplate(id: string, baseVersion: number, by: WaActor): Promise<SubmitResult> {
  await refreshClock();
  const ops = await readOps();
  if (!ops.wabaId || !ops.connection?.ok) throw conflict('Check the Meta connection first (WhatsApp tab → Check connection)');
  const client = metaClient();
  if (!client.ready()) throw unavailable('WhatsApp is not configured on this server');

  const doc = await getTemplate(id);
  if (!doc) throw new HttpError(404, 'not_found', 'No such template');
  const draft = draftForCheck(doc);
  if (!draft) throw conflict('This template has no text of ours to send (link it to a message first)');
  const [pools, docs] = await Promise.all([loadPools(), listTemplates()]);
  // The same report the tab shows (our checks, Meta's registered button, drift, parts we don't handle).
  const report = reportFor(doc, checkContext(pools, docs, ops, doc.use));
  if (!report.ok) {
    await writeLog(
      {
        kind: 'submit.blocked',
        level: 'warn',
        actor: by,
        summary: `Not sent to Meta: ${report.errors} check${report.errors === 1 ? '' : 's'} failed (${report.issues.filter((i) => i.severity === 'error').map((i) => i.code).join(', ')})`,
        detail: { issues: report.issues },
      },
      { templateId: id, name: doc.name, language: doc.language },
    );
    throw validationFailed('Fix the failed checks before sending it to Meta', report.issues);
  }

  let begun: Awaited<ReturnType<typeof beginSubmit>>;
  try {
    begun = await beginSubmit(id, { baseVersion, by, engineNow: engineNow(), realNow: Date.now(), maxCreatesPerHour: META_CREATES_PER_HOUR });
  } catch (err) {
    if (err instanceof HttpLikeTooMany) throw new HttpError(429, 'rate_limited', err.message);
    throw err;
  }
  const cur = begun.doc;
  const wabaId = ops.wabaId;

  // An edit only of what Meta still holds as rejected or paused (an appeal may have approved it
  // meanwhile, and editing an approved template would pull it back into review).
  if (begun.kind === 'edit') {
    let now: ReturnType<typeof parseMetaTemplate> = null;
    let readError: MetaError | null = null;
    let gone = false;
    try {
      const raw = await client.getTemplate(cur.meta!.id!);
      gone = raw === null;
      now = parseMetaTemplate(raw);
    } catch (err) {
      readError = err instanceof MetaError ? err : new MetaError('unavailable', 'Meta couldn’t be asked for its current state');
      if (readError.kind === 'rate_limited') await updateOps({ backoffUntilMs: Date.now() + (readError.info.retryAfterMs ?? 5 * 60_000) });
    }
    const st = String(now?.status ?? '').toUpperCase();
    if (!now || (st !== 'REJECTED' && st !== 'PAUSED')) {
      // Three different stories: Meta couldn't be asked, Meta no longer has it, or Meta's copy changed.
      const why = readError ?? new MetaError(gone ? 'not_found' : 'invalid', gone ? 'Meta no longer has this template' : `Meta holds it as ${st.toLowerCase() || 'unknown'} now`);
      const reverted = await revert(id, why, by, 'submit.failed', readError ? undefined : gone ? 'meta_gone' : 'meta_changed');
      if (now) {
        const pools0 = await loadPools();
        await changeTemplate(id, (d) => (d && d.stage === 'submitted' ? decideFromMeta(d, now!, pools0, new Date(), 'sync', { wabaId }) : null));
      }
      return {
        outcome: 'refused',
        doc: (await getTemplate(id)) ?? reverted,
        error: {
          kind: why.kind,
          message: now ? `Meta holds it as ${st.toLowerCase()} now — nothing was sent; check it` : gone ? 'Meta no longer has this template — nothing was sent' : `Meta couldn’t be asked for its current state — try again (${why.userMsg})`,
          code: why.info.code ?? null,
          subcode: why.info.subcode ?? null,
          fbtraceId: why.info.fbtraceId ?? null,
        },
      };
    }
  }

  let created: { id: string; status: string | null; category: string | null } | null = null;
  try {
    if (begun.kind === 'create') {
      created = await client.createTemplate(wabaId, { name: cur.name, language: cur.language, category: cur.requestedCategory!, components: cur.compiled!.components });
    } else {
      await client.editTemplate(cur.meta!.id!, {
        components: cur.compiled!.components,
        ...(cur.requestedCategory && cur.requestedCategory !== cur.meta?.category ? { category: cur.requestedCategory } : {}),
      });
    }
  } catch (err) {
    const e = err instanceof MetaError ? err : new MetaError('unknown', 'Unexpected failure while calling Meta');
    if (e.kind === 'already_exists' || e.kind === 'locked') return adoptOrLock(id, wabaId, cur, e, by);
    if (e.kind === 'unknown') {
      await writeLog(
        {
          kind: 'submit.unknown',
          level: 'warn',
          actor: by,
          summary: `No answer from Meta for ${cur.name} (${cur.language}): we look it up in 10 minutes and take it over, or put it back`,
          detail: metaErrorDetail(e),
        },
        { templateId: id, name: cur.name, language: cur.language },
      );
      return { outcome: 'unknown', doc: await getTemplate(id), error: errorOut(e) };
    }
    const reverted = await revert(id, e, by, 'submit.failed');
    if ((e.kind === 'setup' || e.kind === 'permission') && ops.everWorked) await connectionAlert(e);
    return { outcome: 'refused', doc: reverted, error: errorOut(e) };
  }

  // Accepted: read it back for Meta's real status and category.
  const metaId = begun.kind === 'edit' ? cur.meta!.id! : created!.id;
  let facts = null;
  try {
    facts = parseMetaTemplate(await client.getTemplate(metaId));
  } catch {
    facts = null;
  }

  const done = await changeTemplate(id, (d) => {
    if (!d || d.stage !== 'submitting') return null;
    if (facts) return decideFromMeta(d, facts, pools, new Date(), 'submit', { wabaId });
    // Accepted but not readable yet: what the create answered (or "in review") until the next sync says more.
    return decideFromMeta(
      d,
      {
        id: metaId,
        name: d.name,
        language: d.language,
        lang: d.lang,
        status: created?.status ?? 'PENDING',
        category: created?.category ?? d.requestedCategory,
        previousCategory: null,
        rejectedReason: null,
        quality: null,
        parameterFormat: 'POSITIONAL',
        headerText: null,
        bodyText: d.compiled?.bodyText ?? null,
        footerText: d.compiled?.footerText ?? null,
        buttons: d.compiled?.button ? [{ type: 'URL', text: d.compiled.button.text, url: d.compiled.button.url, example: [d.compiled.button.example], otpType: null }] : [],
        otherComponents: [],
      },
      pools,
      new Date(),
      'submit',
      { wabaId },
    );
  });
  return { outcome: 'submitted', doc: done.doc, error: null };
}

async function adoptOrLock(id: string, wabaId: string, cur: StoredTemplate, e: MetaError, by: WaActor): Promise<SubmitResult> {
  let facts = null;
  if (e.kind === 'already_exists') {
    try {
      const found = await metaClient().findByName(wabaId, cur.name);
      facts = found.map(parseMetaTemplate).find((f) => f && f.language === cur.language) ?? null;
    } catch (lookup) {
      // Meta couldn't be asked: not "locked" — left sending; the tick looks it up in 10 minutes.
      const le = lookup instanceof MetaError ? lookup : new MetaError('unknown', 'The lookup failed');
      await writeLog(
        { kind: 'submit.unknown', level: 'warn', actor: by, summary: `Meta says ${cur.name} (${cur.language}) exists, but couldn’t be asked for it: looked up again in 10 minutes`, detail: metaErrorDetail(le) },
        { templateId: id, name: cur.name, language: cur.language },
      );
      return { outcome: 'unknown', doc: await getTemplate(id), error: errorOut(le) };
    }
  }
  if (facts) {
    const pools = await loadPools();
    const adopted = await changeTemplate(id, (d) => (d && d.stage === 'submitting' ? decideFromMeta(d, facts!, pools, new Date(), 'adopt', { wabaId }) : null));
    return { outcome: 'adopted', doc: adopted.doc, error: null };
  }
  const locked = new MetaError('locked', e.userMsg, e.info);
  const reverted = await revert(id, locked, by, 'submit.failed', 'name_locked');
  return { outcome: 'locked', doc: reverted, error: errorOut(locked) };
}

/** Back where it was before the submit, with Meta's words. */
export async function revert(id: string, e: MetaError, by: WaActor, kind: string, code?: string, onlyIfStartedAtMs?: number): Promise<StoredTemplate | null> {
  const res = await changeTemplate(id, (d) => {
    if (!d || d.stage !== 'submitting' || !d.submit) return null;
    // The repair puts back only the submit it looked at (never one started since).
    if (onlyIfStartedAtMs !== undefined && d.submit.startedAtMs !== onlyIfStartedAtMs) return null;
    const words =
      code === 'name_locked'
        ? 'Meta is still deleting a template with this name and language (about 30 days): copy it to a new name'
        : code === 'meta_changed'
          ? 'Meta’s copy changed meanwhile: nothing was sent'
          : code === 'meta_gone'
            ? 'Meta no longer has this template: nothing was sent'
          : code === 'unknown_outcome'
            ? 'Meta never confirmed it'
            : ERR_WORDS[e.kind] ?? 'Meta refused it';
    return {
      set: {
        stage: d.submit.prevStage,
        submit: null,
        hint: null,
        lastSubmitError: { code: code ?? e.kind, message: `${words}${e.userMsg ? ` — Meta: “${e.userMsg}”` : ''}`, metaCode: e.info.code ?? null, metaSubcode: e.info.subcode ?? null, fbtraceId: e.info.fbtraceId ?? null, at: new Date() },
        updatedBy: by.uid ?? by.kind,
      },
      log: {
        kind,
        level: 'error',
        actor: by,
        summary: `Meta didn’t take ${d.name} (${d.language}): ${words}`,
        from: 'submitting',
        to: d.submit.prevStage,
        detail: metaErrorDetail(e),
      },
    };
  });
  return res.doc;
}

export function metaErrorDetail(e: MetaError): Record<string, unknown> {
  return { kind: e.kind, message: e.userMsg, httpStatus: e.info.status ?? null, code: e.info.code ?? null, subcode: e.info.subcode ?? null, type: e.info.type ?? null, fbtraceId: e.info.fbtraceId ?? null, retryAfterMs: e.info.retryAfterMs ?? null };
}

function errorOut(e: MetaError) {
  return { kind: e.kind, message: e.userMsg, code: e.info.code ?? null, subcode: e.info.subcode ?? null, fbtraceId: e.info.fbtraceId ?? null };
}

/** The connection broke after having worked: HeidiFi once a day per cause. */
export async function connectionAlert(e: MetaError): Promise<void> {
  await raiseAlert({
    kind: 'whatsapp_connection',
    dedupeKey: `wa_connection:${e.kind}:${dayKey(engineNow(), 'Europe/Zurich')}`,
    audience: 'heidifi',
    subject: 'WhatsApp templates: the Meta connection is failing',
    text: `${ERR_WORDS[e.kind] ?? 'Meta refused the call'}. Meta said: “${e.userMsg}”.\n\nOpen Adaptive Campaigns → WhatsApp in the admin and press Check connection.`,
  });
}
