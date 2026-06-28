import { Router } from 'express';
import { sha256Hex } from '../crypto';
import {
  getAccessTokenByHash,
  revokeAccessToken,
  getRefreshTokenByHash,
  patchRefreshToken,
} from '../store/oauth';

/**
 * Token revocation (RFC 7009). Always returns 200 — even for unknown tokens — so the
 * endpoint does not leak which tokens exist. Revoking an access token also revokes its
 * paired refresh token (and vice-versa), so a revoked session can't be refreshed.
 */
export const revokeRouter = Router();

revokeRouter.post('/oauth/revoke', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (token) {
    const hash = sha256Hex(token);
    const at = await getAccessTokenByHash(hash);
    if (at) {
      await revokeAccessToken(hash);
      if (at.refreshTokenHash) await patchRefreshToken(at.refreshTokenHash, { revoked: true });
    } else {
      const rt = await getRefreshTokenByHash(hash);
      if (rt) {
        await patchRefreshToken(hash, { revoked: true });
        if (rt.accessTokenHash) await revokeAccessToken(rt.accessTokenHash);
      }
    }
  }
  // RFC 7009: respond 200 regardless of whether the token was found.
  res.status(200).json({});
});
