import { ZammadHttpError } from '../errors.js';

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
    const root = trimTrailingSlash(options.baseUrl ?? process.env.ZAMMAD_BASE_URL ?? '');
    if (!root) {
      throw new Error('Missing ZAMMAD_BASE_URL (e.g. https://yourcompany.zammad.com).');
    }
    assertSafeBaseUrl(root);
    this.baseUrl = root.endsWith('/api/v1') ? root : `${root}/api/v1`;
    this.onBehalfOf = options.onBehalfOf?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.ZAMMAD_TIMEOUT_MS ?? 30_000);
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const payload = await readResponseBody(response);
      throw new ZammadHttpError({ status: response.status, url, payload });
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Attachment is ${buffer.byteLength} bytes which exceeds the ${maxBytes} byte limit.`);
    }
    return {
      bytes: buffer,
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
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new ZammadHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return responseBody as T;
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
