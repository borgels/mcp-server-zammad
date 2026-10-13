import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZammadClient, type ZammadClientOptions } from './zammad/client.js';
import { registerZammadTools } from './tools/zammad.js';

export interface CreateServerOptions {
  client?: ZammadClient;
  clientOptions?: ZammadClientOptions;
  /** Gateway-verified end-user identity; every Zammad call runs as this user. */
  onBehalfOf?: string;
  /**
   * Fail closed when no onBehalfOf identity is supplied instead of falling
   * back to the API token user. The HTTP transport sets this.
   */
  requireOnBehalfOf?: boolean;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'zammad',
    version: '0.1.0',
  });

  const onBehalfOf = options.onBehalfOf?.trim() || undefined;
  if (options.requireOnBehalfOf && !onBehalfOf) {
    throw new Error('A verified user identity is required; refusing to fall back to the API token user.');
  }

  const base = options.client ?? new ZammadClient(options.clientOptions);
  const client = onBehalfOf ? base.actingAs(onBehalfOf) : base;
  registerZammadTools(server, client);

  return server;
}
