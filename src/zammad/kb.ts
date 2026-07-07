import type { ZammadClient } from './client.js';

export interface KbSearchRecord {
  answer_id: number;
  translation_id?: number;
  title: string;
  category?: string;
  published?: boolean;
  body_preview: string;
}

export interface KbEmptyResult {
  message: string;
  query: string;
}

export type KbSearchResult = { records: KbSearchRecord[] } | { empty: KbEmptyResult };

interface KbAnswer {
  answerId: number;
  categoryId?: number;
  published: boolean;
}

interface KbTranslation {
  translationId: number;
  answerId: number;
  title: string;
  body: string;
}

interface KbCategory {
  categoryId: number;
  kbId?: number;
  title?: string;
}

interface KbGraph {
  answers: Map<number, KbAnswer>;
  translations: KbTranslation[];
  translationsByAnswer: Map<number, KbTranslation[]>;
  categories: Map<number, KbCategory>;
}

interface CachedGraph {
  graph: KbGraph;
  expiresAt: number;
}

const GRAPH_TTL_MS = 60_000;
const graphCache = new WeakMap<ZammadClient, CachedGraph>();

/**
 * Search the Zammad Knowledge Base using a fallback ladder:
 *   1. Global full-text search (requires Elasticsearch on the Zammad host).
 *   2. If that yields nothing or is unavailable, load the `knowledge_bases/init`
 *      graph and substring-match titles/bodies client-side.
 * Returns a structured empty result (not an error) when nothing matches.
 */
export async function kbSearch(client: ZammadClient, query: string, limit: number): Promise<KbSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { empty: { message: 'Provide a non-empty query to search the knowledge base.', query } };
  }

  const fromFullText = await tryFullTextSearch(client, trimmed, limit);
  if (fromFullText && fromFullText.length > 0) {
    return { records: fromFullText.slice(0, limit) };
  }

  const graph = await loadGraph(client);
  const matches = filterGraph(graph, trimmed).slice(0, limit);
  if (matches.length === 0) {
    return {
      empty: {
        message:
          'No knowledge base answers matched the query. Full-text search requires Elasticsearch; otherwise titles and bodies are matched by substring.',
        query,
      },
    };
  }

  return { records: matches };
}

/**
 * Fetch the full body of a Knowledge Base answer. When `kbId` or `translationId`
 * are omitted they are derived from the cached init graph.
 */
export async function kbRead(
  client: ZammadClient,
  input: { answerId: number; kbId?: number; translationId?: number },
): Promise<unknown> {
  let { kbId, translationId } = input;

  if (kbId === undefined || translationId === undefined) {
    const graph = await loadGraph(client);
    const answer = graph.answers.get(input.answerId);
    if (translationId === undefined) {
      translationId = graph.translationsByAnswer.get(input.answerId)?.[0]?.translationId;
    }
    if (kbId === undefined && answer?.categoryId !== undefined) {
      kbId = graph.categories.get(answer.categoryId)?.kbId;
    }
  }

  if (kbId === undefined) {
    throw new Error(
      `Unable to determine knowledge_base id for answer ${input.answerId}. Provide kbId explicitly.`,
    );
  }

  const query = translationId === undefined ? undefined : { include_contents: translationId };
  const response = await client.get(`/knowledge_bases/${kbId}/answers/${input.answerId}`, query);
  return { kb_id: kbId, answer_id: input.answerId, translation_id: translationId, answer: response.data };
}

/** Clears the in-memory init-graph cache (used by tests). */
export function clearKbCache(client: ZammadClient): void {
  graphCache.delete(client);
}

async function tryFullTextSearch(
  client: ZammadClient,
  query: string,
  limit: number,
): Promise<KbSearchRecord[] | undefined> {
  try {
    const response = await client.get('/search', {
      query,
      objects: 'KnowledgeBaseAnswer::Translation',
      limit,
    });
    const graph = buildGraph(response.data);
    const ordered = orderedTranslationsFromSearch(response.data, graph);
    if (ordered.length === 0) {
      return undefined;
    }
    return ordered.map(translation => toRecord(graph, translation));
  } catch {
    // Full-text search unavailable (no Elasticsearch, endpoint disabled, etc.).
    return undefined;
  }
}

async function loadGraph(client: ZammadClient): Promise<KbGraph> {
  const cached = graphCache.get(client);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.graph;
  }

  const response = await client.post('/knowledge_bases/init', {});
  const graph = buildGraph(response.data);
  graphCache.set(client, { graph, expiresAt: now + GRAPH_TTL_MS });
  return graph;
}

