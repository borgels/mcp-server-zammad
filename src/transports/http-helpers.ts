import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allowTokenUser, isValidForwardedUser, trustForwardedUser } from '../zammad/policy.js';

export class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

export interface HttpConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  httpToken?: string;
}

export function getHttpConfig(): HttpConfig {
  return {
    host: process.env.MCP_HTTP_HOST ?? process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    maxBodyBytes: Number(process.env.MCP_MAX_BODY_BYTES ?? 10_485_760),
    httpToken: process.env.MCP_HTTP_TOKEN || undefined,
  };
}

export function assertAuthorized(req: IncomingMessage, config = getHttpConfig()): void {
  if (!config.httpToken) {
    return;
  }

  if (!tokensMatch(req.headers.authorization, `Bearer ${config.httpToken}`)) {
    throw new HttpRequestError(401, 'Unauthorized');
  }
}

/** Constant-time comparison (hashing both sides first equalizes lengths). */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') {
    return false;
  }
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Refuse to start an HTTP deployment that trusts a forwarded identity
 * header without requiring the shared gateway token: anyone who can reach
 * the port could otherwise pick the identity they act as.
 */
export function assertSafeHttpStartup(config = getHttpConfig()): void {
  if (trustForwardedUser() && !config.httpToken) {
    throw new Error(
      'Refusing to start: ZAMMAD_TRUST_FORWARDED_USER=true requires MCP_HTTP_TOKEN to be set, ' +
        'otherwise any client could choose the X-MCP-User identity.',
    );
  }
}

/**
 * Resolve the identity an HTTP request acts as. Fails closed: without a
 * trusted, well-formed X-MCP-User the request is rejected, unless the
 * operator explicitly opted into token-user mode (ZAMMAD_ALLOW_TOKEN_USER=true
 * with the forwarded-user trust flag off).
 */
export function resolveHttpIdentity(req: IncomingMessage): { onBehalfOf?: string } {
  if (trustForwardedUser()) {
    const forwarded = firstHeaderValue(req.headers['x-mcp-user']);
    if (!forwarded) {
      throw new HttpRequestError(401, 'Missing verified user identity (X-MCP-User).');
    }
    if (!isValidForwardedUser(forwarded)) {
      throw new HttpRequestError(400, 'Invalid X-MCP-User value.');
    }
    return { onBehalfOf: forwarded };
  }

  if (allowTokenUser()) {
    return { onBehalfOf: undefined };
  }

  throw new HttpRequestError(
    401,
    'No verified user identity: set ZAMMAD_TRUST_FORWARDED_USER=true behind a gateway, ' +
      'or ZAMMAD_ALLOW_TOKEN_USER=true to run every request as the API token user.',
  );
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function assertAllowedOrigin(req: IncomingMessage): void {
  if (!isOriginAllowed(req.headers.origin)) {
    throw new HttpRequestError(403, 'Origin not allowed');
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes = getHttpConfig().maxBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  req?: IncomingMessage,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
  };

  if (process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin || process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    return true;
  }

  const configuredOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (configuredOrigins.length) {
    return configuredOrigins.includes(origin);
  }

  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}
