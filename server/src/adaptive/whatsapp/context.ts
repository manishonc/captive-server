/**
 * What the WhatsApp template checks need (PR W1), gathered from the live system: the Adaptive
 * messages that can go by WhatsApp (from the catalogue, fresh), the other templates, Meta's
 * limits, the visitor link base and the STOP texts. Also the views of one template the API
 * returns (status, checks, preview with sample values). No Meta calls here.
 */

import { loadCatalogue } from '../service/catalogue';
import { journeyDefinitionSchema, type JourneyDefinition } from '../core/schemas';
import { whatsappPools, type PoolRow } from '../core/whatsapp/pools';
import { checkImportedTemplate, checkWhatsAppTemplate, type CheckContext, type DraftForCheck, type SiblingInfo, type ValidationReport } from '../core/whatsapp/checks';
import { WA_BODY_FIELDS, WA_DATE_FIELDS, buttonUrlFor, normText, sampleFor, WA_BUTTON_EXAMPLE, type WaUse } from '../core/whatsapp/template';
import { displayStatus, rejectionWords, usable, type WaDisplay } from '../core/whatsapp/status';
import { renderText } from '../core/render';
import { error, makeReport } from '../core/issues';
import { contentKey } from '../core/whatsapp/template';
import type { WaCompiled } from '../core/whatsapp/template';
import { VISITOR_BASE_URL } from '../../services/shortlinks';
import { STOP_KEYWORDS } from '../../services/optOut';
import { STOP_LINES } from '../send/compose';
import { toJson } from '../store/serialize';
import { createsThisHour, type StoredTemplate, type WaOps } from './store';
import type { Lang } from '../core/constants';

/** Our compiled parts in Meta's shape (for comparing with what Meta holds). */
export function compiledParts(c: WaCompiled) {
  return { bodyText: c.bodyText, footerText: c.footerText, buttons: c.button ? [{ text: c.button.text, url: c.button.url }] : [] };
}

/**
 * The parts we compile, from ours (`mine`) or from Meta's copy: the body, the footer, and — only when
 * we compile one — the link button (Meta's first URL button). Other buttons (a fixed link, "Stop
 * promotions", a phone number) are Meta's own and never count as drift.
 */
function driftKey(c: WaCompiled, meta: { bodyText: string | null; footerText: string | null; buttons: Array<{ type: string; text: string | null; url: string | null }> }, mine: boolean): string {
  if (mine) return contentKey(compiledParts(c));
  const url = meta.buttons.find((b) => b.type === 'URL');
  return contentKey({ bodyText: meta.bodyText, footerText: meta.footerText, buttons: c.button && url ? [{ text: url.text, url: url.url }] : c.button ? [{ text: null, url: null }] : [] });
}

/** Buttons that never need a value at send time (besides a link without a variable). */
const PLAIN_BUTTONS = new Set(['QUICK_REPLY', 'PHONE_NUMBER']);

/**
 * The parts of Meta's template we don't fill or keep: a header, media or a carousel, and any button
 * that needs a value at send time other than our link button — a second link with a variable, a
 * coupon code, a flow, a catalog. A send would miss them (Meta refuses it, 132000) and an edit would
 * drop them. `ourButton`: we fill Meta's first link button (a linked or our own template with a
 * button; for a template not linked yet, the link would).
 */
export function unhandledParts(meta: { headerText: string | null; otherComponents: string[]; buttons: Array<{ type: string; url: string | null }> }, ourButton: boolean): string[] {
  const out: string[] = [];
  if (meta.headerText) out.push('a header');
  // Meta's own names (HEADER:IMAGE, CAROUSEL…) in words.
  out.push(...meta.otherComponents.map((c) => (c.startsWith('HEADER:') ? `a header with ${c.slice(7).toLowerCase() || 'media'}` : `a ${c.toLowerCase().replace(/_/g, ' ')}`)));
  const firstUrl = meta.buttons.findIndex((b) => b.type === 'URL');
  meta.buttons.forEach((b, i) => {
    if (PLAIN_BUTTONS.has(b.type)) return;
    if (b.type === 'URL') {
      if (!/\{\{\s*\d+\s*\}\}/.test(b.url ?? '')) return; // a fixed link: nothing to fill
      if (ourButton && i === firstUrl) return; // the one we fill
      out.push('a link button with a value we don’t fill');
      return;
    }
    out.push(`a ${b.type ? b.type.toLowerCase().replace(/_/g, ' ') : 'unknown'} button`);
  });
  return [...new Set(out)];
}

export const visitorBaseUrl = () => VISITOR_BASE_URL.replace(/\/+$/, '');

