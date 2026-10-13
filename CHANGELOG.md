# Changelog

## Unreleased

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
