# Model Context Protocol (MCP) server

The API exposes its five governed agent tools to external MCP clients (Claude Desktop, MCP Inspector, custom agents) over Streamable HTTP at `POST /mcp`, in the same Fastify process as REST. Same governance surface as `/chat`'s tool-calling agent — reused, not reimplemented.

## Architecture

- **Package**: [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) `^1.32.2`.
- **Transport**: `StreamableHTTPServerTransport`, **stateless** (no `sessionIdGenerator`) — no session ID, no state between requests, no SSE resumability. `GET`/`DELETE /mcp` (session resume/terminate, stateful-only) return `405`.
- **One server instance per request**: `src/mcp/routes.ts` builds a fresh `McpServer` + transport per HTTP request, after auth has resolved that request's `RequestContext`. Nothing is shared across callers.
- **Mount point**: `registerMcp()` in `src/app.ts`, alongside `registerChat` — same process, port, and `HOST` binding as the rest of the API.
- **Optional stdio entry point**: `scripts/mcp-stdio.ts` (`npm run mcp:stdio`) for stdio-only local clients. Logs in once at startup and reuses one long-lived `RequestContext` — no per-message re-auth. **Local dev only**; never point it at production.

## Authentication

Same as REST: `POST /auth/login` → 15-minute JWT → `Authorization: Bearer <token>` on every `/mcp` request. `authenticateContext(database, authConfig, request)` (`src/auth/routes.ts`) is the one shared Bearer-verify + `RequestContext`-load path both the REST decorator and the MCP preHandler call — identity never comes from client-supplied arguments. The only difference: on failure the MCP preHandler also sets `WWW-Authenticate: Bearer realm="mcp", error="invalid_token"` before the shared `401`, which never reveals which check failed.

**Full MCP OAuth is NOT implemented** — no dynamic client registration, authorization-code flow, or token exchange under `/mcp`. Bearer JWT from `/auth/login` is the only credential.

## DNS-rebinding protection

- **Origin allowlist**: `MCP_ALLOWED_ORIGINS` (comma-separated, like `CORS_ALLOWED_ORIGINS`), checked in an `onRequest` hook before auth/rate-limit/body parsing. A present-but-disallowed `Origin` → `403`. No `Origin` header at all (curl, the demo script, Inspector CLI, `mcp-stdio.ts`) is allowed through — DNS rebinding is browser-specific and always sends `Origin`. Unset/empty means no browser-style client may call `/mcp` at all, matching the existing `CORS_ALLOWED_ORIGINS` convention.
- **Same bind interface as the API** — no separate listener to misconfigure.
- The SDK's own `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` options are deliberately unused (the SDK deprecates them in favor of external middleware — which the hook above provides).

## Governance (every tool call)

Each tool reuses the exact factory, Zod schema, and `execute()` the REST agent uses (`src/agent/tools.ts`, `src/agent/sql.ts`) — one source of truth. `src/mcp/tools.ts` only adds a thin adapter:

1. **RBAC** — `can()`/`scopeFilter()` against the caller's fresh-reloaded `RequestContext`.
2. **SQL guard** — `sql_analytics` runs the identical AST-validated, 5s-timeout, 200-row-capped runner as `/chat`; a rejected/DML query gets one correction then refusal, both logged.
3. **ACL-filtered KB search** — `kb_search` runs the identical tenant/role-ACL retrieval; a document outside `allowed_roles` is never retrieved.
4. **Audit log** — every call (success, logic failure, or error) writes one `audit_logs` row (`action: 'mcp.tool_call'`, `details.channel: 'mcp'`, `details.tool`/`outcome`).
5. **OTel spans** — each call wrapped in `mcp.tool_call` (`mcp.tool`, `request_id`), nesting the tool's own existing `tool.call` span.
6. **Rate limit** — per-user cap on `/mcp` itself (`RATE_LIMIT_MCP_MAX`, default 30/min), keyed like `/chat`'s.
7. **No leaked diagnostics** — a thrown error maps to a generic `isError: true` result; no stack traces, SQL errors, or provider detail — same contract as `safely()` in `src/agent/tools.ts`.
8. **Untrusted outputs** — every result capped at `MAX_TOOL_BYTES` with the same `UNTRUSTED_TOOL_DATA` prefix/truncation as the model path (`toMcpToolResult`).

