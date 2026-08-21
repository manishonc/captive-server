/**
 * Ask the CMS to top a wallet back up.
 *
 * The mirror of the CMS's `callCaptiveServer`, in the other direction and for
 * exactly one purpose. Debits happen here; Stripe and the credit-grant ledger
 * live in the CMS. Rather than give this server a Stripe client of its own —
 * a second place for billing to go wrong — the send path just says "this wallet
 * went low" and the CMS decides everything else.
 *
 * The call is a HINT, never an instruction: the CMS re-reads the wallet, the
 * threshold and the monthly cap before charging anything, so a duplicated or
 * stale trigger cannot cause a charge the current state would not justify.
 *
 * Fire-and-forget. A refill that fails to trigger costs the tenant a low
 * balance; a send path that blocks on an HTTP call costs every guest their
 * Wi-Fi message.
 */

const TRIGGER_TIMEOUT_MS = 5000;

/**
 * In-process guard against a burst of debits triggering a burst of calls.
 *
 * A busy venue can debit dozens of times a minute, and each one crossing the
 * threshold would fire another request. The CMS is idempotent and would refuse
 * the extras, but there is no reason to make it say no thirty times.
 */
const RECENT_TRIGGER_MS = 60_000;
const recentTriggers = new Map<string, number>();

function recentlyTriggered(tenantUserId: string, now: number): boolean {
  const last = recentTriggers.get(tenantUserId);
  if (last && now - last < RECENT_TRIGGER_MS) return true;
  recentTriggers.set(tenantUserId, now);
  // The map only ever holds tenants seen in the last minute.
  if (recentTriggers.size > 500) {
    for (const [key, at] of recentTriggers) {
      if (now - at >= RECENT_TRIGGER_MS) recentTriggers.delete(key);
    }
  }
  return false;
}

export async function triggerAutoRefill(tenantUserId: string): Promise<void> {
  const baseUrl = process.env.CMS_INTERNAL_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  // Unconfigured is not an error: auto-refill is a CMS feature, and a server
  // deployment without the link simply does not participate.
  if (!baseUrl || !secret || !tenantUserId) return;
  if (recentlyTriggered(tenantUserId, Date.now())) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/captive-portal/internal/auto-refill`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ tenantUserId }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; credits?: number; reason?: string };
    if (data.ok) {
      console.log(`[AUTO-REFILL] topped up ${tenantUserId} with ${data.credits} credits`);
    } else if (data.reason && data.reason !== 'disabled' && data.reason !== 'above_threshold') {
      console.warn(`[AUTO-REFILL] not applied for ${tenantUserId}: ${data.reason}`);
    }
  } catch (error) {
    console.error(`[AUTO-REFILL] trigger failed for ${tenantUserId}:`, error);
  }
}
