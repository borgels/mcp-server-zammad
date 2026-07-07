# Changelog

## 0.1.0

- Initial Zammad MCP server.
- Added stdio and Streamable HTTP transports.
- Added curated read tools for tickets, articles, tags, ticket states,
  priorities, groups, and users.
- Added the `./gateway` export (`createZammadGateway`) with a read-first,
  write-gated tool surface for the Borgels agent gateway.
- Added Knowledge Base search and read tools with an Elasticsearch-first search
  fallback ladder (global search, then `knowledge_bases/init` + client-side
  substring filtering with a short-lived in-memory graph cache).
- Added gated write tools (internal notes, articles, state changes, tags, and
  ticket create/update) that are disabled unless `ZAMMAD_ENABLE_WRITES=true`.
- Added token/bearer credentials from environment only, safe base URL checks,
  and redacted errors.
