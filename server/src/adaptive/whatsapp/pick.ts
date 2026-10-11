/**
 * Which WhatsApp template stands for one Adaptive message in one language (PR PV): what the owner's
 * "See what guests get" shows on its WhatsApp tab and what the owner's WhatsApp Send test sends.
 *
 * The WhatsApp tab's own rules decide (`templateView`: `usable` = approved, ours, not paused, checks
 * clean): the asked language if a template there is usable, else English — W3's rule for sending.
 * For the preview only, next a template Meta hasn't approved yet (asked language, then English).
 * Dismissed templates never count.
 *
 * Reads the registry once per call (a few hundred docs at most); never reaches Meta
 * (tests/adaptiveWhatsAppBoundary.test.ts).
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
  const mine = ctx.docs
    .filter((d) => d.use?.kind === 'adaptive' && d.use.journeyKey === use.journeyKey && d.use.poolKey === use.poolKey)
    .filter((d) => d.dismissed !== true && Boolean(d.source && d.compiled))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.language ?? '').localeCompare(String(b.language ?? '')));
  if (!mine.length) return null;
  // A template doc that can't be judged (damaged by hand, say) is skipped, never picked.
  const views = mine.flatMap((d) => {
    try {
      return [{ d, view: templateView(d, ctx.pools, checkContext(ctx.pools, ctx.docs, ctx.ops, d.use)) }];
    } catch (err) {
      console.error('[WA PICK] template skipped, unreadable', d.id, (err as Error)?.name ?? 'Error');
      return [];
    }
  });
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
