import { Router } from 'express';
import { createClient } from '../store/clients';
import { rateLimit } from '../middleware/rateLimit';

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Claude Code and Cursor auto-register a public client here when a user adds the MCP
 * server. We accept only public clients (token_endpoint_auth_method = "none") with
 * PKCE; redirect URIs must be loopback http://localhost[:port] or https:// (no
 * wildcards, per OAuth 2.1).
 */
export const registerRouter = Router();

function isValidRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) return false;
  if (uri.includes('*')) return false; // OAuth 2.1 forbids wildcard redirect URIs
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false; // OAuth 2.1 forbids fragments in redirect URIs
  // Loopback http is allowed (non-HTTPS) for local MCP clients; everything else must be HTTPS.
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1')) {
    return true;
  }
  return parsed.protocol === 'https:';
}

registerRouter.post('/oauth/register', rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'dcr' }), async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];

  if (redirectUris.length === 0) {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required and must be a non-empty array.',
    });
  }

  for (const uri of redirectUris) {
    if (!isValidRedirectUri(uri)) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI must be http://localhost[:port] or https:// (no wildcards, no fragments): ${uri}`,
      });
    }
  }

  // Public clients only; ignore any client-supplied secret / auth method.
  const client = await createClient({
    clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
    redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
  });

  return res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    client_id_issued_at: client.createdAt,
  });
});
