# Tenant isolation and database context

## Roles and ownership

Migrations connect using `MIGRATION_DATABASE_URL` as `migration_owner`. The application client connects using the separate `DATABASE_URL` as `app_user`; configuration rejects other usernames and query-string `user` overrides, and never falls back to owner credentials. node-postgres permits query parameters to override the URL username, so checking only the username would be insufficient.

`app_user` is a LOGIN role with NOSUPERUSER and NOBYPASSRLS. It does not own application tables, which remain owned by `migration_owner`. PostgreSQL therefore applies ordinary ENABLE ROW LEVEL SECURITY to application queries without FORCE ROW LEVEL SECURITY. Owners and superusers can bypass ordinary RLS; owner credentials must never be used for requests, tool execution, or analytical queries. Migration/fixture code deliberately uses the owner so it can manage all tenants.

Bootstrap grants table SELECT/INSERT/UPDATE/DELETE to `app_user`, not ownership, ALTER, DROP, TRUNCATE, or role administration. Real-login integration tests verify non-owner identity and denied ALTER/DROP operations.

`analytics_ro` is a non-login, non-bypass role. `app_user` can SET LOCAL ROLE to it. The tenant policy names both roles; table privileges determine permitted commands. Analytics grants are SELECT-only on the four views and the base columns referenced by their Drizzle definitions. Emails, phones, internal note/description text, login links, password hashes, tokens, and execution/audit records have no analytics SELECT grant.

## Policies

All 22 tables containing `tenant_id`, including `pending_actions` and `sql_execution_log`, enable RLS in Drizzle using the installed 0.45 API's `.enableRLS()`. Existing PostgreSQL roles are declared with `pgRole('app_user').existing()` and the equivalent declaration for `analytics_ro`, so Drizzle does not recreate them.

Each tenant table has one permissive FOR ALL policy targeting both roles, with identical USING and WITH CHECK expressions:

```sql
tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
```

USING filters rows for SELECT/UPDATE/DELETE, including a raw `SELECT * FROM deals` without a WHERE clause. WITH CHECK rejects inserts or updates that would put a row in a different tenant. Composite foreign keys remain necessary: a row with the correct tenant_id must still not reference another tenant's company, user, employee, or other parent.

`current_setting(..., true)` returns NULL when the setting has never existed. A custom transaction-local setting can reset to an empty string on a reused connection. NULLIF handles both missing states before casting to UUID; equality with NULL is not true, so reads return zero rows and writes fail closed. A malformed nonempty setting fails with an invalid UUID error; application context validation rejects such values before SQL execution.

The root `tenants` table has no `tenant_id` and is outside this policy set. Access to its metadata requires appropriate application authorization; do not expose it as an unrestricted analytical source.

## Transaction boundary

Use `withTenant` from `src/db/client.ts` with IDs taken only from authenticated, server-side request context:

```ts
const result = await withTenant(ctx, async (tx) => {
  return tx.execute(sql`SELECT * FROM deals`);
});
```

The helper validates both UUIDs with Zod, starts a Drizzle transaction, and executes the equivalent of:

```sql
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.user_id', $2, true);
```

Both values are bound parameters. The callback receives the transaction connection; use that connection for every query in the operation and await the work before returning. Success commits and returns the callback's value. Errors roll back. The local settings reset on either outcome, so a subsequent unscoped query sees zero tenant rows. `app.user_id` supplies an audit identity; this tenant policy does not implement per-user permissions.

The default application pool is initialized lazily when `withTenant` is first called and closed on Fastify shutdown. `/health` remains a liveness endpoint and does not open a database connection. `createDbClient` supplies isolated clients for tests; its unscoped `db` has the same application-role RLS restrictions.

## Local login setup

The bootstrap SQL remains limited to extension/role/default-privilege creation and intentionally contains no application password. After starting Compose and applying migrations, provision the login interactively:

```sh
docker compose up -d --wait db
npm run db:migrate
docker compose exec db psql -U migration_owner -d ops_copilot -c '\password app_user'
```

Use your configured database name if it differs from `ops_copilot`. Set the same password in `.env`'s `DATABASE_URL`; the example password is for local development only. Existing environment values are preserved. Never commit real credentials or use the migration URL for the application.

## Remaining security boundaries

For authenticated operations, tenant IDs, user IDs, and roles come from server-side context, never LLM output or identity headers. The authentication endpoints accept a tenant selector to locate credentials under RLS, then derive identity from a verified password or hashed refresh token. They use `withAuthTenant` only for credential lookup, setting the tenant transaction-locally and clearing the user setting until a real user is established. This creates no placeholder identity and never disables RLS or uses owner credentials. Other request handlers must use `withTenant` with authenticated context.

