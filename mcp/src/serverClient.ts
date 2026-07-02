/**
 * HTTP client to the main captive-server API (server/, port 4000) for the
 * campaign lifecycle actions the MCP tools proxy instead of reimplementing:
 * send/pause/resume/cancel dispatch logic lives in server/src/services and is
 * exposed via its `/internal/*` routes (x-internal-secret guarded).
 */

import { config } from './config';

export interface ServerCallResult {
  status: number;
  data: Record<string, unknown>;
}

export async function callServerInternal(
  path: string,
  body: Record<string, unknown>,
): Promise<ServerCallResult> {
  if (!config.serverInternalSecret) {
    return { status: 503, data: { ok: false, error: 'INTERNAL_API_SECRET is not configured on the MCP service' } };
  }

  const response = await fetch(`${config.serverApiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': config.serverInternalSecret,
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
}
