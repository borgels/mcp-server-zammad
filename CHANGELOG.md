# Changelog

## 0.6.0 (2026-11-22)

- Gateway: changes are made as the person the host names. A host passes
  `actAs: { email }` (the template's shared shape, `src/act-as.ts`) in the
  call context; every write tool then finds exactly one active Zammad user
  with that email (`GET /api/v1/users/search`, as the token's user) and sends
  the change with `From: <user id>`, so Zammad records the person as the
  author and applies their permissions. No such user (or more than one):
  nothing is sent, `actAsRefused: 'no_user'`. Zammad refusing `From` (401):
  `actAsRefused: 'not_permitted'`. A malformed `actAs`: `invalid`. Reads run
  as the token's user. Never a fallback to the token's user for a change; the
  email is never audited. The catalog's write tools declare the lookup in
  `upstream` (#47).
- The read-only client view of a gateway read tool also refuses `DELETE`.

## 0.5.2 (2026-11-22)

- `remove_tag` (and `zammad_manage_tags` with action `remove`) now sends
  `DELETE /api/v1/tags/remove`, the only method Zammad routes for that path
  (`config/routes/tag.rb`). It sent `POST`, so the tag stayed on the ticket
  and the tool returned an error. The client has a `delete` method with a
  JSON body, the catalog's `upstream` for `remove_tag` says `DELETE`, and a
  test pins the method for both tag tools (#45).

## 0.5.1 (2026-11-21)

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.5.0 (2026-11-21)

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.5.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.4.0

- Gateway error results carry failure metadata: when Zammad answered with
  an HTTP error, the result has `failure: { httpStatus, requestId? }`, so a
  host can count failures by status without reading their text.
  `requestId` is Zammad's own id from a response header
  (`REQUEST_ID_HEADERS`; Zammad sends `X-Request-Id`), kept only when it is
  a hex id of 8 to 64 characters (one run of hex digits, or groups of four
  or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the token is dropped. Never the body, Zammad's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`).

## 0.3.0 (2026-11-20)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
for hosts that run one instance per tenant in a shared process.

### Changes

- `createZammadGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`:
  the token and the customer's Zammad address are required and never read
  from the environment; the gateway reads no `ZAMMAD_*` variable. It never
  impersonates (no `From`/`X-On-Behalf-Of`) and always has the technician
  tool set.
- `normalizeZammadBaseUrl(url)`: https and a public host name only (no user
  info, port, path, query or fragment, no IP address or local name). Every
  connection of a gateway goes only to public addresses, checked by DNS per
  connection (built-in fetch) or before every request (host fetch).
- Tools: reads `search_capabilities`, `check_connection`, `list_tickets`,
  `search_tickets`, `get_ticket`, `search_knowledge_base`, `list_users`,
  `list_organizations`, `list_reference_data`, `list_tags`; writes (off by
  default) `create_ticket`, `add_note` (internal note), `send_reply` (email
  to the customer), `update_ticket`, `add_tag`, `remove_tag`, `manage_user`.
  No delete, no attachment download.
- `zammadToolCatalog`: deeply frozen, with `inputSchema` from the strict zod
  schema, `upstream` and `broad`.
- Token admission, host policy `{ enableWrites, disabledTools, audit }`, call
  scopes, redaction per instance, the sink check and sealed construction
  errors, as in the template.
- Errors are our own text: `Zammad API request failed with HTTP <status>`
  with our hint and `retry-after`; Zammad's error bodies are no longer read,
  also in the MCP server. Redirects, network failures and timeouts are
  worded by us and quote neither the address nor the cause.
- The audit records an error as a fixed code (`http_<status>`, `timeout`,
  `error`) instead of its message, also in the MCP server.

### Upgrade notes

- Node 22.19 or later (the gateway uses `undici` and `ipaddr.js`).
- MCP server error texts no longer include Zammad's `error_human` text.

## 0.2.0

### Upgrade notes

- The HTTP server refuses to start on a non-loopback bind (`MCP_HTTP_HOST`/`HOST`
  other than 127.0.0.1/localhost/::1), or with `MCP_ALLOW_ANY_ORIGIN=true`, unless
  `MCP_HTTP_TOKEN` is set. `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit
  escape hatch for networks restricted by other means.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters
  (e.g. `openssl rand -hex 32`).
- `PORT`, `MCP_MAX_BODY_BYTES`, `ZAMMAD_TIMEOUT_MS` and the boolean `MCP_*` flags
  are validated; invalid values stop the server at startup instead of becoming NaN.
- `ZAMMAD_BASE_URL` is validated at startup of the HTTP server.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`, `MCP_ALLOWED_HOSTS`,
  `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.

### Changes

- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  (JSON-RPC parse error) instead of 500; oversized bodies get 413 before the body is
  read when `Content-Length` is too large.
- HTTP: failed authentication is counted per client address; after the limit
  further failures get 429 with `Retry-After`. Valid tokens are never throttled.
- HTTP: `Host` header check on loopback binds (DNS rebinding);
  `GET /healthz`; graceful shutdown on SIGTERM/SIGINT; one log line per rejected
  request.
- Zammad client: redirects are never followed, so the token and the impersonation
  header are only sent to `ZAMMAD_BASE_URL`. Error bodies are read up to 64 KB;
  the token is redacted before error text is truncated; query strings are not
  included in error URLs. The attachment size cap is enforced while streaming.
- The server reports the package version.
- Dependencies updated within their ranges; container images are published only
  after CI passes, with SBOM and provenance attestations.
- Security: the HTTP transport now fails closed when no trusted user
  identity is available instead of falling back to the API token user.
  Token-user mode over HTTP requires the new `ZAMMAD_ALLOW_TOKEN_USER=true`.
- Security: `ZAMMAD_TRUST_FORWARDED_USER=true` now requires `MCP_HTTP_TOKEN`
  (refuses to start otherwise); the token is compared in constant time.
- Security: `zammad_manage_user` accepts an explicit allowlist of
  profile/contact fields instead of refusing a fixed denylist.
- Hardening: caller-supplied URL path parameters are validated before use.

## 0.1.0

Initial release.

- Two profiles from one image (ZAMMAD_PROFILE): "user" — self-service
  (create/list/read tickets, reply, close/reopen, attachments, knowledge
  base search); "technician" — adds full ticket search/triage
  (owner/priority/group), internal notes, article-type control, user and
  organization management (roles/passwords refused), tags, reference data.
- Per-user identity: the gateway-verified user (X-MCP-User) becomes
  Zammad's `From` impersonation header, so Zammad enforces the actual
  user's permissions and attributes every action to them.
- No delete tools (ticket/user deletion is permanent in Zammad).
- Zammad quirks handled: guess:-syntax auto-creates customers, KB answer
  bodies fetched via include_contents with translation discovery.
