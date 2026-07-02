/**
 * Internal, secret-guarded endpoints called server-to-server by the CMS.
 *
 * POST /internal/mint-token — issue a short-lived, tenant-bound MCP access
 * token so the CMS's in-app AI can call the MCP tools as that tenant. The
 * interactive OAuth flow (consent screen) doesn't fit server-to-server, but
 * the CMS has already authenticated the tenant with Firebase before asking,
 * so this is an identity hand-off, not an auth bypass.
 *
 * Tokens land in the same CaptivePortal_McpAccessTokens store as OAuth ones
 * (synthetic client id `internal:cms-ai`), so requireBearer, revocation and
 * the hourly cleanup all apply unchanged.
 *
 * Auth: `x-internal-secret` must match MCP_INTERNAL_SECRET (same shared-secret
 * pattern as server/'s INTERNAL_API_SECRET).
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { createAccessToken } from '../store/oauth';

const router = Router();

const MAX_TTL_SECONDS = 900;
const DEFAULT_TTL_SECONDS = 900;
const INTERNAL_CLIENT_ID = 'internal:cms-ai';

router.post('/mint-token', async (req: Request, res: Response) => {
  const secret = req.header('x-internal-secret');
  if (!config.internalSecret || secret !== config.internalSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { tenantUserId, ttlSeconds, label } = (req.body ?? {}) as {
    tenantUserId?: string;
    ttlSeconds?: number;
    label?: string;
  };

  if (!tenantUserId || typeof tenantUserId !== 'string' || !tenantUserId.trim()) {
    return res.status(400).json({ ok: false, error: 'tenantUserId is required' });
  }

  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
      ? Math.floor(Number(ttlSeconds))
      : DEFAULT_TTL_SECONDS,
  );

  try {
    const { raw, doc } = await createAccessToken({
      tenantUserId: tenantUserId.trim(),
      clientId: label ? `${INTERNAL_CLIENT_ID}:${String(label).slice(0, 32)}` : INTERNAL_CLIENT_ID,
      scope: 'access_points:read',
      resource: config.mcpServerUrl,
      ttlSeconds: ttl,
    });

    return res.json({ ok: true, token: raw, expiresAt: doc.expiresAt });
  } catch (err) {
    console.error('[MCP internal mint-token]', err);
    return res.status(500).json({ ok: false, error: 'Failed to mint token' });
  }
});

export const internalRouter = router;
