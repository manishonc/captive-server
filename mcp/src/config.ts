/**
 * Typed environment configuration for the HeidiFi MCP server.
 *
 * In production these are provided by the docker-compose.mcp.yml service. For local
 * development, only FIREBASE_* + MCP_DEV_STATIC_TOKEN + MCP_DEV_TENANT_ID are needed
 * to exercise the MCP tools before OAuth is wired in (Phase A).
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: num('PORT', 4001),
  isProd: process.env.NODE_ENV === 'production',

  // Canonical OAuth/MCP URLs. MCP_SERVER_URL is the RFC 8707 audience; MCP_ISSUER_URL
  // is the Authorization Server issuer origin (same as the resource server in v1).
  mcpServerUrl: process.env.MCP_SERVER_URL || 'https://mcp.heidifi.ai/mcp',
  mcpIssuerUrl: (process.env.MCP_ISSUER_URL || 'https://mcp.heidifi.ai').replace(/\/$/, ''),
  consentUrl: process.env.OAUTH_CONSENT_URL || 'https://portal.heidifi.ai/captive-oauth/consent',
  // (The /oauth/authorize/resume redirect is owned by the CMS via its own OAUTH_RESUME_URL.)

  // Token lifetimes.
  codeTtlSeconds: num('OAUTH_CODE_TTL_SECONDS', 120),
  accessTokenTtlSeconds: num('OAUTH_ACCESS_TOKEN_TTL_SECONDS', 3600),
  refreshTokenTtlDays: num('OAUTH_REFRESH_TOKEN_TTL_DAYS', 30),
  authRequestTtlSeconds: 600, // 10 minutes for the browser consent round-trip

  // Dev-only static-token bypass (Phase A; must be unset in production).
  devStaticToken: process.env.MCP_DEV_STATIC_TOKEN || '',
  devTenantId: process.env.MCP_DEV_TENANT_ID || '',

  // Shared secret guarding /internal/* (CMS server-to-server token minting).
  internalSecret: process.env.MCP_INTERNAL_SECRET || '',

  // The main captive-server API (server/, port 4000) for proxied campaign
  // lifecycle actions; guarded by ITS internal secret.
  serverApiUrl: (process.env.CAPTIVE_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  serverInternalSecret: process.env.INTERNAL_API_SECRET || '',
};

/** The `.well-known/oauth-protected-resource` document URL, advertised on 401s. */
export const protectedResourceMetadataUrl = `${config.mcpIssuerUrl}/.well-known/oauth-protected-resource`;

/** Scopes the MCP server advertises and enforces. */
export const SCOPES = ['access_points:read'] as const;
export type Scope = (typeof SCOPES)[number];
