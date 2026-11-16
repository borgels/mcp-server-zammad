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
