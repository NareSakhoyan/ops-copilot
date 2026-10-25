# Model Context Protocol (MCP) server

The API also exposes its five governed agent tools to external MCP clients (Claude Desktop, the
MCP Inspector, custom agents) over the Streamable HTTP transport at `POST /mcp`, inside the same
Fastify process as the REST API. This is the same governance surface as `/chat`'s tool-calling
agent — reused, not reimplemented — exposed for direct tool invocation by any MCP-speaking client.

## Architecture

- **Package**: [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (`^1.32.2`).
- **Transport**: `StreamableHTTPServerTransport` in **stateless mode** (`sessionIdGenerator` left
  unset): no session ID is issued, no session state is kept between requests, and no SSE
  resumability/event store is configured. `GET`/`DELETE /mcp` (session resume/termination, which
  only exist in stateful mode) return `405 Method not allowed`.
- **One server instance per request**: `src/mcp/routes.ts`'s POST handler builds a fresh
  `McpServer` (`src/mcp/server.ts`) and a fresh transport for every HTTP request, after
  authentication has already resolved that request's `RequestContext`. Nothing — not the server,
  not its registered tool closures, not the transport — is shared across requests or callers, so a
  request is authenticated and scoped entirely on its own.
- **Mount point**: registered via `registerMcp()` in `src/app.ts`, alongside `registerChat` for
  `/chat`, inside the same `buildApp()` Fastify instance — same process, same port, same `HOST`
  binding as the rest of the API (see "DNS-rebinding protection" below).
- **Optional stdio entry point**: `scripts/mcp-stdio.ts` (`npm run mcp:stdio`), for local MCP
  clients that only speak stdio (e.g. some desktop app configurations). It logs in once with real
  credentials at startup and serves one long-lived `RequestContext` for the process's lifetime —
  there is no per-message re-authentication the way the HTTP endpoint provides. **Local
  development only**; never run it against a production database or expose it beyond the local
  operator.

## Authentication

MCP clients authenticate exactly like REST clients: `POST /auth/login` returns a 15-minute access
JWT, sent as `Authorization: Bearer <token>` on every `/mcp` request.

`src/auth/routes.ts` exports `authenticateContext(database, authConfig, request)`, the exact
Bearer-verification + `RequestContext`-loading logic the REST `preHandler` decorator already used.
The MCP route's own `preHandler` calls the same function, so both transports build their
`RequestContext` (`tenantId`, `userId`, `roles`, `permissions`, `departmentId`, `employeeId`)
through one shared code path — never from client-supplied arguments. The MCP preHandler differs
from the REST decorator in one way: on failure it also sets a `WWW-Authenticate: Bearer
realm="mcp", error="invalid_token"` response header before returning `401`.

A missing, malformed, invalid, or expired token all produce the same `401 {"error":"Unauthorized"}`
— the response never reveals which check failed.

**Full MCP OAuth is NOT implemented.** There is no dynamic client registration, no
authorization-code flow, and no token-exchange endpoint under `/mcp`. The only supported credential
is a Bearer access JWT obtained the same way REST clients already obtain one. A client wanting to
use this server must call `POST /auth/login` (or hold a token issued that way) before connecting.

## DNS-rebinding protection

- **Origin allowlist**: `MCP_ALLOWED_ORIGINS` (comma-separated, like `CORS_ALLOWED_ORIGINS`) is
  checked in an `onRequest` hook, before authentication, rate limiting, or body parsing. A request
  whose `Origin` header is present but not on the allowlist is rejected with `403` immediately. A
  request with **no** `Origin` header at all — every non-browser client: `curl`, the demo script,
  the MCP Inspector's CLI mode, `scripts/mcp-stdio.ts` — is allowed through, since DNS rebinding is
  a browser-specific attack that always sends an `Origin` header. Unset/empty
  `MCP_ALLOWED_ORIGINS` means no Origin-bearing (browser-style) client may call `/mcp` at all,
  matching this project's existing `CORS_ALLOWED_ORIGINS` "no configured allowlist means no
  cross-origin access" convention.
- **Same bind interface as the API**: `/mcp` is mounted on the same Fastify instance as every other
  route, so it inherits the same `HOST`/`PORT` binding — there is no separate listener to
  misconfigure onto a more permissive interface.
- The MCP SDK's own `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` transport options
  are deliberately **not** used — the SDK's own documentation marks them deprecated in favor of
  external middleware, which is what the `onRequest` hook above provides.

## Governance (every tool call)

Each of the five tools is registered by reusing the exact same factory function, Zod input schema,
and `execute()` implementation the REST chat agent uses (`src/agent/tools.ts`, `src/agent/sql.ts`)
— one source of truth, no duplicated validation or authorization logic. `src/mcp/tools.ts` only
adds a thin adapter per call:

1. **RBAC** — enforced inside the reused tool (`can()`/`scopeFilter()` against the caller's
   `RequestContext`, reloaded fresh from the database on every call; never trusts cached
   roles/permissions).
2. **SQL guard** — `sql_analytics` runs through the identical AST-validated, view-restricted,
   5-second-timeout, 200-row-capped guarded runner as `/chat` (`src/sql-guard/execute.ts`). A
   rejected or DML query gets one correction attempt, then a refusal; both attempts are logged to
   `sql_execution_log` regardless of outcome.
3. **ACL-filtered KB search** — `kb_search` runs through the identical tenant/role-ACL-filtered
   retrieval as `/chat` (`src/rag/search.ts`, `src/rag/answer.ts`); a document outside the caller's
   `allowed_roles` is never retrieved, let alone answered from.
4. **Audit log** — every MCP tool call (success, business-logic failure, or unexpected error)
   writes one `audit_logs` row (`action: 'mcp.tool_call'`, `entityType: 'mcp_tool'`) with
   `details.channel = 'mcp'` and `details.tool`/`details.outcome`, independent of whatever
   transaction the tool's own read/write already committed.
5. **OTel spans** — each call is wrapped in its own `mcp.tool_call` span carrying `mcp.tool` and
   `request_id` attributes (`withMcpCallSpan` in `src/observability/spans.ts`), with the tool's own
   existing `tool.call` span (`tool.name`, redacted `tool.input`, status, duration) nested inside it
   — the same span every agent tool call already produces, just with an outer MCP-specific span on
   top.
6. **Rate limit** — a per-authenticated-user limit (`RATE_LIMIT_MCP_MAX` per `RATE_LIMIT_WINDOW_MS`,
   default 30/minute) on the `/mcp` endpoint itself, keyed the same way `/chat`'s limit is keyed.
7. **Errors never leak diagnostics** — a thrown error inside a tool call is caught and mapped to a
   generic MCP `isError: true` result (`"Tool request denied or unavailable..."`); SQL/driver
   errors, stack traces, and provider details are never serialized into the response. This matches
   the existing `safely()` wrapper's contract in `src/agent/tools.ts`.
8. **Untrusted tool outputs** — every tool result is capped at the same byte limit as the model
   path (`MAX_TOOL_BYTES`, `src/agent/output.ts`'s `toMcpToolResult`), with the same
   `UNTRUSTED_TOOL_DATA` prefix and truncation marker. MCP clients (and any model behind them) must
   treat tool results as untrusted data, exactly as the system prompt already instructs the chat
   agent.

**Tool input schemas never contain `tenantId`, `userId`, `roles`, or any other identity field.**
Identity comes exclusively from the authenticated `RequestContext`, closed over when each tool is
built per request — it is structurally impossible for a schema field to override it.

## Tools

| Tool | Read-only | Destructive | Notes |
| --- | --- | --- | --- |
| `crm_search` | yes | no | Scoped contacts/companies/deals search, same as `/chat`. |
| `sql_analytics` | yes | no | Guarded analytics question → SQL → rows. |
| `kb_search` | yes | no | ACL-filtered knowledge-base Q&A with citations. |
| `audit_activity` | yes | no | Recent tenant audit events (admin-only row scope). |
| `task_draft` | **no** | no | Creates a `pending_action` only. See below. |

Every tool's `annotations.destructiveHint` is `false` — none of them delete or irreversibly
overwrite data. `task_draft` is the only tool with `readOnlyHint: false`, since it inserts a new
`pending_action` row (nothing existing is modified).

### `task_draft` has no approve or execute counterpart

`task_draft` calls the exact same `createProposal()` the REST chat agent's draft tool calls — it
validates the payload, re-authorizes the assignment, inserts one `pending_action` row, and returns
its id plus a deterministic preview. **It never approves or executes anything.** Its MCP tool
description says so explicitly: *"Creates a pending_action only, with no execution. Approval
happens separately in the app or through the REST /approvals API; MCP exposes no approve or execute
tool."* There is no `approve`/`reject`/`execute` tool registered anywhere in this MCP server —
by construction, not by a runtime permission check. Turning a draft into an actual task still
requires a human (or a separate, explicitly authorized caller) to hit `POST /approvals/{id}/approve`
on the REST API or the equivalent in-app action.

## What is NOT implemented

- **OAuth** — no dynamic client registration, authorization-code flow, token introspection, or
  resource-server metadata endpoint. Bearer JWTs from `/auth/login` only.
- **Resources and prompts** — the MCP spec's `resources/*` and `prompts/*` capabilities are not
  registered. Only `tools/list` and `tools/call` are supported.
- **Multi-tenant client registration** — there is no concept of registering an MCP client
  application per tenant. Any client holding a valid access token for a given tenant can call the
  tools scoped to that tenant's caller, exactly as any REST client with that token could.
- **Stateful sessions / resumability** — stateless mode means no session ID, no reconnection with
  `Last-Event-ID`, and no server-initiated notifications between calls.
- **Approve/execute over MCP** — see `task_draft` above.

## Known limitation: `crm_search`'s advertised schema

`crm_search`'s Zod schema (`src/agent/tools.ts`) is wrapped in `z.preprocess(...)` to normalize
singular/plural entity synonyms (`deal` → `deals`, etc.) before the real discriminated-union schema
validates. The MCP SDK derives each tool's JSON Schema (shown in `tools/list`, used by clients for
UI/autocomplete) from the *input* side of that preprocess wrapper, which collapses to an
undetailed `{"type":"object","properties":{}}` — it cannot statically describe a schema whose shape
depends on a runtime transform. **Runtime validation is unaffected**: `tools/call` still validates
every argument against the real schema (confirmed: an invalid `entity` value is still rejected with
a clear `Input validation error`), so this is a documentation-only limitation of the advertised
schema, not a security or correctness gap.

## Connecting with the MCP Inspector

```sh
npm run dev   # or run the built server / docker compose stack
npx @modelcontextprotocol/inspector
```

In the Inspector UI, choose **Streamable HTTP**, set the URL to `http://127.0.0.1:3000/mcp`, and
add an `Authorization: Bearer <access JWT>` header (obtained from `POST /auth/login`, see
[docs/seed-scenarios.md](seed-scenarios.md) for the dev-seed login fixtures). `tools/list` should
show the five tools described above; `tools/call` on any of them will return the same governed
results `/chat`'s agent would get.

## Demo script

```sh
npm run mcp:demo
```

Logs in as the Tenant A dev-seed admin (overridable via `MCP_DEMO_BASE_URL`,
`MCP_DEMO_TENANT_ID`, `MCP_DEMO_EMAIL`, `MCP_DEMO_PASSWORD`), connects with the MCP client SDK,
lists tools, calls `crm_search` for a sample deal, then calls `task_draft` to propose a follow-up
task assigned to that deal's responsible employee, and prints every result.

## Tests

`npx vitest run tests/mcp.test.ts` covers: unauthenticated/expired-token rejection (with
`WWW-Authenticate`), tenant isolation through `crm_search`, `tools/list` schemas containing no
identity fields, `task_draft` creating a `pending_action` without touching `tasks`, a DML question
through `sql_analytics` being rejected and logged, a rep being refused the manager-only KB document
while a manager is answered, a disallowed `Origin` being rejected (and an allowed/absent one being
accepted), the per-user rate limit returning `429`, the `channel: 'mcp'` audit record, and a
parity check that the same `crm_search` call returns identical rows through the reused tool
directly and through MCP.
