/**
 * Self-hosted 1×1 open-tracking pixel for outbound email.
 *
 * Shared by both send surfaces, keyed by whichever send record owns the mail:
 *   - Campaign Manager  -> CaptivePortal_CampaignSends doc id
 *   - venue automation  -> CaptivePortal_Marketing doc id
 * `GET /t/o/:sendId` (routes/tracking.ts) resolves the id against both.
 *
 * This runs alongside Brevo's own open webhook rather than replacing it. Two
 * independent sources means opens still land if Brevo's tracking is off or its
 * webhook is misconfigured — but it also means one real open bumps `openCount`
 * twice. Consumers must count the `openCounted` unique flag, never `openCount`.
 *
 * CONTRACT: the pixel is appended to the HTML body only. Venue-automation
 * bodies are often authored as plain text, but services/brevo.ts ships every
 * message as `htmlContent`, so recipients' clients parse them as HTML and the
 * tag renders as an invisible image rather than literal text. If a `textContent`
 * alternative is ever added to sendEmail, build it from the PRE-pixel body —
 * otherwise the raw <img> becomes visible garbage in the text part.
 */

/** Public base URL for the pixel. Tracking is silently disabled when unset. */
const TRACKING_BASE = (process.env.SERVER_PUBLIC_URL || '').replace(/\/$/, '');

/**
 * Insert a 1×1 open-tracking pixel into an email body, keyed by the send id.
 * Placed just before </body> when there is one, appended otherwise — matching
 * services/poweredBy.ts, so block-rendered bodies keep the tag inside the
 * document instead of stranding it after </html>.
 */
export function injectOpenPixel(body: string, sendId: string): string {
  const safe = typeof body === 'string' ? body : '';
  if (!TRACKING_BASE || !sendId) return safe;
  const pixel = `<img src="${TRACKING_BASE}/t/o/${sendId}" width="1" height="1" alt="" style="display:none" />`;
  const idx = safe.toLowerCase().lastIndexOf('</body>');
  if (idx !== -1) return safe.slice(0, idx) + pixel + '\n' + safe.slice(idx);
  return `${safe}${pixel}`;
}

/** Exposed for tests and for logging whether tracking is actually configured. */
export function isOpenTrackingConfigured(): boolean {
  return Boolean(TRACKING_BASE);
}
