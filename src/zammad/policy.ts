import { currentInstancePolicy } from './scope.js';

/**
 * One image, two profiles — selected by ZAMMAD_PROFILE:
 *
 *  - "user" (default): employee self-service. Create tickets, see and
 *    follow up on their own tickets, read the knowledge base. Every call
 *    runs as the requesting user (X-On-Behalf-Of), so Zammad's customer
 *    permission model does the real enforcement.
 *
 *  - "technician": the agent workbench. Everything in user mode plus
 *    full ticket search/triage (state/owner/priority/group), internal
 *    notes, user/organization management, and tags. Also impersonated,
 *    so actions are attributed to the actual technician.
 *
 * Identity comes from an authenticating proxy as X-MCP-User and is only
 * honored when ZAMMAD_TRUST_FORWARDED_USER=true (the proxy must strip the
 * header from client traffic and set it itself; MCP_HTTP_TOKEN is required).
 *
 * Over HTTP the server fails closed: a request without a trusted identity
 * is rejected instead of silently running as the (admin) token user. The
 * token-user fallback is kept for stdio and for HTTP deployments that set
 * ZAMMAD_ALLOW_TOKEN_USER=true explicitly (with the trust flag off).
 */
export type ZammadProfile = 'user' | 'technician';

/** The profile in effect: an embedded gateway call always has the technician tool set; ZAMMAD_PROFILE is not read. */
export function profile(): ZammadProfile {
  if (currentInstancePolicy()) {
    return 'technician';
  }
  return process.env.ZAMMAD_PROFILE === 'technician' ? 'technician' : 'user';
}

export function trustForwardedUser(): boolean {
  return process.env.ZAMMAD_TRUST_FORWARDED_USER === 'true';
}

export function allowTokenUser(): boolean {
  return process.env.ZAMMAD_ALLOW_TOKEN_USER === 'true';
}

/** A Zammad login/email: no whitespace/control characters, bounded length. */
export function isValidForwardedUser(value: string): boolean {
  return value.length > 0 && value.length <= 254 && /^[^\s\x00-\x1f\x7f]+$/.test(value);
}

export interface ZammadPolicyDecision {
  allowed: boolean;
  reason: string;
}

const USER_TOOLS = new Set([
  'zammad_search_capabilities',
  'zammad_whoami',
  'zammad_list_tickets',
  'zammad_get_ticket',
  'zammad_create_ticket',
  'zammad_reply_ticket',
  'zammad_update_ticket',
  'zammad_download_attachment',
  'zammad_search_knowledge_base',
]);

const TECHNICIAN_TOOLS = new Set([
  ...USER_TOOLS,
  'zammad_search_tickets',
  'zammad_list_users',
  'zammad_manage_user',
  'zammad_list_organizations',
  'zammad_manage_tags',
  'zammad_list_reference_data',
]);

/** The embedded gateway's tools (prefixed names), and which of them change data in Zammad. */
export const GATEWAY_READ_TOOLS: ReadonlySet<string> = new Set([
  'zammad_search_capabilities',
  'zammad_check_connection',
  'zammad_list_tickets',
  'zammad_search_tickets',
  'zammad_get_ticket',
  'zammad_search_knowledge_base',
  'zammad_list_users',
  'zammad_list_organizations',
  'zammad_list_reference_data',
  'zammad_list_tags',
]);

export const GATEWAY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'zammad_create_ticket',
  'zammad_add_note',
  'zammad_send_reply',
  'zammad_update_ticket',
  'zammad_add_tag',
  'zammad_remove_tag',
  'zammad_manage_user',
]);

/**
 * Inside a gateway call (always under an InstancePolicy, src/zammad/scope.ts)
 * no environment variable is read: a tool the host disabled is refused, and a
 * write tool runs only when the host enabled writes.
 */
function checkHostedToolPolicy(toolName: string): ZammadPolicyDecision {
  const hosted = currentInstancePolicy()!;
  if (hosted.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }
  if (GATEWAY_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read tool' };
  }
  if (GATEWAY_WRITE_TOOLS.has(toolName)) {
    return hosted.enableWrites
      ? { allowed: true, reason: 'writes enabled by the embedding host' }
      : { allowed: false, reason: 'writes are disabled. The embedding host has not enabled writes for this instance.' };
  }
  return { allowed: false, reason: 'tool is not a gateway tool.' };
}

export function checkToolPolicy(toolName: string): ZammadPolicyDecision {
  if (currentInstancePolicy()) {
    return checkHostedToolPolicy(toolName);
  }
  const tools = profile() === 'technician' ? TECHNICIAN_TOOLS : USER_TOOLS;
  if (tools.has(toolName)) {
    return { allowed: true, reason: `allowed in ${profile()} profile` };
  }
  if (TECHNICIAN_TOOLS.has(toolName)) {
    return { allowed: false, reason: `tool requires the technician profile: ${toolName}` };
  }
  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}

export function toolNamesForProfile(): Set<string> {
  return profile() === 'technician' ? TECHNICIAN_TOOLS : USER_TOOLS;
}
