export interface ZammadErrorPayload {
  error?: string;
  error_human?: string;
  message?: string;
}

const SECRET_PATTERNS = [
  /authorization:\s*(bearer|token token=)\s*[^,\s}]+/gi,
  /(apiToken|ZAMMAD_API_TOKEN|api_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class ZammadHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: ZammadErrorPayload | unknown;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: ZammadErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatZammadHttpError(input));
    this.name = 'ZammadHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
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
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatZammadHttpError(input: {
  status: number;
  url: string;
  payload?: ZammadErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isZammadErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Zammad API request failed with HTTP ${input.status}`,
    payload?.error_human ?? payload?.error,
    payload?.message,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isZammadErrorPayload(value: unknown): value is ZammadErrorPayload {
  return typeof value === 'object' && value !== null;
}
