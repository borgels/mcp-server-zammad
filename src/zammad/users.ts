import type { ZammadClient } from './client.js';
import { MAX_PER_PAGE } from './tickets.js';

export async function whoami(client: ZammadClient): Promise<unknown> {
  const me = await client.get<Record<string, unknown>>('/users/me');
  return {
    actingAs: client.onBehalfOf ?? '(token user)',
    id: me.id,
    login: me.login,
    firstname: me.firstname,
    lastname: me.lastname,
    email: me.email,
    organization_id: me.organization_id,
    role_ids: me.role_ids,
  };
}

export interface ListUsersInput {
  query?: string;
  userId?: number;
  page?: number;
  perPage?: number;
}

export async function listUsers(client: ZammadClient, input: ListUsersInput = {}): Promise<unknown> {
  if (input.userId) {
    return client.get(`/users/${input.userId}`, { expand: true });
  }
  const pagination = {
    page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 25, MAX_PER_PAGE),
    expand: true,
  };
  if (input.query) {
    return client.get('/users/search', { ...pagination, query: input.query });
  }
  return client.get('/users', pagination);
}

export interface ManageUserInput {
  action: 'create' | 'update';
  userId?: number;
  /** Zammad user fields: email, firstname, lastname, organization, phone, note, … */
  payload: Record<string, unknown>;
}

/**
 * Create/update customers (e.g. register a new employee so tickets can be
 * opened for them). Role/password/permission changes are refused — those
 * belong in the Zammad admin UI.
 */
export async function manageUser(client: ZammadClient, input: ManageUserInput): Promise<unknown> {
  const forbidden = ['role_ids', 'roles', 'password', 'group_ids', 'permissions'];
  const used = forbidden.filter(key => key in input.payload);
  if (used.length > 0) {
    throw new Error(`Refusing to set ${used.join(', ')} — roles/passwords/groups are managed in the Zammad admin UI.`);
  }

  if (input.action === 'create') {
    return client.post('/users', input.payload);
  }
  if (!input.userId) {
    throw new Error('userId is required for action=update.');
  }
  return client.put(`/users/${input.userId}`, input.payload);
}

export async function listOrganizations(
  client: ZammadClient,
  input: { query?: string; organizationId?: number } = {},
): Promise<unknown> {
  if (input.organizationId) {
    return client.get(`/organizations/${input.organizationId}`, { expand: true });
  }
  if (input.query) {
    return client.get('/organizations/search', { query: input.query, expand: true });
  }
  return client.get('/organizations', { expand: true });
}

export interface ManageTagsInput {
  action: 'list' | 'add' | 'remove';
  ticketId: number;
  tag?: string;
}

export async function manageTags(client: ZammadClient, input: ManageTagsInput): Promise<unknown> {
  if (input.action === 'list') {
    return client.get('/tags', { object: 'Ticket', o_id: input.ticketId });
  }
  if (!input.tag) {
    throw new Error('tag is required for add/remove.');
  }
  const body = { item: input.tag, object: 'Ticket', o_id: input.ticketId };
  return input.action === 'add' ? client.post('/tags/add', body) : client.post('/tags/remove', body);
}

export async function listReferenceData(client: ZammadClient): Promise<unknown> {
  const [groups, states, priorities] = await Promise.all([
    client.get('/groups'),
    client.get('/ticket_states'),
    client.get('/ticket_priorities'),
  ]);
  return { groups, states, priorities };
}
