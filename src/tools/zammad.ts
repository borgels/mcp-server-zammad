import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../zammad/audit.js';
import {
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../zammad/capabilities.js';
import type { ZammadClient } from '../zammad/client.js';
import { checkToolPolicy, profile, toolNamesForProfile } from '../zammad/policy.js';
import {
  createTicket,
  downloadAttachment,
  getTicket,
  listTickets,
  MAX_PER_PAGE,
  replyTicket,
  searchTickets,
  updateTicket,
} from '../zammad/tickets.js';
import { searchKnowledgeBase } from '../zammad/kb.js';
import {
  listOrganizations,
  listReferenceData,
  listUsers,
  manageTags,
  manageUser,
  whoami,
} from '../zammad/users.js';

const ticketIdSchema = z.number().int().positive();
const pageShape = {
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(MAX_PER_PAGE).optional(),
};

export function registerZammadTools(server: McpServer, client: ZammadClient): void {
  const available = toolNamesForProfile();
  const technician = profile() === 'technician';

  const register: typeof server.registerTool = (name, config, handler) => {
    if (!available.has(name)) {
      return undefined as never;
    }
    return server.registerTool(name, config, handler);
  };

  register(
    'zammad_search_capabilities',
    {
      title: 'Search Zammad Capabilities',
      description: 'Search the Zammad MCP server capabilities and examples. Use this first when deciding which tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit, available)),
      ),
  );

  register(
    'zammad_whoami',
    {
      title: 'Who Am I (Zammad)',
      description: 'Show which Zammad user this session acts as, with roles and organization.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runAuditedTool(client, 'zammad_whoami', input, async () => jsonToolResult(await whoami(client))),
  );

  register(
    'zammad_list_tickets',
    {
      title: 'List My Tickets (Zammad)',
      description:
        'List tickets visible to you (customers: own + shared-organization tickets; technicians: your groups). Optional query filters, e.g. "state.name:open".',
      inputSchema: {
        query: z.string().trim().min(1).optional(),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_list_tickets', input, async () => jsonToolResult(await listTickets(client, input))),
  );

  register(
    'zammad_get_ticket',
    {
      title: 'Get Ticket (Zammad)',
      description: 'Fetch one ticket with its full conversation and attachment metadata.',
      inputSchema: {
        ticketId: ticketIdSchema,
        includeArticles: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_get_ticket', input, async () => jsonToolResult(await getTicket(client, input))),
  );

  register(
    'zammad_create_ticket',
    {
      title: 'Create Ticket (Zammad)',
      description: technician
        ? 'Open a support ticket. You are the customer unless you pass customer=<email> (unknown emails are auto-created as customers).'
        : 'Open a support ticket with a title and description. You are registered as the customer.',
      inputSchema: {
        title: z.string().trim().min(3),
        body: z.string().trim().min(3).describe('The problem description (plain text).'),
        group: z.string().trim().min(1).optional(),
        ...(technician
          ? { customer: z.string().trim().email().optional().describe('Open on behalf of this customer email.') }
          : {}),
        priorityId: z.number().int().optional(),
        tags: z.string().trim().optional().describe('Comma-separated tags.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_create_ticket', input, async () =>
        jsonToolResult(await createTicket(client, input)),
      ),
  );

  register(
    'zammad_reply_ticket',
    {
      title: 'Reply on Ticket (Zammad)',
      description: technician
        ? 'Add a reply. internal=true makes it an internal note the customer cannot see. articleType "email" actually SENDS an email to the customer — default "note" stays in Zammad. Articles are immutable once created.'
        : 'Add a reply to one of your tickets. Articles are immutable once created.',
      inputSchema: {
        ticketId: ticketIdSchema,
        body: z.string().trim().min(1),
        ...(technician
          ? {
              internal: z.boolean().default(false),
              articleType: z.enum(['note', 'web', 'email', 'phone']).optional(),
            }
          : {}),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_reply_ticket', input, async () =>
        jsonToolResult(await replyTicket(client, input)),
      ),
  );

  register(
    'zammad_update_ticket',
    {
      title: 'Update Ticket (Zammad)',
      description: technician
        ? 'Change title, state (open/closed/pending…), owner, priority, or group. pendingTime (ISO timestamp) goes with pending states.'
        : 'Change the title or state of one of your tickets (e.g. close it, or reopen with state "open").',
      inputSchema: {
        ticketId: ticketIdSchema,
        title: z.string().trim().min(3).optional(),
        state: z.string().trim().min(2).optional(),
        pendingTime: z.string().trim().optional(),
        ...(technician
          ? {
              ownerId: z.number().int().optional(),
              priorityId: z.number().int().optional(),
              group: z.string().trim().optional(),
            }
          : {}),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_update_ticket', input, async () =>
        jsonToolResult(await updateTicket(client, input)),
      ),
  );

  register(
    'zammad_download_attachment',
    {
      title: 'Download Attachment (Zammad)',
      description: 'Download a ticket attachment (ids from zammad_get_ticket). Capped at 2 MB by default (maxBytes up to 20 MB).',
      inputSchema: {
        ticketId: ticketIdSchema,
        articleId: z.number().int().positive(),
        attachmentId: z.number().int().positive(),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_download_attachment', input, async () =>
        jsonToolResult(await downloadAttachment(client, input)),
      ),
  );

  register(
    'zammad_search_knowledge_base',
    {
      title: 'Search Knowledge Base (Zammad)',
      description:
        'Search knowledge-base answers (in your language; visibility enforced by Zammad), or fetch one answer\'s full content with knowledgeBaseId + answerId.',
      inputSchema: {
        query: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        knowledgeBaseId: z.number().int().positive().optional(),
        answerId: z.number().int().positive().optional(),
        translationId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_search_knowledge_base', input, async () =>
        jsonToolResult(await searchKnowledgeBase(client, input)),
      ),
  );

  register(
    'zammad_search_tickets',
    {
      title: 'Search All Tickets (Zammad)',
      description:
        'Full ticket search across your groups. Elasticsearch syntax: "state.name:open AND priority_id:3", "customer.email:x@y.dk", "tags:hardware".',
      inputSchema: {
        query: z.string().trim().min(1),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_search_tickets', input, async () =>
        jsonToolResult(await searchTickets(client, input)),
      ),
  );

  register(
    'zammad_list_users',
    {
      title: 'List/Search Users (Zammad)',
      description: 'List or search Zammad users, or fetch one by userId.',
      inputSchema: {
        query: z.string().trim().min(1).optional(),
        userId: z.number().int().positive().optional(),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_list_users', input, async () => jsonToolResult(await listUsers(client, input))),
  );

  register(
    'zammad_manage_user',
    {
      title: 'Create/Update User (Zammad)',
      description:
        'Create or update a customer user (e.g. register a new employee). Roles, passwords, and group assignments are refused by design.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        userId: z.number().int().positive().optional(),
        payload: z.record(z.string(), z.unknown()),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_manage_user', input, async () => jsonToolResult(await manageUser(client, input))),
  );

  register(
    'zammad_list_organizations',
    {
      title: 'List Organizations (Zammad)',
      description: 'List or search organizations, or fetch one by organizationId.',
      inputSchema: {
        query: z.string().trim().min(1).optional(),
        organizationId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_list_organizations', input, async () =>
        jsonToolResult(await listOrganizations(client, input)),
      ),
  );

  register(
    'zammad_manage_tags',
    {
      title: 'Manage Ticket Tags (Zammad)',
      description: 'List, add, or remove tags on a ticket.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove']),
        ticketId: ticketIdSchema,
        tag: z.string().trim().min(1).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_manage_tags', input, async () => jsonToolResult(await manageTags(client, input))),
  );

  register(
    'zammad_list_reference_data',
    {
      title: 'List Reference Data (Zammad)',
      description: 'Groups, ticket states, and priorities — the valid values for ticket updates.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(client, 'zammad_list_reference_data', input, async () =>
        jsonToolResult(await listReferenceData(client)),
      ),
  );
}

async function runAuditedTool<T>(
  client: ZammadClient,
  tool: string,
  input: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);
  const actingAs = client.onBehalfOf ?? '(token user)';

  if (!policy.allowed) {
    await writeAuditEvent({ tool, actingAs, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, actingAs, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      actingAs,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const value = input as Record<string, unknown>;
  return {
    ticketId: value.ticketId,
    articleId: value.articleId,
    attachmentId: value.attachmentId,
    userId: value.userId,
    organizationId: value.organizationId,
    knowledgeBaseId: value.knowledgeBaseId,
    answerId: value.answerId,
    action: value.action,
    state: value.state,
    internal: value.internal,
    articleType: value.articleType,
    customer: value.customer,
    tag: value.tag,
    query: value.query,
  };
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
