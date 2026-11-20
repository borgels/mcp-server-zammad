// The sink check (README, "Embedding"): nothing that leaves a gateway holds a piece of 6 characters of the access
// token. Every output is checked in its final form; known counterexamples and tokens spliced from real outputs.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZammadGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';

const BASE = 'https://helpdesk.example.com';
const TOKEN = 'qqqqwwwwzzzzxxxx1';
const resolveHost = async () => ['93.184.216.34'];
let dir: string;

beforeEach(() => {
  vi.unstubAllEnvs();
  dir = mkdtempSync(join(tmpdir(), 'zammad-sink-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A Zammad that answers the gateway's reads, echoing `echo` (the token, typically) in its data. */
function zammad(echo: string): typeof fetch {
  return async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/users/me') return json({ id: 1, login: 'agent@example.com', note: `seen ${echo}` });
    if (path === '/api/v1/tickets') return json([{ id: 7, title: `Ticket ${echo}`, [echo]: echo, nested: { token: echo } }]);
    if (path === '/api/v1/tickets/7') return json({ id: 7, title: `Bearer ${echo}` });
    return json({ error: `not found ${echo}` }, 404);
  };
}

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(secrets: readonly string[], outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return secrets.flatMap(pieces).filter(piece => texts.some(text => text.includes(piece)));
}

/** Every output of a normal session with `value` as the token, or the refusal when it is not admitted. */
async function outputs(value: string, viaFile = false): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  // Set as a shared process would have it: the gateway reads no ZAMMAD_AUDIT_LOG, so nothing may land there either.
  if (viaFile) vi.stubEnv('ZAMMAD_AUDIT_LOG', auditPath);
  let gw: ReturnType<typeof createZammadGateway>;
  try {
    gw = createZammadGateway({
      apiToken: value,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: zammad(value),
      resolveHost,
      policy: { enableWrites: true, ...(viaFile ? {} : { audit: (record: Record<string, unknown>) => void records.push(record) }) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name, error] };
  }
  const results = [
    await gw.callTool('check_connection', {}, { caller: `person ${value}`, requestId: value }),
    await gw.callTool('list_tickets', {}),
    await gw.callTool('get_ticket', { ticketId: 7, includeArticles: false }),
    await gw.callTool('get_ticket', { ticketId: 8 }),
    await gw.callTool('search_capabilities', { query: 'ticket' }),
    await gw.callTool(value, {}),
    await gw.callTool('add_note', { ticketId: 7, body: value }),
    await gw.callTool('check_connection', { unknown: value }),
  ];
  const lines = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
  return { outputs: [gw.tools, ...results, ...records, lines] };
}

describe('the sink check', () => {
  it('holds for known counterexamples, through the sink and the file', async () => {
    for (const value of [
      TOKEN,
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'URI malformedQz7pX2vK9mWb\uD800',
      'Qz7pX2vK9"title":"Ticket',
      'Qz7pX2vK9mWb"id":7,"tit',
    ]) {
      for (const viaFile of [false, true]) {
        const { refused, outputs: seen } = await outputs(value, viaFile);
        if (refused !== undefined) expect(refused, value).toMatch(/credential was refused/);
        expect(leaked([value], seen), `${value} ${viaFile}`).toEqual([]);
      }
    }
  });

  it('holds for tokens spliced from the outputs of a normal session', async () => {
    const base = await outputs(TOKEN);
    expect(base.refused).toBeUndefined();
    const texts = base.outputs
      .flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)))
      .filter(text => text.length >= 6);
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 40; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const value = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(value, round % 2 === 0);
      if (refused === undefined) admitted += 1;
      expect(leaked([value], seen), value).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });

  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiToken, baseUrl] of [
      ['Qz7way.jsV8k2mP9X', 'http://invalid'],
      ['short', BASE],
      [TOKEN, 'https://127.0.0.1'],
      [TOKEN, `https://${TOKEN}@helpdesk.example.com`],
    ] as const) {
      let caught: Error | undefined;
      try {
        createZammadGateway({ apiToken, baseUrl, policy: {} });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiToken).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked([apiToken], [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });
});

describe('credentials the upstream echoes, which are not the instance’s own', () => {
  it('are masked in structuredContent and in the text block, whole for credential-named fields', async () => {
    const other = 'ZZotherSESSIONvalue123';
    const fetchImpl: typeof fetch = async () =>
      json({
        id: 7,
        text: `Authorization: Bearer ${other}`,
        token: { nested: other },
        password: 12345,
        note: `api_token=${other}`,
        legacy: `Token token=${other}`,
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      });
    const gw = createZammadGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl, resolveHost });
    const result = await gw.callTool('get_ticket', { ticketId: 7, includeArticles: false });
    expect(result.isError).toBeUndefined();
    const all = JSON.stringify(result);
    expect(all).not.toContain(other);
    expect(all).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result.structuredContent).toMatchObject({ id: 7, token: '‹redacted›', password: '‹redacted›' });
  });
});

describe('the audit records a tool failure by its code', () => {
  async function codes(fetchImpl: typeof fetch, timeoutMs = 5_000): Promise<unknown[]> {
    const records: Array<Record<string, unknown>> = [];
    const gw = createZammadGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl,
      resolveHost,
      timeoutMs,
      policy: { audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('list_tickets', {});
    return records.filter(record => record.action === 'error').map(record => record.error);
  }

  it('writes http_<status>, timeout or error, never the message', async () => {
    expect(await codes(async () => json({ error: 'busy' }, 429))).toEqual(['http_429']);
    expect(await codes(async () => json({ error: 'boom' }, 500))).toEqual(['http_500']);
    expect(
      await codes(
        (_url, init) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
        20,
      ),
    ).toEqual(['timeout']);
    expect(
      await codes(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
      }),
    ).toEqual(['error']);
  });

  it('writes no caller, request id or unknown tool name of the host to the audit', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createZammadGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: async () => json([]),
      resolveHost,
      policy: { audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('steal_everything_please', {}, { caller: 'mette@example.com', requestId: 'req-from-host-1' });
    await gw.callTool('list_tickets', {}, { caller: 'mette@example.com', requestId: 'req-from-host-1' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/mette@example\.com|req-from-host-1|steal_everything/);
    expect(records[0]).toMatchObject({ tool: 'unknown_tool', action: 'rejected' });
  });
});
