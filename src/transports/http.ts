import { ConfigError } from '../config-env.js';
import { ZammadClient } from '../zammad/client.js';
import { allowTokenUser, profile, trustForwardedUser } from '../zammad/policy.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Zammad MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // Validate the Zammad client configuration (base URL, timeout) once at
    // startup instead of failing on every request.
    new ZammadClient();
  } catch (error) {
    console.error(`Zammad MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }
  if (!trustForwardedUser()) {
    console.error(
      allowTokenUser()
        ? `WARNING: ZAMMAD_ALLOW_TOKEN_USER=true: every HTTP request runs as the API token user (profile: ${profile()}).`
        : 'WARNING: ZAMMAD_TRUST_FORWARDED_USER is not "true" and ZAMMAD_ALLOW_TOKEN_USER is not set; ' +
            'all MCP requests will be rejected with 401.',
    );
  }

  const running = await startHttpServer(config);
  console.error(`Zammad MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
