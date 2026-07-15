import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZammadClient, type ZammadClientOptions } from './zammad/client.js';
import { registerZammadTools } from './tools/zammad.js';

export interface CreateServerOptions {
  client?: ZammadClient;
  clientOptions?: ZammadClientOptions;
  /** Gateway-verified end-user identity; every Zammad call runs as this user. */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'zammad',
    version: '0.1.0',
  });

  const base = options.client ?? new ZammadClient(options.clientOptions);
  const client = options.onBehalfOf ? base.actingAs(options.onBehalfOf) : base;
  registerZammadTools(server, client);

  return server;
}
