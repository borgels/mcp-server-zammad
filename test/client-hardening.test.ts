import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZammadClient } from '../src/zammad/client.js';
import { PACKAGE_VERSION } from '../src/version.js';

const TOKEN = 'zammad-test-token-0123456789';

function client(fetchImpl: typeof fetch): ZammadClient {
  return new ZammadClient({ apiToken: TOKEN, baseUrl: 'https://zammad.example.com', fetchImpl });
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Zammad client hardening', () => {
  it('never follows redirects', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x?sig=secret' } });
    });
    await expect(client(fetchImpl as typeof fetch).get('/tickets', { query: 'q' })).rejects.toThrow(
      /redirect \(HTTP 302\).*redirects are not followed/,
    );
    await expect(client(fetchImpl as typeof fetch).getBinary('/attachments/1', 1024)).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('redacts the token before truncating error text and drops query strings', async () => {
    const body = `${'x'.repeat(490)} token ${TOKEN} ${'y'.repeat(200_000)}`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500 }));
    const error: Error & { url: string } = await client(fetchImpl as typeof fetch)
      .get('/tickets/search', { query: 'secret-query' })
      .then(() => { throw new Error("expected failure"); }, (e: unknown) => e as Error & { url: string });
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN.slice(0, 8));
    expect(error.message.length).toBeLessThan(2_000);
    expect(error.url).toBe('https://zammad.example.com/api/v1/tickets/search');
  });

  it('enforces the attachment cap while streaming', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(4096), { status: 200 }));
    await expect(client(fetchImpl as typeof fetch).getBinary('/attachments/1', 1024)).rejects.toThrow(/1024 byte limit/);
    const ok = await client(fetchImpl as typeof fetch).getBinary('/attachments/1', 8192);
    expect(ok.bytes.byteLength).toBe(4096);
  });

  it('rejects an invalid ZAMMAD_TIMEOUT_MS instead of using NaN', () => {
    process.env.ZAMMAD_BASE_URL = 'https://zammad.example.com';
    process.env.ZAMMAD_TIMEOUT_MS = 'abc';
    expect(() => new ZammadClient()).toThrow(/ZAMMAD_TIMEOUT_MS/);
    process.env.ZAMMAD_TIMEOUT_MS = '0';
    expect(() => new ZammadClient()).toThrow(/ZAMMAD_TIMEOUT_MS/);
    process.env.ZAMMAD_TIMEOUT_MS = '5000';
    expect(() => new ZammadClient()).not.toThrow();
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
