/**
 * Delivery-status ordering.
 *
 * Neither Meta nor Twilio guarantees the order of status callbacks. Meta says
 * so explicitly for WhatsApp: `sent`, `delivered` and `read` can arrive in any
 * order, and duplicates are retried. Both our handlers previously wrote
 * whatever arrived last straight onto `deliveryStatus`, so a `delivered` that
 * landed after a `read` silently demoted the record — and analytics counts
 * reads off that single field, so the read would vanish.
 *
 * This ranks the lifecycle and only ever moves a record forward.
 *
 * Terminal failures rank highest deliberately. A failure is the most actionable
 * state, and providers only emit one at the end of a message's life, so there
 * is no realistic sequence where a later success should overwrite it.
 */

const STATUS_RANK: Record<string, number> = {
  scheduled: 0,
  queued: 1,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  // Terminal — always wins.
  failed: 5,
  undelivered: 5,
  bounced: 5,
  hard_bounce: 5,
  blocked: 5,
  spam: 5,
  invalid_email: 5,
  error: 5,
};

function rankOf(status: unknown): number | null {
  const key = String(status ?? '').toLowerCase().trim();
  if (!key) return null;
  return key in STATUS_RANK ? STATUS_RANK[key] : null;
}

/**
 * Should `incoming` replace `current` on the record?
 *
 * Unranked statuses (either side) always apply — better to record a status we
 * don't model yet than to drop it silently. An identical repeat does not apply,
 * which drops provider retries instead of churning writes.
 */
export function shouldAdvanceStatus(current: unknown, incoming: unknown): boolean {
  const incomingRank = rankOf(incoming);
  if (incomingRank === null) return true;

  const currentRank = rankOf(current);
  if (currentRank === null) return true;

  return incomingRank > currentRank;
}

/**
 * Brevo event names -> the delivery vocabulary the CMS analytics buckets by
 * (`scheduled | queued | sent | delivered | read | failed | undelivered`).
 *
 * Writing raw Brevo names onto a Marketing doc would land the record in no
 * bucket at all — counted in the send total, invisible in the status bars.
 * That's the same silent gap `queued` had on the SMS side.
 *
 * Returns null for events that must NOT move the status:
 *  - transient failures (soft_bounce, deferred) are routinely followed by a
 *    delivered, so treating them as terminal would misreport a healthy send
 *  - engagement events are recorded as opens, not statuses
 *  - anything unrecognised, rather than guessing a bucket for it
 */
export function normalizeBrevoStatus(event: string): string | null {
  const e = String(event || '').toLowerCase().trim();

  if (e === 'delivered') return 'delivered';
  if (['request', 'sent'].includes(e)) return 'sent';
  if (['hard_bounce', 'blocked', 'spam', 'invalid_email', 'error', 'failed'].includes(e)) {
    return 'failed';
  }

  // soft_bounce | deferred | opened | unique_opened | click | unsubscribed |
  // list_addition | anything new Brevo adds later.
  return null;
}

export { STATUS_RANK };
