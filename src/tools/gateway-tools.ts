import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { IDENTITY_NOTE, READ_TOOL_ANNOTATIONS, searchCapabilities, TOKEN_USER_NOTE, WRITE_TOOL_ANNOTATIONS } from '../zammad/capabilities.js';
import { clientForChange } from '../zammad/act-as-user.js';
import type { ZammadClient } from '../zammad/client.js';
import { searchKnowledgeBase } from '../zammad/kb.js';
import { currentOfferedTools } from '../zammad/scope.js';
import { addNote, createTicket, getTicket, listTickets, searchTickets, sendReply, updateTicket } from '../zammad/tickets.js';
import { checkConnection, listOrganizations, listReferenceData, listUsers, manageTags, manageUser } from '../zammad/users.js';
import { jsonToolResult, pageShape, runAuditedTool, ticketIdSchema } from './zammad.js';

/**
 * The tools of the embedded gateway (src/gateway.ts), with the technician
 * tool set, under the host's policy. Reads run as the token's own user. A
 * change runs as the person the host names in `actAs` (the client from
 * clientForChange: their own Zammad user, found by email, with the From
 * header), and is refused when that person has no user; without `actAs` it
 * runs as the token's own user. The MCP server's own tools (src/tools/zammad.ts) are
 * unchanged; the gateway splits reply and tags into tools with one effect
 * each, so a host can grant them one by one.
 *
 * Read tools get a view of the client that can only GET.
 */
function readOnly(client: ZammadClient, tool: string): ZammadClient {
  const refuse = async () => {
    throw new Error(`Read tool ${tool} attempted a change in Zammad; refused.`);
  };
  return Object.assign(Object.create(client) as ZammadClient, { post: refuse, put: refuse, delete: refuse });
}

const tagShape = {
  ticketId: ticketIdSchema,
  tag: z.string().trim().min(1).max(200),
};

