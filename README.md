# mcp-server-zammad

MCP server for the [Zammad](https://docs.zammad.org/en/latest/api/intro.html) helpdesk API with **per-user impersonation**: behind an authenticating gateway, every Zammad call runs as the actual requesting user (Zammad's `From` header), so Zammad's own permission model does the enforcement — customers only see their tickets, and every article/change is attributed to the real person.

This is an independent, unofficial project. It is not developed, endorsed or supported by Zammad.

## Profiles

One image, two tool sets, selected by `ZAMMAD_PROFILE`:

- **`user`** — employee self-service: `zammad_create_ticket`, `zammad_list_tickets`, `zammad_get_ticket` (full conversation), `zammad_reply_ticket` (always public), `zammad_update_ticket` (title/state only), `zammad_download_attachment`, `zammad_search_knowledge_base`, `zammad_whoami`.
- **`technician`** — everything above plus `zammad_search_tickets` (Elasticsearch syntax), internal notes + article-type control on replies (type `email` really sends mail), owner/priority/group on updates, ticket creation on behalf of customers (unknown emails auto-created via Zammad's `guess:` syntax), `zammad_list_users` / `zammad_manage_user` (explicit allowlist of profile/contact fields; roles, groups, organization memberships and passwords refused; email only on create), `zammad_list_organizations`, `zammad_manage_tags`, `zammad_list_reference_data`.

**No delete tools** — ticket and user deletion is permanent in Zammad and stays in the admin UI.

## Identity

The HTTP transport reads `X-MCP-User` (set by your gateway from a verified token) and binds it per request when `ZAMMAD_TRUST_FORWARDED_USER=true`. The API token needs `admin.user` for impersonation.

The HTTP transport fails closed:

- With `ZAMMAD_TRUST_FORWARDED_USER=true`, `MCP_HTTP_TOKEN` must be set (the server refuses to start otherwise), and every request without a valid `X-MCP-User` is rejected with 401.
- With the trust flag off, requests are rejected unless `ZAMMAD_ALLOW_TOKEN_USER=true` is set explicitly, in which case every request runs as the API token user (single-user / trusted-network deployments only).
- stdio always runs as the token user.

## Configuration

See `.env.example`. Required: `ZAMMAD_BASE_URL`, `ZAMMAD_API_TOKEN` (sent as `Authorization: Bearer`).
Numeric settings such as `ZAMMAD_TIMEOUT_MS` must be plain integers; an invalid value stops the server at startup.

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port. |
| `MCP_HTTP_TOKEN` | – | Bearer token required on `/mcp`. At least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. Required for any non-loopback bind, with `MCP_ALLOW_ANY_ORIGIN=true`, and with `ZAMMAD_TRUST_FORWARDED_USER=true`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve a non-loopback bind without a token (only when access is restricted by other means). Does not lift the token requirement of `ZAMMAD_TRUST_FORWARDED_USER`. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow every origin (requires `MCP_HTTP_TOKEN`). |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Without it, a loopback bind only accepts localhost names and no check is done on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get 429; `0` disables. Valid tokens are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

`GET /healthz` answers `{"status":"ok"}` without authentication. The server shuts down gracefully on SIGTERM/SIGINT.

## Embedding (`./gateway`)

`mcp-server-zammad/gateway` lets a host application run the tools in-process
instead of over MCP, in the same shape as `mcp-server-template`. One process
can run several gateway instances, for example one per tenant.

```ts
import { createZammadGateway, normalizeZammadBaseUrl, zammadToolCatalog } from 'mcp-server-zammad/gateway';

// Before storing an address a customer typed: throws GatewayConfigError, or returns https://<host>.
const baseUrl = normalizeZammadBaseUrl(input.address);

const gateway = createZammadGateway({
  apiToken: tenant.zammadToken,
  baseUrl,
  policy: { enableWrites: true, audit: record => log(record) },
});
const result = await gateway.callTool('list_tickets', { query: 'state.name:open' }, { caller: 'user-1' });
```

The module exports:

- `createZammadGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`.
  `apiToken` is a Zammad personal access token (sent as
  `Authorization: Bearer`), `baseUrl` the customer's Zammad address
  (`https://company.zammad.com` or a self-hosted https address; the client adds
  `/api/v1`). Both are required and never read from the environment. The
  gateway reads no `ZAMMAD_*` variable at all: not `ZAMMAD_API_TOKEN`,
  `ZAMMAD_BASE_URL`, `ZAMMAD_PROFILE` (the gateway always has the technician
  tool set), `ZAMMAD_TRUST_FORWARDED_USER`/`ZAMMAD_ALLOW_TOKEN_USER`,
  `ZAMMAD_TIMEOUT_MS` (default 30 seconds), `ZAMMAD_DEFAULT_GROUP` (a ticket
  without a group goes to `Users`) or `ZAMMAD_AUDIT_LOG`.
- **No impersonation.** The gateway never sends `From` or `X-On-Behalf-Of`:
  every call runs as the user who owns the token, with that user's Zammad
  permissions. Per-person rights are the host's business.
- `normalizeZammadBaseUrl(url)`: a pure check a host can run before it stores
  an address. It returns `https://<host>` (lower case, no trailing slash or
  dot) or throws `GatewayConfigError` with a message starting
  `Zammad address refused:` (`ADDRESS_REFUSED`) that never quotes the value.
  Refused: anything but `https://`, a user name or password, a port, a path,
  a query string or a fragment, an IP address, `localhost` and local or
  single-label names (`.local`, `.internal`, `.lan`, `.home.arpa`, ...).
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId })`. Names are accepted
  with or without the `zammad_` prefix. Input is validated with the tool's zod
  schema before anything is sent, and unknown fields are refused. The audit
  records of a call hold `caller` only as an HMAC pseudonym (a per-process
  key) and a request id of the server's own; the host's `requestId` is not
  written. An error is recorded as a fixed code (`http_<status>`, `timeout`
  or `error`), never as its message.
- `zammadGatewayTools`: the definitions (`name` without prefix, `title`,
  `description`, `riskLevel`, `enabledByDefault`, `inputSchema` as JSON
  Schema derived from the zod schema the call is validated with).
- `zammadToolCatalog`: the same tools, deeply frozen, with `upstream` (method
  and path template of every Zammad request the tool may make) and `broad`
  (no Zammad tool is broad).
- `GatewayConfigError`, `KEY_REFUSED`, `ADDRESS_REFUSED`,
  `PRIVATE_ADDRESS_REFUSED` and the types (`ZammadGatewayOptions`,
  `ZammadGateway`, `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types such as `GatewayJsonObject`).

