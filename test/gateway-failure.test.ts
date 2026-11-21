// Failure metadata on gateway error results: Zammad's HTTP status and its request id (a UUID or hex id only), for a
// host that counts failures without reading their text. Never the body, Zammad's code or message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureMetadata, requestIdFrom, vendorRequestId, ZammadHttpError } from '../src/errors.js';
import { createZammadGateway } from '../src/gateway.js';
import { ZammadClient } from '../src/zammad/client.js';

const BASE = 'https://helpdesk.example.com';
const TOKEN = 'qqqqwwwwzzzzxxxx1';
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const resolveHost = async () => ['93.184.216.34']; // A public unicast test address, never contacted. hygiene:allow
const VENDOR_BODY = { error: 'Ticket of Jane Doe not found', error_human: 'E_NOPE' };

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = VENDOR_BODY, apiToken = TOKEN) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch;
  return createZammadGateway({ apiToken, baseUrl: BASE, fetchImpl, resolveHost });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    const url = `${BASE}/api/v1/tickets/7`;
    expect(failureMetadata(new ZammadHttpError({ status: 404, method: 'GET', url, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new ZammadHttpError({ status: 500, method: 'GET', url, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-request-id': UUID }).callTool('get_ticket', { ticketId: 7 });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(422, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool('get_ticket', {
      ticketId: 7,
    });
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the token', async () => {
    // The token's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-request-id': 'deadbeef00112233' }, {}, 'deadbeef00112233-token-0').callTool(
      'get_ticket',
      { ticketId: 7 },
    );
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not Zammad', async () => {
    const gw = gatewayAnswering(200, {});
    expect((await gw.callTool('get_ticket', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createZammadGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      resolveHost,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect((await offline.callTool('get_ticket', { ticketId: 7 })).failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-request-id': UUID }, { id: 7, title: 'Printer' }).callTool('get_ticket', {
      ticketId: 7,
      includeArticles: false,
    });
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});

describe('the client', () => {
  it('keeps the request id on an HTTP error of an attachment download', async () => {
    const fetchImpl = (async () =>
      new Response('Jane Doe', { status: 403, headers: { 'x-request-id': UUID } })) as typeof fetch;
    const client = new ZammadClient({ apiToken: TOKEN, baseUrl: BASE, fetchImpl });
    const error = await client.getBinary('/ticket_attachment/1/2/3', 1024).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZammadHttpError);
    expect(failureMetadata(error)).toEqual({ httpStatus: 403, requestId: UUID });
  });
});