Custom PostgreSQL settings are not an authentication mechanism. A caller permitted to execute arbitrary SQL could call set_config or alter session state. The later SQL guard must restrict queries, functions, schema access, and session/role changes; database credentials must not be exposed to an LLM. Tenant RLS alone does not provide document ACLs, column-level redaction, or per-user authorization.

## Authentication and sessions

Login verifies Argon2 password hashes and uses generic failures for missing tenants/users and incorrect passwords. Strict Zod schemas reject supplied roles, user IDs, and unexpected body fields. A cached random dummy hash permits password verification even when no user matches. Login permits five attempts per minute per connection IP using `@fastify/rate-limit`; proxy headers are not trusted. The limiter is in memory and resets on restart, suitable for the single-process MVP.

`jose` signs and verifies HS256 access JWTs with a required secret, issuer, audience, and 15-minute lifetime. Only HS256 is accepted. The shared Fastify preHandler verifies the token and required claims, verifies the database user still exists, then reloads roles, permissions, employee, and department from that tenant. It supplies the server-generated request ID. JWT role snapshots and request headers cannot override database authorization. Permission changes affect the next authenticated request, including requests using an older JWT.

Refresh tokens contain 32 random bytes and are returned as opaque base64url strings. Only SHA-256 hashes are stored. A login creates a new UUID family with a fixed seven-day expiry. Rotation marks the old token used and inserts a replacement in the same transaction, retaining consumed rows so older ancestors can trigger reuse detection. Do not purge those records while a family remains active. A transaction advisory lock per tenant/family serializes refresh and logout, including attempts using different generations. Reusing a consumed token commits whole-family revocation and an audit event before returning 401. Concurrent refresh calls therefore invalidate the family; clients must serialize refreshes. Logout revokes the current family idempotently. Independent login sessions are unaffected.

Logout/reuse revocation prevent future refreshes; existing access JWTs remain valid until their original expiry, at most 15 minutes. Immediate access-token revocation is outside this approved design. Tokens are returned in JSON and sent as Bearer headers; no cookie/browser-storage scheme is implemented. Protect token transport with HTTPS when deployed. Configuration has no fallback signing key; a missing or short `JWT_SECRET` prevents startup. Generate a random secret as described in the README.

## RBAC and scoped queries

`can(ctx, 'resource:action')` requires an explicit database permission and an applicable recognized role scope. There is no implicit permission grant for admins. Admin scope covers one tenant; managers cover employees in their department; reps cover records assigned to their employee; viewer-only users can access aggregates but never individual rows or mutations. Missing scope links and unknown roles fail closed. Multiple roles use the broadest applicable scope. See [api.md](api.md) for initial grants.

Callers must pair permission checks with `scopeFilter` for CRM queries, supplying the resource's assignment column. The filter always includes the authenticated tenant and constrains the responsible employee directly or through a department subquery. Without an assignment column, department/employee scopes return false. Aggregate mode is restricted to aggregate-producing queries; the analytics AST guard enforces its conservative aggregate-only subset before choosing that mode. Mock deal/task reads enforce assignment scope; manager/rep contact reads require a link to a visible deal. Viewer-only users cannot access any of these row-level methods.

`GET /audit-logs` requires `audit_logs:read` and whole-tenant row scope, keeping it admin-only for the defined roles. It accepts bounded pagination, not a tenant selector. RLS filters the query independently, so a tenant A token cannot retrieve tenant B's events.

## Transactional audit and logging

`writeAudit(tx, ctx, event)` receives the existing action transaction. Tenant, actor, and request UUID come from server context; event metadata is Zod-validated JSON and stored in the existing `details` JSONB column. Session creation, rotation, family revocation, and logout each write audit events atomically with their database changes. If audit writing fails, the action also rolls back. Failed credential checks have no authenticated actor; they remain structured HTTP request logs rather than attributed database events.

The request logger redacts authorization/cookie and password/token fields. Request bodies are not logged. Internal database errors are not serialized with query parameters; clients receive generic errors. Authentication audit metadata contains identifiers, never raw passwords or tokens. Application writers must continue excluding secrets from future event metadata.

The audit table retains its existing application DML grants. This change does not make audit records tamper-proof against compromised application SQL access; deterministic SQL guards and narrow tool APIs remain required.

## Human-approved task creation

Proposal input contains only an action type and strict task fields. Tenant, requester, approver, role, permissions, and request ID come from server-side context, with database context reloaded at service boundaries. Proposal creation checks `tasks:create` and the assignee's tenant/department/employee scope. Decisions require `approvals:decide` plus requester ownership, same-department manager authority, or tenant admin authority. Listing requires `approvals:read` and the same ownership/department/admin visibility. Other tenants receive 404 for proposal/task lookups. Viewers fail closed even if mistakenly assigned mutation permissions.

