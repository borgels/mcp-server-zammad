import { ZammadHttpError } from '../errors.js';

export type ZammadHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ZammadQueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface ZammadClientOptions {
  baseUrl?: string;
  token?: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ZammadRequest {
  method: ZammadHttpMethod;
  path: string;
  query?: Record<string, ZammadQueryValue>;
  body?: unknown;
}

export interface ZammadResponse<T = unknown> {
  data: T;
  status: number;
}

export class ZammadClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ZammadClientOptions = {}) {
    const rawBaseUrl = options.baseUrl ?? process.env.ZAMMAD_URL ?? process.env.ZAMMAD_BASE_URL ?? '';
    this.baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (this.baseUrl) {
      assertSafeBaseUrl(this.baseUrl);
    }
    this.token = options.token ?? process.env.ZAMMAD_TOKEN;
    this.bearerToken = options.bearerToken ?? process.env.ZAMMAD_BEARER_TOKEN ?? process.env.ZAMMAD_OAUTH_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.ZAMMAD_TIMEOUT_MS ?? 30_000);
  }

  async get<T = unknown>(path: string, query?: Record<string, ZammadQueryValue>): Promise<ZammadResponse<T>> {
    return this.request<T>({ method: 'GET', path, query });
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, ZammadQueryValue>,
  ): Promise<ZammadResponse<T>> {
    return this.request<T>({ method: 'POST', path, body, query });
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, ZammadQueryValue>,
  ): Promise<ZammadResponse<T>> {
    return this.request<T>({ method: 'PUT', path, body, query });
  }

  async delete<T = unknown>(path: string, query?: Record<string, ZammadQueryValue>): Promise<ZammadResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, query });
  }

  async request<T = unknown>(request: ZammadRequest): Promise<ZammadResponse<T>> {
    const url = this.url(request.path, request.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authHeader(),
    };

    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new ZammadHttpError({
        status: response.status,
        method: request.method,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId:
          response.headers.get('x-request-id') ??
          response.headers.get('request-id') ??
          response.headers.get('traceparent') ??
          undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return {
      data: responseBody as T,
      status: response.status,
    };
  }

  getAuthContext(): { authMethod: 'bearer' | 'token' | 'none'; baseUrl: string } {
    return {
      authMethod: this.bearerToken ? 'bearer' : this.token ? 'token' : 'none',
      baseUrl: this.baseUrl,
    };
  }

  private authHeader(): string {
    if (this.bearerToken) {
      return `Bearer ${this.bearerToken}`;
    }
    if (this.token) {
      return `Token token=${this.token}`;
    }
    throw new Error('Missing Zammad credentials. Set ZAMMAD_TOKEN (HTTP token) or ZAMMAD_BEARER_TOKEN (OAuth bearer).');
  }

  private url(path: string, query: Record<string, ZammadQueryValue> = {}): string {
    if (!this.baseUrl) {
      throw new Error('Missing Zammad base URL. Set ZAMMAD_URL (or ZAMMAD_BASE_URL).');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}/api/v1${normalizedPath}`);

    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(url.searchParams, key, value);
    }

    return url.toString();
  }
}

export function paginationQuery(input: {
  page?: number;
  perPage?: number;
  expand?: boolean;
}): Record<string, ZammadQueryValue> {
  return {
    page: input.page,
    per_page: input.perPage,
    expand: input.expand,
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: ZammadQueryValue): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(searchParams, key, item);
    }
    return;
  }

  searchParams.append(key, String(value));
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ZAMMAD_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send Zammad credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