/** Every Adaptive message that can go by WhatsApp, from the live journey definitions. */
export async function loadPools(opts: { fresh?: boolean } = {}): Promise<PoolRow[]> {
  const cat = await loadCatalogue({ fresh: opts.fresh ?? true });
  const templates = [...cat.templates.entries()].map(([key, rec]) => {
    const live = rec.header.publishedVersion ? rec.versions.find((v) => v.version === rec.header.publishedVersion) : rec.versions[0];
    const parsed = live ? journeyDefinitionSchema.safeParse(live.definition) : null;
    return {
      key,
      name: rec.header.name,
      availability: rec.header.availability,
      definition: parsed?.success ? (parsed.data as JourneyDefinition) : null,
    };
  });
  return whatsappPools(templates, cat.variants as never);
}

export function poolFor(pools: PoolRow[], use: WaUse | null): PoolRow | null {
  if (!use || use.kind !== 'adaptive') return null;
  return pools.find((p) => p.journeyKey === use.journeyKey && p.poolKey === use.poolKey) ?? pools.find((p) => p.poolKey === use.poolKey) ?? null;
}

export function siblingsOf(docs: StoredTemplate[]): SiblingInfo[] {
  return docs.map((d) => ({
    id: d.id,
    name: d.name,
    language: d.language,
    category: d.meta?.category ?? d.requestedCategory ?? null,
    bodyNorm: normText(d.compiled?.bodyText ?? d.meta?.bodyText ?? ''),
    dismissed: d.dismissed === true,
    active:
      d.stage === 'draft'
        ? d.lastSubmitError?.code !== 'name_locked'
        : !['PENDING_DELETION', 'DELETED'].includes(String(d.meta?.status ?? '').toUpperCase()),
  }));
}

export function checkContext(pools: PoolRow[], docs: StoredTemplate[], ops: WaOps, use: WaUse | null, realNow = Date.now()): CheckContext {
  return {
    visitorBaseUrl: visitorBaseUrl(),
    optOutKeywords: STOP_KEYWORDS,
    footers: STOP_LINES,
    pool: poolFor(pools, use),
    siblings: siblingsOf(docs),
    templateCount: ops.templateCount,
    templateLimit: ops.templateLimit,
    createsThisHour: createsThisHour(ops, realNow),
  };
}

export function draftForCheck(d: StoredTemplate): DraftForCheck | null {
  if (!d.source || !d.compiled) return null;
  return {
    id: d.id,
    name: d.name,
    lang: d.lang,
    requestedCategory: d.requestedCategory,
    use: d.use,
    source: d.source,
    compiled: d.compiled,
    atMeta: d.stage !== 'draft',
    nameLocked: d.lastSubmitError?.code === 'name_locked',
  };
}

/** The checks of one template: ours (or linked) get the full set, others only what we can judge. */
export function reportFor(d: StoredTemplate, ctx: CheckContext): ValidationReport {
  const draft = draftForCheck(d);
  const atMeta = checkImportedTemplate({ name: d.name, buttons: d.meta?.buttons ?? [], use: d.use }, { visitorBaseUrl: ctx.visitorBaseUrl });
  if (!draft) return atMeta;
  const ours = checkWhatsAppTemplate(draft, ctx);
  // A rejected or paused template being edited is ours to send again: its new text (and button) is
  // what Meta gets, so neither Meta's old button nor its old text counts against it.
  const status = String(d.meta?.status ?? '').toUpperCase();
  const editPending = status === 'REJECTED' || status === 'PAUSED';
  // A template Meta has: its registered button counts too (a linked legacy template may carry a broken one).
  const metaButton = d.stage !== 'draft' && d.meta && !editPending ? atMeta.issues.filter((i) => i.code === 'T12' && i.severity === 'error') : [];
  // T23: what Meta holds must be what we compiled — the send (W3) fills Meta's text with our field map.
  // Only what we compile is compared (body, footer, our link button); other parts are T24.
  const drift =
    d.stage === 'submitted' && d.meta && d.compiled && d.meta.bodyText !== null && !editPending && driftKey(d.compiled, d.meta, true) !== driftKey(d.compiled, d.meta, false)
      ? [error('T23', 'Meta holds different text than ours (changed in WhatsApp Manager, or an older version): it isn’t used until they match — link it again or write it anew')]
      : [];
  // T24: parts we don't fill (a header, media, a carousel, a button needing a value) — a send would
  // miss them, an edit would drop them.
  // Meta's first link button is ours to fill — or, while a rejected/paused template is edited, ours to
  // replace or drop (the edit sends our buttons), so removing our button never locks the template.
  const parts = d.source && d.meta ? unhandledParts(d.meta, editPending || Boolean(d.compiled?.button)) : [];
  const unmodelled = parts.length ? [error('T24', `Meta’s template has parts this tab doesn’t handle (${parts.join(', ')}): it isn’t used, and it can’t be edited here`)] : [];
  const extra = [...metaButton, ...drift, ...unmodelled];
  return extra.length ? makeReport([...ours.issues, ...extra]) : ours;
}

