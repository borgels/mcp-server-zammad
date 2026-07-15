export type CapabilityRisk = 'read' | 'write';

export interface ZammadCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const IDENTITY_NOTE =
  'Runs as the requesting user (gateway identity → Zammad From header) — Zammad enforces their real permissions and attributes the action to them.';

export const ZAMMAD_CAPABILITIES: ZammadCapability[] = [
  {
    id: 'zammad_search_capabilities',
    title: 'Search Zammad Capabilities',
    description: 'Find the Zammad MCP tool for tickets, replies, knowledge base, users, or tags.',
    risk: 'read',
    examples: [{ query: 'opret sag' }],
    identifierFormats: ['Tool id such as zammad_create_ticket.'],
    safetyNotes: ['Discovery only. Does not call Zammad.'],
    keywords: ['discover', 'help', 'capabilities'],
  },
  {
    id: 'zammad_whoami',
    title: 'Who Am I (Zammad)',
    description: 'Show which Zammad user this session acts as, with roles and organization.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [IDENTITY_NOTE],
    keywords: ['me', 'identity', 'hvem', 'user'],
  },
  {
    id: 'zammad_list_tickets',
    title: 'List My Tickets (Zammad)',
    description:
      'List the tickets visible to you (customers: own + shared-organization tickets; technicians: group tickets). Optional free-text/field query, e.g. "state.name:open".',
    risk: 'read',
    examples: [{}, { query: 'state.name:open' }],
    identifierFormats: ['Elasticsearch query-string syntax for the query param'],
    safetyNotes: [IDENTITY_NOTE],
    keywords: ['tickets', 'sager', 'mine', 'liste', 'open', 'support'],
  },
  {
    id: 'zammad_get_ticket',
    title: 'Get Ticket (Zammad)',
    description: 'Fetch one ticket with its full conversation (articles) and attachment metadata.',
    risk: 'read',
    examples: [{ ticketId: 42 }],
    identifierFormats: ['ticketId (number)'],
    safetyNotes: ['Internal notes are only visible to technicians — Zammad filters them for customers.'],
    keywords: ['ticket', 'sag', 'conversation', 'articles', 'detaljer'],
  },
  {
    id: 'zammad_create_ticket',
    title: 'Create Ticket (Zammad)',
    description:
      'Open a new support ticket with a title and description. You are the customer; technicians can open on behalf of another customer (unknown emails are auto-created).',
    risk: 'write',
    examples: [{ title: 'VPN virker ikke', body: 'Jeg kan ikke forbinde siden i morges.' }],
    identifierFormats: [],
    safetyNotes: [IDENTITY_NOTE],
    keywords: ['create', 'opret', 'ny sag', 'ticket', 'anmeldelse', 'fejl'],
  },
  {
    id: 'zammad_reply_ticket',
    title: 'Reply on Ticket (Zammad)',
    description:
      'Add a reply to a ticket. Technicians can also add internal notes (invisible to the customer) and choose the article type — type "email" actually sends an email.',
    risk: 'write',
    examples: [{ ticketId: 42, body: 'Tak — det virker nu.' }],
    identifierFormats: [],
    safetyNotes: [
      IDENTITY_NOTE,
      'Replies cannot be edited or deleted afterwards (Zammad articles are immutable).',
    ],
    keywords: ['reply', 'svar', 'kommentar', 'note', 'intern note', 'besked'],
  },
  {
    id: 'zammad_update_ticket',
    title: 'Update Ticket (Zammad)',
    description:
      'Change ticket fields: title and state (e.g. close/reopen) for everyone; owner, priority, and group require the technician profile.',
    risk: 'write',
    examples: [{ ticketId: 42, state: 'closed' }, { ticketId: 42, ownerId: 4, priorityId: 3 }],
    identifierFormats: ['state names: new, open, closed, "pending reminder", "pending close"'],
    safetyNotes: [IDENTITY_NOTE],
    keywords: ['update', 'luk', 'close', 'genåbn', 'state', 'owner', 'prioritet', 'tildel'],
  },
  {
    id: 'zammad_download_attachment',
    title: 'Download Attachment (Zammad)',
    description: 'Download a ticket attachment (ids from zammad_get_ticket). Text is returned as UTF-8, binary as base64; capped at 2 MB by default.',
    risk: 'read',
    examples: [{ ticketId: 42, articleId: 120, attachmentId: 7 }],
    identifierFormats: ['ticketId + articleId + attachmentId from zammad_get_ticket'],
    safetyNotes: [],
    keywords: ['attachment', 'bilag', 'fil', 'download', 'screenshot'],
  },
  {
    id: 'zammad_search_knowledge_base',
    title: 'Search Knowledge Base (Zammad)',
    description:
      'Search knowledge-base answers (searches your language; internal answers only for those with access), or fetch one answer\'s full content with knowledgeBaseId + answerId.',
    risk: 'read',
    examples: [{ query: 'vpn opsætning' }, { knowledgeBaseId: 1, answerId: 12 }],
    identifierFormats: ['ids come from the search result asset graph'],
    safetyNotes: [IDENTITY_NOTE],
    keywords: ['knowledge base', 'vidensbase', 'kb', 'guide', 'howto', 'faq', 'vejledning'],
  },
  {
    id: 'zammad_search_tickets',
    title: 'Search All Tickets (Zammad, technician)',
    description:
      'Full ticket search across your groups with Elasticsearch syntax, e.g. "state.name:open AND priority_id:3", "customer.email:x@y.dk", "tags:hardware". Sortable.',
    risk: 'read',
    examples: [{ query: 'state.name:open AND group.name:Users' }],
    identifierFormats: ['Elasticsearch query-string syntax'],
    safetyNotes: [],
    keywords: ['search', 'søg', 'alle sager', 'triage', 'queue', 'kø'],
  },
  {
    id: 'zammad_list_users',
    title: 'List/Search Users (Zammad, technician)',
    description: 'List or search Zammad users (customers and agents), or fetch one by userId.',
    risk: 'read',
    examples: [{ query: 'smith' }, { userId: 5 }],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['users', 'brugere', 'kunder', 'customer', 'search'],
  },
  {
    id: 'zammad_manage_user',
    title: 'Create/Update User (Zammad, technician)',
    description:
      'Create or update a customer (e.g. register a new employee before opening tickets for them). Roles, passwords, and groups are refused — those belong in the Zammad admin UI.',
    risk: 'write',
    examples: [{ action: 'create', payload: { email: 'new.employee@example.com', firstname: 'Ny', lastname: 'Medarbejder', organization: 'Example Corp' } }],
    identifierFormats: [],
    safetyNotes: ['Cannot set role_ids/password/group_ids by design.'],
    keywords: ['user', 'opret bruger', 'kunde', 'medarbejder', 'update'],
  },
  {
    id: 'zammad_list_organizations',
    title: 'List Organizations (Zammad, technician)',
    description: 'List or search organizations, or fetch one by organizationId.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['organizations', 'selskaber', 'virksomheder'],
  },
  {
    id: 'zammad_manage_tags',
    title: 'Manage Ticket Tags (Zammad, technician)',
    description: 'List, add, or remove tags on a ticket.',
    risk: 'write',
    examples: [{ action: 'add', ticketId: 42, tag: 'hardware' }],
    identifierFormats: ['action: list | add | remove'],
    safetyNotes: [],
    keywords: ['tags', 'labels', 'kategorisering'],
  },
  {
    id: 'zammad_list_reference_data',
    title: 'List Reference Data (Zammad, technician)',
    description: 'Groups, ticket states, and priorities in one call — the valid values for updates.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['groups', 'states', 'priorities', 'reference'],
  },
];

export function searchCapabilities(query: string, limit = 20, available?: Set<string>): ZammadCapability[] {
  const pool = available
    ? ZAMMAD_CAPABILITIES.filter(capability => available.has(capability.id))
    : ZAMMAD_CAPABILITIES;
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return pool.slice(0, limit);
  }
  return pool
    .map(capability => ({ capability, score: scoreCapability(capability, normalized) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: ZammadCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
