import { Router } from 'express';
import { config, SCOPES } from '../config';

/**
 * OAuth 2.0 discovery documents.
 *  - /.well-known/oauth-protected-resource (RFC 9728) — tells MCP clients where the
 *    authorization server is. (The 401 + WWW-Authenticate that triggers discovery is
 *    emitted by the bearer middleware on /mcp.)
 *  - /.well-known/oauth-authorization-server (RFC 8414) — tells clients the endpoint
 *    map for THIS authorization server (issuer = the MCP server origin in v1).
 */
export const metadataRouter = Router();

metadataRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: config.mcpServerUrl,
    authorization_servers: [config.mcpIssuerUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
    resource_documentation: 'https://www.heidifi.ai/docs/mcp',
    resource_policy_uri: 'https://www.heidifi.ai/privacy',
    resource_tos_uri: 'https://www.heidifi.ai/terms',
  });
});

metadataRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const issuer = config.mcpIssuerUrl;
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    require_pushed_authorization_requests: false,
  });
});