**Tool input schemas never contain `tenantId`/`userId`/`roles`** — identity comes only from the closed-over `RequestContext`; a schema field can't override it.

## Tools

| Tool | Read-only | Destructive | Notes |
| --- | --- | --- | --- |
| `crm_search` | yes | no | Scoped contacts/companies/deals search, same as `/chat`. |
| `sql_analytics` | yes | no | Guarded analytics question → SQL → rows. |
| `kb_search` | yes | no | ACL-filtered knowledge-base Q&A with citations. |
| `audit_activity` | yes | no | Recent tenant audit events (admin-only scope). |
| `task_draft` | **no** | no | Creates a `pending_action` only — see below. |

Every tool has `destructiveHint: false`; only `task_draft` has `readOnlyHint: false` (it inserts a row, nothing existing is modified).

### `task_draft` has no approve/execute counterpart

It calls the same `createProposal()` the REST draft tool calls — validates, re-authorizes, inserts one `pending_action`, returns a deterministic preview. **Never approves or executes anything**; its description says so explicitly. No `approve`/`reject`/`execute` tool exists in this server, by construction. Turning a draft into a task still needs a human hitting `POST /approvals/{id}/approve` (or the equivalent in-app action).

## What is NOT implemented

- **OAuth** — no dynamic registration, auth-code flow, introspection, or resource-metadata endpoint.
- **Resources and prompts** — only `tools/list`/`tools/call`; `resources/*`/`prompts/*` aren't registered.
- **Multi-tenant client registration** — any client holding a valid token for a tenant can call that tenant's tools, same as a REST client with that token.
- **Stateful sessions / resumability** — stateless mode, no `Last-Event-ID`, no server-initiated notifications.
- **Approve/execute over MCP** — see `task_draft` above.

## Known limitation: `crm_search`'s advertised schema

`crm_search`'s Zod schema is wrapped in `z.preprocess(...)` to normalize entity synonyms (`deal`→`deals`, etc.) before the real discriminated union validates. The MCP SDK derives `tools/list`'s JSON Schema from the *input* side of that wrapper, which can't statically describe a runtime transform — it collapses to an undetailed `{"type":"object","properties":{}}`. **Runtime validation is unaffected**: `tools/call` still rejects an invalid `entity` with a clear error. Documentation-only limitation, not a security or correctness gap.

## Connecting with the MCP Inspector

```sh
npm run dev   # or the built server / docker compose stack
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP**, URL `http://127.0.0.1:3000/mcp`, add `Authorization: Bearer <access JWT>` (from `POST /auth/login` — see [seed-scenarios.md](seed-scenarios.md) for dev logins). `tools/list` shows the five tools; `tools/call` on any returns the same governed result `/chat` would get.

## Demo script

```sh
npm run mcp:demo
```

Logs in as the Tenant A dev-seed admin (override via `MCP_DEMO_BASE_URL`/`TENANT_ID`/`EMAIL`/`PASSWORD`), connects with the MCP client SDK, lists tools, calls `crm_search` for a sample deal, calls `task_draft` to propose a follow-up for that deal's responsible employee, and prints every result.

## Tests

`npx vitest run tests/mcp.test.ts` covers: unauthenticated/expired-token rejection (with `WWW-Authenticate`), tenant isolation through `crm_search`, identity-free `tools/list` schemas, `task_draft` creating a `pending_action` without touching `tasks`, a DML question rejected and logged, a rep refused the manager-only KB document while a manager is answered, disallowed vs. allowed/absent `Origin`, the per-user `429`, the `channel: 'mcp'` audit record, and a parity check that `crm_search` returns identical rows via the reused tool directly and via MCP.
