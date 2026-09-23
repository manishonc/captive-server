/**
 * "What changed" between two playbook versions (or a version and the draft), in
 * the words the admin Publish and Compare dialogs show.
 */

import { pickLang, type Offer, type PlaybookContent, type SlotValue } from './schemas';
import { VENUE_TYPE_LABELS } from './constants';

export interface DiffLine {
  kind: 'added' | 'removed' | 'changed';
  label: string;
  before?: string;
  after?: string;
}

export interface DiffNames {
  journey(key: string): string;
  question(key: string): string;
}

const plainNames: DiffNames = { journey: (k) => k, question: (k) => k };

export function diffPlaybookContent(
  before: PlaybookContent | null,
  after: PlaybookContent,
  names: DiffNames = plainNames,
): DiffLine[] {
  const lines: DiffLine[] = [];
  const changed = (label: string, a: string, b: string) => {
    if (a !== b) lines.push({ kind: 'changed', label, before: a, after: b });
  };

  if (!before) {
    lines.push({ kind: 'added', label: 'First version', after: after.name.en || 'Untitled playbook' });
    return lines;
  }

  changed('Name', before.name.en, after.name.en);
  for (const lang of ['de', 'it', 'fr'] as const) changed(`Name (${lang.toUpperCase()})`, before.name[lang] ?? '', after.name[lang] ?? '');
  changed('Description', before.summary.en, after.summary.en);
  for (const lang of ['de', 'it', 'fr'] as const) {
    changed(`Description (${lang.toUpperCase()})`, before.summary[lang] ?? '', after.summary[lang] ?? '');
  }
  changed('Icon', before.icon, after.icon);
  changed('Kind', before.kind, after.kind);
  changed('Venue types', typesText(before.venueTypes), typesText(after.venueTypes));

  // Journeys
  const beforeJ = new Map(before.journeys.map((j) => [j.journeyKey, j]));
  const afterJ = new Map(after.journeys.map((j) => [j.journeyKey, j]));
  for (const j of after.journeys) {
    const name = names.journey(j.journeyKey);
    const prev = beforeJ.get(j.journeyKey);
    if (!prev) {
      lines.push({ kind: 'added', label: 'Journey added', after: `${name} v${j.templateVersion} · ${j.defaultEnabled ? 'on' : 'off'} by default` });
      continue;
    }
    changed(`${name}: pinned version`, `v${prev.templateVersion}`, `v${j.templateVersion}`);
    changed(`${name}: on by default`, yesNo(prev.defaultEnabled), yesNo(j.defaultEnabled));
    changed(`${name}: required`, yesNo(prev.required), yesNo(j.required));
    const slotKeys = new Set([...Object.keys(prev.slotDefaults ?? {}), ...Object.keys(j.slotDefaults ?? {})]);
    for (const slotKey of slotKeys) {
      changed(`${name}: default “${slotKey}”`, slotText(prev.slotDefaults?.[slotKey]), slotText(j.slotDefaults?.[slotKey]));
    }
  }
  for (const j of before.journeys) {
    if (!afterJ.has(j.journeyKey)) lines.push({ kind: 'removed', label: 'Journey removed', before: names.journey(j.journeyKey) });
  }
  const commonBefore = before.journeys.filter((j) => afterJ.has(j.journeyKey)).map((j) => j.journeyKey);
  const commonAfter = after.journeys.filter((j) => beforeJ.has(j.journeyKey)).map((j) => j.journeyKey);
  if (commonBefore.join(',') !== commonAfter.join(',')) {
    lines.push({
      kind: 'changed',
      label: 'Journey order (priority)',
      before: commonBefore.map(names.journey).join(' → '),
      after: commonAfter.map(names.journey).join(' → '),
    });
  }

  // Offers
  const beforeO = new Map(before.offerMenuDefaults.map((o) => [o.offerKey, o]));
  const afterO = new Map(after.offerMenuDefaults.map((o) => [o.offerKey, o]));
  for (const o of after.offerMenuDefaults) {
    const prev = beforeO.get(o.offerKey);
    if (!prev) lines.push({ kind: 'added', label: 'Default offer added', after: offerText(o) });
    else changed(`Offer “${o.name || o.offerKey}”`, offerText(prev), offerText(o));
  }
  for (const o of before.offerMenuDefaults) {
    if (!afterO.has(o.offerKey)) lines.push({ kind: 'removed', label: 'Default offer removed', before: offerText(o) });
  }

  // Questions
  const beforeQ = new Set(before.questionKeys);
  const afterQ = new Set(after.questionKeys);
  for (const q of after.questionKeys) if (!beforeQ.has(q)) lines.push({ kind: 'added', label: 'Question added', after: names.question(q) });
  for (const q of before.questionKeys) if (!afterQ.has(q)) lines.push({ kind: 'removed', label: 'Question removed', before: names.question(q) });

  // Estimate hints (numbers owners see before turning on)
  const hint = (c: PlaybookContent) =>
    `${Math.round(c.estimateHints.returnRate * 100)}% come back · ${(c.estimateHints.avgSpend.amountMinor / 100).toFixed(0)} ${c.estimateHints.avgSpend.currency} per visit`;
  changed('Estimate assumptions', hint(before), hint(after));
  const touchKeys = new Set([...Object.keys(before.estimateHints.avgTouchesPerGuest), ...Object.keys(after.estimateHints.avgTouchesPerGuest)]);
  for (const key of touchKeys) {
    changed(
      `${names.journey(key)}: messages per guest (estimate)`,
      String(before.estimateHints.avgTouchesPerGuest[key] ?? '—'),
      String(after.estimateHints.avgTouchesPerGuest[key] ?? '—'),
    );
  }

  return lines;
}

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

function typesText(types: string[]): string {
  return types.length ? types.map((t) => VENUE_TYPE_LABELS[t as keyof typeof VENUE_TYPE_LABELS] ?? t).join(', ') : '—';
}

function slotText(value: SlotValue | undefined): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'object') return pickLang(value);
  return String(value);
}

export function offerText(o: Offer): string {
  const value =
    o.kind === 'percent'
      ? `${o.value}% off`
      : o.kind === 'amount'
        ? `${(o.value / 100).toFixed(0)} ${o.currency ?? 'CHF'} off`
        : o.kind === 'upsell'
          ? `guest pays ${(o.value / 100).toFixed(0)} ${o.currency ?? 'CHF'}`
          : 'free';
  return `“${o.label.en}” · ${value} · ${o.expiryDays} days`;
}
