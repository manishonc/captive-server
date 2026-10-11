/**
 * The values of one approved WhatsApp template (PR PV: the owner's WhatsApp Send test; W3's send
 * will reuse it). Each `{{n}}` gets its field rendered the way our text writes it — the first
 * expression of that field in the source, with its `| default:"…"` and `| date:"…"` — on one line
 * (Meta refuses a value with a line break, a tab or 4+ spaces in a row) and never empty (Meta
 * refuses that too: such a field is reported as missing, and nothing is sent).
 *
 * Pure: nothing outside adaptive/core (tests/adaptiveWhatsAppBoundary.test.ts).
 */

import { renderText, type RenderValues } from '../render';
import { canonicalField, parseMergeExpressions } from '../registry/mergeFields';
import type { WaCompiled, WaSource } from './template';

/** A value Meta takes: one line, no tabs, at most three spaces in a row. */
export function oneLine(s: string): string {
  return s
    // Every kind of line break or tab, incl. the Unicode ones a pasted text can carry.
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
}

export interface WaBodyValues {
  /** Meta's body parameters, in `{{n}}` order. */
  params: string[];
  /** Fields with no value (and no default): the template can't be sent with these values. */
  missing: string[];
  /** The body as the guest reads it. */
  text: string;
}

export function waBodyValues(source: Pick<WaSource, 'body'>, compiled: Pick<WaCompiled, 'params'>, values: RenderValues): WaBodyValues {
  const firstExpression = new Map<string, string>();
  for (const e of parseMergeExpressions(source.body)) {
    const field = canonicalField(e.name);
    if (!firstExpression.has(field)) firstExpression.set(field, e.raw);
  }
  const params: string[] = [];
  const missing: string[] = [];
  for (const p of [...compiled.params].sort((a, b) => a.n - b.n)) {
    const r = renderText(firstExpression.get(p.field) ?? `{{${p.field}}}`, values);
    const value = r.unknown.length ? '' : oneLine(r.text);
    if (!value) missing.push(p.field);
    params.push(value);
  }
  return { params, missing, text: renderText(source.body, values).text };
}
