import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ZammadClient } from '../src/zammad/client.js';
import { createServer } from '../src/server.js';
import { checkToolPolicy } from '../src/zammad/policy.js';
import { createTicket, replyTicket, updateTicket } from '../src/zammad/tickets.js';
import { listUsers, manageUser } from '../src/zammad/users.js';
import { pathSegment } from '../src/zammad/path.js';
import type { IncomingMessage } from 'node:http';
import {
  assertAuthorized,
  assertSafeHttpStartup,
  HttpRequestError,
  resolveHttpIdentity,
  tokensMatch,
} from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function makeClient(record: Recorded[], onBehalfOf?: string): ZammadClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    record.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return new ZammadClient({
    apiToken: 'tok',
    baseUrl: 'https://helpdesk.example.com',
    onBehalfOf,
    fetchImpl,
  });
}

describe('identity plumbing', () => {
  it('sends Bearer auth and the From header when acting on behalf of a user', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record, 'customer@example.com');
    await client.get('/tickets');

    expect(record[0]?.headers.Authorization).toBe('Bearer tok');
    expect(record[0]?.headers.From).toBe('customer@example.com');
  });

  it('omits the From header when acting as the token user', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record);
    await client.get('/tickets');
    expect(record[0]?.headers.From).toBeUndefined();
  });
});

describe('profiles', () => {
  it('user profile exposes only self-service tools; technician gets the full set', async () => {
    process.env.ZAMMAD_PROFILE = 'user';
    const userServer = createServer({ client: makeClient([]) });
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const c1 = new Client({ name: 't', version: '0' });
    await Promise.all([userServer.connect(st1), c1.connect(ct1)]);
    const userTools = (await c1.listTools()).tools.map(t => t.name);

    expect(userTools).toContain('zammad_create_ticket');
    expect(userTools).toContain('zammad_search_knowledge_base');
    expect(userTools).not.toContain('zammad_search_tickets');
    expect(userTools).not.toContain('zammad_manage_user');

    process.env.ZAMMAD_PROFILE = 'technician';
    const techServer = createServer({ client: makeClient([]) });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: 't', version: '0' });
    await Promise.all([techServer.connect(st2), c2.connect(ct2)]);
    const techTools = (await c2.listTools()).tools.map(t => t.name);

    expect(techTools).toContain('zammad_search_tickets');
    expect(techTools).toContain('zammad_manage_user');
    expect(techTools.length).toBeGreaterThan(userTools.length);
  });

  it('policy denies technician tools in user profile', () => {
    process.env.ZAMMAD_PROFILE = 'user';
    expect(checkToolPolicy('zammad_list_tickets').allowed).toBe(true);
    expect(checkToolPolicy('zammad_search_tickets')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('zammad_delete_ticket')).toMatchObject({ allowed: false });
  });
});

describe('guardrails', () => {
  it('user profile cannot create for another customer, add internal notes, or triage', async () => {
    process.env.ZAMMAD_PROFILE = 'user';
    const client = makeClient([]);

    await expect(
      createTicket(client, { title: 'Test sag', body: 'x', customer: 'other@example.com' }),
    ).rejects.toThrow('technician');
    await expect(replyTicket(client, { ticketId: 1, body: 'x', internal: true })).rejects.toThrow('technician');
    await expect(updateTicket(client, { ticketId: 1, ownerId: 4 })).rejects.toThrow('technician');
  });

  it('user replies are public web articles; technician defaults to note', async () => {
    process.env.ZAMMAD_PROFILE = 'user';
    const record: Recorded[] = [];
    await replyTicket(makeClient(record), { ticketId: 1, body: 'hej' });
    expect(record[0]?.body).toMatchObject({ type: 'web', internal: false });

    process.env.ZAMMAD_PROFILE = 'technician';
    const record2: Recorded[] = [];
    await replyTicket(makeClient(record2), { ticketId: 1, body: 'note', internal: true });
    expect(record2[0]?.body).toMatchObject({ type: 'note', internal: true });
  });

  it('technician create-for-customer uses the guess: auto-create syntax', async () => {
    process.env.ZAMMAD_PROFILE = 'technician';
    const record: Recorded[] = [];
    await createTicket(makeClient(record), { title: 'Ny sag', body: 'x', customer: 'new.customer@example.com' });
    expect(record[0]?.body).toMatchObject({ customer_id: 'guess:new.customer@example.com' });
  });

  it('manage_user refuses role/password/group changes', async () => {
    process.env.ZAMMAD_PROFILE = 'technician';
    const client = makeClient([]);
    await expect(
      manageUser(client, { action: 'create', payload: { email: 'x@y.dk', role_ids: [1] } }),
    ).rejects.toThrow('admin UI');
  });

  it('manage_user refuses unknown fields (allowlist, not denylist)', async () => {
    await expect(
      manageUser(makeClient([]), { action: 'create', payload: { email: 'x@y.dk', somethingNew: true } }),
    ).rejects.toThrow(/Refusing to set somethingNew/);
  });
});