export function displayOf(d: StoredTemplate, report: ValidationReport | null, pools: PoolRow[]): WaDisplay {
  const pool = poolFor(pools, d.use);
  return displayStatus({
    stage: d.stage,
    metaStatus: d.meta?.status ?? null,
    metaCategory: d.meta?.category ?? null,
    dismissed: d.dismissed === true,
    checksOk: report ? report.ok : true,
    poolCategory: pool?.whatsappCategory ?? null,
    adaptive: d.use?.kind === 'adaptive',
  });
}

/** Sample values for the preview (the same table Meta's examples come from). */
function previewValues(lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of WA_BODY_FIELDS) {
    out[f] = WA_DATE_FIELDS.has(f) ? (f === 'stay.checkOutDate' ? '2026-10-23T12:00:00.000Z' : '2026-10-20T12:00:00.000Z') : sampleFor(f, lang, null);
  }
  return out;
}

export function previewOf(d: StoredTemplate): { body: string; footer: string | null; button: { text: string; url: string } | null } {
  const lang = d.lang ?? 'en';
  if (d.source) {
    const body = renderText(d.source.body, previewValues(lang)).text;
    return {
      body,
      footer: d.source.footer,
      button: d.source.button ? { text: d.source.button.text, url: buttonUrlFor(visitorBaseUrl()).replace('{{1}}', WA_BUTTON_EXAMPLE) } : null,
    };
  }
  const urlButton = d.meta?.buttons.find((b) => b.type === 'URL') ?? d.meta?.buttons[0];
  return {
    body: d.meta?.bodyText ?? '',
    footer: d.meta?.footerText ?? null,
    button: urlButton ? { text: urlButton.text ?? '', url: urlButton.url ?? '' } : null,
  };
}

/** One template as the admin screens show it (a list line, or the window with `full`). */
export function templateView(d: StoredTemplate, pools: PoolRow[], ctx: CheckContext, opts: { full?: boolean } = {}) {
  const report = reportFor(d, ctx);
  const display = displayOf(d, report, pools);
  const pool = poolFor(pools, d.use);
  const line = {
    id: d.id,
    name: d.name,
    language: d.language,
    lang: d.lang,
    use: d.use,
    message: pool ? { journeyKey: pool.journeyKey, poolKey: pool.poolKey, name: pool.poolName, journeyName: pool.journeyName, rule: pool.whatsappCategory } : null,
    origin: d.origin,
    stage: d.stage,
    display,
    // Usable (W3) also needs clean checks: a linked template may carry a broken button at Meta.
    usable: usable(display, d.useEnabled !== false, d.use?.kind === 'adaptive') && report.ok && Boolean(d.source && d.compiled),
    useEnabled: d.useEnabled !== false,
    dismissed: d.dismissed === true,
    requestedCategory: d.requestedCategory,
    metaCategory: d.meta?.category ?? null,
    previousCategory: d.meta?.previousCategory ?? null,
    metaStatus: d.meta?.status ?? null,
    quality: d.meta?.quality ?? null,
    rejectedReason: d.meta?.rejectedReason ?? null,
    rejectedWords: d.meta?.status === 'REJECTED' ? rejectionWords(d.meta?.rejectedReason) : null,
    lastSubmitError: d.lastSubmitError ? toJson(d.lastSubmitError) : null,
    checks: { ok: report.ok, errors: report.errors, warnings: report.warnings },
    preview: previewOf(d),
    version: d.version,
    seq: d.seq,
    // The list line carries a short reasoning (PR W2: the template window has it whole).
    ai: d.ai ? (opts.full ? toJson(d.ai) : { ...(toJson(d.ai) as Record<string, unknown>), reasoning: String(d.ai.reasoning ?? '').slice(0, 300) }) : null,
    createdAt: toJson(d.createdAt ?? null),
    updatedAt: toJson(d.updatedAt ?? null),
    approvedAt: toJson(d.meta?.approvedAt ?? null),
    lastChangedAtMeta: toJson(d.meta?.lastChangedAt ?? null),
  };
  if (!opts.full) return line;
  return {
    ...line,
    checks: report,
    source: d.source,
    compiled: d.compiled ? { bodyText: d.compiled.bodyText, footerText: d.compiled.footerText, button: d.compiled.button, params: d.compiled.params, components: d.compiled.components } : null,
    meta: d.meta ? toJson({ ...d.meta }) : null,
    /**
     * What neither a link nor an edit here can handle in Meta's template (empty: everything): the cms
     * offers no Link, Edit or Send. Meta's first link button is never listed — linking (again) or an
     * edit fills it; a template that has it but no button of ours shows T24 in its checks instead.
     */
    unhandled: d.meta ? unhandledParts(d.meta, true) : [],
    submit: d.submit ? toJson(d.submit) : null,
    allowedFields: pool?.allowedFields ?? null,
    linkField: pool?.linkField ?? null,
  };
}
