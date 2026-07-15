# mcp-server-zammad

MCP server for the [Zammad](https://docs.zammad.org/en/latest/api/intro.html) helpdesk API with **per-user impersonation**: behind an authenticating gateway, every Zammad call runs as the actual requesting user (Zammad's `From` header), so Zammad's own permission model does the enforcement — customers only see their tickets, and every article/change is attributed to the real person.

## Profiles

One image, two tool sets, selected by `ZAMMAD_PROFILE`:

- **`user`** — employee self-service: `zammad_create_ticket`, `zammad_list_tickets`, `zammad_get_ticket` (full conversation), `zammad_reply_ticket` (always public), `zammad_update_ticket` (title/state only), `zammad_download_attachment`, `zammad_search_knowledge_base`, `zammad_whoami`.
- **`technician`** — everything above plus `zammad_search_tickets` (Elasticsearch syntax), internal notes + article-type control on replies (type `email` really sends mail), owner/priority/group on updates, ticket creation on behalf of customers (unknown emails auto-created via Zammad's `guess:` syntax), `zammad_list_users` / `zammad_manage_user` (roles/passwords/groups refused), `zammad_list_organizations`, `zammad_manage_tags`, `zammad_list_reference_data`.

**No delete tools** — ticket and user deletion is permanent in Zammad and stays in the admin UI.

## Identity

The HTTP transport reads `X-MCP-User` (set by your gateway from a verified token) and binds it per request when `ZAMMAD_TRUST_FORWARDED_USER=true`. The API token needs `admin.user` for impersonation. Without a forwarded user, calls run as the token user.

## Configuration

See `.env.example`. Required: `ZAMMAD_BASE_URL`, `ZAMMAD_API_TOKEN` (sent as `Authorization: Bearer`).

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-zammad` (published on push to `main`).