export function registerZammadGatewayTools(server: McpServer, client: ZammadClient): void {
  const read = (tool: string) => readOnly(client, tool);
  // Policy, audit and the result as JSON text, as in the MCP server's tools.
  const run = (tool: string, input: unknown, call: () => Promise<unknown>) =>
    runAuditedTool(client, tool, input, async () => jsonToolResult(await call()));

  server.registerTool(
    'zammad_search_capabilities',
    {
      title: 'Search Zammad capabilities',
      description: 'Find the Zammad tool for tickets, notes, replies, knowledge base, users or tags.',
      inputSchema: {
        query: z.string().trim().max(500).default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('zammad_search_capabilities', input, async () =>
        searchCapabilities(input.query, input.limit, currentOfferedTools() ?? new Set()).map(capability => ({
          ...capability,
          // The gateway reads as the token's user and changes as the host's person.
          safetyNotes: capability.safetyNotes.map(note => (note === IDENTITY_NOTE ? TOKEN_USER_NOTE : note)),
        })),
      ),
  );

  server.registerTool(
    'zammad_check_connection',
    { title: 'Check Zammad connection', inputSchema: {}, annotations: READ_TOOL_ANNOTATIONS },
    async input => run('zammad_check_connection', input, async () => checkConnection(read('check_connection'))),
  );

  server.registerTool(
    'zammad_list_tickets',
    {
      title: 'List Zammad tickets',
      inputSchema: { query: z.string().trim().min(1).max(2000).optional(), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_list_tickets', input, async () => listTickets(read('list_tickets'), input)),
  );

  server.registerTool(
    'zammad_search_tickets',
    {
      title: 'Search Zammad tickets',
      inputSchema: { query: z.string().trim().min(1).max(2000), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_search_tickets', input, async () => searchTickets(read('search_tickets'), input)),
  );

  server.registerTool(
    'zammad_get_ticket',
    {
      title: 'Get Zammad ticket',
      inputSchema: { ticketId: ticketIdSchema, includeArticles: z.boolean().default(true) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_get_ticket', input, async () => getTicket(read('get_ticket'), input)),
  );

  server.registerTool(
    'zammad_search_knowledge_base',
    {
      title: 'Search Zammad knowledge base',
      inputSchema: {
        query: z.string().trim().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        knowledgeBaseId: z.number().int().positive().optional(),
        answerId: z.number().int().positive().optional(),
        translationId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('zammad_search_knowledge_base', input, async () =>
        searchKnowledgeBase(read('search_knowledge_base'), input),
      ),
  );

  server.registerTool(
    'zammad_list_users',
    {
      title: 'List Zammad users',
      inputSchema: {
        query: z.string().trim().min(1).max(500).optional(),
        userId: z.number().int().positive().optional(),
        ...pageShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_list_users', input, async () => listUsers(read('list_users'), input)),
  );

  server.registerTool(
    'zammad_list_organizations',
    {
      title: 'List Zammad organizations',
      inputSchema: {
        query: z.string().trim().min(1).max(500).optional(),
        organizationId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('zammad_list_organizations', input, async () =>
        listOrganizations(read('list_organizations'), input),
      ),
  );

  server.registerTool(
    'zammad_list_reference_data',
    { title: 'List Zammad reference data', inputSchema: {}, annotations: READ_TOOL_ANNOTATIONS },
    async input =>
      run('zammad_list_reference_data', input, async () => listReferenceData(read('list_reference_data'))),
  );

  server.registerTool(
    'zammad_list_tags',
    { title: 'List Zammad ticket tags', inputSchema: { ticketId: ticketIdSchema }, annotations: READ_TOOL_ANNOTATIONS },
    async input =>
      run('zammad_list_tags', input, async () =>
        manageTags(read('list_tags'), { action: 'list', ticketId: input.ticketId }),
      ),
  );

  server.registerTool(
    'zammad_create_ticket',
    {
      title: 'Create Zammad ticket',
      inputSchema: {
        title: z.string().trim().min(3).max(500),
        body: z.string().trim().min(3).max(100_000).describe('The problem description (plain text).'),
        group: z.string().trim().min(1).max(200).optional(),
        customer: z.string().trim().email().max(254).optional().describe('Customer email; unknown emails are created as customers.'),
        priorityId: z.number().int().positive().optional(),
        tags: z.string().trim().max(1000).optional().describe('Comma-separated tags.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_create_ticket', input, async () => createTicket(await clientForChange(client), input)),
  );

  server.registerTool(
    'zammad_add_note',
    {
      title: 'Add internal note',
      inputSchema: { ticketId: ticketIdSchema, body: z.string().trim().min(1).max(100_000) },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_add_note', input, async () => addNote(await clientForChange(client), input)),
  );

  server.registerTool(
    'zammad_send_reply',
    {
      title: 'Send reply to customer',
      inputSchema: { ticketId: ticketIdSchema, body: z.string().trim().min(1).max(100_000) },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_send_reply', input, async () => sendReply(await clientForChange(client), input)),
  );

  server.registerTool(
    'zammad_update_ticket',
    {
      title: 'Update Zammad ticket',
      inputSchema: {
        ticketId: ticketIdSchema,
        title: z.string().trim().min(3).max(500).optional(),
        state: z.string().trim().min(2).max(100).optional(),
        pendingTime: z.string().trim().min(1).max(64).optional(),
        ownerId: z.number().int().positive().optional(),
        priorityId: z.number().int().positive().optional(),
        group: z.string().trim().min(1).max(200).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_update_ticket', input, async () => updateTicket(await clientForChange(client), input)),
  );

  server.registerTool(
    'zammad_add_tag',
    { title: 'Add Zammad ticket tag', inputSchema: tagShape, annotations: WRITE_TOOL_ANNOTATIONS },
    async input =>
      run('zammad_add_tag', input, async () =>
        manageTags(await clientForChange(client), { action: 'add', ticketId: input.ticketId, tag: input.tag }),
      ),
  );

  server.registerTool(
    'zammad_remove_tag',
    { title: 'Remove Zammad ticket tag', inputSchema: tagShape, annotations: WRITE_TOOL_ANNOTATIONS },
    async input =>
      run('zammad_remove_tag', input, async () =>
        manageTags(await clientForChange(client), { action: 'remove', ticketId: input.ticketId, tag: input.tag }),
      ),
  );

  server.registerTool(
    'zammad_manage_user',
    {
      title: 'Create or update Zammad user',
      inputSchema: {
        action: z.enum(['create', 'update']),
        userId: z.number().int().positive().optional(),
        payload: z.record(z.string(), z.unknown()),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input => run('zammad_manage_user', input, async () => manageUser(await clientForChange(client), input)),
  );
}