| Tool | Risk | Default | Zammad requests (on `baseUrl`) |
|---|---|---|---|
| `search_capabilities` | read | on | none |
| `check_connection` | read | on | `GET /api/v1/users/me` |
| `list_tickets` | read | on | `GET /api/v1/tickets`, `GET /api/v1/tickets/search` |
| `search_tickets` | read | on | `GET /api/v1/tickets/search` |
| `get_ticket` | read | on | `GET /api/v1/tickets/{ticketId}`, `GET /api/v1/ticket_articles/by_ticket/{ticketId}` |
| `search_knowledge_base` | read | on | `GET /api/v1/search`, `GET /api/v1/knowledge_bases/{knowledgeBaseId}/answers/{answerId}` |
| `list_users` | read | on | `GET /api/v1/users`, `GET /api/v1/users/search`, `GET /api/v1/users/{userId}` |
| `list_organizations` | read | on | `GET /api/v1/organizations`, `GET /api/v1/organizations/search`, `GET /api/v1/organizations/{organizationId}` |
| `list_reference_data` | read | on | `GET /api/v1/groups`, `GET /api/v1/ticket_states`, `GET /api/v1/ticket_priorities` |
| `list_tags` | read | on | `GET /api/v1/tags` |
| `create_ticket` | write | off | `POST /api/v1/tickets` |
| `add_note` | write | off | `POST /api/v1/ticket_articles` (internal note) |
| `send_reply` | write | off | `GET /api/v1/tickets/{ticketId}`, `GET /api/v1/users/{userId}`, `POST /api/v1/ticket_articles` (email to the customer) |
| `update_ticket` | write | off | `PUT /api/v1/tickets/{ticketId}` |
| `add_tag` | write | off | `POST /api/v1/tags/add` |
| `remove_tag` | write | off | `POST /api/v1/tags/remove` |
| `manage_user` | write | off | `POST /api/v1/users`, `PUT /api/v1/users/{userId}` |

