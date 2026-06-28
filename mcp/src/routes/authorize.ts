import { Router, Response } from 'express';
import { config } from '../config';
import { getClient } from '../store/clients';
import {
  createAuthRequest,
  consumeApprovedAuthRequest,
  createAuthCode,
} from '../store/oauth';
import { SCOPES } from '../config';

/**
 * Authorization endpoint (OAuth 2.1 Authorization Code + PKCE).
 *
 * GET /oauth/authorize  — validate the client/PKCE/resource, write a pending
 *   CaptivePortal_McpAuthRequests doc, and 302 to the CMS consent screen (portal.heidifi.ai).
 *   The CMS sets the doc to `approved` (+ tenantUserId); it never sees redirect_uri.
 *
 * GET /oauth/authorize/resume — the CMS redirects the browser back here; we
 *   transactionally consume the approved request and mint a one-time code, then
 *   302 to the client's registered redirect_uri with ?code=&state=.
 */
export const authorizeRouter = Router();

function errorPage(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type('text/html')
    .send(
      `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>HeidiFi — authorization error</h2><p>${message}</p></body></html>`,
    );
}

authorizeRouter.get('/oauth/authorize', async (req, res) => {
  const q = (req.query || {}) as Record<string, string>;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = q;

  // Validate client + redirect_uri first — these cannot be safely redirected.
  const client = await getClient(client_id);
  if (!client) return errorPage(res, 400, 'Unknown client.');
  if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    return errorPage(res, 400, 'Invalid redirect_uri.');
  }

  const redirectWithError = (error: string, description: string): void => {
    const u = new URL(redirect_uri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    res.redirect(302, u.toString());
  };

  if (response_type !== 'code') return redirectWithError('unsupported_response_type', 'Only "code" is supported.');
  if (!code_challenge) return redirectWithError('invalid_request', 'code_challenge (PKCE) is required.');
  if (code_challenge_method !== 'S256') return redirectWithError('invalid_request', 'code_challenge_method must be S256.');
  if (resource !== config.mcpServerUrl) {
    return redirectWithError('invalid_target', `resource must be ${config.mcpServerUrl}.`);
  }

  const requested = (scope || SCOPES.join(' '))
    .split(/\s+/)
    .filter(Boolean)
    .filter((s) => (SCOPES as readonly string[]).includes(s));
  const grantedScope = requested.length ? requested.join(' ') : SCOPES.join(' ');

  const ar = await createAuthRequest({
    clientId: client_id,
    clientName: client.clientName,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256',
    state: state || '',
    scope: grantedScope,
    resource: config.mcpServerUrl,
    ttlSeconds: config.authRequestTtlSeconds,
  });

  const consent = new URL(config.consentUrl);
  consent.searchParams.set('request_id', ar.requestId);
  res.redirect(302, consent.toString());
});

authorizeRouter.get('/oauth/authorize/resume', async (req, res) => {
  const requestId = (req.query.request_id as string) || '';
  const ar = await consumeApprovedAuthRequest(requestId);
  if (!ar) {
    return errorPage(res, 400, 'Authorization request was not approved, has expired, or has already been used.');
  }

  const rawCode = await createAuthCode({
    clientId: ar.clientId,
    tenantUserId: ar.tenantUserId as string,
    redirectUri: ar.redirectUri,
    codeChallenge: ar.codeChallenge,
    codeChallengeMethod: ar.codeChallengeMethod,
    scope: ar.scope,
    resource: ar.resource,
    ttlSeconds: config.codeTtlSeconds,
  });

  const u = new URL(ar.redirectUri);
  u.searchParams.set('code', rawCode);
  if (ar.state) u.searchParams.set('state', ar.state);
  res.redirect(302, u.toString());
});
