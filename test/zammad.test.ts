import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ZammadClient } from '../src/zammad/client.js';
import { createServer } from '../src/server.js';
import { checkToolPolicy } from '../src/zammad/policy.js';
import { createTicket, replyTicket, updateTicket } from '../src/zammad/tickets.js';
import { manageUser } from '../src/zammad/users.js';

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
});
