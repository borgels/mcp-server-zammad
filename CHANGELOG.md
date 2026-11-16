# Changelog

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