`add_note` adds an internal note (the customer does not see it, no mail is
sent). `send_reply` makes Zammad **send a real email** to the ticket's
customer (the customer's email address, the ticket title as subject). There
are no delete tools, and no attachment download in the gateway. Read tools
get a client that can only `GET`. The MCP server's own tools
(`zammad_reply_ticket`, `zammad_manage_tags`, ...) are unchanged.

**Address and network.** Every connection goes only to public addresses:
the host name is resolved and every address must be public unicast
(private, loopback, link-local, carrier-grade NAT, unique local, metadata
and documentation ranges, and IPv4 embedded in IPv6 are refused). With the
built-in fetch the check runs in the connection's own lookup, so the address
checked is the address used (DNS rebinding is checked per connection). With
a host `fetchImpl` the name is checked before every request. A refusal
happens at the call, not at construction, as an error result
`Refused: the Zammad address points to a private or local network address.`
(`PRIVATE_ADDRESS_REFUSED`); a name that does not resolve gives
`Network error calling the Zammad API (GET) (ENOTFOUND).` Redirects are never
followed.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: write tools run only with
`enableWrites: true`; disabled tools are left out of `tools` (and out of
`search_capabilities`) and refused when called; audit records go to `audit`
(none without it). `disabledTools` must name gateway tools. A sink that
throws on a start record refuses the call. Without `policy` the instance uses
the default policy (no writes, no disabled tools, no audit records). Every
call runs in a call scope of its own (AsyncLocalStorage), so a call made from
inside another instance's call never inherits its policy, sink, redactor or
caller. There is no process-wide registry of secrets.

**Results.** A successful result is a short English summary line, a blank
line and the data as compact JSON, exactly equal to `structuredContent`. The
data is redacted twice before it is serialised: credential-shaped text
(Authorization headers, Bearer, Basic and `Token token=` values, JSON Web
Tokens, credential assignments) and the value of credential-named fields are
masked, and the instance's token (exact, encoded, and any piece of 6
characters or more, in strings, keys and the string form of numbers) is
replaced by `‹redacted›`. An answer from Zammad that is not JSON is refused.

**Errors.** An error result carries our own English text, never Zammad's
response body or message, a redirect's `Location` or the configured address.
An HTTP failure starts with `Zammad API request failed with HTTP <status>`,
followed by our own hint (401, 403, 404, 422, 429) and the parsed
`retry-after` where there is one. Other errors start with
`Invalid input for <tool>:`, `Unsupported Zammad gateway tool.`,
`Zammad API responded with a redirect (HTTP <status>)`,
`Network error calling the Zammad API`, `Zammad API request timed out after`,
`Zammad answered with something that is not JSON`, `Refused: the Zammad
address points to a private or local network address.`, or a policy
refusal (`writes are disabled. ...`, `tool is disabled on this instance by
the embedding host: <tool>`).
When Zammad answered with an HTTP error, the error result also has
`failure: { httpStatus, requestId? }`: the status, and Zammad's request id
from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`; Zammad, a
Rails application, sends `X-Request-Id`) only when it is a hex id of 8 to 64
characters (one run of hex digits, or groups of four or more joined by single
hyphens, as in a UUID) and does not hold the shape of a personal number. A
host can count failures from it without reading their text. Never the
response body, Zammad's error code or message.

**Token admission and the sink check.** A gateway accepts only a token of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece of
6 characters with a string literal in `src/` (`src/fixed-corpus.generated.ts`,
kept up to date by a test), with the fixed fallbacks (`src/fallbacks.ts`) or
with the tool list. A refused token throws `GatewayConfigError` at
construction (`options.apiToken: A credential was refused: ...`), before
anything is built or sent; the refusal holds no piece of the token, and every
error a gateway throws has no `cause` and a `stack` of only `name: message`.
As the very last step every output (the tool list, each result, each audit
record) is checked in its final form, and one that still holds a piece of the
token is replaced by a fixed fallback. Whether Zammad accepts the token is
only known at the first call (`check_connection`: HTTP 401).

## Security model

- The server calls Zammad with one configured API token. With `ZAMMAD_TRUST_FORWARDED_USER=true` each request is executed as the forwarded user via Zammad's `From` impersonation header, so Zammad's permissions for that user apply; otherwise every request runs as the token user.
- Authenticating end users and deciding who may use which identity belongs in an identity-aware proxy or gateway in front of this server. `MCP_HTTP_TOKEN` only authenticates that caller; the proxy must strip `X-MCP-User` from client traffic and set it itself.
- Tool access is not data access: the profile limits which tools exist, while the data a tool can reach is limited only by the Zammad permissions of the acting user.
- The HTTP server does not terminate TLS. Run it on a private network or behind a TLS-terminating proxy.
- Upstream redirects are never followed, so the token is only sent to `ZAMMAD_BASE_URL`.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-zammad` (published on push to `main`).

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.5.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