Decisions lock the proposal. Approval and execution claiming use guarded Drizzle UPDATEs and commit both transition audits before running the mock. Rejecting cannot race an approval into executing twice. Expired pending/approved proposals transition to expired on an authorized decision attempt and return 410 after commit. No background expiry scheduler is present; pending/approved lists omit elapsed proposals.

The executor and mock share in-process operations, with no extra credentials or transport. `/rest/tasks.task.add` requires an executing/executed proposal identified by `Idempotency-Key`, matching normalized payload, eligible caller, and freshly checked requester permissions. A normal authenticated request cannot create a task while the proposal is still pending or approved. The task UUID equals the proposal UUID. Repeating a completed add returns the matching existing task; changing approved fields or using another tenant's proposal is rejected.

Each execution has at most three total attempts, retrying only typed 5xx/timeout errors with exponential backoff. Task-creation permissions and assignment scope for both requester and approver are checked before claiming and again before every new task insertion. A department manager cannot use a tenant admin's proposal to assign outside the manager's own department. Task creation and its audit event share a transaction; each approval transition and its audit event also share a transaction. Raw unexpected error text is excluded from persisted execution errors and audit metadata.

Task creation and final action completion use separate transactions. A crash or failure to commit the final audit may leave an executing action even if its task exists. UUID uniqueness prevents duplicate task creation, but there is no automatic takeover/recovery of an executing action. Inspect the proposal, task with the same UUID, and audit records before manual recovery. Failed, rejected, and expired actions are terminal; a new independent proposal is required to request the operation again.

## Verification

The RLS tests were written and run before policies/client implementation; they initially exposed cross-tenant reads and writes. They use a disposable PostgreSQL 18 container and a real app_user password-authenticated pool, not a superuser connection merely pretending to be the application.

Coverage includes unfiltered tenant-A reads, rejected tenant-B inserts, fresh and reused connections without context, composite FK rejection, denied ALTER/DROP, commit and rollback behavior, validated IDs, owner-URL rejection, UPDATE/DELETE isolation, conditional analytics SELECT, and exactly one policy on each tenant table without FORCE. No developer database is reset by these tests.

## Development seed

`npm run db:seed` is an explicit development command using `DATABASE_URL` as `app_user`, with one `withTenant` transaction for each new demo tenant. It neither bypasses RLS nor uses owner credentials. Existing matching tenants are skipped without rewriting records or credentials. The CLI refuses production mode; its known passwords are public development fixtures documented in [seed-scenarios.md](seed-scenarios.md). The tenant-A injection note is stored as CRM activity data and is not executed. Chat tests now exercise this poisoned note with a mocked model; live prompt-injection robustness still requires evaluation.

## Guarded SQL analytics

`runAnalyticsQuery(ctx, sql, question?)` in `src/sql-guard/execute.ts` accepts only server-side request identity. It reloads the user, roles, department, employee, and permissions from PostgreSQL. `deals:aggregate` is the existing analytics capability gate. Detail queries additionally require `deals:read`, `tasks:read`, or `contacts:read` for their views; employee-performance details require `deals:read`. No new permission vocabulary or HTTP endpoint is introduced.

The four views use both `security_invoker` and `security_barrier`. RLS filters the tenant as the non-owner analytics caller; view predicates apply the trusted scope bound by the runner. Admins see tenant records, managers their department, and reps their own assignments. Contacts for managers/reps must link to a scoped deal; their latest activity timestamp is contact-wide within the tenant. Missing analytics settings produce no view rows.

Viewers must use a conservative aggregate subset: one direct view, aggregate projections, grouping by status/currency/department or a truncated date, and no record/person identities. `count(DISTINCT id)` is allowed, but returning IDs/names, `max(id)`, employee grouping, nested queries, joins, CTEs, unions, and windows are denied for viewers. Identical restrictions classify queries eligible for aggregate scope. A mixed viewer/rep account gets whole-tenant scope only for those proven aggregate queries; detail queries retain the rep's own-record scope. This is aggregate authorization, not statistical disclosure protection such as minimum group sizes or differential privacy.

`validateSql` uses `pgsql-ast-parser` with an explicit AST allowlist. Exactly one SELECT (including validated read-only CTEs/unions/subqueries for row-capable users) is permitted. It rejects DML/DDL, SELECT INTO, recursive/writing CTEs, locking SELECTs, role/session changes, functions in FROM, caller-supplied placeholders, base tables, other schemas, system catalogs/columns, and unknown syntax. Inputs are bounded to 20,000 characters, 2,000 visited nodes, and depth 40. Identifiers use the ASCII lowercase schema vocabulary; quoted permitted identifiers work, while quoted forbidden names remain forbidden.

