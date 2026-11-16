import { ConfigError, readEnvInteger } from '../config-env.js';
import { describeUrl, registerSecret, ZammadHttpError } from '../errors.js';

/** Error responses are read up to this many bytes. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface ZammadClientOptions {
  apiToken?: string;
  baseUrl?: string;
  /** Zammad login/email to impersonate via X-On-Behalf-Of on every call. */
  onBehalfOf?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Client for the Zammad REST API. Auth is a personal access token sent as
 * `Authorization: Bearer <token>`. When onBehalfOf is set, every request
 * carries the `From` header (the documented successor to X-On-Behalf-Of)
 * so Zammad executes it AS that user: their permissions apply and they are
 * recorded as the author. The token user needs admin.user for
 * impersonation to be accepted.
 */
export class ZammadClient {
  private readonly apiToken?: string;
  readonly baseUrl: string;
  readonly onBehalfOf?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ZammadClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.ZAMMAD_API_TOKEN;
    registerSecret(this.apiToken);
    const root = trimTrailingSlash(options.baseUrl ?? process.env.ZAMMAD_BASE_URL ?? '');
    if (!root) {
      throw new Error('Missing ZAMMAD_BASE_URL (e.g. https://yourcompany.zammad.com).');
    }
    assertSafeBaseUrl(root);
    this.baseUrl = root.endsWith('/api/v1') ? root : `${root}/api/v1`;
    this.onBehalfOf = options.onBehalfOf?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? readEnvInteger('ZAMMAD_TIMEOUT_MS', 30_000, { max: MAX_TIMEOUT_MS });
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ConfigError('timeoutMs must be a positive integer.');
    }
  }

  /** A copy of this client acting as the given user (or as the token user when undefined). */
  actingAs(onBehalfOf: string | undefined): ZammadClient {
    return new ZammadClient({
      apiToken: this.apiToken,
      baseUrl: this.baseUrl,
      onBehalfOf,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, undefined, body);
  }

  /** Fetch binary content (attachment downloads). Enforces a byte cap. */
  async getBinary(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    assertNotRedirect(response, 'GET', url);

    if (!response.ok) {
      const payload = await readErrorBody(response);
      throw new ZammadHttpError({ status: response.status, url, payload });
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Attachment is ${declared} bytes which exceeds the ${maxBytes} byte limit.`);
    }
    // The cap is enforced while streaming, so an oversized body is never fully buffered.
    const { bytes, exceeded } = await readUpTo(response, maxBytes);
    if (exceeded) {
      throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    }
    return {
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(): Record<string, string> {
    if (!this.apiToken) {
      throw new Error('Missing ZAMMAD_API_TOKEN. Set it in the MCP server environment.');
    }
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
      ...(this.onBehalfOf ? { From: this.onBehalfOf } : {}),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const headers = this.headers();
    const init: RequestInit = {
      method,
      headers,
      // Never follow redirects: the token would be re-sent to wherever the
      // Location points (Authorization is only dropped cross-origin, and the
      // From impersonation header is never dropped).
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    assertNotRedirect(response, method, url);

    if (!response.ok) {
      const responseBody = await readErrorBody(response);
      throw new ZammadHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return (await readResponseBody(response)) as T;
  }
}

function assertNotRedirect(response: Response, method: string, url: string): void {
  // With redirect: 'manual', fetch returns the 3xx itself (or an opaque
  // redirect with status 0 in browser-like runtimes).
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Zammad API responded with a redirect (HTTP ${response.status}) for ${method} ${describeUrl(url)}; ` +
        'redirects are not followed. Check that ZAMMAD_BASE_URL is the final https:// address of the instance.',
    );
  }
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

/** Error bodies are read up to a small limit; JSON is parsed only when complete. */
async function readErrorBody(response: Response): Promise<unknown> {
  const { bytes, exceeded } = await readUpTo(response, MAX_ERROR_BODY_BYTES);
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  if (exceeded) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ZAMMAD_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing to send the Zammad token over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
