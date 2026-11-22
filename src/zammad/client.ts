import { ConfigError, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { ActAsRefusedError } from '../act-as.js';
import { registerSecret, requestIdFrom, ZammadHttpError } from '../errors.js';
import { describeUrl, type SecretRedactor } from '../upstream-http.js';
import { isPublicAddress, pinnedFetch, systemResolve, type ResolveHost } from './network.js';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Largest successful JSON answer an embedded client reads. */
const MAX_EMBEDDED_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Our own text when the connection's check refuses a private or local address. */
export const PRIVATE_ADDRESS_REFUSED = 'Refused: the Zammad address points to a private or local network address.';

export interface ZammadClientOptions {
  apiToken?: string;
  baseUrl?: string;
  /** Zammad login/email to impersonate via the From header on every call. Not available to embedded clients. */
  onBehalfOf?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Where omitted values (apiToken, baseUrl, timeoutMs) are read from.
   * Defaults to process.env for the MCP server. Embedded clients pass `{}`.
   */
  credentialEnv?: Env;
  /**
   * Embedded (gateway) client: the token goes to `redactor` instead of the
   * process-wide registry, the base URL must already be normalised by
   * normalizeZammadBaseUrl, every connection goes only to public addresses
   * (DNS checked), and an answer that is not JSON is refused.
   */
  embedded?: { redactor: SecretRedactor; resolveHost?: ResolveHost };
}

export type QueryValue = string | number | boolean | null | undefined;

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Client for the Zammad REST API. Auth is a personal access token sent as
 * `Authorization: Bearer <token>`. When onBehalfOf is set, every request
 * carries the `From` header (the documented successor to X-On-Behalf-Of)
 * so Zammad executes it AS that user: their permissions apply and they are
 * recorded as the author. The token user needs admin.user for
 * impersonation to be accepted.
 *
 * Redirects are never followed and Zammad's error bodies are never read:
 * errors are our own text with the HTTP status first.
 */
export class ZammadClient {
  private readonly apiToken?: string;
  readonly baseUrl: string;
  readonly onBehalfOf?: string;
  /** The Zammad user an embedded copy acts as (asUser); undefined on the token's own client. */
  readonly actingUserId?: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly embedded?: { redactor: SecretRedactor; resolveHost: ResolveHost; hostFetch: boolean };

  constructor(options: ZammadClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.apiToken = options.apiToken ?? env.ZAMMAD_API_TOKEN;
    const root = trimTrailingSlash(options.baseUrl ?? readEnvString('ZAMMAD_BASE_URL', env) ?? '');
    if (!root) {
      throw new Error('Missing ZAMMAD_BASE_URL (e.g. https://yourcompany.zammad.com).');
    }
    if (options.embedded) {
      options.embedded.redactor.addSecret(this.apiToken);
      const resolveHost = options.embedded.resolveHost ?? systemResolve;
      this.embedded = { redactor: options.embedded.redactor, resolveHost, hostFetch: options.fetchImpl !== undefined };
      // Never impersonates: every call runs as the token's own user.
      this.onBehalfOf = undefined;
      // The built-in fetch connects only to public addresses, checked for every new connection (network.ts).
      this.fetchImpl = options.fetchImpl ?? pinnedFetch(resolveHost);
    } else {
      registerSecret(this.apiToken);
      assertSafeBaseUrl(root);
      this.onBehalfOf = options.onBehalfOf?.trim() || undefined;
      this.fetchImpl = options.fetchImpl ?? fetch;
    }
    this.baseUrl = root.endsWith('/api/v1') ? root : `${root}/api/v1`;
    this.timeoutMs = options.timeoutMs ?? readEnvInteger('ZAMMAD_TIMEOUT_MS', 30_000, { max: MAX_TIMEOUT_MS }, env);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new ConfigError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
  }

  /** A copy of this client acting as the given user (or as the token user when undefined). */
  actingAs(onBehalfOf: string | undefined): ZammadClient {
    if (this.embedded) {
      throw new Error('An embedded Zammad client does not impersonate.');
    }
    return new ZammadClient({
      apiToken: this.apiToken,
      baseUrl: this.baseUrl,
      onBehalfOf,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * A copy of this embedded client that sends every request with `From: <userId>`, so Zammad runs it as that user: their
   * permissions apply and they are recorded as the author. Only Zammad's own numeric id is sent, never an email or a
   * login. A 401 to such a request means Zammad would not let the token act for the user (the token user lacks
   * admin.user, or the user cannot be used): it becomes ActAsRefusedError('not_permitted'), never a refused token.
   */
  asUser(userId: number): ZammadClient {
    if (!this.embedded) {
      throw new Error('asUser is for embedded clients; the MCP server uses actingAs.');
    }
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new ActAsRefusedError('no_user');
    }
    const copy = Object.create(this) as ZammadClient;
    Object.defineProperty(copy, 'onBehalfOf', { value: String(userId), enumerable: true });
    Object.defineProperty(copy, 'actingUserId', { value: userId, enumerable: true });
    return copy;
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

  /** DELETE with an optional JSON body (Zammad's /tags/remove takes its parameters in the body). */
  async delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, undefined, body);
  }

  /** Fetch binary content (attachment downloads). Enforces a byte cap. */
  async getBinary(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await this.send('GET', url, {
      method: 'GET',
      headers: this.headers(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    assertNotRedirect(response, 'GET');

    if (!response.ok) {
      await discard(response);
      throw new ZammadHttpError({
        status: response.status,
        method: 'GET',
        url: describeUrl(url),
        requestId: requestIdFrom(response.headers),
      });
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard(response);
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
      throw new Error(
        this.embedded
          ? 'No Zammad access token is configured for this connection.'
          : 'Missing ZAMMAD_API_TOKEN. Set it in the MCP server environment.',
      );
    }
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
      ...(this.onBehalfOf ? { From: this.onBehalfOf } : {}),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

    const response = await this.send(method, url, init);
    assertNotRedirect(response, method);

    if (!response.ok) {
      // The body is never read: Zammad's text never becomes part of an error.
      await discard(response);
      // Acting as a user, a 401 is Zammad refusing the From header (the token was accepted for the lookup before it).
      if (response.status === 401 && this.actingUserId !== undefined) throw new ActAsRefusedError('not_permitted');
      throw new ZammadHttpError({
        status: response.status,
        method,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId: requestIdFrom(response.headers),
      });
    }

    return (await this.readBody(response, method)) as T;
  }

  /** The request, with network failures and timeouts in our own words (no address, no cause text). */
  private async send(method: string, url: string, init: RequestInit): Promise<Response> {
    try {
      if (this.embedded?.hostFetch) {
        // The host's fetch connects by itself: the name is checked here, before every request.
        await this.assertPublicHost(new URL(url).hostname);
      }
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(method, error);
    }
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    let addresses: readonly string[];
    try {
      addresses = await this.embedded!.resolveHost(hostname);
    } catch {
      throw Object.assign(new Error('The Zammad address could not be resolved.'), { code: 'ENOTFOUND' });
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw Object.assign(new Error(PRIVATE_ADDRESS_REFUSED), { code: 'ERR_ZAMMAD_PRIVATE_ADDRESS' });
    }
  }

  private transportError(method: string, error: unknown): Error {
    if (error instanceof ZammadHttpError) {
      return error;
    }
    if (isTimeoutError(error)) {
      return Object.assign(new Error(`Zammad API request timed out after ${this.timeoutMs} ms (${method}).`), {
        name: 'TimeoutError',
      });
    }
    const codes = causeCodes(error);
    if (codes.includes('ERR_ZAMMAD_PRIVATE_ADDRESS')) {
      return new Error(PRIVATE_ADDRESS_REFUSED);
    }
    const shown = codes.find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling the Zammad API (${method})${shown ? ` (${shown})` : ''}.`);
  }

  private async readBody(response: Response, method: string): Promise<unknown> {
    if (!this.embedded) {
      return readResponseBody(response);
    }
    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_EMBEDDED_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (read.exceeded) {
      throw new Error(`The Zammad answer exceeds the ${MAX_EMBEDDED_RESPONSE_BYTES} byte limit (${method}).`);
    }
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Never passed on as text: an answer that is not JSON is not what the API documents.
      throw new Error(`Zammad answered with something that is not JSON (${method}); nothing of it is passed on.`);
    }
  }
}

function assertNotRedirect(response: Response, method: string): void {
  // With redirect: 'manual', fetch returns the 3xx itself (or an opaque
  // redirect with status 0 in browser-like runtimes).
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Zammad API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
        'redirects are not followed. Check that the Zammad address is the final https:// address of the instance.',
    );
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** The `code` of an error and of every cause below it. */
function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
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
    throw new Error('ZAMMAD_BASE_URL is not a valid URL.');
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
