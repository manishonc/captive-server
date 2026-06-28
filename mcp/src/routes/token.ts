import { Router, Response } from 'express';
import { config, SCOPES } from '../config';
import { rateLimit } from '../middleware/rateLimit';
import { sha256Hex, verifyPkceS256 } from '../crypto';
import { getClient, touchClient } from '../store/clients';
import {
  consumeAuthCode,
  createAccessToken,
  createRefreshToken,
  getRefreshTokenByHash,
  markRefreshConsumed,
  patchAccessToken,
  patchRefreshToken,
  revokeChainFrom,
} from '../store/oauth';

/**
 * Token endpoint (RFC 6749 §4.1.3 + §6, under OAuth 2.1).
 *  - authorization_code grant: exchanges a one-time code (+ PKCE verifier) for an
 *    opaque access token + a rotated refresh token.
 *  - refresh_token grant: rotates the refresh token; replaying a consumed refresh
 *    is treated as theft and revokes the whole forward chain.
 */
export const tokenRouter = Router();

function tokenError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

tokenRouter.post('/oauth/token', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'token' }), async (req, res) => {
  const body = (req.body || {}) as Record<string, string>;
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const { code, redirect_uri, code_verifier, client_id, resource } = body;
    if (!code || !redirect_uri || !code_verifier || !client_id) {
      return tokenError(res, 400, 'invalid_request', 'code, redirect_uri, code_verifier, client_id are required.');
    }
    const client = await getClient(client_id);
    if (!client) return tokenError(res, 401, 'invalid_client', 'Unknown client.');

    const codeDoc = await consumeAuthCode(code);
    if (!codeDoc) return tokenError(res, 400, 'invalid_grant', 'Authorization code is invalid, used, or expired.');
    if (codeDoc.clientId !== client_id) return tokenError(res, 400, 'invalid_grant', 'client_id does not match the code.');
    if (codeDoc.redirectUri !== redirect_uri) return tokenError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
    if (resource && resource !== codeDoc.resource) return tokenError(res, 400, 'invalid_target', 'resource does not match.');
    if (!verifyPkceS256(code_verifier, codeDoc.codeChallenge)) {
      return tokenError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    await touchClient(client_id);

    // Issue the access token, then a refresh token linked to it, then backfill the link.
    const access = await createAccessToken({
      tenantUserId: codeDoc.tenantUserId,
      clientId: client_id,
      scope: codeDoc.scope,
      resource: codeDoc.resource,
      ttlSeconds: config.accessTokenTtlSeconds,
    });
    const refresh = await createRefreshToken({
      tenantUserId: codeDoc.tenantUserId,
      clientId: client_id,
      scope: codeDoc.scope,
      resource: codeDoc.resource,
      ttlDays: config.refreshTokenTtlDays,
    });
    await patchAccessToken(access.doc.tokenHash, { refreshTokenHash: refresh.doc.tokenHash });
    await patchRefreshToken(refresh.doc.tokenHash, { accessTokenHash: access.doc.tokenHash });

    return res.json({
      access_token: access.raw,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refresh.raw,
      scope: codeDoc.scope,
    });
  }

  if (grantType === 'refresh_token') {
    const { refresh_token, client_id, scope } = body;
    if (!refresh_token || !client_id) {
      return tokenError(res, 400, 'invalid_request', 'refresh_token and client_id are required.');
    }
    const client = await getClient(client_id);
    if (!client) return tokenError(res, 401, 'invalid_client', 'Unknown client.');

    const rtHash = sha256Hex(refresh_token);
    const rt = await getRefreshTokenByHash(rtHash);
    if (!rt || rt.clientId !== client_id) {
      return tokenError(res, 400, 'invalid_grant', 'Unknown refresh token.');
    }
    if (rt.revoked) return tokenError(res, 400, 'invalid_grant', 'Refresh token has been revoked.');
    if (Date.now() > rt.expiresAt) return tokenError(res, 400, 'invalid_grant', 'Refresh token has expired.');

    if (rt.consumed) {
      // Reuse of an already-rotated refresh token → token theft. Revoke the chain.
      await revokeChainFrom(rtHash);
      return tokenError(res, 400, 'invalid_grant', 'Refresh-token reuse detected; the session has been revoked.');
    }

    // Scope may only stay the same or narrow.
    const requested = scope
      ? String(scope)
          .split(/\s+/)
          .filter(Boolean)
          .filter((s) => (SCOPES as readonly string[]).includes(s))
      : null;
    const newScope = requested && requested.length ? requested.join(' ') : rt.scope;

    const access = await createAccessToken({
      tenantUserId: rt.tenantUserId,
      clientId: client_id,
      scope: newScope,
      resource: rt.resource,
      ttlSeconds: config.accessTokenTtlSeconds,
    });
    const refresh = await createRefreshToken({
      tenantUserId: rt.tenantUserId,
      clientId: client_id,
      scope: newScope,
      resource: rt.resource,
      ttlDays: config.refreshTokenTtlDays,
    });
    await patchAccessToken(access.doc.tokenHash, { refreshTokenHash: refresh.doc.tokenHash });
    await patchRefreshToken(refresh.doc.tokenHash, { accessTokenHash: access.doc.tokenHash });
    await markRefreshConsumed(rtHash, refresh.doc.tokenHash);

    return res.json({
      access_token: access.raw,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refresh.raw,
      scope: newScope,
    });
  }

  return tokenError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
});
