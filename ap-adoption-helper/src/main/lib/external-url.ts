// Which external URLs the app is willing to hand to the system browser.
//
// This replaces an exact-string-equality check against `homeUrl`. That was safe but too
// narrow for the self-serve flow, which finishes on a "continue on your dashboard" button
// pointing at a per-venue deep link — under exact matching that click did nothing at all
// except write a line to the log.
//
// Origin plus path-prefix, https only. Pure and unit-tested, because the failure mode of
// getting this wrong is handing an attacker-influenced URL to the user's browser.

/** True when `target` is https and lives at or under one of `allowed`. */
export function isAllowedExternal(target: unknown, allowed: string[]): boolean {
  let t: URL;
  try {
    t = new URL(String(target ?? ''));
  } catch {
    return false;
  }
  // No http: the dashboard is https, and a downgrade is either a misconfiguration or an
  // attempt to get credentials onto the wire in the clear.
  if (t.protocol !== 'https:') return false;

  return allowed.some((entry) => {
    let base: URL;
    try {
      base = new URL(entry);
    } catch {
      return false;
    }
    // Origin comparison, NOT startsWith on the href — `https://heidifi.ai.evil.com` has
    // `https://heidifi.ai` as a string prefix and must not match.
    if (base.origin !== t.origin) return false;

    const basePath = base.pathname.replace(/\/+$/, '');
    if (basePath === '') return true;
    // `/captive-venue` must match `/captive-venue` and `/captive-venue/x`, but not
    // `/captive-venue-other`.
    return t.pathname === basePath || t.pathname.startsWith(`${basePath}/`);
  });
}
