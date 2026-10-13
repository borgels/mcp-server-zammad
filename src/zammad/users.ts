import type { ZammadClient } from './client.js';
import { pathSegment } from './path.js';
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
    return client.get(`/users/${pathSegment(input.userId)}`, { expand: true });
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
  /** Zammad user fields — only MANAGE_USER_FIELDS are accepted. */
  payload: Record<string, unknown>;
}

/**
 * Profile/contact fields a technician may set. Everything else — roles,
 * group access, secondary organizations, passwords, login, active flag,
 * permissions — is refused and stays in the Zammad admin UI.
 */
export const MANAGE_USER_FIELDS: ReadonlySet<string> = new Set([
  'firstname',
  'lastname',
  'email',
  'phone',
  'mobile',
  'fax',
  'web',
  'department',
  'address',
  'street',
  'zip',
  'city',
  'country',
  'note',
  'vip',
  'organization',
  'organization_id',
]);

/** Fields only accepted on create (changing them later could rebind an identity). */
const CREATE_ONLY_FIELDS: ReadonlySet<string> = new Set(['email']);

/**
 * Create/update customers (e.g. register a new employee so tickets can be
 * opened for them). Only an explicit allowlist of profile/contact fields is
 * forwarded; role/group/organization-association/password changes belong in
 * the Zammad admin UI.
 */
export async function manageUser(client: ZammadClient, input: ManageUserInput): Promise<unknown> {
  const keys = Object.keys(input.payload);
  const refused = keys.filter(
    key => !MANAGE_USER_FIELDS.has(key) || (input.action === 'update' && CREATE_ONLY_FIELDS.has(key)),
  );
  if (refused.length > 0) {
    throw new Error(
      `Refusing to set ${refused.join(', ')} — only ${[...MANAGE_USER_FIELDS].join(', ')} can be set here ` +
        '(email only on create); roles, groups, organization memberships and passwords are managed in the Zammad admin UI.',
    );
  }
  if (keys.length === 0) {
    throw new Error('payload must contain at least one field.');
  }

  if (input.action === 'create') {
    return client.post('/users', input.payload);
  }
  if (!input.userId) {
    throw new Error('userId is required for action=update.');
  }
  return client.put(`/users/${pathSegment(input.userId)}`, input.payload);
}

export async function listOrganizations(
  client: ZammadClient,
  input: { query?: string; organizationId?: number } = {},
): Promise<unknown> {
  if (input.organizationId) {
    return client.get(`/organizations/${pathSegment(input.organizationId)}`, { expand: true });
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
