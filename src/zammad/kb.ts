import type { ZammadClient } from './client.js';

/**
 * Knowledge-base access. The practical search route is Zammad's global
 * Elasticsearch endpoint scoped to answer translations; it searches in the
 * acting user's locale and respects visibility (internal answers require
 * knowledge_base.reader — enforced by Zammad via impersonation).
 * Answer bodies live on translations and must be requested explicitly
 * with include_contents=<translation_id>.
 */
export interface SearchKnowledgeBaseInput {
  query?: string;
  limit?: number;
  /** Fetch the full body of one answer instead of searching. */
  knowledgeBaseId?: number;
  answerId?: number;
  translationId?: number;
}

interface AnswerAssetGraph {
  assets?: {
    KnowledgeBaseAnswer?: Record<string, { translation_ids?: number[] }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function searchKnowledgeBase(client: ZammadClient, input: SearchKnowledgeBaseInput): Promise<unknown> {
  if (input.answerId) {
    if (!input.knowledgeBaseId) {
      throw new Error('knowledgeBaseId is required when fetching an answer.');
    }
    const path = `/knowledge_bases/${input.knowledgeBaseId}/answers/${input.answerId}`;

    let translationId = input.translationId;
    if (!translationId) {
      // The body lives on a translation; discover its id from the asset graph.
      const graph = await client.get<AnswerAssetGraph>(path);
      const answer = graph.assets?.KnowledgeBaseAnswer?.[String(input.answerId)];
      translationId = answer?.translation_ids?.[0];
      if (!translationId) {
        return graph;
      }
    }
    return client.get(path, { include_contents: translationId });
  }

  if (!input.query?.trim()) {
    throw new Error('Provide a query to search, or knowledgeBaseId + answerId to fetch an answer.');
  }

  return client.get('/search', {
    query: input.query,
    objects: 'KnowledgeBaseAnswerTranslation',
    limit: Math.min(input.limit ?? 10, 50),
  });
}
