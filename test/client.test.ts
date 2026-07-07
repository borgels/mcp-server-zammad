import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUnknownError, redactSecrets, ZammadHttpError } from '../src/errors.js';
import { ZammadClient } from '../src/zammad/client.js';

const originalEnv = { ...process.env };

describe('ZammadClient', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends the Zammad token auth header and hits /api/v1', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: 1 }));
    const client = new ZammadClient({
      token: 'secret-token',
      baseUrl: 'https://helpdesk.example.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/tickets/1', { expand: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://helpdesk.example.com/api/v1/tickets/1?expand=true');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Token token=secret-token',
    });
  });

  it('supports OAuth bearer tokens and forgives a trailing /api/v1 in the base URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const client = new ZammadClient({
      bearerToken: 'bearer-token',
      baseUrl: 'https://helpdesk.example.com/api/v1/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/groups');

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://helpdesk.example.com/api/v1/groups');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer bearer-token' });
  });

  it('serializes JSON bodies and parses 204 responses as null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = new ZammadClient({
      token: 't',
      baseUrl: 'https://helpdesk.example.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await client.post('/tags/add', { item: 'vip', object: 'Ticket', o_id: 7 });

    expect(response.data).toBeNull();
    expect(response.status).toBe(204);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"item":"vip","object":"Ticket","o_id":7}');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('rejects unsafe credential transport URLs', () => {
    expect(() => new ZammadClient({ token: 't', baseUrl: 'http://helpdesk.example.com' })).toThrow(/Refusing/);
    expect(() => new ZammadClient({ token: 't', baseUrl: 'http://127.0.0.1:8080' })).not.toThrow();
  });

  it('throws a helpful error when credentials are missing', async () => {
    const client = new ZammadClient({ baseUrl: 'https://helpdesk.example.com' });
    await expect(client.get('/groups')).rejects.toThrow(/Missing Zammad credentials/);
  });

  it('formats and redacts API errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'Invalid token=super-secret' }, { status: 401 }),
    );
    const client = new ZammadClient({
      token: 'super-secret',
      baseUrl: 'https://helpdesk.example.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    let raised: ZammadHttpError | undefined;
    try {
      await client.get('/tickets/1');
    } catch (error) {
      raised = error as ZammadHttpError;
    }

    expect(raised).toBeInstanceOf(ZammadHttpError);
    expect(raised?.message).toContain('Zammad API request failed with HTTP 401');
    expect(formatUnknownError(raised)).not.toContain('super-secret');
    expect(redactSecrets('ZAMMAD_TOKEN=abc Authorization: Token token=xyz')).toContain('[REDACTED]');
    expect(redactSecrets('ZAMMAD_TOKEN=abc Authorization: Token token=xyz')).not.toContain('abc');
    expect(redactSecrets('ZAMMAD_TOKEN=abc Authorization: Token token=xyz')).not.toContain('xyz');
  });
});
