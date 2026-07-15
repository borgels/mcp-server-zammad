import type { ZammadClient, QueryValue } from './client.js';
import { profile } from './policy.js';

export const MAX_PER_PAGE = 100;
const DEFAULT_ATTACHMENT_CAP = 2 * 1024 * 1024;
const MAX_ATTACHMENT_CAP = 20 * 1024 * 1024;

export interface ListTicketsInput {
  /** Optional search query; without it, lists the tickets visible to the acting user. */
  query?: string;
  page?: number;
  perPage?: number;
}

export async function listTickets(client: ZammadClient, input: ListTicketsInput = {}): Promise<unknown> {
  const query: Record<string, QueryValue> = {
    expand: true,
    page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 25, MAX_PER_PAGE),
  };
  if (input.query) {
    return client.get('/tickets/search', { ...query, query: input.query });
  }
  return client.get('/tickets', query);
}

export async function getTicket(
  client: ZammadClient,
  input: { ticketId: number; includeArticles?: boolean },
): Promise<unknown> {
  const ticket = await client.get(`/tickets/${input.ticketId}`, { expand: true });
  if (input.includeArticles === false) {
    return ticket;
  }
  const articles = await client.get(`/ticket_articles/by_ticket/${input.ticketId}`, { expand: true });
  return { ticket, articles };
}

export interface CreateTicketInput {
  title: string;
  body: string;
  group?: string;
  /**
   * Customer email; defaults to the acting user. Technician-only.
   * Unknown emails are auto-created as customers (Zammad "guess:" syntax).
   */
  customer?: string;
  priorityId?: number;
  tags?: string;
}

export async function createTicket(client: ZammadClient, input: CreateTicketInput): Promise<unknown> {
  const technician = profile() === 'technician';
  if (input.customer && !technician) {
    throw new Error('Only the technician profile can create tickets on behalf of another customer.');
  }
  return client.post('/tickets', {
    title: input.title,
    group: input.group ?? process.env.ZAMMAD_DEFAULT_GROUP ?? 'Users',
    ...(input.customer ? { customer_id: `guess:${input.customer}` } : {}),
    priority_id: input.priorityId,
    tags: input.tags,
    article: {
      body: input.body,
      // "web" is what the customer portal produces; it is public and does
      // not itself send outbound email (triggers decide notifications).
      type: 'web',
      content_type: 'text/plain',
      internal: false,
    },
  });
}

export type ArticleType = 'note' | 'web' | 'email' | 'phone';

export interface ReplyTicketInput {
  ticketId: number;
  body: string;
  /** Internal notes are technician-only and invisible to the customer. */
  internal?: boolean;
  /** Technician-only. "email" actually SENDS an email to the customer. Default: note. */
  articleType?: ArticleType;
}

export async function replyTicket(client: ZammadClient, input: ReplyTicketInput): Promise<unknown> {
  const technician = profile() === 'technician';
  if (input.internal && !technician) {
    throw new Error('Internal notes require the technician profile.');
  }
  if (input.articleType && !technician) {
    throw new Error('Choosing the article type requires the technician profile.');
  }
  return client.post('/ticket_articles', {
    ticket_id: input.ticketId,
    body: input.body,
    type: technician ? (input.articleType ?? 'note') : 'web',
    content_type: 'text/plain',
    internal: input.internal ?? false,
  });
}

export interface UpdateTicketInput {
  ticketId: number;
  title?: string;
  /** State name, e.g. open, closed, "pending reminder". */
  state?: string;
  pendingTime?: string;
  /** Technician-only fields: */
  ownerId?: number;
  priorityId?: number;
  group?: string;
}

export async function updateTicket(client: ZammadClient, input: UpdateTicketInput): Promise<unknown> {
  const technician = profile() === 'technician';
  if (!technician && (input.ownerId !== undefined || input.priorityId !== undefined || input.group !== undefined)) {
    throw new Error('Changing owner, priority, or group requires the technician profile.');
  }

  const body: Record<string, unknown> = {
    title: input.title,
    state: input.state,
    pending_time: input.pendingTime,
    owner_id: input.ownerId,
    priority_id: input.priorityId,
    group: input.group,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) {
      delete body[key];
    }
  }
  if (Object.keys(body).length === 0) {
    throw new Error('Nothing to update — provide at least one field.');
  }
  return client.put(`/tickets/${input.ticketId}`, body);
}

export interface DownloadAttachmentInput {
  ticketId: number;
  articleId: number;
  attachmentId: number;
  maxBytes?: number;
}

export async function downloadAttachment(client: ZammadClient, input: DownloadAttachmentInput): Promise<{
  contentType: string;
  sizeBytes: number;
  encoding: 'utf-8' | 'base64';
  content: string;
}> {
  const maxBytes = Math.min(input.maxBytes ?? DEFAULT_ATTACHMENT_CAP, MAX_ATTACHMENT_CAP);
  const { bytes, contentType } = await client.getBinary(
    `/ticket_attachment/${input.ticketId}/${input.articleId}/${input.attachmentId}`,
    maxBytes,
  );
  const isText = /^(text\/|application\/(json|xml|csv))/.test(contentType);
  return {
    contentType,
    sizeBytes: bytes.byteLength,
    encoding: isText ? 'utf-8' : 'base64',
    content: isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'),
  };
}

export async function searchTickets(
  client: ZammadClient,
  input: { query: string; page?: number; perPage?: number },
): Promise<unknown> {
  return client.get('/tickets/search', {
    query: input.query,
    expand: true,
    page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 25, MAX_PER_PAGE),
  });
}