function filterGraph(graph: KbGraph, query: string): KbSearchRecord[] {
  const needle = query.toLowerCase();
  return graph.translations
    .filter(
      translation =>
        translation.title.toLowerCase().includes(needle) || translation.body.toLowerCase().includes(needle),
    )
    .map(translation => toRecord(graph, translation));
}

function toRecord(graph: KbGraph, translation: KbTranslation): KbSearchRecord {
  const answer = graph.answers.get(translation.answerId);
  const category = answer?.categoryId !== undefined ? graph.categories.get(answer.categoryId)?.title : undefined;
  return {
    answer_id: translation.answerId,
    translation_id: translation.translationId,
    title: translation.title,
    category,
    published: answer?.published,
    body_preview: bodyPreview(translation.body),
  };
}

function orderedTranslationsFromSearch(payload: unknown, graph: KbGraph): KbTranslation[] {
  const record = asRecord(payload);
  const result = record?.result;
  if (Array.isArray(result)) {
    const ordered: KbTranslation[] = [];
    for (const item of result) {
      const itemRecord = asRecord(item);
      const id = toNumber(itemRecord?.id);
      if (id === undefined) {
        continue;
      }
      const translation = graph.translations.find(entry => entry.translationId === id);
      if (translation) {
        ordered.push(translation);
      }
    }
    if (ordered.length > 0) {
      return ordered;
    }
  }
  return graph.translations;
}

function buildGraph(payload: unknown): KbGraph {
  const answers = new Map<number, KbAnswer>();
  for (const raw of collectRecords(payload, 'KnowledgeBaseAnswer')) {
    const answerId = toNumber(raw.id);
    if (answerId === undefined) {
      continue;
    }
    answers.set(answerId, {
      answerId,
      categoryId: toNumber(raw.category_id),
      published: isPublished(raw),
    });
  }

  const contents = new Map<number, string>();
  for (const raw of collectRecords(payload, 'KnowledgeBaseAnswerTranslationContent')) {
    const id = toNumber(raw.id);
    if (id !== undefined) {
      contents.set(id, toString(raw.body));
    }
  }

  const translations: KbTranslation[] = [];
  const translationsByAnswer = new Map<number, KbTranslation[]>();
  for (const raw of collectRecords(payload, 'KnowledgeBaseAnswerTranslation')) {
    const translationId = toNumber(raw.id);
    const answerId = toNumber(raw.kb_answer_id) ?? toNumber(raw.answer_id);
    if (translationId === undefined || answerId === undefined) {
      continue;
    }
    const contentId = toNumber(raw.content_id);
    const body = toString(raw.body) || (contentId !== undefined ? contents.get(contentId) ?? '' : '');
    const translation: KbTranslation = {
      translationId,
      answerId,
      title: toString(raw.title),
      body,
    };
    translations.push(translation);
    const bucket = translationsByAnswer.get(answerId) ?? [];
    bucket.push(translation);
    translationsByAnswer.set(answerId, bucket);
  }

  const categories = new Map<number, KbCategory>();
  for (const raw of collectRecords(payload, 'KnowledgeBaseCategory')) {
    const categoryId = toNumber(raw.id);
    if (categoryId === undefined) {
      continue;
    }
    categories.set(categoryId, {
      categoryId,
      kbId: toNumber(raw.knowledge_base_id),
    });
  }
  for (const raw of collectRecords(payload, 'KnowledgeBaseCategoryTranslation')) {
    const categoryId = toNumber(raw.category_id);
    if (categoryId === undefined) {
      continue;
    }
    const existing = categories.get(categoryId) ?? { categoryId };
    if (!existing.title) {
      existing.title = toString(raw.title) || undefined;
    }
    categories.set(categoryId, existing);
  }

  return { answers, translations, translationsByAnswer, categories };
}

/**
 * Collects records for a Zammad model from either the top-level payload or the
 * `assets` envelope, tolerating both array and id-keyed object shapes.
 */
function collectRecords(payload: unknown, model: string): Array<Record<string, unknown>> {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  const results: Array<Record<string, unknown>> = [];
  pushCollection(results, record[model]);
  const assets = asRecord(record.assets);
  if (assets) {
    pushCollection(results, assets[model]);
  }
  return results;
}

function pushCollection(target: Array<Record<string, unknown>>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      if (record) {
        target.push(record);
      }
    }
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const item of Object.values(record)) {
      const entry = asRecord(item);
      if (entry) {
        target.push(entry);
      }
    }
  }
}

function isPublished(raw: Record<string, unknown>): boolean {
  if (typeof raw.published === 'boolean') {
    return raw.published;
  }
  if (typeof raw.is_publicly_published === 'boolean') {
    return raw.is_publicly_published;
  }
  return Boolean(raw.published_at);
}

function bodyPreview(body: string): string {
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