The function allowlist is `count`, `sum`, `avg`, `min`, `max`, `coalesce`, `nullif`, `date_trunc`, `now`, `round`, `abs`, `ceil`, and `floor`, plus supported SQL EXTRACT/current-date/current-timestamp syntax. Functions and symbolic operators are pinned to `pg_catalog`; COALESCE/NULLIF remain native SQL constructs. Casts accept only supported built-in scalar types. Dangerous functions such as `set_config`, `current_setting`, `pg_sleep`, file access, JSON/array collection, and arbitrary extension functions are rejected even inside expressions, CTEs, or subqueries.

The executor runs regenerated AST SQL rather than the submitted text. Value literals are bound parameters; numeric tokens retain their exact text and PostgreSQL numeric types, avoiding JavaScript rounding. Positional GROUP BY/ORDER BY integers remain syntax. Real view names are schema-qualified and execution search path is limited to `pg_catalog, pg_temp`; public views remain schema-qualified. This also prevents fallback to public overloads through implicit operators. The outer AST SELECT applies LIMIT 200 regardless of inner limits/unions. This is the narrow SQL-generation path; user/LLM text is never concatenated into executable SQL.

Execution uses `withTenant` and a savepoint: bind the trusted analytics scope, SET LOCAL ROLE analytics_ro, set a five-second statement timeout, and execute. On success it restores app_user and the default search path before writing the log; on failure the savepoint rollback restores usable application context. The outer transaction records accepted/rejected/error verdicts before the function returns or throws. A real timeout is tested, including the committed error record and subsequent connection reuse. State resets at transaction end. Log-write failure propagates, so data is not returned without its execution record.

`sql_execution_log` has tenant RLS, a tenant-local actor foreign key, request ID, optional question (NULL when absent), submitted SQL, verdict, row count, duration, and a safe static error. Invalid SQL is logged before execution; SQL errors omit raw backend messages, which may contain values. Submitted SQL and questions can contain sensitive literals, so these application-only records are excluded from analytics grants. Invalid/unavailable server identities cannot create attributed execution records.

**Database boundary:** PostgreSQL requires column SELECT on underlying tables for invoker views. As explicitly agreed, analytics_ro can directly read those granted columns. It cannot SELECT * where excluded columns exist, read excluded columns or unrelated application tables, or modify application data. Tenant RLS applies to direct granted-column reads with an unchanged tenant context. View-only access, department/employee scopes, viewer aggregation, and prevention of role/GUC changes also depend on the validator and trusted runner. Standard PostgreSQL catalog/function visibility is not removed globally; the validator rejects catalog relations and unsafe functions. An unrestricted raw SQL channel could alter custom settings or reset its role, so these grants are defense in depth rather than a sandbox for arbitrary SQL. See [PostgreSQL's invoker-view rules](https://www.postgresql.org/docs/18/sql-createview.html).

## Knowledge access and untrusted retrieval

Documents and chunks enable tenant RLS as non-owner `app_user`; missing context yields zero rows. Composite tenant/document FKs prevent cross-tenant linkage. The analytics role receives no KB column or table privileges. Document allowed_roles ACLs are enforced by trusted search SQL (not a separate PostgreSQL role policy), with current memberships reloaded from the tenant database before top-k. No caller-provided or LLM-provided role list controls retrieval. Tenant admins alone may ingest through the flagged CLI.

Search also filters by embedding model. An explicit threshold is required before answering; empty or weak authorized results return fixed refusal without a chat call. Excerpts are JSON-encoded between unpredictable delimiters and labeled untrusted data. The chat model has no executable tools. Returned citations must match retrieved labels; this verifies citation identity, not factual entailment or immunity to every prompt injection. Synthetic attack examples and mocked-model tests do not establish live-model robustness. Google credentials and raw credential-bearing SDK causes are never logged. See [knowledge-base.md](knowledge-base.md) for quota persistence and setup.

## Chat and tool boundaries

All five tools close over authenticated server context; strict argument schemas reject supplied tenant/user/role fields. Each database tool reloads current RBAC, uses withTenant, and applies existing row scopes. Company reads require companies:read independently of contact access. Contacts' activity notes are restricted by activity employee scope as well as visible contact IDs. Generated SQL still passes the existing validator, analytics role, timeout, result cap, and logging; the generation prompt exposes only approved view columns.

Chat is read-only by default: task_draft is not present unless the original HTTP request explicitly sets allowTaskDraft:true. Even then it can only create a pending action and audit, never approve/execute or call Bitrix. Successful drafts end the loop and use a deterministic pending preview. Tool output and CRM/KB text are labeled untrusted; the model has no role, tenant-setting, or direct SQL execution tool. These deterministic boundaries prevent writes by the poisoned read fixture; they do not prove that a live model is immune to all instruction injection, disclosure, or misleading prose. Citations, groundedness, and bilingual tool choice require live evaluation.
