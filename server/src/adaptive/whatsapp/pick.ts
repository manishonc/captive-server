/**
 * Which WhatsApp template stands for one Adaptive message in one language (PR PV): what the owner's
 * "See what guests get" shows on its WhatsApp tab, what the owner's WhatsApp Send test sends and —
 * PR W3 — what a journey sends (`usableWaTemplates`, all of them, so several rotate).
 *
 * The WhatsApp tab's own rules decide (`templateView`: `usable` = approved, ours, not paused, checks
 * clean): the asked language if a template there is usable, else English — W3's rule for sending.
 * For the preview only, next a template Meta hasn't approved yet (asked language, then English).
 * Dismissed templates never count.
 *
 * Reads the registry once per call (a few hundred docs at most) — the worker through
 * `cachedWaPickContext` (at most once a minute); never reaches Meta (tests/adaptiveWhatsAppBoundary.test.ts).
 */

import type { Lang } from '../core/constants';
import type { PoolRow } from '../core/whatsapp/pools';
import { checkContext, loadPools, templateView } from './context';
import { listTemplates, readOps, type StoredTemplate, type WaOps } from './store';

export interface WaPickContext {
  docs: StoredTemplate[];
  pools: PoolRow[];
  ops: WaOps;
}

export async function loadWaPickContext(): Promise<WaPickContext> {
  // The catalogue from its cache: the preview and the test already loaded it.
  const [docs, pools, ops] = await Promise.all([listTemplates(), loadPools({ fresh: false }), readOps()]);
  return { docs, pools, ops };
}

/** PR W3: the worker's copy — at most one registry read a minute (pausing a template takes ≤ 1 min). */
const PICK_CACHE_MS = 60_000;
let cachedPick: { at: number; value: Promise<WaPickContext> } | null = null;

export function cachedWaPickContext(realNow = Date.now()): Promise<WaPickContext> {
  if (cachedPick && realNow - cachedPick.at < PICK_CACHE_MS) return cachedPick.value;
  const value = loadWaPickContext();
  cachedPick = { at: realNow, value };
  // A failed read isn't kept: the next send reads again.
  value.catch(() => {
    if (cachedPick?.value === value) cachedPick = null;
  });
  return value;
}

/** Test seam: forget the worker's copy. */
export function __clearWaPickCache(): void {
  cachedPick = null;
}

export interface WaPick {
  /** `approved`: guests get it once WhatsApp sends; `in_review`: Meta hasn't approved it yet. */
  status: 'approved' | 'in_review';
  /** The template's language (English when the asked one has none). */
  lang: Lang;
  template: StoredTemplate;
}

const WAITING = new Set(['in_review', 'submitting']);

export function pickWaTemplate(
  ctx: WaPickContext,
  use: { journeyKey: string; poolKey: string },
  lang: Lang,
  opts: { approvedOnly?: boolean } = {},
): WaPick | null {
  const mine = ourTemplatesOf(ctx, use);
  if (!mine.length) return null;
  const views = viewsOf(ctx, mine);
  const langs: Lang[] = lang === 'en' ? ['en'] : [lang, 'en'];
  for (const l of langs) {
    const ok = views.find((x) => x.d.lang === l && x.view.usable);
    if (ok) return { status: 'approved', lang: l, template: ok.d };
  }
  if (opts.approvedOnly) return null;
  for (const l of langs) {
    const waiting = views.find((x) => x.d.lang === l && WAITING.has(String(x.view.display)));
    if (waiting) return { status: 'in_review', lang: l, template: waiting.d };
  }
  return null;
}

function ourTemplatesOf(ctx: WaPickContext, use: { journeyKey: string; poolKey: string } | null): StoredTemplate[] {
  return ctx.docs
    .filter((d) => d.use?.kind === 'adaptive' && (!use || (d.use.journeyKey === use.journeyKey && d.use.poolKey === use.poolKey)))
    .filter((d) => d.dismissed !== true && Boolean(d.source && d.compiled))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.language ?? '').localeCompare(String(b.language ?? '')));
}

/** A template doc that can't be judged (damaged by hand, say) is skipped, never picked. */
function viewsOf(ctx: WaPickContext, docs: StoredTemplate[]) {
  return docs.flatMap((d) => {
    try {
      return [{ d, view: templateView(d, ctx.pools, checkContext(ctx.pools, ctx.docs, ctx.ops, d.use)) }];
    } catch (err) {
      console.error('[WA PICK] template skipped, unreadable', d.id, (err as Error)?.name ?? 'Error');
      return [];
    }
  });
}

/**
 * PR W3: every template a journey may send for one message — the usable ones in the guest's language,
 * else (none there) in English; by name, so the wordings W1, W2… keep their order. Empty: WhatsApp
 * can't carry this message for this guest.
 */
export function usableWaTemplates(ctx: WaPickContext, use: { journeyKey: string; poolKey: string }, lang: Lang): { lang: Lang; templates: StoredTemplate[] } | null {
  const views = viewsOf(ctx, ourTemplatesOf(ctx, use));
  for (const l of (lang === 'en' ? ['en'] : [lang, 'en']) as Lang[]) {
    const ok = views.filter((x) => x.d.lang === l && x.view.usable).map((x) => x.d);
    if (ok.length) return { lang: l, templates: ok };
  }
  return null;
}

/** PR W3: how many templates journeys may send today (the WhatsApp sending switch needs one). */
export function usableWaTemplateCount(ctx: WaPickContext): number {
  return viewsOf(ctx, ourTemplatesOf(ctx, null)).filter((x) => x.view.usable).length;
}
