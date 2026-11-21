import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  failureMetadata,
  formatUnknownError,
  MAX_REDACT_DEPTH,
  redactCredentialPatterns,
  vendorRequestId,
  type FailureMetadata,
} from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { registerZammadGatewayTools } from './tools/gateway-tools.js';
import { normalizeZammadBaseUrl } from './zammad/address.js';
import { writeAuditEvent } from './zammad/audit.js';
import { ZammadClient, type ZammadClientOptions } from './zammad/client.js';
import type { ResolveHost } from './zammad/network.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './zammad/scope.js';
import { REDACTION_MARKER, SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Schemas, handlers, policy checks and audit
 * live in src/tools/gateway-tools.ts and are shared with the MCP server's
 * modules.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the access token and the Zammad address
 * passed to createZammadGateway and reads no ZAMMAD_* variable at all: not
 * the token (ZAMMAD_API_TOKEN), not the address (ZAMMAD_BASE_URL), not the
 * profile (ZAMMAD_PROFILE: the gateway always has the technician tool set),
 * not the impersonation settings (the gateway never impersonates: no From or
 * X-On-Behalf-Of header, every call runs as the token's own user), not
 * ZAMMAD_TIMEOUT_MS (30 seconds unless `timeoutMs` is given), not
 * ZAMMAD_DEFAULT_GROUP, and none of the audit variables.
 *
 * The address must be https and a public host name (normalizeZammadBaseUrl).
 * Every connection goes only to public addresses: the host name is resolved
 * and each address checked before a connection is made, and redirects are
 * never followed.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`; without it the instance uses the default policy (no
 * writes, no disabled tools, no audit records).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './zammad/scope.js';
export { GatewayConfigError } from './zammad/scope.js';
export { ADDRESS_REFUSED, normalizeZammadBaseUrl } from './zammad/address.js';
export { PRIVATE_ADDRESS_REFUSED } from './zammad/client.js';
export { KEY_REFUSED } from './key-admission.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Zammad answered with, and
 * Zammad's own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, Zammad's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Zammad only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Zammad API request a tool may make: the method and the path template on the customer's Zammad address. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Zammad request the tool may make. Empty for a tool that does not call Zammad. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). No Zammad gateway tool is broad.
   */
  readonly broad: boolean;
}

export interface ZammadGatewayOptions {
  /** The customer's Zammad personal access token, sent as `Authorization: Bearer`. Required; never read from the environment. */
  apiToken: string;
  /**
   * The customer's Zammad address, e.g. https://company.zammad.com or a self-hosted https address. Required; never
   * read from the environment. Checked with normalizeZammadBaseUrl; the client adds /api/v1.
   */
  baseUrl: string;
  /**
   * The fetch to use. Without it the built-in fetch connects only to the
   * public addresses it checked. With it, the host name is still resolved and
   * checked before every request.
   */
  fetchImpl?: typeof fetch;
  /** Time limit per Zammad request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /** Resolves the host name to its addresses (default: the system resolver). For tests and custom DNS. */
  resolveHost?: ResolveHost;
  /**
   * Instance policy from the host. Without it the instance uses the default
   * policy (no writes, no disabled tools, no audit records); it never reads
   * a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/** Time limit per Zammad request when the host gives none. */
const DEFAULT_TIMEOUT_MS = 30_000;

const API = '/api/v1';
const get = (path: string): GatewayUpstreamOperation => ({ method: 'GET', path: `${API}${path}` });
const post = (path: string): GatewayUpstreamOperation => ({ method: 'POST', path: `${API}${path}` });
const put = (path: string): GatewayUpstreamOperation => ({ method: 'PUT', path: `${API}${path}` });

/** The gateway's tools, with their own titles and descriptions. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    title: 'Search Zammad capabilities',
    description: 'Find the Zammad tools this connection offers, with examples.',
    riskLevel: 'read',
    summary: 'Zammad capabilities.',
    upstream: [],
  },
  {
    name: 'check_connection',
    title: 'Check Zammad connection',
    description: 'Verify that Zammad accepts the access token, and show the user it belongs to (name, email and roles).',
    riskLevel: 'read',
    summary: 'Zammad connection checked.',
    upstream: [get('/users/me')],
  },
  {
    name: 'list_tickets',
    title: 'List Zammad tickets',
    description: 'List the tickets the token user can see, newest first, optionally filtered with a search query such as "state.name:open".',
    riskLevel: 'read',
    summary: 'Zammad tickets.',
    upstream: [get('/tickets'), get('/tickets/search')],
  },
  {
    name: 'search_tickets',
    title: 'Search Zammad tickets',
    description: 'Search tickets with Zammad search syntax, e.g. "state.name:open AND priority_id:3" or "customer.email:name@example.com".',
    riskLevel: 'read',
    summary: 'Zammad tickets.',
    upstream: [get('/tickets/search')],
  },
  {
    name: 'get_ticket',
    title: 'Get Zammad ticket',
    description: 'Fetch one ticket, by default with its conversation (articles, internal notes included) and attachment metadata.',
    riskLevel: 'read',
    summary: 'Zammad ticket.',
    upstream: [get('/tickets/{ticketId}'), get('/ticket_articles/by_ticket/{ticketId}')],
  },
  {
    name: 'search_knowledge_base',
    title: 'Search Zammad knowledge base',
    description: 'Search knowledge base answers, or fetch the full content of one answer with knowledgeBaseId and answerId.',
    riskLevel: 'read',
    summary: 'Zammad knowledge base.',
    upstream: [get('/search'), get('/knowledge_bases/{knowledgeBaseId}/answers/{answerId}')],
  },
  {
    name: 'list_users',
    title: 'List Zammad users',
    description: 'List or search users (customers and agents), or fetch one by userId.',
    riskLevel: 'read',
    summary: 'Zammad users.',
    upstream: [get('/users'), get('/users/search'), get('/users/{userId}')],
  },
  {
    name: 'list_organizations',
    title: 'List Zammad organizations',
    description: 'List or search organizations, or fetch one by organizationId.',
    riskLevel: 'read',
    summary: 'Zammad organizations.',
    upstream: [get('/organizations'), get('/organizations/search'), get('/organizations/{organizationId}')],
  },
  {
    name: 'list_reference_data',
    title: 'List Zammad reference data',
    description: 'Groups, ticket states and priorities: the valid values for creating and updating tickets.',
    riskLevel: 'read',
    summary: 'Zammad reference data.',
    upstream: [get('/groups'), get('/ticket_states'), get('/ticket_priorities')],
  },
  {
    name: 'list_tags',
    title: 'List Zammad ticket tags',
    description: 'List the tags on one ticket.',
    riskLevel: 'read',
    summary: 'Zammad ticket tags.',
    upstream: [get('/tags')],
  },
  {
    name: 'create_ticket',
    title: 'Create Zammad ticket',
    description:
      'Open a new ticket with a title and a first message. The token user is the customer unless customer (an email) is given; an unknown email is created as a new customer. Without group the ticket goes to the group "Users".',
    riskLevel: 'write',
    summary: 'Zammad ticket created.',
    upstream: [post('/tickets')],
  },
  {
    name: 'add_note',
    title: 'Add internal note',
    description: 'Add an internal note to a ticket. The customer cannot see it and no email is sent. Notes cannot be edited or deleted afterwards.',
    riskLevel: 'write',
    summary: 'Zammad note added.',
    upstream: [post('/ticket_articles')],
  },
  {
    name: 'send_reply',
    title: 'Send reply to customer',
    description:
      'Send a reply to the ticket\'s customer. Zammad SENDS it as a real email to the customer\'s email address, with the ticket title as subject, and adds it to the ticket. It cannot be recalled, edited or deleted afterwards. For a message only colleagues see, use add_note.',
    riskLevel: 'write',
    summary: 'Zammad reply sent.',
    upstream: [get('/tickets/{ticketId}'), get('/users/{userId}'), post('/ticket_articles')],
  },
  {
    name: 'update_ticket',
    title: 'Update Zammad ticket',
    description:
      'Change a ticket\'s title, state (e.g. open, closed, "pending reminder"), owner, priority or group. pendingTime (ISO timestamp) goes with pending states. Valid values come from list_reference_data.',
    riskLevel: 'write',
    summary: 'Zammad ticket updated.',
    upstream: [put('/tickets/{ticketId}')],
  },
  {
    name: 'add_tag',
    title: 'Add Zammad ticket tag',
    description: 'Add one tag to a ticket.',
    riskLevel: 'write',
    summary: 'Zammad tag added.',
    upstream: [post('/tags/add')],
  },
  {
    name: 'remove_tag',
    title: 'Remove Zammad ticket tag',
    description: 'Remove one tag from a ticket.',
    riskLevel: 'write',
    summary: 'Zammad tag removed.',
    upstream: [post('/tags/remove')],
  },
  {
    name: 'manage_user',
    title: 'Create or update Zammad user',
    description:
      'Create or update a user\'s profile and contact fields: firstname, lastname, email (create only), phone, mobile, fax, web, department, address, street, zip, city, country, note, vip, organization, organization_id. Roles, groups, organization memberships and passwords are refused.',
    riskLevel: 'write',
    summary: 'Zammad user saved.',
    upstream: [post('/users'), put('/users/{userId}')],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/**
 * The gateway's tools as registered: the zod input schema (strict: an
 * unknown field is refused, not dropped) and the handler bound to `client`.
 */
function registeredTools(client: ZammadClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: z.strictObject(config.inputSchema ?? {}), handler });
    },
  };
  registerZammadGatewayTools(server as never, client);
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new ZammadClient({
    apiToken: 'schema-only',
    baseUrl: 'https://schema.invalid',
    credentialEnv: {},
    timeoutMs: 1,
    fetchImpl: () => Promise.reject(new Error('schema only')),
    embedded: { redactor: new SecretRedactor(), resolveHost: async () => [] },
  }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(`${TOOL_PREFIX}${tool.name}`);
  if (!registered) {
    throw new Error(`Zammad gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const zammadGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `zammadGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const zammadToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => `${TOOL_PREFIX}${tool.name}`);
const SUMMARIES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool.summary]),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

function requiredToken(options: ZammadGatewayOptions | undefined, given: readonly unknown[]): string {
  const apiToken: unknown = options?.apiToken;
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new GatewayConfigError(
      'createZammadGateway requires options.apiToken. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(apiToken.trim())) throw new GatewayConfigError(refusedText('options.apiToken', given));
  return apiToken.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiToken` and `baseUrl` are required and are
 * the only connection settings the instance uses; a missing or refused value
 * fails here, before anything is built or sent. Where the address points is
 * checked when a connection is made (first call).
 */
export function createZammadGateway(options: ZammadGatewayOptions) {
  let token: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const raw = options as Partial<ZammadGatewayOptions> | undefined;
  const secrets = typeof raw?.apiToken === 'string' ? [raw.apiToken, raw.apiToken.trim()] : [];
  try {
    // Admission first, before a redactor is built from the token.
    token = requiredToken(options, secrets);
    guard = new SecretRedactor().addSecret(token);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the token.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    const gateway = buildZammadGateway(options, token, guard);
    // The tool list leaves the gateway as it is: a token that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && token !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the token becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the token. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && token !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    }
    throw final;
  }
}

function buildZammadGateway(options: ZammadGatewayOptions, apiToken: string, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes (onBehalfOf, credentialEnv, ...) is dropped.
  const { policy: hostPolicy, baseUrl, fetchImpl, timeoutMs, resolveHost } = options;
  const address = normalizeZammadBaseUrl(baseUrl);
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new GatewayConfigError('options.fetchImpl must be a function.');
  }
  if (resolveHost !== undefined && typeof resolveHost !== 'function') {
    throw new GatewayConfigError('options.resolveHost must be a function.');
  }
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  const clientOptions: ZammadClientOptions = {
    apiToken,
    baseUrl: address,
    credentialEnv: {},
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
    embedded: { redactor, ...(resolveHost ? { resolveHost } : {}) },
  };
  const client = new ZammadClient(clientOptions);
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: zammadGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own.
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data. An error result is our own text, and is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            // The failure metadata is redacted with the rest, then checked again: what is not in form is dropped.
            const final = withFailureInForm(result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result);
            // The sink check, as the very last step: a result that holds a piece of the token anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Zammad gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = name.slice(TOOL_PREFIX.length);
        return errorResult(formatUnknownError(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Zammad gateway result.');
    } catch (error) {
      return errorResult(formatUnknownError(error), failureMetadata(error));
    }
  }
}

/**
 * Field names whose value is a credential whatever it looks like: the value of
 * such a field is replaced whole, not only when it matches a pattern.
 */
const CREDENTIAL_NAME =
  /^x?(authorization|proxyauthorization|cookie|setcookie|(access|refresh|id|session|bearer|auth|api|private|secret|subscription)(token|key)|token|apisecret|clientsecret|secret|password|passwd|credentials?)$/;

/** Whether a field name names a credential, however it is written (case, `-`, `_`, spaces, a leading `x-`). */
function isCredentialField(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ''));
}

/**
 * One text as a gateway may return it: credential-shaped text masked, then the instance's own secrets, then the
 * patterns again (they take the marker as part of a value), until nothing changes.
 */
function redactText(value: string, redactor: SecretRedactor): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactor.redact(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the credential patterns and the redactor, the value of every
 * credential-named field replaced whole, whatever its type, and every number
 * or boolean whose string form would be redacted replaced by the string
 * "‹redacted›". Anything nested deeper than MAX_REDACT_DEPTH is replaced.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactText(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const text = String(value);
    if (redactText(text, redactor) !== text) return REDACTION_MARKER;
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactText(key, redactor),
      isCredentialField(key) && entry !== null && entry !== undefined ? REDACTION_MARKER : redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createZammadGateway. */
export type ZammadGateway = ReturnType<typeof createZammadGateway>;

/**
 * The handler's result as the gateway returns it: its data redacted twice
 * (values, keys and numbers by their string form), and only then serialised
 * after the summary, so a secret cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  let data: unknown = result;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Our handlers always return JSON text; anything else is not passed on.
      return errorResult('The Zammad gateway tool returned something that is not JSON; nothing of it is passed on.');
    }
  }
  // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
  return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
