/**
 * PR W2b: the registry as Auto's rules see it (core/whatsapp/auto.ts) — each template with its
 * display and its checks as the tab shows them. Used by the tick (whatsapp/auto.ts), the submit's
 * own re-check (whatsapp/submit.ts) and the tab's overview. API side only: it reads the check
 * context (the visitor base, the STOP words).
 */

import type { AutoView } from '../core/whatsapp/auto';
import { wantedCategory } from '../core/whatsapp/aiBrief';
import { usable, type WaDisplay } from '../core/whatsapp/status';
import type { ValidationReport } from '../core/issues';
import type { PoolRow } from '../core/whatsapp/pools';
import { tsMs } from '../store/time';
import { checkContext, displayOf, poolFor, reportFor } from './context';
import { aiInfoOf, type StoredTemplate, type WaOps } from './store';

export function autoViewOf(d: StoredTemplate, report: ValidationReport, display: WaDisplay): AutoView {
  const ai = aiInfoOf(d);
  const atMs = ai ? Date.parse(ai.at) : NaN;
  const adaptive = d.use?.kind === 'adaptive';
  return {
    id: d.id,
    name: d.name,
    lang: d.lang,
    use: d.use?.kind === 'adaptive' ? { journeyKey: d.use.journeyKey, poolKey: d.use.poolKey } : null,
    origin: d.origin,
    dismissed: d.dismissed === true,
    version: d.version,
    stage: d.stage,
    display,
    metaStatus: d.meta?.status ?? null,
    requestedCategory: d.requestedCategory,
    checks: { errors: report.errors, warnings: report.warnings },
    lastSubmitErrorCode: d.lastSubmitError?.code ?? null,
    usable: usable(display, d.useEnabled !== false, adaptive) && report.ok,
    ai: ai
      ? {
          kind: ai.kind,
          writtenAs: ai.writtenAs ?? null,
          appliedVersion: ai.appliedVersion,
          fixes: ai.fixes,
          atMs: Number.isFinite(atMs) ? atMs : null,
          autoSubmittedVersion: ai.autoSubmittedVersion ?? null,
          autoAttempts: ai.autoAttempts ?? null,
          ...(ai.sentVersion !== undefined ? { sentVersion: ai.sentVersion } : {}),
        }
      : null,
    metaChangedAtMs: tsMs(d.meta?.lastChangedAt),
    orderMs: tsMs(d.createdAt) ?? 0,
  };
}

/** Every template (or `only` these) as Auto sees it, with the tab's display and checks. */
export function autoViewsFor(docs: StoredTemplate[], pools: PoolRow[], ops: WaOps, only?: (d: StoredTemplate) => boolean): AutoView[] {
  return docs
    .filter((d) => !only || only(d))
    .map((d) => {
      const report = reportFor(d, checkContext(pools, docs, ops, d.use));
      return autoViewOf(d, report, displayOf(d, report, pools));
    });
}

/** The category a message's templates must have (its rule). */
export function wantedFor(pools: PoolRow[]): (use: { journeyKey: string; poolKey: string }) => string | null {
  return (use) => {
    const pool = poolFor(pools, { kind: 'adaptive', ...use });
    return pool ? wantedCategory(pool) : null;
  };
}
