import { describe, expect, it } from 'vitest';
import { createZammadGateway, zammadGatewayTools, type GatewayToolResult } from '../src/gateway.js';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

function gatewayWithCapture(responses: Record<string, unknown> = {}) {
  const requests: CapturedRequest[] = [];
  const gateway = createZammadGateway({
    token: 'zammad-token',
    baseUrl: 'https://helpdesk.example.com',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname.replace('/api/v1', '');
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(responses[path] ?? { ok: true });
    },
  });
  return { gateway, requests };
}

function structured(result: GatewayToolResult): unknown {
  return result.structuredContent;
}

describe('Zammad gateway export', () => {
  it('exposes reads enabled-by-default and writes gated off', () => {
    const names = zammadGatewayTools.map(tool => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_ticket',
        'search_tickets',
        'list_articles',
        'get_ticket_tags',
        'kb_search',
        'kb_read',
        'add_internal_note',
        'add_tag',
        'remove_tag',
        'create_ticket',
      ]),
    );

    const reads = zammadGatewayTools.filter(tool => tool.riskLevel === 'read');
    const writes = zammadGatewayTools.filter(tool => tool.riskLevel === 'write');
    expect(reads.every(tool => tool.enabledByDefault)).toBe(true);
    expect(writes.every(tool => !tool.enabledByDefault)).toBe(true);
    expect(writes.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['add_internal_note', 'add_article', 'set_state', 'add_tag', 'remove_tag', 'create_ticket', 'update_ticket']),
    );
  });

  it('sends Token auth and expand=true on ticket reads', async () => {
    const { gateway, requests } = gatewayWithCapture({ '/tickets/42': { id: 42, title: 'Broken login' } });

    const result = await gateway.callTool('get_ticket', { id: 42 });

    expect(requests[0]?.authorization).toBe('Token token=zammad-token');
    expect(requests[0]?.url).toContain('/api/v1/tickets/42');
    expect(requests[0]?.url).toContain('expand=true');
    expect(structured(result)).toMatchObject({ id: 42, title: 'Broken login' });
  });

  it('posts a correct internal note payload', async () => {
    const { gateway, requests } = gatewayWithCapture();

    await gateway.callTool('add_internal_note', { ticket_id: 5, body: '<p>looking into it</p>' });

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toContain('/api/v1/ticket_articles');
    expect(requests[0]?.body).toEqual({
      ticket_id: 5,
      body: '<p>looking into it</p>',
      type: 'note',
      internal: true,
      sender: 'Agent',
      content_type: 'text/html',
    });
  });

  it('adds and removes ticket tags with the documented endpoints', async () => {
    const { gateway, requests } = gatewayWithCapture();

    await gateway.callTool('add_tag', { ticket_id: 9, tag: 'vip' });
    await gateway.callTool('remove_tag', { ticket_id: 9, tag: 'vip' });

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toContain('/api/v1/tags/add');
    expect(requests[0]?.body).toEqual({ item: 'vip', object: 'Ticket', o_id: 9 });

    expect(requests[1]?.method).toBe('DELETE');
    expect(requests[1]?.url).toContain('/api/v1/tags/remove');
    expect(requests[1]?.url).toContain('item=vip');
    expect(requests[1]?.url).toContain('object=Ticket');
    expect(requests[1]?.url).toContain('o_id=9');
  });

  it('returns an error result for unknown tools', async () => {
    const { gateway } = gatewayWithCapture();
    const result = await gateway.callTool('nope', {});
    expect(result.isError).toBe(true);
  });
});
