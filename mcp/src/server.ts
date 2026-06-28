import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { config } from './config';
import { mcpRouter } from './mcp/mcpRoute';
import { metadataRouter } from './routes/metadata';
import { registerRouter } from './routes/register';
import { authorizeRouter } from './routes/authorize';
import { tokenRouter } from './routes/token';
import { revokeRouter } from './routes/revoke';
import { startTokenCleanup } from './jobs/tokenCleanup';

const app = express();

// Behind the reverse proxy (Coolify/nginx) so rate-limiting + logging see the real client IP.
app.set('trust proxy', 1);

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'heidifi-mcp', version: '1.0.0' });
});

// OAuth discovery (RFC 9728 + 8414), Dynamic Client Registration (RFC 7591),
// the Authorization Code + token endpoints (RFC 6749 / OAuth 2.1), and revocation (RFC 7009).
app.use(metadataRouter);
app.use(registerRouter);
app.use(authorizeRouter);
app.use(tokenRouter);
app.use(revokeRouter);

// MCP protocol endpoint (bearer-protected).
app.use('/mcp', mcpRouter);

app.listen(config.port, () => {
  console.log(`[heidifi-mcp] listening on port ${config.port}`);
  startTokenCleanup();
  if (config.devStaticToken) {
    console.warn(
      `[heidifi-mcp] DEV MODE active: accepting MCP_DEV_STATIC_TOKEN bound to tenant "${config.devTenantId || '(none)'}". DO NOT use in production.`,
    );
  } else {
    console.log('[heidifi-mcp] production token validation enabled (CaptivePortal_McpAccessTokens).');
  }
});
