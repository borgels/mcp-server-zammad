import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from '../zammad/annotations.js';
import type { ZammadClient } from '../zammad/client.js';
import * as ops from '../zammad/operations.js';

const ticketIdSchema = z.number().int().positive();
const userIdSchema = z.number().int().positive();
const nonEmpty = z.string().trim().min(1);
const passthroughFields = z.record(z.string(), z.unknown()).optional();

export function registerZammadTools(server: McpServer, client: ZammadClient): void {
  // ---- Reads --------------------------------------------------------------

  server.registerTool(
    'get_ticket',
    {
      title: 'Get Zammad Ticket',
      description: 'Fetch one Zammad ticket by id, with expand=true so association ids resolve to human-readable names.',
      inputSchema: { id: ticketIdSchema },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.getTicket(client, input.id)),
  );

  server.registerTool(
    'search_tickets',
    {
      title: 'Search Zammad Tickets',
      description: 'Search tickets with a Zammad query string (e.g. "state.name:open AND priority.name:3 high").',
      inputSchema: { query: nonEmpty, limit: z.number().int().min(1).max(200).default(25) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.searchTickets(client, input.query, input.limit)),
  );

  server.registerTool(
    'list_articles',
    {
      title: 'List Zammad Ticket Articles',
      description: 'List all articles (customer messages and agent notes) on a ticket, with expanded names.',
      inputSchema: { ticket_id: ticketIdSchema },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.listArticles(client, input.ticket_id)),
  );

  server.registerTool(
    'get_ticket_tags',
    {
      title: 'Get Zammad Ticket Tags',
      description: 'List the tags attached to a ticket.',
      inputSchema: { ticket_id: ticketIdSchema },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.getTicketTags(client, input.ticket_id)),
  );

  server.registerTool(
    'list_ticket_states',
    {
      title: 'List Zammad Ticket States',
      description: 'List the ticket states configured on this Zammad instance.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => handle(() => ops.listTicketStates(client)),
  );

  server.registerTool(
    'list_ticket_priorities',
    {
      title: 'List Zammad Ticket Priorities',
      description: 'List the ticket priorities configured on this Zammad instance.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => handle(() => ops.listTicketPriorities(client)),
  );

  server.registerTool(
    'list_groups',
    {
      title: 'List Zammad Groups',
      description: 'List helpdesk groups (queues).',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => handle(() => ops.listGroups(client)),
  );

  server.registerTool(
    'get_user',
    {
      title: 'Get Zammad User',
      description: 'Fetch one Zammad user (agent or customer) by id.',
      inputSchema: { id: userIdSchema },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.getUser(client, input.id)),
  );

  server.registerTool(
    'search_users',
    {
      title: 'Search Zammad Users',
      description: 'Search users (agents and customers) by name, login, or email.',
      inputSchema: { query: nonEmpty, limit: z.number().int().min(1).max(200).default(25) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.searchUsers(client, input.query, input.limit)),
  );

  server.registerTool(
    'kb_search',
    {
      title: 'Search Zammad Knowledge Base',
      description:
        'Search knowledge base answers. Uses Zammad full-text search when Elasticsearch is available; otherwise loads the knowledge base graph and matches titles/bodies by substring. Returns compact records or a structured empty result.',
      inputSchema: { query: nonEmpty, limit: z.number().int().min(1).max(200).default(10) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => handle(() => ops.knowledgeBaseSearch(client, input.query, input.limit)),
  );

  server.registerTool(
    'kb_read',
    {
      title: 'Read Zammad Knowledge Base Answer',
      description:
        'Fetch the full body of a knowledge base answer. If kb_id or translation_id are omitted they are derived from the knowledge base graph.',
      inputSchema: {
        answer_id: z.number().int().positive(),
        kb_id: z.number().int().positive().optional(),
        translation_id: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => ops.knowledgeBaseRead(client, { answerId: input.answer_id, kbId: input.kb_id, translationId: input.translation_id })),
  );

  // ---- Gated writes -------------------------------------------------------

  server.registerTool(
    'add_internal_note',
    {
      title: 'Add Internal Note',
      description: 'Append an internal (agent-only) HTML note to a ticket. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: { ticket_id: ticketIdSchema, body: nonEmpty, subject: z.string().trim().min(1).optional() },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.addInternalNote(client, { ticketId: input.ticket_id, body: input.body, subject: input.subject });
      }),
  );

  server.registerTool(
    'add_article',
    {
      title: 'Add Ticket Article',
      description: 'Append an article to a ticket. Set internal=true for an agent-only note. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: {
        ticket_id: ticketIdSchema,
        body: nonEmpty,
        subject: z.string().trim().min(1).optional(),
        internal: z.boolean().default(false),
        type: z.string().trim().min(1).default('note'),
        sender: z.string().trim().min(1).default('Agent'),
        content_type: z.string().trim().min(1).default('text/html'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.addArticle(client, {
          ticketId: input.ticket_id,
          body: input.body,
          subject: input.subject,
          internal: input.internal,
          type: input.type,
          sender: input.sender,
          contentType: input.content_type,
        });
      }),
  );

  server.registerTool(
    'set_state',
    {
      title: 'Set Ticket State',
      description: 'Change a ticket state by name (e.g. open, closed, pending reminder). Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: { ticket_id: ticketIdSchema, state: nonEmpty },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.setState(client, input.ticket_id, input.state);
      }),
  );

  server.registerTool(
    'add_tag',
    {
      title: 'Add Ticket Tag',
      description: 'Attach a tag to a ticket. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: { ticket_id: ticketIdSchema, tag: nonEmpty },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.addTag(client, input.ticket_id, input.tag);
      }),
  );

  server.registerTool(
    'remove_tag',
    {
      title: 'Remove Ticket Tag',
      description: 'Detach a tag from a ticket. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: { ticket_id: ticketIdSchema, tag: nonEmpty },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.removeTag(client, input.ticket_id, input.tag);
      }),
  );

  server.registerTool(
    'create_ticket',
    {
      title: 'Create Ticket',
      description: 'Create a new ticket with an optional first article. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: {
        title: nonEmpty,
        group: nonEmpty,
        customer: z.string().trim().min(1).optional(),
        state: z.string().trim().min(1).optional(),
        priority: z.string().trim().min(1).optional(),
        owner: z.string().trim().min(1).optional(),
        body: z.string().trim().min(1).optional(),
        subject: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        internal: z.boolean().optional(),
        fields: passthroughFields,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.createTicket(client, {
          title: input.title,
          group: input.group,
          customer: input.customer,
          state: input.state,
          priority: input.priority,
          owner: input.owner,
          body: input.body,
          subject: input.subject,
          articleType: input.type,
          articleInternal: input.internal,
          fields: input.fields,
        });
      }),
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update Ticket',
      description: 'Update fields on an existing ticket. Requires ZAMMAD_ENABLE_WRITES=true.',
      inputSchema: {
        id: ticketIdSchema,
        title: z.string().trim().min(1).optional(),
        state: z.string().trim().min(1).optional(),
        priority: z.string().trim().min(1).optional(),
        group: z.string().trim().min(1).optional(),
        owner: z.string().trim().min(1).optional(),
        customer: z.string().trim().min(1).optional(),
        fields: passthroughFields,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      handle(() => {
        assertWritesEnabled();
        return ops.updateTicket(client, {
          id: input.id,
          title: input.title,
          state: input.state,
          priority: input.priority,
          group: input.group,
          owner: input.owner,
          customer: input.customer,
          fields: input.fields,
        });
      }),
  );
}

function assertWritesEnabled(): void {
  if (process.env.ZAMMAD_ENABLE_WRITES !== 'true') {
    throw new Error(
      'Zammad write tools are disabled. Set ZAMMAD_ENABLE_WRITES=true in the server environment to enable them.',
    );
  }
}

async function handle(call: () => Promise<unknown> | unknown) {
  try {
    const data = await call();
    return jsonToolResult(data);
  } catch (error) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: formatUnknownError(error) }],
    };
  }
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
