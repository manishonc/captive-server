/**
 * HTTP client to the CMS's secret-guarded `/api/captive-portal/internal/*` API.
 *
 * Sibling of serverClient.ts, pointed the other way. The CMS is the sole writer of
 * CaptivePortal_SplashScreenConfig and owns the splash validator — ~350 lines of
 * coercion rules whose shape is already mirrored in six places — so splash tools
 * call in there instead of duplicating the rules here. That also gets us the
 * template registry with real names and descriptions, and the tenant's CDN media
 * library, neither of which exists on this side.
 *
 * Note this is the FIRST outbound call from the MCP service to the CMS; until now
 * traffic only ran CMS -> MCP (token minting). CMS_INTERNAL_SECRET is therefore a
 * distinct secret from MCP_INTERNAL_SECRET, so compromising one service does not
 * grant writes through the other.
 */

import { config } from './config';

export interface CmsCallResult {
  status: number;
  data: Record<string, unknown>;
}

export async function callCmsInternal(
  path: string,
  body: Record<string, unknown>,
): Promise<CmsCallResult> {
  if (!config.cmsBaseUrl || !config.cmsInternalSecret) {
    return {
      status: 503,
      data: {
        ok: false,
        error: 'The CMS internal API is not configured on the MCP service (CMS_BASE_URL / CMS_INTERNAL_SECRET).',
      },
    };
  }

  try {
    const response = await fetch(`${config.cmsBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': config.cmsInternalSecret,
      },
      body: JSON.stringify(body),
    });

    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error body */
    }
    return { status: response.status, data };
  } catch (err) {
    return {
      status: 502,
      data: { ok: false, error: err instanceof Error ? err.message : 'CMS request failed' },
    };
  }
}

/**
 * Turn a non-2xx CMS response into the sentence a tool should surface. The CMS
 * returns `error` plus a machine `code`; the code is worth keeping because the
 * model branches on it (re-preview on confirm_token_mismatch, for instance).
 */
export function cmsErrorMessage(result: CmsCallResult): string {
  const error = typeof result.data.error === 'string' ? result.data.error : 'The CMS rejected the request.';
  const code = typeof result.data.code === 'string' ? result.data.code : null;
  return code ? `${error} (code: ${code})` : error;
}
