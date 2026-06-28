import { Request, Response, NextFunction } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { config, protectedResourceMetadataUrl } from '../config';
import { sha256Hex } from '../crypto';
import { getAccessTokenByHash, touchAccessToken } from '../store/oauth';

/** Express request augmented with the MCP SDK's `auth` field (set by this middleware). */
export interface AuthedRequest extends Request {
  auth?: AuthInfo;
}

/** RFC 9728: respond 401 pointing the client at the protected-resource metadata doc. */
export function unauthorized(res: Response, description: string): void {
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl}"`);
  res.status(401).json({ error: 'invalid_token', error_description: description });
}

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return ab.equals(bb); // length already equal; safe enough here
}

/**
 * Bearer-token middleware for the MCP endpoint.
 *
 * 1. Dev bypass: when MCP_DEV_STATIC_TOKEN is set, accept that token bound to
 *    MCP_DEV_TENANT_ID (local development / Phase A smoke-testing only).
 * 2. Production: look up the opaque token by SHA-256 hash in CaptivePortal_McpAccessTokens,
 *    enforce expiry + revocation, and bind the tenantUserId for the tool layer.
 */
export async function requireBearer(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();

  if (!token) return unauthorized(res, 'Missing bearer token.');

  // Dev bypass.
  if (config.devStaticToken && constantTimeMatch(token, config.devStaticToken)) {
    req.auth = {
      token,
      clientId: 'dev-static',
      scopes: ['access_points:read'],
      extra: { tenantUserId: config.devTenantId, dev: true },
    };
    return next();
  }

  // Production validation: opaque token, looked up by hash.
  const tokenHash = sha256Hex(token);
  const at = await getAccessTokenByHash(tokenHash);
  if (!at) return unauthorized(res, 'Invalid bearer token.');
  if (at.revoked) return unauthorized(res, 'Token has been revoked.');
  if (Date.now() >= at.expiresAt) return unauthorized(res, 'Token has expired.');

  await touchAccessToken(tokenHash); // best-effort last-used ping
  req.auth = {
    token,
    clientId: at.clientId,
    scopes: at.scope ? at.scope.split(/\s+/) : [],
    resource: undefined,
    expiresAt: at.expiresAt / 1000,
    extra: { tenantUserId: at.tenantUserId },
  };
  return next();
}