describe('manage_user allowlist', () => {
  it.each([
    'role_ids',
    'roles',
    'group_ids',
    'groups',
    'group_names_access_map',
    'organization_ids',
    'organizations',
    'password',
    'permissions',
    'login',
    'active',
  ])('refuses %s', async key => {
    const record: Recorded[] = [];
    await expect(
      manageUser(makeClient(record), { action: 'create', payload: { email: 'x@example.com', [key]: 1 } }),
    ).rejects.toThrow(/Refusing to set/);
    expect(record).toHaveLength(0);
  });

  it('refuses changing email on update but allows safe profile fields', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record);
    await expect(
      manageUser(client, { action: 'update', userId: 5, payload: { email: 'other@example.com' } }),
    ).rejects.toThrow(/Refusing to set email/);
    await manageUser(client, {
      action: 'update',
      userId: 5,
      payload: { firstname: 'A', phone: '123', organization: 'Example' },
    });
    expect(record).toHaveLength(1);
    expect(record[0]?.url).toBe('https://helpdesk.example.com/api/v1/users/5');
    expect(record[0]?.body).toEqual({ firstname: 'A', phone: '123', organization: 'Example' });
  });
});

describe('fail-closed identity', () => {
  function req(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it('rejects HTTP requests without X-MCP-User when the trust flag is on', () => {
    process.env.ZAMMAD_TRUST_FORWARDED_USER = 'true';
    expect(() => resolveHttpIdentity(req({}))).toThrow(HttpRequestError);
    expect(() => resolveHttpIdentity(req({ 'x-mcp-user': '   ' }))).toThrow(/X-MCP-User/);
    expect(() => resolveHttpIdentity(req({ 'x-mcp-user': 'a b@example.com' }))).toThrow(/Invalid/);
    expect(resolveHttpIdentity(req({ 'x-mcp-user': 'u@example.com' }))).toEqual({ onBehalfOf: 'u@example.com' });
  });

  it('still requires the header when the trust flag is on even if token-user mode is allowed', () => {
    process.env.ZAMMAD_TRUST_FORWARDED_USER = 'true';
    process.env.ZAMMAD_ALLOW_TOKEN_USER = 'true';
    expect(() => resolveHttpIdentity(req({}))).toThrow(/X-MCP-User/);
  });

  it.each(['user', 'technician'])('rejects untrusted HTTP requests in the %s profile by default', p => {
    process.env.ZAMMAD_PROFILE = p;
    delete process.env.ZAMMAD_TRUST_FORWARDED_USER;
    delete process.env.ZAMMAD_ALLOW_TOKEN_USER;
    // A header without the trust flag must not be honored, nor fall back to the token user.
    expect(() => resolveHttpIdentity(req({ 'x-mcp-user': 'u@example.com' }))).toThrow(HttpRequestError);
    expect(() => resolveHttpIdentity(req({}))).toThrow(/ZAMMAD_ALLOW_TOKEN_USER/);
  });

  it('falls back to the token user only with explicit ZAMMAD_ALLOW_TOKEN_USER=true', () => {
    delete process.env.ZAMMAD_TRUST_FORWARDED_USER;
    process.env.ZAMMAD_ALLOW_TOKEN_USER = 'true';
    expect(resolveHttpIdentity(req({ 'x-mcp-user': 'u@example.com' }))).toEqual({ onBehalfOf: undefined });
  });

  it('createServer refuses to bind the token user when an identity is required', () => {
    expect(() => createServer({ client: makeClient([]), requireOnBehalfOf: true })).toThrow(/identity is required/);
    expect(() => createServer({ client: makeClient([]), requireOnBehalfOf: true, onBehalfOf: ' ' })).toThrow();
    expect(() =>
      createServer({ client: makeClient([]), requireOnBehalfOf: true, onBehalfOf: 'u@example.com' }),
    ).not.toThrow();
    // stdio keeps the token-user fallback.
    expect(() => createServer({ client: makeClient([]) })).not.toThrow();
  });
});

describe('http hardening', () => {
  it('compares the bearer token in constant time and rejects mismatches', () => {
    expect(tokensMatch('Bearer s3cret', 'Bearer s3cret')).toBe(true);
    expect(tokensMatch('Bearer s3cre', 'Bearer s3cret')).toBe(false);
    expect(tokensMatch(undefined, 'Bearer s3cret')).toBe(false);
    const config = { host: '127.0.0.1', port: 0, maxBodyBytes: 1, httpToken: 's3cret' };
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer nope' } } as unknown as IncomingMessage, config))
      .toThrow(HttpRequestError);
    expect(() =>
      assertAuthorized({ headers: { authorization: 'Bearer s3cret' } } as unknown as IncomingMessage, config),
    ).not.toThrow();
  });

  it('refuses to start when the trust flag is on without MCP_HTTP_TOKEN', () => {
    process.env.ZAMMAD_TRUST_FORWARDED_USER = 'true';
    expect(() => assertSafeHttpStartup({ host: 'h', port: 0, maxBodyBytes: 1 })).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => assertSafeHttpStartup({ host: 'h', port: 0, maxBodyBytes: 1, httpToken: 't' })).not.toThrow();
    delete process.env.ZAMMAD_TRUST_FORWARDED_USER;
    expect(() => assertSafeHttpStartup({ host: 'h', port: 0, maxBodyBytes: 1 })).not.toThrow();
  });
});

describe('path parameter guard', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', '%2F', '..%2f'])('rejects %j', value => {
    expect(() => pathSegment(value)).toThrow(/Invalid path parameter/);
  });

  it('accepts and encodes ordinary values', () => {
    expect(pathSegment(42)).toBe('42');
    expect(pathSegment('a b')).toBe('a%20b');
  });

  it('is applied to user lookups', async () => {
    const record: Recorded[] = [];
    await expect(listUsers(makeClient(record), { userId: '..' as unknown as number })).rejects.toThrow(
      /Invalid path parameter/,
    );
    expect(record).toHaveLength(0);
  });
});
