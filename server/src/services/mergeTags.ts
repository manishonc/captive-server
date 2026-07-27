/**
 * `{{token}}` substitution for outbound message bodies.
 *
 * Shared by the Campaign Manager dispatcher (services/campaigns.ts) and the
 * venue-automation schedulers (routes/captive.ts, routes/socialWifiWebhook.ts)
 * so both surfaces resolve the same tag vocabulary the CMS composer offers.
 *
 * ORDER MATTERS at the call sites: interpolate BEFORE the short-link swaps.
 * `{{ratingUrl}}` expands to the canonical `<visitor>/<venueId>/rate` URL, and
 * swapVenueRatingUrl() only recognises that literal form when it rewrites it
 * into a per-send tracked short link. Swapping first would leave the tag
 * unexpanded and the send untracked.
 */

/** Replace {{token}} placeholders from a per-guest context. Unknowns → empty. */
export function interpolate(tpl: string, ctx: Record<string, string>): string {
  if (!tpl) return tpl;
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
