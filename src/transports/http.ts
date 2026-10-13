import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { allowTokenUser, profile, trustForwardedUser } from '../zammad/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  assertSafeHttpStartup,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  resolveHttpIdentity,
  sendJson,
} from './http-helpers.js';

const config = getHttpConfig();
assertSafeHttpStartup(config);
if (!trustForwardedUser()) {
  console.error(
    allowTokenUser()
      ? `WARNING: ZAMMAD_ALLOW_TOKEN_USER=true — every HTTP request runs as the API token user (profile: ${profile()}).`
      : 'WARNING: ZAMMAD_TRUST_FORWARDED_USER is not "true" and ZAMMAD_ALLOW_TOKEN_USER is not set; ' +
          'all MCP requests will be rejected with 401.',
  );
}

const httpServer = createNodeServer(async (req, res) => {
  try {
    if (req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);

    // The gateway forwards the Entra-verified user as X-MCP-User; the
    // stateless per-request server binds it as the Zammad on-behalf-of
    // identity. Only honored when the deployment says the header can be
    // trusted (it never arrives from public traffic — the gateway sets it).
    // Fails closed: no trusted identity → 401, never the admin token user
    // (unless ZAMMAD_ALLOW_TOKEN_USER=true was set explicitly).
    const identity = resolveHttpIdentity(req);
    const body = await readJsonBody(req, config.maxBodyBytes);

    const mcpServer = createMcpServer({
      onBehalfOf: identity.onBehalfOf,
      requireOnBehalfOf: trustForwardedUser() || !allowTokenUser(),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }

      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      }, req);
    }
  }
});

httpServer.listen(config.port, config.host, () => {
  console.error(`Zammad MCP HTTP server listening on http://${config.host}:${config.port}/mcp`);
});
