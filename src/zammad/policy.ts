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
 * Identity comes from the gateway as X-MCP-User and is only honored when
 * ZAMMAD_TRUST_FORWARDED_USER=true (the header is stripped from public
 * traffic by the gateway; only the internal network can set it).
 */
export type ZammadProfile = 'user' | 'technician';

export function profile(): ZammadProfile {
  return process.env.ZAMMAD_PROFILE === 'technician' ? 'technician' : 'user';
}

export function trustForwardedUser(): boolean {
  return process.env.ZAMMAD_TRUST_FORWARDED_USER === 'true';
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

export function checkToolPolicy(toolName: string): ZammadPolicyDecision {
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
