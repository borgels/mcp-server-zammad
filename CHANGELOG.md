# Changelog

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
