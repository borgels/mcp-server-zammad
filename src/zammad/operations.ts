import type { ZammadClient } from './client.js';
import { kbRead, kbSearch, type KbSearchResult } from './kb.js';

/**
 * Shared Zammad operations used by both the MCP tool layer (`src/tools/zammad.ts`)
 * and the Borgels gateway export (`src/gateway.ts`). Keeping the request shapes in
 * one place guarantees the two surfaces stay behaviourally identical.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTicket(client: ZammadClient, id: number): Promise<unknown> {
  return (await client.get(`/tickets/${id}`, { expand: true })).data;
}

export async function searchTickets(client: ZammadClient, query: string, limit: number): Promise<unknown> {
  return (await client.get('/tickets/search', { query, limit, expand: true })).data;
}

export async function listArticles(client: ZammadClient, ticketId: number): Promise<unknown> {
  return (await client.get(`/ticket_articles/by_ticket/${ticketId}`, { expand: true })).data;
}

export async function getTicketTags(client: ZammadClient, ticketId: number): Promise<unknown> {
  return (await client.get('/tags', { object: 'Ticket', o_id: ticketId })).data;
}

export async function listTicketStates(client: ZammadClient): Promise<unknown> {
  return (await client.get('/ticket_states')).data;
}

export async function listTicketPriorities(client: ZammadClient): Promise<unknown> {
  return (await client.get('/ticket_priorities')).data;
}

export async function listGroups(client: ZammadClient): Promise<unknown> {
  return (await client.get('/groups')).data;
}

export async function getUser(client: ZammadClient, id: number): Promise<unknown> {
  return (await client.get(`/users/${id}`)).data;
}

export async function searchUsers(client: ZammadClient, query: string, limit: number): Promise<unknown> {
  return (await client.get('/users/search', { query, limit })).data;
}

export async function knowledgeBaseSearch(
  client: ZammadClient,
  query: string,
  limit: number,
): Promise<KbSearchResult> {
  return kbSearch(client, query, limit);
}

export async function knowledgeBaseRead(
  client: ZammadClient,
  input: { answerId: number; kbId?: number; translationId?: number },
): Promise<unknown> {
  return kbRead(client, input);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AddInternalNoteParams {
  ticketId: number;
  body: string;
  subject?: string;
}

export async function addInternalNote(client: ZammadClient, params: AddInternalNoteParams): Promise<unknown> {
  return (
    await client.post('/ticket_articles', dropUndefined({
      ticket_id: params.ticketId,
      subject: params.subject,
      body: params.body,
      type: 'note',
      internal: true,
      sender: 'Agent',
      content_type: 'text/html',
    }))
  ).data;
}

export interface AddArticleParams {
  ticketId: number;
  body: string;
  subject?: string;
  internal?: boolean;
  type?: string;
  sender?: string;
  contentType?: string;
}

export async function addArticle(client: ZammadClient, params: AddArticleParams): Promise<unknown> {
  return (
    await client.post('/ticket_articles', dropUndefined({
      ticket_id: params.ticketId,
      subject: params.subject,
      body: params.body,
      type: params.type ?? 'note',
      internal: params.internal ?? false,
      sender: params.sender ?? 'Agent',
      content_type: params.contentType ?? 'text/html',
    }))
  ).data;
}

export async function setState(client: ZammadClient, ticketId: number, state: string): Promise<unknown> {
  return (await client.put(`/tickets/${ticketId}`, { state })).data;
}

export async function addTag(client: ZammadClient, ticketId: number, tag: string): Promise<unknown> {
  return (await client.post('/tags/add', { item: tag, object: 'Ticket', o_id: ticketId })).data;
}

export async function removeTag(client: ZammadClient, ticketId: number, tag: string): Promise<unknown> {
  return (await client.delete('/tags/remove', { item: tag, object: 'Ticket', o_id: ticketId })).data;
}

export interface CreateTicketParams {
  title: string;
  group: string;
  customer?: string;
  state?: string;
  priority?: string;
  owner?: string;
  body?: string;
  subject?: string;
  articleType?: string;
  articleInternal?: boolean;
  fields?: Record<string, unknown>;
}

export async function createTicket(client: ZammadClient, params: CreateTicketParams): Promise<unknown> {
  const payload: Record<string, unknown> = dropUndefined({
    title: params.title,
    group: params.group,
    customer_id: params.customer,
    state: params.state,
    priority: params.priority,
    owner_id: params.owner,
    ...(params.fields ?? {}),
  });

  if (params.body !== undefined) {
    payload.article = dropUndefined({
      subject: params.subject ?? params.title,
      body: params.body,
      type: params.articleType ?? 'note',
      internal: params.articleInternal ?? false,
      content_type: 'text/html',
    });
  }

  return (await client.post('/tickets', payload)).data;
}

export interface UpdateTicketParams {
  id: number;
  title?: string;
  state?: string;
  priority?: string;
  group?: string;
  owner?: string;
  customer?: string;
  fields?: Record<string, unknown>;
}

export async function updateTicket(client: ZammadClient, params: UpdateTicketParams): Promise<unknown> {
  const payload = dropUndefined({
    title: params.title,
    state: params.state,
    priority: params.priority,
    group: params.group,
    owner_id: params.owner,
    customer_id: params.customer,
    ...(params.fields ?? {}),
  });

  return (await client.put(`/tickets/${params.id}`, payload)).data;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}
