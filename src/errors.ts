export interface ZammadHttpErrorInput {
  status: number;
  method: string;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  requestId?: string;
  fallbackMessage?: string;
}

const SECRET_PATTERNS = [
  /Authorization:\s*(Token token=|Bearer|Basic)\s*[^,\s}]+/gi,
  /(ZAMMAD_TOKEN|ZAMMAD_BEARER_TOKEN|ZAMMAD_OAUTH_TOKEN|access_token|refresh_token|apiKey|accessToken|password|token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /\bToken token=[^,\s}]+/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/g,
];

export class ZammadHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly payload?: unknown;
  readonly retryAfter?: string;
  readonly requestId?: string;

  constructor(input: ZammadHttpErrorInput) {
    super(formatZammadHttpError(input));
    this.name = 'ZammadHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.requestId = input.requestId;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^Authorization:/i.test(match)) {
          return 'Authorization: [REDACTED]';
        }

        if (/^Token token=/i.test(match)) {
          return 'Token token=[REDACTED]';
        }

        if (/^(Bearer|Basic)\s/i.test(match)) {
          const scheme = match.split(/\s+/)[0] ?? 'Authorization';
          return `${scheme} [REDACTED]`;
        }

        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatZammadHttpError(input: ZammadHttpErrorInput): string {
  const parts = [
    `Zammad API request failed with HTTP ${input.status}`,
    `${input.method.toUpperCase()} ${redactSecrets(input.url)}`,
    input.requestId ? `request-id=${input.requestId}` : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    zammadErrorText(input.payload),
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function zammadErrorText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const value = payload as Record<string, unknown>;
  const message =
    value.error ??
    value.error_human ??
    value.message ??
    value.error_description ??
    value.errorMessage ??
    value.title ??
    (Array.isArray(value.errors) ? value.errors.map(String).join(', ') : undefined);

  return typeof message === 'string' ? message : undefined;
}
