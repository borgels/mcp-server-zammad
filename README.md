# mcp-server-zammad

TypeScript MCP server for the [Zammad](https://zammad.org) helpdesk REST API and
Knowledge Base API. It is intentionally boring good: typed, documented,
read-first, credential-sane, and write-gated.

> **Disclaimer:** This is an independent, unofficial project by Borgels. Borgels
> is not affiliated with, endorsed by, or supported by Zammad. "Zammad" is
> referenced only to describe what this server talks to. You need your own Zammad
> instance and API token, and use of the API is subject to Zammad's own terms.
>
> This project is original work licensed under Apache-2.0. It was written against
> the public Zammad REST and Knowledge Base API documentation and does not reuse
> code from other (AGPL or unlicensed) Zammad MCP servers.

## Scope

The server exposes Zammad through curated tools:

- Read tools for tickets, articles, tags, ticket states, priorities, groups, and
  users.
- Knowledge Base search and read tools with an Elasticsearch-first fallback
  ladder.
- Gated write tools for notes, articles, state changes, tags, and ticket
  create/update.

Default install mode is read-first. Write tools are registered but refuse to run
unless `ZAMMAD_ENABLE_WRITES=true` is set in the server environment. In the
Borgels agent gateway (`./gateway`) the same write tools are exposed with
`enabledByDefault: false`.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Create an API token in Zammad (Profile → Token Access), then set it in the MCP
server environment. The server never accepts credentials as tool arguments.

```sh
export ZAMMAD_URL="https://helpdesk.example.com"
export ZAMMAD_TOKEN="your-access-token"
```

The server appends `/api/v1` itself, so `ZAMMAD_URL` should be the instance root.
`ZAMMAD_BASE_URL` is accepted as an alias, and a trailing `/api/v1` is tolerated.

Optional settings:

```sh
export ZAMMAD_TIMEOUT_MS=30000
# Use an OAuth bearer token instead of a Zammad HTTP token:
export ZAMMAD_BEARER_TOKEN="your-oauth-token"
# Enable the gated write tools:
export ZAMMAD_ENABLE_WRITES=true
```

## Claude Or Cursor Config

Use the stdio server for local MCP clients:

```json
{
  "mcpServers": {
    "zammad": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-zammad/dist/transports/stdio.js"],
      "env": {
        "ZAMMAD_URL": "https://helpdesk.example.com",
        "ZAMMAD_TOKEN": "your-access-token"
      }
    }
  }
}
```

During development:

```json
{
  "mcpServers": {
    "zammad": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-zammad"],
      "env": {
        "ZAMMAD_URL": "https://helpdesk.example.com",
        "ZAMMAD_TOKEN": "your-access-token"
      }
    }
  }
}
```

## Tools

### Reads (enabled by default)

- `get_ticket` — fetch one ticket by id (uses `expand=true`).
- `search_tickets` — search tickets with a Zammad query string.
- `list_articles` — list all articles on a ticket.
- `get_ticket_tags` — list a ticket's tags.
- `list_ticket_states` — list configured ticket states.
- `list_ticket_priorities` — list configured priorities.
- `list_groups` — list helpdesk groups (queues).
- `get_user` — fetch one user by id.
- `search_users` — search agents and customers.
- `kb_search` — search the knowledge base (see below).
- `kb_read` — fetch a knowledge base answer body.

### Gated writes (require `ZAMMAD_ENABLE_WRITES=true`)

- `add_internal_note` — append an internal, agent-only note to a ticket.
- `add_article` — append an article (public reply or note) to a ticket.
- `set_state` — change a ticket's state.
- `add_tag` / `remove_tag` — attach or detach a tag.
- `create_ticket` — create a ticket with an optional first article.
- `update_ticket` — update fields on a ticket.

Reads use `expand=true` so association ids resolve to human-readable names.

## Knowledge Base Search

Zammad has no dedicated Knowledge Base search endpoint, so `kb_search` uses a
fallback ladder:

1. Global full-text search:
   `GET /api/v1/search?query=…&objects=KnowledgeBaseAnswer::Translation`. This
   requires **Elasticsearch** on the Zammad host.
2. If that yields nothing or is unavailable, the server calls
   `POST /api/v1/knowledge_bases/init`, caches the returned graph in memory for a
   short TTL, and matches answer titles/bodies by substring.

Both paths return compact records:

```json
{
  "answer_id": 10,
  "translation_id": 100,
  "title": "How to reset your password",
  "category": "Accounts",
  "published": true,
  "body_preview": "Open settings and click reset..."
}
```

When nothing matches, `kb_search` returns a structured empty result
(`{ "message": "…", "query": "…" }`) rather than an error.

`kb_read` fetches the full answer body via
`GET /api/v1/knowledge_bases/{kb_id}/answers/{answer_id}?include_contents={translation_id}`.
If `kb_id` or `translation_id` are omitted, they are derived from the cached init
graph.

## Borgels Gateway

The package exports a gateway contract from `mcp-server-zammad/gateway` for the
Borgels agent gateway:

```ts
import { createZammadGateway, zammadGatewayTools } from 'mcp-server-zammad/gateway';

const gateway = createZammadGateway({
  baseUrl: process.env.ZAMMAD_URL,
  token: process.env.ZAMMAD_TOKEN,
});

const result = await gateway.callTool('get_ticket', { id: 42 });
```

`zammadGatewayTools` describes every tool with a `riskLevel` (`read` / `write`)
and `enabledByDefault` flag. Reads are enabled by default; writes are not.

## Streamable HTTP Transport

```sh
npm run dev:http
```

- Binds to `127.0.0.1` by default.
- Set `MCP_HTTP_TOKEN` to require bearer auth.
- Set `MCP_ALLOWED_ORIGINS` for browser-based local clients. Without it, loopback
  origins are allowed and other origins are rejected.
- `MCP_MAX_BODY_BYTES` defaults to `10485760` (10 MiB).

## Live Smoke Test

The normal test suite uses mocked `fetch`. With real credentials you can run a
read-only live smoke test:

```sh
npm run smoke:live
```

It calls read tools and the knowledge base search ladder only; it never touches
write endpoints.

## Security

- Credentials are read from environment variables only.
- `ZAMMAD_URL` must be `https://`; loopback `http://` is allowed for local mocks.
- Formatted errors redact `Authorization` headers, `Token token=…` material,
  bearer/basic tokens, and configured secrets.
- Write tools are disabled unless `ZAMMAD_ENABLE_WRITES=true`.
- The Streamable HTTP transport binds to loopback and supports optional bearer
  auth and origin allowlisting.

Security reports: security@borgels.com.
