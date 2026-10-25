# Tenant isolation and database context

## Roles and ownership

- `migration_owner` runs migrations via `MIGRATION_DATABASE_URL`. The app connects as `app_user` via the separate `DATABASE_URL`; config rejects other usernames or query-string `user` overrides (node-postgres lets query params override the URL username, so a username-only check wouldn't be enough), and never falls back to owner credentials.
- `app_user` is `NOSUPERUSER`/`NOBYPASSRLS` and does not own application tables (`migration_owner` does), so ordinary `ENABLE ROW LEVEL SECURITY` applies without `FORCE`. Owners/superusers can bypass RLS — owner credentials must never serve requests, tools, or analytics. Migration/seed code deliberately uses the owner to manage all tenants.
- Bootstrap grants `app_user` table SELECT/INSERT/UPDATE/DELETE only — no ownership, ALTER, DROP, TRUNCATE, or role admin. Tests verify this with a real login, not a superuser pretending to be one.
- `analytics_ro` is non-login/non-bypass; `app_user` can `SET LOCAL ROLE` to it. It gets SELECT-only on the four analytics views and their referenced base columns — never emails, phones, notes, login links, hashes, tokens, or audit/execution records.

## RLS policies

All 22 `tenant_id`-bearing tables (including `pending_actions`, `sql_execution_log`) have Drizzle `.enableRLS()`. One permissive `FOR ALL` policy per table, targeting both `app_user` and `analytics_ro`, with identical USING/WITH CHECK:

```sql
tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
```

USING filters every read (including an unqualified `SELECT * FROM deals`); WITH CHECK blocks cross-tenant inserts/updates. `NULLIF` turns both "never set" and "reset to empty string" into NULL, so both fail closed (zero rows read, writes rejected) rather than erroring; a malformed non-empty setting still errors, and application context validation rejects such values before SQL runs. Composite FKs still matter — a correct `tenant_id` doesn't stop a row from referencing another tenant's parent record. The root `tenants` table has no `tenant_id` and sits outside this policy set.

## Transaction boundary

`withTenant` (`src/db/client.ts`) takes IDs only from authenticated server context:

```ts
const result = await withTenant(ctx, (tx) => tx.execute(sql`SELECT * FROM deals`));
```

It Zod-validates both UUIDs, opens a transaction, and sets `app.tenant_id`/`app.user_id` as bound parameters (never string-interpolated). Use the callback's connection for every query; commit on success, rollback on error, settings reset either way. `app.user_id` is an audit identity only — this layer implements tenant isolation, not per-user permissions. The pool opens lazily on first use and closes on Fastify shutdown, so `/health` needs no DB connection.

## Local login setup

```sh
docker compose up -d --wait postgres
npm run db:migrate
docker compose exec postgres psql -U migration_owner -d ops_copilot -c '\password app_user'
```

Bootstrap SQL intentionally ships no application password. Set the same value in `.env`'s `DATABASE_URL`. Never commit real credentials or use the migration URL as the application role.

## Remaining boundaries

Tenant/user/role identity always comes from server context, never LLM output or request headers. Auth endpoints use a tenant selector only to locate credentials under RLS (`withAuthTenant`), deriving real identity afterward from a verified password or refresh-token hash — no placeholder identity, no disabled RLS, no owner credentials. RLS alone isn't authentication: a caller able to run arbitrary SQL could still call `set_config` or alter session state, so the SQL guard (below) restricts queries/functions/schema/session changes independently, and RLS provides no document ACLs or column redaction on its own.

## Authentication and sessions

- Login verifies Argon2 hashes with generic failure messages for bad tenant/user/password, strict Zod rejection of unexpected fields, and a cached dummy hash so timing doesn't reveal "no such user." Five attempts/minute per IP (`@fastify/rate-limit`, in-memory, resets on restart); proxy headers aren't trusted.
- Access JWTs: `jose`, HS256 only, required secret/issuer/audience, 15-minute lifetime. The shared preHandler verifies the token, confirms the DB user still exists, and reloads roles/permissions/employee/department fresh from the tenant — JWT role claims are snapshots, never the authorization source, so permission changes apply on the very next request even with an older token.
- Refresh tokens: 32 random bytes, returned as opaque base64url; only an HMAC-SHA256 hash (keyed by `REFRESH_TOKEN_PEPPER`) is stored. Login opens a 7-day family; rotation marks the old token used and inserts a replacement in the same transaction, keeping consumed rows for reuse detection. A per-tenant/family advisory lock serializes refresh/logout, so concurrent refresh = reuse = whole-family revocation (with an audit event, committed before the 401). Logout revokes the current family idempotently; other sessions are unaffected.
- Revocation stops future refreshes but not already-issued access JWTs (valid ≤15 min — no immediate revocation). Tokens travel as JSON/Bearer only, no cookies; protect transport with HTTPS in deployment. No fallback signing key — a missing/short `JWT_SECRET` prevents startup.

## RBAC and scoped queries

`can(ctx, 'resource:action')` requires an explicit DB permission plus a recognized role scope — no implicit admin bypass. Admin = tenant, manager = department, rep = own assigned records, viewer = aggregates only, never individual rows or mutations. Unknown roles or missing scope links fail closed; multiple roles get the broadest applicable scope. See [api.md](api.md) for the initial grant matrix.

Every CRM query must pair its permission check with `scopeFilter`, supplying the resource's assignment column (tenant + employee, directly or via department); without one, department/employee scope returns nothing. Aggregate mode is gated to queries the AST guard classifies as aggregate-only. `GET /audit-logs` needs `audit_logs:read` plus whole-tenant scope (admin-only among current roles); RLS independently blocks cross-tenant reads regardless.

## Audit and logging

`writeAudit(tx, ctx, event)` runs inside the caller's existing transaction — tenant/actor/request ID from server context, event detail as Zod-validated JSON in `details`. Session create/rotate/revoke/logout each write their audit event atomically with the DB change; if the write fails, the whole action rolls back. Failed credential checks (no authenticated actor) stay as HTTP logs, not DB audit rows.

Logs redact `authorization`/`cookie`/password/token fields and never include request bodies or raw DB errors. This doesn't make audit rows tamper-proof against a compromised app-level SQL connection — the SQL guard and narrow tool APIs are the actual defense there.

## Human-approved task creation

Proposals carry only an action type and strict task fields — tenant/requester/approver/role/permissions/request ID always come from server context. Creating one needs `tasks:create` plus the assignee's scope; deciding one needs `approvals:decide` plus requester/department-manager/admin authority; listing needs `approvals:read` with the same visibility. Cross-tenant lookups 404. Viewers fail closed even if mistakenly granted a mutation permission.

Decisions lock the row; approval and execution-claiming use guarded `UPDATE`s with both transition audits committed first, so rejection can't race an approval into double execution. Pending/approved proposals lazily expire (→410) on the next decision attempt — no background scheduler. `/rest/tasks.task.add` requires an executing/executed proposal matched by `Idempotency-Key`, re-verified permissions, and a matching payload; the task UUID equals the proposal UUID, so repeating a completed add returns the existing task rather than duplicating it. Each execution gets ≤3 attempts, retrying only typed 5xx/timeouts; permissions and scope are re-checked both before claiming and before the actual insert, so a manager can't ride an admin's proposal outside their department.

Task creation and the "proposal complete" transaction are separate — a crash between them can leave an action stuck `executing` even though its task exists. The proposal UUID prevents a duplicate task, but there's no automatic takeover; recovery means inspecting the proposal/task/audit rows by hand. Failed/rejected/expired proposals are terminal — a repeat requires a brand-new proposal.

## Verification

RLS tests were written before the policies existed and initially caught real cross-tenant reads/writes; they run against a disposable Postgres with a real password-authenticated `app_user` pool, never a superuser pretending to be one. Coverage: unfiltered tenant-A reads, rejected tenant-B inserts, fresh/reused connections without context, composite-FK rejection, denied ALTER/DROP, commit/rollback, ID validation, owner-URL rejection, UPDATE/DELETE isolation, conditional analytics SELECT, and exactly one unforced policy per table.

## Development seed

`npm run db:seed` runs as `app_user` in one `withTenant` transaction per tenant — no RLS bypass, no owner credentials, no table rewrites of existing demo tenants. Refuses `NODE_ENV=production` (its passwords are public fixtures — see [seed-scenarios.md](seed-scenarios.md)). The planted injection note is stored as ordinary CRM data, never executed; chat tests exercise it against a mocked model, but live-model robustness still needs separate evaluation.

## Guarded SQL analytics

`runAnalyticsQuery(ctx, sql, question?)` (`src/sql-guard/execute.ts`) takes only server-side identity and reloads roles/permissions fresh from Postgres. `deals:aggregate` gates all analytics access; detail rows additionally need each view's own read permission (`deals:read`/`tasks:read`/`contacts:read`).

The four views use `security_invoker` + `security_barrier`: RLS filters by tenant, view predicates apply the caller's trusted scope (admin = tenant, manager = department, rep = own assignments). Viewers get a conservative aggregate-only subset — one view, aggregate projections, grouping by status/currency/department/truncated date, `count(DISTINCT id)` allowed, but no returned identities, `max(id)`, employee grouping, joins, CTEs, unions, or windows. A mixed viewer/rep account only gets whole-tenant scope for queries proven aggregate-only; everything else keeps the rep's own-record scope. This is authorization, not statistical disclosure protection (no minimum group sizes, no differential privacy).

`validateSql` (`pgsql-ast-parser`) enforces an explicit AST allow-list: exactly one SELECT (read-only CTEs/unions/subqueries permitted for row-capable users); rejects DML/DDL, `SELECT INTO`, recursive/writing CTEs, locking selects, role/session changes, functions-in-FROM, caller placeholders, base tables, other schemas, system catalogs/columns, and unknown syntax. Bounded to 20,000 chars / 2,000 nodes / depth 40, ASCII-lowercase identifiers. Allowed functions: `count, sum, avg, min, max, coalesce, nullif, date_trunc, now, round, abs, ceil, floor`, plus EXTRACT/current-date/current-timestamp — all pinned to `pg_catalog`. Dangerous functions (`set_config`, `current_setting`, `pg_sleep`, file/JSON/array builtins, extensions) are rejected even nested inside expressions or subqueries.

The executor runs *regenerated* AST SQL, not the submitted text: bound value literals, preserved numeric token text (no JS float rounding), schema-qualified real views, and `search_path` locked to `pg_catalog, pg_temp` (blocking fallback to public overloads). An outer `LIMIT 200` always applies. User/LLM text is never concatenated into executable SQL.

Execution: `withTenant` + a savepoint → bind trusted scope → `SET LOCAL ROLE analytics_ro` → 5-second statement timeout → run. Success restores `app_user`/default search path before logging; failure rolls back to the savepoint (application context stays usable). Verdict (accepted/rejected/error), row count, duration, and a safe static error always get logged before the function returns or throws — a log-write failure propagates, so no result is ever returned unaudited.

`sql_execution_log` has tenant RLS, a tenant-local actor FK, request ID, optional question, submitted SQL, verdict, row count, duration, and a safe error only (raw backend messages may contain literal values, so they're excluded) — and no analytics grant on this table, since submitted SQL/questions can themselves contain sensitive literals.

**Boundary:** Postgres requires base-column SELECT for invoker views, so `analytics_ro` can read those specific granted columns directly — but not `SELECT *` where excluded columns exist, not excluded columns/tables, and no writes. This is defense in depth on top of the validator and trusted runner, not a sandbox against arbitrary raw SQL. See [Postgres's invoker-view rules](https://www.postgresql.org/docs/18/sql-createview.html).

## Knowledge access and untrusted retrieval

`documents`/`chunks` have tenant RLS (missing context → zero rows) and composite tenant/document FKs; the analytics role gets no KB privileges at all. `allowed_roles` ACLs are enforced by the search SQL itself (not a Postgres role policy), using memberships reloaded fresh before top-k — no caller- or LLM-supplied role list can widen retrieval. Only tenant admins can ingest, via a flagged CLI.

Search also filters by embedding model. An explicit threshold is required before answering; weak/empty authorized results return a fixed refusal with no chat call. Retrieved excerpts are JSON-encoded between unpredictable delimiters and labeled untrusted; the answering chat call gets no executable tools. Citations must match retrieved labels exactly — this checks citation *identity*, not factual entailment or immunity to every injection. See [knowledge-base.md](knowledge-base.md) for quota/setup.

## Chat and tool boundaries

All five tools close over authenticated server context; strict schemas reject any supplied tenant/user/role field. Each tool reloads RBAC fresh and applies existing row scopes — generated SQL still passes the full guard (AST validator, `analytics_ro`, timeout, cap, logging) and only sees approved view columns.

Chat is read-only unless the original HTTP request sets `allowTaskDraft:true` — and even then `task_draft` only inserts a `pending_action` plus audit, never approves/executes/calls Bitrix. Tool output and CRM/KB text are always labeled untrusted; the model has no role-setting or direct-SQL tool. These are deterministic boundaries that block writes from a poisoned read — they don't prove a live model resists every instruction-injection or disclosure attempt; citations, groundedness, and bilingual tool choice still need live evaluation.

## Observability redaction

`redactValue` (`src/observability/redact.ts`) runs over every tool-call span attribute and every pino log line before it's recorded, pattern-matching emails, phone numbers, token-shaped strings, and known-sensitive key names (`password`, `token`, `pepper`, `authorization`, `apiKey`, `cookie`, `database_url`, `connection_string`, `dsn`) and replacing matches with `[redacted]`. This is pattern-based, not a DLP guarantee — a secret that doesn't match (e.g. a name) isn't caught. LLM prompt/completion content is excluded from spans entirely (`recordInputs`/`recordOutputs: false`), not redacted after the fact, since it may carry arbitrary CRM text.

## Secrets (containerized deployment)

`src/secrets.ts` resolves `JWT_SECRET`, `REFRESH_TOKEN_PEPPER`, `DATABASE_URL`, `MIGRATION_DATABASE_URL` from either the bare env var or `<NAME>_FILE` (a Docker-secret path); `_FILE` wins if both are set. This runs before Zod validation, so a missing/short (<32 char) secret still fails startup regardless of source. Refresh tokens are hashed with HMAC-SHA256 keyed by `REFRESH_TOKEN_PEPPER` rather than plain SHA-256 — a leaked DB dump alone can't precompute matches, and rotating the pepper invalidates every outstanding refresh token.

DB URL passwords are checked against a deny-list of known placeholders (`local-development-only`, `password`, `changeme`, ...) whenever `NODE_ENV=production`. `JWT_SECRET`/`REFRESH_TOKEN_PEPPER` skip this check deliberately — their unconditional ≥32-char requirement already makes every deny-listed value too short to match.

`GOOGLE_APPLICATION_CREDENTIALS` (Vertex) stays outside this loader by design — point it at a mounted secret file's path directly; it's already a file path by Google's own convention, so `_FILE` indirection would be redundant.

## Rate limiting

A global default (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, 300/min/IP) applies via `@fastify/rate-limit`, registered `global: false` with an explicit `onRequest` hook — `global: true`'s auto-apply installs its hook during the plugin's own deferred registration, which wouldn't complete before `buildApp`'s synchronous route declarations, silently rate-limiting nothing. `/auth/login` and `/auth/refresh` additionally cap at 5/min/IP; `/chat` caps per authenticated user (`RATE_LIMIT_CHAT_MAX`, default 30/min), keyed on `request.context.userId` via a `preHandler`-staged limiter registered after the auth hook. All limits return 429 + `Retry-After`. The limiter is in-memory/per-process (see [operations.md](operations.md#known-limits)); `TRUST_PROXY` controls whether `request.ip` trusts `X-Forwarded-For` (defaults to no).

`RATE_LIMIT_TEST_BYPASS` can disable the global limiter, but only outside `NODE_ENV=production` — never honored in production regardless of value. `evals/run.ts` doesn't need it: it already caches/reuses access tokens across calls.

## Other request hardening

`@fastify/helmet` and an explicit CORS allowlist (`CORS_ALLOWED_ORIGINS`, empty by default — no browser frontend, no cross-origin access) register before any route. `BODY_LIMIT_BYTES` (default 1 MiB) makes Fastify's body-size limit explicit. The DB pool sets `connectionTimeoutMillis` (5s) and client-side `query_timeout` (15s), but deliberately not server-side `statement_timeout` — that would conflict with the SQL guard's own narrower 5s timeout for analytics. Embeddings already had a 30s abort signal; LLM calls already had the shared 300s deadline. `src/net/retry.ts` centralizes the exponential-backoff formula used by embeddings and mock-task retries (`computeBackoffMs`) without changing their timing or control flow; LLM calls keep relying on the AI SDK's own `maxRetries: 2`.

## Health endpoints

`GET /health/live` reports process-up only, no dependency checks. `GET /health/ready` checks DB reachability, migration presence (via `information_schema.tables`, no extra grant needed), and that the configured LLM provider's env vars are present — never calling the LLM itself. A failing probe returns 503 with boolean fields only, never raw errors or connection strings. `LLM_PROVIDER=mock` (network-free, from the AI SDK's own test helpers) exists for `scripts/smoke.sh`/CI and is rejected at startup under `NODE_ENV=production`.
