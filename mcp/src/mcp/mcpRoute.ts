import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './registry';
import { requireBearer, AuthedRequest } from '../middleware/bearer';

export const mcpRouter = Router();

/**
 * Stateless streamable-HTTP MCP endpoint.
 *
 * Each POST builds a fresh McpServer + transport (no session state), validates the
 * bearer token (requireBearer sets req.auth → reaches tools as extra.authInfo), then
 * hands the request to the SDK transport. This matches the canonical stateless pattern
 * (sessionIdGenerator: undefined).
 */
mcpRouter.post('/', requireBearer, async (req: AuthedRequest, res: Response) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
});

// Stateless mode has no standalone SSE stream or session to terminate.
mcpRouter.get('/', (_req: Request, res: Response) => {
  res
    .status(406)
    .json({ error: 'GET not supported in stateless mode; send JSON-RPC requests via POST.' });
});

mcpRouter.delete('/', (_req: Request, res: Response) => {
  res.status(405).json({ error: 'DELETE not supported in stateless mode.' });
});
