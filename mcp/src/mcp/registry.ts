import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListAccessPoints } from './tools/listAccessPoints';

/**
 * Build a fresh McpServer with all tools registered.
 *
 * The stateless streamable-HTTP transport creates a new server + transport per
 * request, so tool registration must be cheap and idempotent — it is.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'heidifi-captive-portal',
    version: '1.0.0',
    title: 'HeidiFi Captive Portal',
  });

  registerListAccessPoints(server);
  // Future tools (list_venues, list_campaigns, send_campaign, …) register here.

  return server;
}
