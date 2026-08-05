/**
 * ⚠️ TEMPORARY DIAGNOSTIC — delete this file once the stale AP credentials are fixed.
 *
 * Sweeps every UniFi access point and reports whether the credentials stored on its
 * Firestore doc still authenticate against the controller.
 *
 * Why this exists: `CaptivePortal_AccessPoints/{id}.unifiConfig` holds a SNAPSHOT of
 * the controller username/password taken when the AP was created (CMS
 * app/api/captive-portal/access-points/route.js). Nothing re-syncs it, so rotating the
 * controller password silently strands every AP created before the rotation — guests on
 * those APs get a 502 from /captive/unifi/authorize with `api.err.Invalid`.
 *
 * The failure is intermittent from the outside: captive-server caches one controller
 * session per `controllerUrl`, so a stale AP works whenever a healthy AP has logged in
 * within the last 55 minutes and breaks again once that session lapses. This check
 * calls `verifyCredentials`, which bypasses that cache, so each credential set is
 * judged on its own.
 *
 * To remove: delete this file, the `/internal/unifi/credential-check` route in
 * routes/internal.ts, `verifyCredentials` in services/unifi.ts (inline `performLogin`
 * back into `login` if nothing else uses it), and on the CMS side
 * app/api/captive-portal/unifi-credential-check/, the `unifiCredentialCheck` method in
 * lib/captive-portal-api.js, and UnifiCredentialCheckButton.tsx (+ its usage).
 */

import { db } from '../firebase';
import { UnifiConfig } from '../types/captive';
import { effectiveControllerUrl, normalizeMac, verifyCredentials } from './unifi';

const AP_COLLECTION = 'CaptivePortal_AccessPoints';
const VENUE_COLLECTION = 'CaptivePortal_Venues';

export type ApCredentialStatus = 'ok' | 'failed' | 'not_configured';

export interface ApCredentialResult {
  apId: string;
  name: string;
  mac: string;
  venueId: string;
  venueName: string;
  controllerUrl: string;
  site: string;
  username: string;
  /** Never the password itself — only whether one is stored. */
  passwordSet: boolean;
  status: ApCredentialStatus;
  /** Controller's own message when status is 'failed'. */
  error?: string;
}

export interface CredentialCheckReport {
  checkedAt: string;
  /** Distinct credential sets actually dialled (APs sharing credentials are probed once). */
  credentialSetsProbed: number;
  total: number;
  /** Not named `ok` — the route spreads this report alongside the envelope's `ok: true`. */
  healthy: number;
  failed: number;
  notConfigured: number;
  results: ApCredentialResult[];
}

interface StoredUnifiConfig {
  controllerType?: string;
  controllerUrl?: string;
  site?: string;
  username?: string;
  password?: string;
}

/**
 * Identity of a credential set. APs created from the same CMS env vars share one, and
 * a venue's APs usually all share one — probing each AP separately would fire a burst
 * of identical logins at the controller and risk tripping its lockout. Includes the
 * password so a re-keyed AP is never mistaken for its stale siblings.
 */
function credentialKey(config: UnifiConfig): string {
  return JSON.stringify([config.controllerType, config.controllerUrl, config.site, config.username, config.password]);
}

/** Strip the noisy `UniFi login failed HTTP 400: ` wrapper down to what an admin can act on. */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/HTTP (\d+): (.*)$/s);
  if (!match) return raw;
  const [, status, body] = match;
  try {
    const msg = JSON.parse(body)?.meta?.msg;
    if (msg === 'api.err.Invalid') return `HTTP ${status} api.err.Invalid — controller rejected this username/password`;
    if (msg) return `HTTP ${status} ${msg}`;
  } catch {
    /* non-JSON body — fall through to the raw text */
  }
  return `HTTP ${status} ${body}`.trim();
}

async function resolveVenueNames(venueIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    venueIds.map(async (venueId) => {
      try {
        const snap = await db.collection(VENUE_COLLECTION).doc(venueId).get();
        names.set(venueId, String(snap.data()?.venue_name || ''));
      } catch {
        names.set(venueId, '');
      }
    }),
  );
  return names;
}

export async function checkApCredentials(): Promise<CredentialCheckReport> {
  const snap = await db.collection(AP_COLLECTION).where('vendor', '==', 'unifi').get();

  interface Row {
    result: ApCredentialResult;
    config?: UnifiConfig;
    key?: string;
  }

  const rows: Row[] = [];
  snap.forEach((doc) => {
    const data = doc.data() as { name?: string; mac?: string; venueId?: string; unifiConfig?: StoredUnifiConfig | null };
    const stored = data.unifiConfig || null;
    const controllerUrl = effectiveControllerUrl(stored?.controllerUrl);
    const site = String(stored?.site || 'default').trim() || 'default';
    const username = String(stored?.username || '').trim();
    const password = String(stored?.password || '');

    const result: ApCredentialResult = {
      apId: doc.id,
      name: String(data.name || ''),
      mac: normalizeMac(String(data.mac || '')),
      venueId: String(data.venueId || ''),
      venueName: '',
      controllerUrl,
      site,
      username,
      passwordSet: Boolean(password),
      status: 'not_configured',
    };

    if (!controllerUrl || !username || !password) {
      result.error = 'AP doc has no complete unifiConfig (controllerUrl / username / password)';
      rows.push({ result });
      return;
    }

    const config: UnifiConfig = {
      controllerType: stored?.controllerType === 'udm' ? 'udm' : 'classic',
      controllerUrl,
      site,
      username,
      password,
    };
    rows.push({ result, config, key: credentialKey(config) });
  });

  // Probe each distinct credential set once, sequentially — a stale set produces a
  // failed login, and firing those in parallel is what UniFi reads as a brute-force.
  const probed = new Map<string, { ok: boolean; error?: string }>();
  for (const row of rows) {
    if (!row.config || !row.key || probed.has(row.key)) continue;
    try {
      await verifyCredentials(row.config);
      probed.set(row.key, { ok: true });
    } catch (err) {
      probed.set(row.key, { ok: false, error: describeError(err) });
    }
  }

  for (const row of rows) {
    if (!row.key) continue;
    const outcome = probed.get(row.key);
    if (!outcome) continue;
    row.result.status = outcome.ok ? 'ok' : 'failed';
    if (outcome.error) row.result.error = outcome.error;
  }

  const venueIds = [...new Set(rows.map((r) => r.result.venueId).filter(Boolean))];
  const venueNames = await resolveVenueNames(venueIds);
  for (const row of rows) {
    row.result.venueName = venueNames.get(row.result.venueId) || '';
  }

  // Broken APs first — this report exists to find them.
  const rank: Record<ApCredentialStatus, number> = { failed: 0, not_configured: 1, ok: 2 };
  const results = rows.map((r) => r.result).sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

  return {
    checkedAt: new Date().toISOString(),
    credentialSetsProbed: probed.size,
    total: results.length,
    healthy: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    notConfigured: results.filter((r) => r.status === 'not_configured').length,
    results,
  };
}
