/**
 * Where a WhatsApp template stands (PR W1), worked out — never stored — from our own step
 * (`stage`: draft → submitting → submitted) and Meta's raw status, so a status Meta adds tomorrow
 * shows as "needs attention" instead of breaking anything. Also: which changes are problems that
 * alert at once (the 08:00 summary carries the rest), and the words for Meta's rejection codes.
 * Pure.
 */

export type WaStage = 'draft' | 'submitting' | 'submitted';

export type WaDisplay =
  | 'needs_fix'
  | 'ready'
  | 'submitting'
  | 'in_review'
  | 'approved'
  /** Approved, but Meta's category doesn't fit the message (a service message filed as marketing). */
  | 'blocked'
  | 'rejected'
  | 'paused'
  | 'disabled'
  | 'deleted'
  /** Meta archived it (unused for months): it can be unarchived in WhatsApp Manager for 28 days. */
  | 'archived'
  | 'attention'
  | 'dismissed';

const IN_REVIEW = new Set(['PENDING', 'IN_REVIEW', 'PENDING_REVIEW', 'IN_APPEAL', 'APPEAL_REQUESTED']);
const DELETED = new Set(['PENDING_DELETION', 'DELETED']);

export interface StatusFacts {
  stage: WaStage;
  metaStatus: string | null;
  metaCategory: string | null;
  dismissed: boolean;
  /** No check errors (drafts only). */
  checksOk: boolean;
  /** The message's rule when the template is for an Adaptive message, else null. */
  poolCategory: 'marketing' | 'utility' | null;
  adaptive: boolean;
}

/** Meta's category fits the message: a service message needs UTILITY; a marketing one takes either. */
export function categoryFits(metaCategory: string | null, poolCategory: 'marketing' | 'utility' | null): boolean {
  if (!poolCategory || !metaCategory) return false;
  if (poolCategory === 'utility') return metaCategory === 'UTILITY';
  return metaCategory === 'MARKETING' || metaCategory === 'UTILITY';
}

export function displayStatus(f: StatusFacts): WaDisplay {
  if (f.dismissed) return 'dismissed';
  if (f.stage === 'draft') return f.checksOk ? 'ready' : 'needs_fix';
  if (f.stage === 'submitting') return 'submitting';
  const s = String(f.metaStatus ?? '').toUpperCase();
  if (s === 'APPROVED') return f.adaptive && !categoryFits(f.metaCategory, f.poolCategory) ? 'blocked' : 'approved';
  if (IN_REVIEW.has(s)) return 'in_review';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'PAUSED') return 'paused';
  if (s === 'DISABLED') return 'disabled';
  if (DELETED.has(s)) return 'deleted';
  if (s === 'ARCHIVED') return 'archived';
  return 'attention';
}

/** May be sent (W3): approved, fitting its message, ours to use, not paused by HeidiFi. */
export function usable(display: WaDisplay, useEnabled: boolean, adaptive: boolean): boolean {
  return display === 'approved' && useEnabled && adaptive;
}

