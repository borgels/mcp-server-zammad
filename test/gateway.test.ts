import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_REFUSED,
  createZammadGateway,
  GatewayConfigError,
  KEY_REFUSED,
  normalizeZammadBaseUrl,
  PRIVATE_ADDRESS_REFUSED,
  zammadGatewayTools,
  zammadToolCatalog,
  type GatewayJsonObject,
  type ZammadGatewayOptions,
} from '../src/gateway.js';
import { admitsKey } from '../src/key-admission.js';
import { callerPseudonym } from '../src/zammad/audit.js';

const TOKEN_A = 'qqqqwwwwzzzzxxxx1';
const TOKEN_B = 'jjjjkkkkvvvvyyyy2';
const BASE = 'https://helpdesk.example.com';
const PUBLIC_IP = '93.184.216.34'; // A public unicast test address, never contacted. hygiene:allow
const resolveHost = vi.fn(async () => [PUBLIC_IP]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zammad-gateway-'));
  vi.unstubAllEnvs();
  resolveHost.mockClear();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them all.
  vi.stubEnv('ZAMMAD_API_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('ZAMMAD_BASE_URL', 'https://env-base.example.org');
  vi.stubEnv('ZAMMAD_PROFILE', 'user');
  // Not a number: an instance that read it would throw.
  vi.stubEnv('ZAMMAD_TIMEOUT_MS', 'not-a-number');
  vi.stubEnv('ZAMMAD_DEFAULT_GROUP', 'EnvGroup');
  vi.stubEnv('ZAMMAD_AUDIT_LOG', join(dir, 'audit.log'));
  vi.stubEnv('ZAMMAD_TRUST_FORWARDED_USER', 'true');
  vi.stubEnv('ZAMMAD_ALLOW_TOKEN_USER', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The request's method and path. */
function requestOf(url: unknown, init: RequestInit | undefined): string {
  return `${init?.method ?? 'GET'} ${decodeURIComponent(new URL(String(url)).pathname)}`;
}

const DATA = { id: 7, title: 'Printer', customer_id: 5, email: 'kunde@example.com', login: 'agent@example.com' };

/** A Zammad that answers every request with `data`. */
function zammad(data: unknown = DATA) {
  return vi.fn<typeof fetch>(async () => jsonResponse(data));
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<ZammadGatewayOptions> = {}) {
  return createZammadGateway({ apiToken: TOKEN_A, baseUrl: BASE, fetchImpl, resolveHost, ...extra });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function matches(template: string, path: string): boolean {
  const pattern = template
    .split('/')
    .map(segment => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}$`).test(path);
}

/** A valid minimal input per gateway tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  check_connection: {},
  list_tickets: {},
  search_tickets: { query: 'state.name:open' },
  get_ticket: { ticketId: 7 },
  search_knowledge_base: { query: 'vpn' },
  list_users: {},
  list_organizations: {},
  list_reference_data: {},
  list_tags: { ticketId: 7 },
  create_ticket: { title: 'Printer virker ikke', body: 'Den blinker rødt.' },
  add_note: { ticketId: 7, body: 'Ringet til kunden.' },
  send_reply: { ticketId: 7, body: 'Det er løst nu.' },
  update_ticket: { ticketId: 7, state: 'closed' },
  add_tag: { ticketId: 7, tag: 'hardware' },
  remove_tag: { ticketId: 7, tag: 'hardware' },
  manage_user: { action: 'create', payload: { email: 'ny@example.com', firstname: 'Ny' } },
};

/** Further inputs that reach every declared request. */
const MORE_INPUTS: Array<[string, GatewayJsonObject]> = [
  ['list_tickets', { query: 'state.name:open' }],
  ['search_knowledge_base', { knowledgeBaseId: 1, answerId: 2, translationId: 3 }],
  ['list_users', { query: 'jensen' }],
  ['list_users', { userId: 5 }],
  ['list_organizations', { query: 'firma' }],
  ['list_organizations', { organizationId: 3 }],
  ['manage_user', { action: 'update', userId: 5, payload: { phone: '12345678' } }],
];

const WRITES = ['create_ticket', 'add_note', 'send_reply', 'update_ticket', 'add_tag', 'remove_tag', 'manage_user'];

/** The person a host names in actAs, and their user in the stand-in Zammad. */
const PERSON = 'mette.hansen@demobyg.example';
const PERSON_ID = 9;

/** A Zammad that finds `users` on a user search and answers every other request with DATA. */
function zammadWithUsers(users: unknown[] = [{ id: PERSON_ID, email: 'Mette.Hansen@Demobyg.example', active: true }]) {
  return vi.fn<typeof fetch>(async (url, init) =>
    requestOf(url, init) === 'GET /api/v1/users/search' ? jsonResponse(users) : jsonResponse(DATA),
  );
}

describe('Zammad gateway surface', () => {
  it('uses test credentials the gateway admits', () => {
    expect(admitsKey(TOKEN_A)).toBe(true);
    expect(admitsKey(TOKEN_B)).toBe(true);
  });

  it('has the agreed tool set: reads enabled by default, writes not, nothing broad, no deletion of records', () => {
    expect(zammadToolCatalog.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault, tool.broad])).toEqual([
      ['search_capabilities', 'read', true, false],
      ['check_connection', 'read', true, false],
      ['list_tickets', 'read', true, false],
      ['search_tickets', 'read', true, false],
      ['get_ticket', 'read', true, false],
      ['search_knowledge_base', 'read', true, false],
      ['list_users', 'read', true, false],
      ['list_organizations', 'read', true, false],
      ['list_reference_data', 'read', true, false],
      ['list_tags', 'read', true, false],
      ['create_ticket', 'write', false, false],
      ['add_note', 'write', false, false],
      ['send_reply', 'write', false, false],
      ['update_ticket', 'write', false, false],
      ['add_tag', 'write', false, false],
      ['remove_tag', 'write', false, false],
      ['manage_user', 'write', false, false],
    ]);
    expect(Object.keys(MINIMAL_INPUT).sort()).toEqual(zammadToolCatalog.map(tool => tool.name).sort());
    for (const tool of zammadToolCatalog) {
      expect(tool.name.startsWith('zammad_')).toBe(false);
      // The only DELETE is Zammad's tag removal, which takes a tag off a ticket and deletes no record.
      const deletes = tool.upstream.filter(operation => operation.method === 'DELETE').map(operation => operation.path);
      expect(deletes).toEqual(tool.name === 'remove_tag' ? ['/api/v1/tags/remove'] : []);
    }
  });

  it('has a deeply frozen catalog equal to the tool definitions, with strict input schemas', () => {
    expect(Object.isFrozen(zammadToolCatalog)).toBe(true);
    for (const entry of zammadToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const operation of entry.upstream) {
        expect(Object.isFrozen(operation)).toBe(true);
        expect(operation.path.startsWith('/api/v1/')).toBe(true);
      }
      expect(entry.inputSchema.type).toBe('object');
      expect(entry.inputSchema.additionalProperties).toBe(false);
      const { upstream: _upstream, broad: _broad, ...definition } = entry;
      expect(zammadGatewayTools.find(tool => tool.name === entry.name)).toEqual(definition);
    }
    expect(() => {
      (zammadToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('lists the input fields of each tool', () => {
    const fields = Object.fromEntries(
      zammadToolCatalog.map(tool => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)]),
    );
    expect(fields.send_reply).toEqual(['ticketId', 'body']);
    expect(fields.add_note).toEqual(['ticketId', 'body']);
    expect(fields.update_ticket).toEqual(['ticketId', 'title', 'state', 'pendingTime', 'ownerId', 'priorityId', 'group']);
    expect(fields.create_ticket).toEqual(['title', 'body', 'group', 'customer', 'priorityId', 'tags']);
    expect(zammadToolCatalog.find(tool => tool.name === 'send_reply')!.inputSchema.required).toEqual(['ticketId', 'body']);
    expect(zammadToolCatalog.find(tool => tool.name === 'send_reply')!.description).toMatch(/SENDS it as a real email/);
  });
});

describe('Zammad gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool, and reaches each of them', async () => {
    const reached = new Set<string>();
    for (const [name, input] of [...Object.entries(MINIMAL_INPUT), ...MORE_INPUTS]) {
      // A change is made as a person, which reaches the user search.
      const fetchImpl = zammadWithUsers();
      const context = WRITES.includes(name) ? { actAs: { email: PERSON } } : undefined;
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool(name, input, context);
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      const declared = zammadToolCatalog.find(tool => tool.name === name)!.upstream;
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(String(url).startsWith(`${BASE}/api/v1/`)).toBe(true);
        const [method, path] = requestOf(url, init).split(' ');
        const hit = declared.find(operation => operation.method === method && matches(operation.path, path!));
        expect(hit, `${name}: ${method} ${path}`).toBeDefined();
        reached.add(`${name} ${hit!.method} ${hit!.path}`);
      }
    }
    for (const tool of zammadToolCatalog) {
      for (const operation of tool.upstream) {
        expect(reached.has(`${tool.name} ${operation.method} ${operation.path}`), `${tool.name} ${operation.path}`).toBe(true);
      }
    }
  });

  it('adds a tag with POST and removes it with DELETE, the only method Zammad routes for /tags/remove', async () => {
    for (const [name, request] of [
      ['add_tag', 'POST /api/v1/tags/add'],
      ['remove_tag', 'DELETE /api/v1/tags/remove'],
    ] as const) {
      const fetchImpl = zammad({});
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool(name, { ticketId: 7, tag: 'hardware' });
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(requestOf(url, init)).toBe(request);
      expect(headersOf(init)['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ item: 'hardware', object: 'Ticket', o_id: 7 });
    }
  });

  it('adds an internal note the customer cannot see', async () => {
    const fetchImpl = zammad();
    await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', { ticketId: 7, body: 'Intern' });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ ticket_id: 7, body: 'Intern', type: 'note', content_type: 'text/plain', internal: true });
  });

  it('sends a reply as an email to the ticket customer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = requestOf(url, init);
      if (request === 'GET /api/v1/tickets/7') return jsonResponse({ id: 7, title: 'Printer', customer_id: 5 });
      if (request === 'GET /api/v1/users/5') return jsonResponse({ id: 5, email: 'kunde@example.com' });
      return jsonResponse({ id: 99 });
    });
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('send_reply', { ticketId: 7, body: 'Løst' });
    expect(result.isError).toBeUndefined();
    const [, init] = fetchImpl.mock.calls[2]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      ticket_id: 7,
      to: 'kunde@example.com',
      subject: 'Printer',
      body: 'Løst',
      type: 'email',
      sender: 'Agent',
      content_type: 'text/plain',
      internal: false,
    });
  });

  it('sends no reply when the customer has no email address', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      requestOf(url, init) === 'GET /api/v1/tickets/7' ? jsonResponse({ id: 7, customer_id: 5 }) : jsonResponse({ id: 5 }),
    );
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('send_reply', { ticketId: 7, body: 'Løst' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no email address; no email was sent/);
    expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).not.toContain('POST /api/v1/ticket_articles');
  });

  it('lists only what the instance offers in search_capabilities, without impersonation notes', async () => {
    const result = await gateway(zammad(), { policy: { disabledTools: ['send_reply'] } }).callTool('search_capabilities', { limit: 50 });
    const ids = (result.structuredContent as Array<{ id: string; safetyNotes: string[] }>).map(entry => entry.id);
    expect(ids).toContain('zammad_add_note');
    expect(ids).toContain('zammad_check_connection');
    expect(ids).not.toContain('zammad_send_reply');
    expect(ids).not.toContain('zammad_reply_ticket');
    expect(ids).not.toContain('zammad_manage_tags');
    expect(ids).not.toContain('zammad_download_attachment');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/From header/);
  });
});

describe('Zammad gateway connection settings', () => {
  it('uses only the token and address it was given, never ZAMMAD_*, and sends no From header without actAs', async () => {
    const fetchImpl = zammad();
    const g = createZammadGateway({
      apiToken: TOKEN_A,
      baseUrl: `${BASE}/`,
      fetchImpl,
      resolveHost,
      policy: { enableWrites: true },
      // Not gateway options: dropped.
      ...({ onBehalfOf: 'someone@example.com', credentialEnv: process.env } as object),
    } as ZammadGatewayOptions);
    for (const [name, input] of Object.entries(MINIMAL_INPUT)) await g.callTool(name, input);
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith(`${BASE}/api/v1/`)).toBe(true);
      const headers = headersOf(init);
      expect(headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('from');
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('x-on-behalf-of');
    }
    // create_ticket without a group goes to "Users", not ZAMMAD_DEFAULT_GROUP.
    const create = fetchImpl.mock.calls.find(([url, init]) => requestOf(url, init) === 'POST /api/v1/tickets')!;
    expect(JSON.parse(String(create[1]?.body)).group).toBe('Users');
    // The technician tool set, though ZAMMAD_PROFILE=user: customer and owner are accepted.
    const result = await g.callTool('update_ticket', { ticketId: 7, ownerId: 4, priorityId: 2 });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('requires the token and the address', () => {
    expect(() => createZammadGateway({ baseUrl: BASE } as ZammadGatewayOptions)).toThrow(/requires options.apiToken/);
    expect(() => createZammadGateway({ apiToken: TOKEN_A } as ZammadGatewayOptions)).toThrow(ADDRESS_REFUSED);
    expect(() => createZammadGateway(undefined as never)).toThrow(GatewayConfigError);
  });

  it('refuses a short token or one that shares text with our own texts, without quoting it', () => {
    for (const apiToken of ['short-token', 'Zammad API request failed with HTTP']) {
      let error: unknown;
      try {
        createZammadGateway({ apiToken, baseUrl: BASE });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message).toContain('options.apiToken');
      expect((error as Error).message).not.toContain(apiToken);
      expect((error as Error).stack).not.toMatch(/\n\s+at /);
    }
    expect(KEY_REFUSED).toMatch(/refused/);
  });

  it('normalises an accepted address', () => {
    expect(normalizeZammadBaseUrl('https://Firma.Zammad.com')).toBe('https://firma.zammad.com');
    expect(normalizeZammadBaseUrl(' https://helpdesk.example.com/ ')).toBe('https://helpdesk.example.com');
    expect(normalizeZammadBaseUrl('https://helpdesk.example.com.')).toBe('https://helpdesk.example.com');
    expect(normalizeZammadBaseUrl('https://xn--blbr-roa.example.com')).toBe('https://xn--blbr-roa.example.com');
  });

  it('refuses an address that is not https to a public host name, without quoting it', () => {
    const refused = [
      'http://helpdesk.example.com',
      'ftp://helpdesk.example.com',
      'https://user:pass@helpdesk.example.com',
      'https://user@helpdesk.example.com',
      'https://helpdesk.example.com/api/v1',
      'https://helpdesk.example.com/zammad',
      'https://helpdesk.example.com?x=1',
      'https://helpdesk.example.com/#frag',
      'https://helpdesk.example.com:8443',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://2130706433',
      'https://0x7f000001',
      'https://intranet',
      'https://zammad.local',
      'https://zammad.internal',
      'https://metadata.google.internal',
      'helpdesk.example.com',
      '',
      42,
    ];
    for (const value of refused) {
      let error: unknown;
      try {
        normalizeZammadBaseUrl(value);
      } catch (caught) {
        error = caught;
      }
      expect(error, String(value)).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message.startsWith(ADDRESS_REFUSED), String(value)).toBe(true);
      if (typeof value === 'string' && value) expect((error as Error).message).not.toContain(value);
      expect(() => createZammadGateway({ apiToken: TOKEN_A, baseUrl: value as string }), String(value)).toThrow(ADDRESS_REFUSED);
    }
  });

  it('refuses at the first call when the name points to a private address, before anything is sent', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::5', '100.64.0.1']) {
      const fetchImpl = zammad();
      const g = gateway(fetchImpl, { resolveHost: async () => [PUBLIC_IP, address] });
      const result = await g.callTool('check_connection', {});
      expect(result.isError, address).toBe(true);
      expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses a private address with the built-in fetch too, checked by the connection itself', async () => {
    const g = createZammadGateway({ apiToken: TOKEN_A, baseUrl: BASE, resolveHost: async () => ['127.0.0.1'] });
    const result = await g.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
  });

  it('words a name that does not resolve as a network error', async () => {
    const g = gateway(zammad(), {
      resolveHost: async () => {
        throw new Error('getaddrinfo ENOTFOUND helpdesk.example.com');
      },
    });
    const result = await g.callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Network error calling the Zammad API (GET) (ENOTFOUND).');
  });

  it('never follows a redirect, and does not quote the address or the Location', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/steal' } });
    });
    const result = await gateway(fetchImpl).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Zammad API responded with a redirect \(HTTP 302\) for GET; redirects are not followed/);
    expect(result.content[0]!.text).not.toContain('elsewhere');
    expect(result.content[0]!.text).not.toContain('helpdesk.example.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses 30 seconds as time limit, or the host’s, and words a timeout itself', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return jsonResponse({});
    });
    const result = await gateway(fetchImpl, { timeoutMs: 20 }).callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Zammad API request timed out after 20 ms (GET).');
  });
});

describe('Zammad gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = zammad();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const [name, input] of [
      ['get_ticket', {}],
      ['get_ticket', { ticketId: -1 }],
      ['get_ticket', { ticketId: 7, extra: true }],
      ['add_tag', { ticketId: 7 }],
      ['create_ticket', { title: 'Printer', body: 'Virker ikke', customer: 'not-an-email' }],
      ['send_reply', { ticketId: 7, body: 'x', to: 'someone@example.com' }],
      ['add_note', { ticketId: 7, body: 'x', internal: false }],
    ] as Array<[string, GatewayJsonObject]>) {
      const result = await g.callTool(name, input);
      expect(result.isError, `${name} ${JSON.stringify(input)}`).toBe(true);
      expect(result.content[0]!.text).toMatch(new RegExp(`^Invalid input for ${name}:`));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unknown tools and the MCP server tools outside the gateway, and accepts the prefix', async () => {
    const fetchImpl = zammad();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const name of ['whoami', 'reply_ticket', 'manage_tags', 'download_attachment', 'delete_ticket', 'zammad_whoami']) {
      const result = await g.callTool(name, {});
      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unsupported Zammad gateway tool.' }] });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await g.callTool('zammad_check_connection', {})).isError).toBeUndefined();
    expect((await g.callTool('CHECK_CONNECTION', {})).isError).toBeUndefined();
  });
});

describe('Zammad gateway policy', () => {
  it('without a host policy: reads allowed, no writes, no audit', async () => {
    const fetchImpl = zammad();
    const g = gateway(fetchImpl);
    expect(g.tools.map(tool => tool.name)).toEqual(zammadToolCatalog.map(tool => tool.name));
    expect((await g.callTool('list_tickets', {})).isError).toBeUndefined();
    fetchImpl.mockClear();
    for (const name of WRITES) {
      const result = await g.callTool(name, MINIMAL_INPUT[name]!);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toBe('writes are disabled. The embedding host has not enabled writes for this instance.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = zammad();
    const g = gateway(fetchImpl, { policy: { enableWrites: true, disabledTools: ['send_reply', 'zammad_list_users'] } });
    expect(g.tools.map(tool => tool.name)).not.toContain('send_reply');
    expect(g.tools.map(tool => tool.name)).not.toContain('list_users');
    const result = await g.callTool('send_reply', MINIMAL_INPUT.send_reply!);
    expect(result.content[0]!.text).toBe('tool is disabled on this instance by the embedding host: zammad_send_reply');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => gateway(fetchImpl, { policy: { disabledTools: ['reply_ticket'] } })).toThrow(
      'policy.disabledTools[0] is not a known gateway tool.',
    );
    expect(() => gateway(fetchImpl, { policy: { enableWrites: 'yes' as never } })).toThrow(/enableWrites/);
  });

  it('audits to the host’s sink only, with the caller as a pseudonym, and does not run a tool whose start record fails', async () => {
    const fetchImpl = zammad();
    const { records, audit } = sink();
    await gateway(fetchImpl, { policy: { enableWrites: true, audit } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
      caller: 'medarbejder@example.com',
      requestId: 'host-request-1',
    });
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]!.caller).toBe(callerPseudonym('medarbejder@example.com'));
    expect(JSON.stringify(records)).not.toContain('medarbejder@example.com');
    expect(JSON.stringify(records)).not.toContain('host-request-1');
    expect(records[0]).not.toHaveProperty('actingAs');
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);

    const refusing = vi.fn(async () => {
      throw new Error('sink down');
    });
    fetchImpl.mockClear();
    const result = await gateway(fetchImpl, { policy: { enableWrites: true, audit: refusing } }).callTool(
      'add_note',
      MINIMAL_INPUT.add_note!,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Zammad gateway results and errors', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const result = await gateway(zammad({ id: 7, title: 'Printer' })).callTool('get_ticket', { ticketId: 7, includeArticles: false });
    expect(result.structuredContent).toEqual({ id: 7, title: 'Printer' });
    expect(result.content).toEqual([{ type: 'text', text: `Zammad ticket.\n\n${JSON.stringify(result.structuredContent)}` }]);
  });

  it('starts an error with the HTTP status in our own text and never carries the Zammad body', async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'Zammad says: secret internal detail', error_human: 'Kunde Hansen findes ikke' }, status, {
          'retry-after': '30',
        }),
      );
      const result = await gateway(fetchImpl).callTool('get_ticket', { ticketId: 7 });
      const text = result.content[0]!.text;
      expect(result.isError).toBe(true);
      expect(text.startsWith(`Zammad API request failed with HTTP ${status}`)).toBe(true);
      expect(text).not.toMatch(/secret internal detail|Hansen|helpdesk\.example\.com/);
      expect(text).toContain('retry-after=30s');
    }
  });

  it('refuses an answer that is not JSON instead of passing it on', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>login page</html>', { status: 200 }));
    const result = await gateway(fetchImpl).callTool('list_tickets', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Zammad answered with something that is not JSON (GET); nothing of it is passed on.');
  });

  it('redacts the token from values, keys and numbers of a result', async () => {
    const echo = { note: `token ${TOKEN_A} here`, [TOKEN_A]: 1, piece: TOKEN_A.slice(2, 10), header: `Bearer ${TOKEN_A}` };
    const result = await gateway(zammad(echo)).callTool('get_ticket', { ticketId: 7, includeArticles: false });
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_A.slice(2, 8));
  });
});

describe('Zammad gateway tenants and call scopes', () => {
  it('keeps two tenants apart when they call at the same time, each with its own token, address and sink', async () => {
    const fetchA = vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse({ tenant: 'a' });
    });
    const fetchB = vi.fn<typeof fetch>(async () => jsonResponse({ tenant: 'b' }));
    const sinkA = sink();
    const sinkB = sink();
    const a = createZammadGateway({ apiToken: TOKEN_A, baseUrl: 'https://a.example.com', fetchImpl: fetchA, resolveHost, policy: { audit: sinkA.audit } });
    const b = createZammadGateway({ apiToken: TOKEN_B, baseUrl: 'https://b.example.com', fetchImpl: fetchB, resolveHost, policy: { audit: sinkB.audit, disabledTools: ['list_users'] } });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? a : b).callTool('list_tickets', {}, { caller: `user-${index % 2}` })),
    );
    results.forEach((result, index) => expect(result.structuredContent).toEqual({ tenant: index % 2 === 0 ? 'a' : 'b' }));
    for (const [url, init] of fetchA.mock.calls) {
      expect(String(url).startsWith('https://a.example.com/api/v1/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_A}`);
    }
    for (const [url, init] of fetchB.mock.calls) {
      expect(String(url).startsWith('https://b.example.com/api/v1/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_B}`);
    }
    expect(sinkA.records).toHaveLength(10);
    expect(sinkB.records).toHaveLength(10);
    expect(new Set(sinkA.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-0')]));
    expect(new Set(sinkB.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-1')]));
    expect((await a.callTool('list_users', {})).isError).toBeUndefined();
    expect((await b.callTool('list_users', {})).isError).toBe(true);
  });

  it('runs a call made from inside another instance’s sink under its own scope', async () => {
    const inner = gateway(zammad());
    let innerResult: unknown;
    const outer = gateway(zammad(), {
      policy: {
        enableWrites: true,
        audit: async record => {
          if (record.action === 'start') innerResult = await inner.callTool('add_note', MINIMAL_INPUT.add_note!);
        },
      },
    });
    expect((await outer.callTool('add_note', MINIMAL_INPUT.add_note!)).isError).toBeUndefined();
    // The inner instance has no writes: the outer policy did not leak into its call.
    expect((innerResult as { isError?: boolean }).isError).toBe(true);
  });

  it('keeps no process-wide registry: an instance’s token is not redacted outside its calls', async () => {
    gateway(zammad());
    const { redactSecrets } = await import('../src/errors.js');
    expect(redactSecrets(`x ${TOKEN_A} y`)).toBe(`x ${TOKEN_A} y`);
  });
});

describe('Zammad gateway acting as a person (actAs)', () => {
  const writes = () => gateway;

  it('finds the person as the token user, then sends the change with From: their id', async () => {
    for (const name of WRITES) {
      const fetchImpl = zammadWithUsers();
      const result = await writes()(fetchImpl, { policy: { enableWrites: true } }).callTool(name, MINIMAL_INPUT[name]!, {
        caller: 'p1',
        actAs: { email: ` ${PERSON.toUpperCase()} ` },
      });
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      const calls = fetchImpl.mock.calls;
      expect(requestOf(calls[0]![0], calls[0]![1]), name).toBe('GET /api/v1/users/search');
      expect(new URL(String(calls[0]![0])).searchParams.get('query')).toBe(PERSON);
      expect(headersOf(calls[0]![1]).From, `${name}: the lookup runs as the token user`).toBeUndefined();
      for (const [url, init] of calls.slice(1)) {
        expect(headersOf(init).From, `${name}: ${requestOf(url, init)}`).toBe(String(PERSON_ID));
      }
      expect(calls.length, name).toBeGreaterThan(1);
    }
  });

  it('sends nothing when the person has no single active user with that email', async () => {
    const cases: unknown[][] = [
      [],
      [{ id: 9, email: 'mette.hansen@demobyg.example.other', active: true }],
      [{ id: 9, email: PERSON, active: false }],
      [
        { id: 9, email: PERSON, active: true },
        { id: 10, email: PERSON, active: true },
      ],
      [{ id: 'nine', email: PERSON, active: true }],
    ];
    for (const users of cases) {
      const fetchImpl = zammadWithUsers(users);
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('send_reply', MINIMAL_INPUT.send_reply!, {
        actAs: { email: PERSON },
      });
      expect(result, JSON.stringify(users)).toMatchObject({ isError: true, actAsRefused: 'no_user' });
      expect(JSON.stringify(result)).not.toContain(PERSON);
      expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).toEqual(['GET /api/v1/users/search']);
    }
  });

  it('says not_permitted when Zammad refuses the From header, and does not call it a refused token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      requestOf(url, init) === 'GET /api/v1/users/search'
        ? jsonResponse([{ id: PERSON_ID, email: PERSON, active: true }])
        : jsonResponse({ error: 'Current user has no permission to use From' }, 401),
    );
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
      actAs: { email: PERSON },
    });
    expect(result).toMatchObject({ isError: true, actAsRefused: 'not_permitted' });
    expect(result.failure).toBeUndefined();
  });

  it('keeps a 401 to the lookup itself as a refused token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, 401));
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
      actAs: { email: PERSON },
    });
    expect(result.isError).toBe(true);
    expect(result.actAsRefused).toBeUndefined();
    expect(result.failure?.httpStatus).toBe(401);
  });

  it('runs reads as the token user, without a lookup', async () => {
    const fetchImpl = zammadWithUsers();
    const result = await gateway(fetchImpl).callTool('get_ticket', { ticketId: 7 }, { actAs: { email: PERSON } });
    expect(result.isError).toBeUndefined();
    expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).not.toContain('GET /api/v1/users/search');
    for (const [, init] of fetchImpl.mock.calls) expect(headersOf(init).From).toBeUndefined();
  });

  it('runs a change as the token user when the host names no person', async () => {
    const fetchImpl = zammadWithUsers();
    await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!);
    expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).toEqual(['POST /api/v1/ticket_articles']);
    expect(headersOf(fetchImpl.mock.calls[0]![1]).From).toBeUndefined();
  });

  it('refuses a malformed person before anything is sent', async () => {
    for (const actAs of [null, { email: 'not an email' }, { email: 7 }, { email: 'a\u0000b@demobyg.example' }, 'mette@demobyg.example', { email: PERSON, name: '' }, { email: 'a..b@demobyg.example' }, { email: '.a@demobyg.example' }, { email: 'a.@demobyg.example' }, { email: `${'a'.repeat(65)}@demobyg.example` }]) {
      const fetchImpl = zammadWithUsers();
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
        actAs: actAs as never,
      });
      expect(result, JSON.stringify(actAs)).toMatchObject({ isError: true, actAsRefused: 'invalid' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('keeps dotted addresses that are valid', async () => {
    const fetchImpl = zammadWithUsers();
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
      actAs: { email: 'mette.k.hansen@demobyg.example' },
    });
    expect(result.actAsRefused).not.toBe('invalid');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('sends the refusal of a malformed person through the sink check like every other result', async () => {
    // A token the admission allows that shares a piece of 6 characters with the result's field name actAsRefused.
    const token = 'qqqactAsRwwwzzzz1';
    const fetchImpl = zammadWithUsers();
    const gw = createZammadGateway({ apiToken: token, baseUrl: BASE, fetchImpl, resolveHost, policy: { enableWrites: true } });
    const result = await gw.callTool('add_note', MINIMAL_INPUT.add_note!, { actAs: null as never });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const text = JSON.stringify(result);
    for (let i = 0; i + 6 <= token.length; i += 1) expect(text, token.slice(i, i + 6)).not.toContain(token.slice(i, i + 6));
  });

  it('never writes the email to the audit', async () => {
    const { records, audit } = sink();
    const gw = gateway(zammadWithUsers(), { policy: { enableWrites: true, audit } });
    await gw.callTool('add_note', MINIMAL_INPUT.add_note!, { caller: 'p1', actAs: { email: PERSON } });
    await gw.callTool('add_note', MINIMAL_INPUT.add_note!, { caller: 'p1', actAs: { email: 'nobody@demobyg.example' } });
    expect(records.length).toBeGreaterThan(0);
    const text = JSON.stringify(records).toLowerCase();
    expect(text).not.toContain(PERSON);
    expect(text).not.toContain('nobody@demobyg.example');
  });

  it('refuses when the lookup may have been cut short, so a second user with the email cannot hide on a later page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, email: i === 0 ? PERSON : `andre${i}@demobyg.example`, active: true }));
    const fetchImpl = zammadWithUsers(full);
    const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool('add_note', MINIMAL_INPUT.add_note!, {
      actAs: { email: PERSON },
    });
    expect(result).toMatchObject({ isError: true, actAsRefused: 'no_user' });
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('limit')).toBe('100');
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it('keeps each call to its own person when calls run at the same time', async () => {
    const people: Record<string, number> = { 'a@demobyg.example': 31, 'b@demobyg.example': 32 };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (requestOf(url, init) === 'GET /api/v1/users/search') {
        const query = new URL(String(url)).searchParams.get('query')!;
        await new Promise(resolve => setTimeout(resolve, query.startsWith('a') ? 20 : 1));
        return jsonResponse([{ id: people[query], email: query, active: true }]);
      }
      return jsonResponse(DATA);
    });
    const gw = gateway(fetchImpl, { policy: { enableWrites: true } });
    await Promise.all([
      gw.callTool('add_note', { ticketId: 1, body: 'a' }, { actAs: { email: 'a@demobyg.example' } }),
      gw.callTool('add_note', { ticketId: 2, body: 'b' }, { actAs: { email: 'b@demobyg.example' } }),
      gw.callTool('add_note', { ticketId: 3, body: 'c' }),
    ]);
    const posts = fetchImpl.mock.calls
      .filter(([url, init]) => requestOf(url, init) === 'POST /api/v1/ticket_articles')
      .map(([, init]) => [JSON.parse(String(init!.body)).ticket_id, headersOf(init).From ?? null]);
    expect(posts.sort()).toEqual([[1, '31'], [2, '32'], [3, null]]);
  });

  it('keeps the read-only view from deleting', async () => {
    const fetchImpl = zammadWithUsers();
    const result = await gateway(fetchImpl).callTool('list_tags', { ticketId: 7 }, { actAs: { email: PERSON } });
    expect(result.isError).toBeUndefined();
    for (const [url, init] of fetchImpl.mock.calls) expect(requestOf(url, init).startsWith('GET ')).toBe(true);
  });
});
