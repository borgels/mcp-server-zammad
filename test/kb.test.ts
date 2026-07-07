import { describe, expect, it, vi } from 'vitest';
import { ZammadClient } from '../src/zammad/client.js';
import { kbRead, kbSearch } from '../src/zammad/kb.js';

const initPayload = {
  KnowledgeBaseAnswer: [{ id: 10, category_id: 5, published_at: '2020-01-01' }],
  KnowledgeBaseAnswerTranslation: [{ id: 100, kb_answer_id: 10, title: 'How to reset your password', content_id: 1000 }],
  KnowledgeBaseAnswerTranslationContent: [{ id: 1000, body: '<p>Open settings and click reset.</p>' }],
  KnowledgeBaseCategory: [{ id: 5, knowledge_base_id: 2 }],
  KnowledgeBaseCategoryTranslation: [{ id: 50, category_id: 5, title: 'Accounts' }],
};

const searchPayload = {
  result: [{ type: 'KnowledgeBaseAnswer::Translation', id: 100 }],
  assets: {
    KnowledgeBaseAnswer: { '10': { id: 10, category_id: 5, published: true } },
    KnowledgeBaseAnswerTranslation: {
      '100': { id: 100, kb_answer_id: 10, title: 'How to reset your password', body: '<p>Open settings and click reset.</p>' },
    },
    KnowledgeBaseCategory: { '5': { id: 5, knowledge_base_id: 2 } },
    KnowledgeBaseCategoryTranslation: { '50': { id: 50, category_id: 5, title: 'Accounts' } },
  },
};

function client(handler: (method: string, path: string) => unknown) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace('/api/v1', '');
    calls.push({ method: request.method, path });
    return Response.json(handler(request.method, path) ?? { ok: true });
  });
  const instance = new ZammadClient({
    token: 't',
    baseUrl: 'https://helpdesk.example.com',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { instance, calls };
}

describe('knowledge base search ladder', () => {
  it('uses full-text search first and does not load the init graph', async () => {
    const { instance, calls } = client((method, path) => {
      if (path === '/search') return searchPayload;
      throw new Error(`unexpected call ${method} ${path}`);
    });

    const result = await kbSearch(instance, 'reset', 10);

    expect('records' in result).toBe(true);
    if ('records' in result) {
      expect(result.records[0]).toEqual({
        answer_id: 10,
        translation_id: 100,
        title: 'How to reset your password',
        category: 'Accounts',
        published: true,
        body_preview: 'Open settings and click reset.',
      });
    }
    expect(calls.map(call => call.path)).toEqual(['/search']);
  });

  it('falls back to knowledge_bases/init and substring-matches when full-text is empty', async () => {
    const { instance, calls } = client((method, path) => {
      if (path === '/search') return { result: [] };
      if (path === '/knowledge_bases/init') return initPayload;
      return { ok: true };
    });

    const result = await kbSearch(instance, 'password', 10);

    expect('records' in result).toBe(true);
    if ('records' in result) {
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        answer_id: 10,
        translation_id: 100,
        category: 'Accounts',
        published: true,
        body_preview: 'Open settings and click reset.',
      });
    }
    expect(calls.map(call => call.path)).toEqual(['/search', '/knowledge_bases/init']);
  });

  it('returns a structured empty result (not an error) when nothing matches', async () => {
    const { instance } = client((_method, path) => {
      if (path === '/search') return { result: [] };
      if (path === '/knowledge_bases/init') return initPayload;
      return { ok: true };
    });

    const result = await kbSearch(instance, 'no-such-topic', 10);

    expect('empty' in result).toBe(true);
    if ('empty' in result) {
      expect(result.empty.query).toBe('no-such-topic');
      expect(result.empty.message).toMatch(/No knowledge base answers matched/);
    }
  });

  it('derives kb_id and translation_id for kb_read from the init graph', async () => {
    const requested: string[] = [];
    const { instance } = client((method, path) => {
      requested.push(`${method} ${path}`);
      if (path === '/knowledge_bases/init') return initPayload;
      if (path === '/knowledge_bases/2/answers/10') return { id: 10, body: 'full answer body' };
      return { ok: true };
    });

    const result = (await kbRead(instance, { answerId: 10 })) as {
      kb_id: number;
      translation_id?: number;
      answer: unknown;
    };

    expect(result.kb_id).toBe(2);
    expect(result.translation_id).toBe(100);
    expect(result.answer).toMatchObject({ body: 'full answer body' });
    expect(requested).toContain('POST /knowledge_bases/init');
    expect(requested).toContain('GET /knowledge_bases/2/answers/10');
  });
});