/** Meta's rejection codes in words (unknown codes are shown as they are). */
export function rejectionWords(code: string | null | undefined): string {
  const c = String(code ?? '').toUpperCase();
  switch (c) {
    case '':
    case 'NONE':
      return 'Meta gave no reason';
    case 'ABUSIVE_CONTENT':
      return 'Meta found the content abusive or misleading';
    case 'INCORRECT_CATEGORY':
      return 'Meta says the category is wrong';
    case 'INVALID_FORMAT':
      return 'Meta says the format is invalid (fields, examples or length)';
    case 'SCAM':
      return 'Meta flagged it as a possible scam';
    case 'TAG_CONTENT_MISMATCH':
      return 'Meta says the text doesn’t match the category or the language';
    case 'PROMOTIONAL':
      return 'Meta says it is promotional';
    default:
      return `Meta’s reason: ${c}`;
  }
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface AlertView {
  display: WaDisplay;
  name: string;
  language: string;
  otp: boolean;
  metaCategory: string | null;
  quality: string | null;
  rejectedReason: string | null;
}

export interface PendingAlert {
  /** Dedupe key (`wa:<docId>:<seq>`): one email per change, even if the flush runs twice. */
  key: string;
  urgent: boolean;
  subject: string;
  text: string;
}

const WHERE = 'Open Adaptive Campaigns → WhatsApp in the admin to see the template and its timeline.';

/**
 * The problems a change brings (each alerts at once); approvals and everything else go in the
 * daily summary. `before` null = first seen (an import): only the OTP template alerts then.
 */
export function alertsForChange(before: AlertView | null, after: AlertView, key: string): PendingAlert[] {
  const label = `${after.name} (${after.language})`;
  const entered = (d: WaDisplay) => after.display === d && before?.display !== d;
  const out: PendingAlert[] = [];
  const push = (urgent: boolean, subject: string, text: string) => out.push({ key: `${key}:${out.length}`, urgent, subject, text: `${text}\n\n${WHERE}` });

  if (!before) {
    if (after.otp && after.display !== 'approved') {
      push(true, `URGENT: WhatsApp login code template ${label} is ${after.display}`, `The guest-login code template ${label} is not approved at Meta (${after.display}). Guests who choose WhatsApp can't get a login code.`);
    }
    return out;
  }
  if (entered('rejected')) push(false, `WhatsApp template rejected: ${label}`, `Meta rejected ${label}. ${rejectionWords(after.rejectedReason)}.`);
  if (entered('paused') || entered('disabled')) {
    push(
      after.otp,
      `${after.otp ? 'URGENT: ' : ''}WhatsApp template ${after.display}: ${label}`,
      after.otp
        ? `Meta ${after.display} the guest-login code template ${label}. Guests who choose WhatsApp can't get a login code.`
        : `Meta ${after.display} ${label} (usually because guests reported or blocked it). It isn't used until Meta lifts this.`,
    );
  }
  if (entered('deleted') && (before.display === 'approved' || before.display === 'in_review' || before.display === 'blocked' || after.otp)) {
    push(after.otp, `${after.otp ? 'URGENT: ' : ''}WhatsApp template deleted at Meta: ${label}`, `${label} no longer exists at Meta (it was ${before.display}).`);
  }
  if (entered('archived') && (before.display === 'approved' || before.display === 'in_review' || before.display === 'blocked')) {
    push(after.otp, `WhatsApp template archived by Meta: ${label}`, `Meta archived ${label} (unused for a long time). Unarchive it in WhatsApp Manager within 28 days, or Meta deletes it.`);
  }
  if (entered('blocked')) {
    push(false, `WhatsApp template can't be used: ${label}`, `Meta files ${label} as ${after.metaCategory ?? 'another category'}, which doesn't fit this service message. It isn't used. Write plainer wording under a new name, or appeal in WhatsApp Manager within 60 days.`);
  }
  if (entered('attention')) push(false, `WhatsApp template needs attention: ${label}`, `Meta reports an unusual state for ${label}. Check it in WhatsApp Manager.`);
  if (after.quality === 'RED' && before.quality !== 'RED') {
    push(after.otp, `WhatsApp template quality is low: ${label}`, `Meta rates ${label} low quality (guests report or block it). Meta may pause it soon.`);
  }
  return out;
}

// ── The 08:00 summary ────────────────────────────────────────────────────────

export interface DigestItem {
  label: string;
  note?: string;
}

export interface DigestInput {
  approved: DigestItem[];
  waiting: DigestItem[];
  inReview: DigestItem[];
  problems: DigestItem[];
}

/** The daily summary (null when there is nothing to tell). */
export function digestText(d: DigestInput): { subject: string; text: string } | null {
  const total = d.approved.length + d.waiting.length + d.inReview.length + d.problems.length;
  if (!total) return null;
  const section = (title: string, items: DigestItem[]): string[] =>
    items.length
      ? [
          `${title} (${items.length}):`,
          ...items.slice(0, 40).map((i) => `- ${i.label}${i.note ? ` — ${i.note}` : ''}`),
          ...(items.length > 40 ? [`- … and ${items.length - 40} more`] : []),
          '',
        ]
      : [];
  const lines = [
    ...section('Approved by Meta since the last summary', d.approved),
    ...section('Waiting for you', d.waiting),
    ...section('In review at Meta', d.inReview),
    ...section('Problems', d.problems),
    WHERE,
  ];
  const parts = [
    d.approved.length ? `${d.approved.length} approved` : null,
    d.waiting.length ? `${d.waiting.length} waiting for you` : null,
    d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? '' : 's'}` : null,
    d.inReview.length ? `${d.inReview.length} in review` : null,
  ].filter(Boolean);
  return { subject: `WhatsApp templates: ${parts.join(', ')}`, text: lines.join('\n') };
}
