import { ZammadClient, type ZammadClientOptions } from './zammad/client.js';
import * as ops from './zammad/operations.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface ZammadGatewayOptions extends ZammadClientOptions {}

const ticketId = { type: 'integer', description: 'Zammad ticket id.' } satisfies GatewayJsonObject;
const searchLimit = { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum results to return.' } satisfies GatewayJsonObject;

export const zammadGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'get_ticket',
    title: 'Get Zammad ticket',
    description: 'Fetch one ticket by id with expanded association names.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', required: ['id'], properties: { id: ticketId }, additionalProperties: false },
  },
  {
    name: 'search_tickets',
    title: 'Search Zammad tickets',
    description: 'Search tickets with a Zammad query string.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, limit: searchLimit },
      additionalProperties: false,
    },
  },
  {
    name: 'list_articles',
    title: 'List Zammad ticket articles',
    description: 'List all articles (messages/notes) on a ticket.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: ticketId }, additionalProperties: false },
  },
  {
    name: 'get_ticket_tags',
    title: 'Get Zammad ticket tags',
    description: 'List the tags attached to a ticket.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', required: ['ticket_id'], properties: { ticket_id: ticketId }, additionalProperties: false },
  },
  {
    name: 'list_ticket_states',
    title: 'List Zammad ticket states',
    description: 'List available ticket states.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_ticket_priorities',
    title: 'List Zammad ticket priorities',
    description: 'List available ticket priorities.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_groups',
    title: 'List Zammad groups',
    description: 'List helpdesk groups (queues).',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_user',
    title: 'Get Zammad user',
    description: 'Fetch one user by id.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } }, additionalProperties: false },
  },
  {
    name: 'search_users',
    title: 'Search Zammad users',
    description: 'Search users (agents and customers) by a query string.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, limit: searchLimit },
      additionalProperties: false,
    },
  },
  {
    name: 'kb_search',
    title: 'Search Zammad knowledge base',
    description: 'Search knowledge base answers (full-text when available, otherwise substring matching).',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, limit: searchLimit },
      additionalProperties: false,
    },
  },
  {
    name: 'kb_read',
    title: 'Read Zammad knowledge base answer',
    description: 'Fetch the full body of a knowledge base answer.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['answer_id'],
      properties: {
        answer_id: { type: 'integer' },
        kb_id: { type: 'integer' },
        translation_id: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_internal_note',
    title: 'Add internal note to Zammad ticket',
    description: 'Append an internal (agent-only) note to a ticket.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'body'],
      properties: { ticket_id: ticketId, body: { type: 'string' }, subject: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_article',
    title: 'Add article to Zammad ticket',
    description: 'Append an article (public reply or note) to a ticket.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'body'],
      properties: {
        ticket_id: ticketId,
        body: { type: 'string' },
        subject: { type: 'string' },
        internal: { type: 'boolean' },
        type: { type: 'string' },
        sender: { type: 'string' },
        content_type: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_state',
    title: 'Set Zammad ticket state',
    description: 'Change a ticket state (e.g. open, closed, pending reminder).',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'state'],
      properties: { ticket_id: ticketId, state: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_tag',
    title: 'Add tag to Zammad ticket',
    description: 'Attach a tag to a ticket.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'tag'],
      properties: { ticket_id: ticketId, tag: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_tag',
    title: 'Remove tag from Zammad ticket',
    description: 'Detach a tag from a ticket.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'tag'],
      properties: { ticket_id: ticketId, tag: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'create_ticket',
    title: 'Create Zammad ticket',
    description: 'Create a new ticket with an optional first article.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['title', 'group'],
      properties: {
        title: { type: 'string' },
        group: { type: 'string' },
        customer: { type: 'string', description: 'Customer email or id.' },
        state: { type: 'string' },
        priority: { type: 'string' },
        owner: { type: 'string', description: 'Owner login or id.' },
        body: { type: 'string' },
        subject: { type: 'string' },
        type: { type: 'string' },
        internal: { type: 'boolean' },
        fields: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_ticket',
    title: 'Update Zammad ticket',
    description: 'Update fields on an existing ticket.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ticketId,
        title: { type: 'string' },
        state: { type: 'string' },
        priority: { type: 'string' },
        group: { type: 'string' },
        owner: { type: 'string' },
        customer: { type: 'string' },
        fields: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
];

export function createZammadGateway(options: ZammadGatewayOptions = {}) {
  const client = new ZammadClient(options);

  return {
    tools: zammadGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      switch (toolName) {
        case 'get_ticket':
          return jsonResult('Fetched Zammad ticket.', await ops.getTicket(client, requiredNumber(input.id, 'id')));

        case 'search_tickets':
          return jsonResult(
            'Fetched Zammad tickets.',
            await ops.searchTickets(client, requiredString(input.query, 'query'), numberValue(input.limit) ?? 25),
          );

        case 'list_articles':
          return jsonResult('Fetched Zammad ticket articles.', await ops.listArticles(client, requiredNumber(input.ticket_id, 'ticket_id')));

        case 'get_ticket_tags':
          return jsonResult('Fetched Zammad ticket tags.', await ops.getTicketTags(client, requiredNumber(input.ticket_id, 'ticket_id')));

        case 'list_ticket_states':
          return jsonResult('Fetched Zammad ticket states.', await ops.listTicketStates(client));

        case 'list_ticket_priorities':
          return jsonResult('Fetched Zammad ticket priorities.', await ops.listTicketPriorities(client));

        case 'list_groups':
          return jsonResult('Fetched Zammad groups.', await ops.listGroups(client));

        case 'get_user':
          return jsonResult('Fetched Zammad user.', await ops.getUser(client, requiredNumber(input.id, 'id')));

        case 'search_users':
          return jsonResult(
            'Fetched Zammad users.',
            await ops.searchUsers(client, requiredString(input.query, 'query'), numberValue(input.limit) ?? 25),
          );

        case 'kb_search':
          return jsonResult(
            'Searched Zammad knowledge base.',
            await ops.knowledgeBaseSearch(client, requiredString(input.query, 'query'), numberValue(input.limit) ?? 10),
          );

        case 'kb_read':
          return jsonResult('Fetched Zammad knowledge base answer.', await ops.knowledgeBaseRead(client, {
            answerId: requiredNumber(input.answer_id, 'answer_id'),
            kbId: numberValue(input.kb_id),
            translationId: numberValue(input.translation_id),
          }));

        case 'add_internal_note':
          return jsonResult('Added internal note.', await ops.addInternalNote(client, {
            ticketId: requiredNumber(input.ticket_id, 'ticket_id'),
            body: requiredString(input.body, 'body'),
            subject: stringValue(input.subject),
          }));

        case 'add_article':
          return jsonResult('Added ticket article.', await ops.addArticle(client, {
            ticketId: requiredNumber(input.ticket_id, 'ticket_id'),
            body: requiredString(input.body, 'body'),
            subject: stringValue(input.subject),
            internal: booleanValue(input.internal),
            type: stringValue(input.type),
            sender: stringValue(input.sender),
            contentType: stringValue(input.content_type),
          }));

        case 'set_state':
          return jsonResult('Updated ticket state.', await ops.setState(client, requiredNumber(input.ticket_id, 'ticket_id'), requiredString(input.state, 'state')));

        case 'add_tag':
          return jsonResult('Added ticket tag.', await ops.addTag(client, requiredNumber(input.ticket_id, 'ticket_id'), requiredString(input.tag, 'tag')));

        case 'remove_tag':
          return jsonResult('Removed ticket tag.', await ops.removeTag(client, requiredNumber(input.ticket_id, 'ticket_id'), requiredString(input.tag, 'tag')));

        case 'create_ticket':
          return jsonResult('Created ticket.', await ops.createTicket(client, {
            title: requiredString(input.title, 'title'),
            group: requiredString(input.group, 'group'),
            customer: stringValue(input.customer),
            state: stringValue(input.state),
            priority: stringValue(input.priority),
            owner: stringValue(input.owner),
            body: stringValue(input.body),
            subject: stringValue(input.subject),
            articleType: stringValue(input.type),
            articleInternal: booleanValue(input.internal),
            fields: objectValue(input.fields),
          }));

        case 'update_ticket':
          return jsonResult('Updated ticket.', await ops.updateTicket(client, {
            id: requiredNumber(input.id, 'id'),
            title: stringValue(input.title),
            state: stringValue(input.state),
            priority: stringValue(input.priority),
            group: stringValue(input.group),
            owner: stringValue(input.owner),
            customer: stringValue(input.customer),
            fields: objectValue(input.fields),
          }));

        default:
          return errorResult(`Unsupported Zammad gateway tool: ${toolName}`);
      }
    },
  };
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(value: GatewayJsonValue | undefined, name: string): string {
  const parsed = stringValue(value);
  if (!parsed) {
    throw new Error(`Missing required input: ${name}`);
  }
  return parsed;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function requiredNumber(value: GatewayJsonValue | undefined, name: string): number {
  const parsed = numberValue(value);
  if (parsed === undefined) {
    throw new Error(`Missing required numeric input: ${name}`);
  }
  return parsed;
}

function booleanValue(value: GatewayJsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function objectValue(value: GatewayJsonValue | undefined): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
