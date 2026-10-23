# Decisions

## Runtime and modules

Use Node.js 24 and ECMAScript modules (ESM).

## Package manager

Use npm instead of pnpm. Required verification commands are `npm test` and `npm run lint`.

## Project layout and execution

Use the current workspace as the project root, with package name `ops-copilot`. Keep application modules under `src/`, and `evals/`, `tests/`, and `docs/` at the root. Use `tsx` for development, `tsc` for compilation, and Node.js to run the compiled ESM application.

## Configuration

A `.env` file must exist. Include a local `.env` and a matching `.env.example`; ignore local environment files in version control. Load the required file using Node.js environment parsing, then validate configuration using Zod before starting the server. Process environment values take precedence over file values. Defaults are `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, and `LOG_LEVEL=info`. Invalid configuration prevents startup.

## Health and request logging

`GET /health` returns HTTP 200 and `{"status":"ok"}`. Generate request UUIDs on the server, include them in pino request logs as `reqId`, and return them in the `X-Request-ID` response header. Client headers do not set request IDs.

## Development log display

Pipe `npm run dev` output through the `pino-pretty` CLI, installed as a development dependency. Color severity labels, display local timestamps, and omit PID/hostname from the terminal display while retaining request IDs and event details. Keep application logging as structured Pino JSON, including production `npm start` output and captured test logs. Format the existing redacted records without adding request bodies, tokens, raw database errors, or a second logger implementation.

## Application foundation

The project is named `ops-copilot`. Use Fastify, strict TypeScript without `any`, Zod for external input and environment validation, pino for logging with a request ID per request, Vitest for tests, and ESLint for linting. Provide `GET /health`.

## Trust boundaries

Obtain `tenant_id`, `user_id`, and role only from server-side request context, never LLM output. Use SQL parameters; never concatenate user or LLM text into SQL.

## Change process

Every feature needs tests. Run the required verification commands before finishing. Ask the user about ambiguous requirements or architectural choices not recorded here, and append a short entry for each non-trivial choice.

## Tooling compatibility

Use TypeScript 6.0 because the installed typescript-eslint release supports TypeScript versions below 6.1. Use ESLint flat configuration with type-aware rules, including an explicit ban on `any`. Keep the npm lockfile for reproducible dependency installation.

## Pre-commit checks

Use Husky to run lint-staged before commits. The npm `prepare` lifecycle installs Git hooks. Run `eslint --fix` on staged TypeScript and JavaScript files; lint-staged stages successful fixes and blocks commits on remaining lint errors. Full tests and lint remain required before finishing feature work.

## Cleanup

Keep files and configuration relevant to this Node.js/Fastify project. Remove the unrelated Next.js snippet documents, unused Vitest mock settings, and the redundant `noImplicitAny` setting already enabled by `strict`. Preserve the requested scaffold directories and tests for existing behavior.

## Database foundation

Use `pgvector/pgvector:pg18` in Docker Compose, Drizzle ORM with node-postgres (`pg`), and Drizzle Kit to generate committed SQL migrations. Test against disposable PostgreSQL 18 pgvector containers using Testcontainers. Store PostgreSQL 18 data under `/var/lib/postgresql`. Local credentials live in the required `.env`, with development examples in `.env.example`.

## Database ownership and bootstrap

The local image's bootstrap superuser is `migration_owner`. Only migration tooling uses `MIGRATION_DATABASE_URL`; application access is intended to use the separate restricted `app_user`. Bootstrap SQL only enables vector, creates `app_user` and `analytics_ro`, grants role membership, and configures the migration owner's future table DML grants to `app_user`. Do not provision an application password, add analytics SELECT grants, seed data, create tables, or add RLS in bootstrap. Run the currently empty Drizzle SQL grants step after migrations.

## Tenant-scoped CRM schema

Every business table other than `tenants` is tenant-scoped, including application users, roles, and permissions. Use UUID primary keys, a unique `(tenant_id, id)` on each tenant table, and explicit composite foreign keys for references to tenant-scoped rows. Natural identifiers and RBAC memberships are unique within a tenant. Keep default restrictive deletion behavior rather than cascading business-record deletion.

## Minimal CRM relationships and constraints

Employees may optionally link to one login and one department; contacts may optionally link to a company. Leads and deals may link to a company, contact, and responsible employee, and deals may link to a lead. Activities require a contact and may link to a deal and employee. Tasks require a description, deadline, and assignee, with optional contact and deal links. Orders may link to a company, contact, and deal; order items require an order and product. Audit actor and entity IDs may be absent for system events; polymorphic audit entity IDs have no foreign key. Refresh tokens require a tenant-scoped user, a token hash, and an expiration time.

Deal status values are `open`, `won`, and `lost`; task status values are `todo`, `in_progress`, `done`, and `cancelled`. Activity types are `call`, `email`, and `meeting`. Use SQL CHECK constraints rather than PostgreSQL enum types. Do not add lead/order workflow statuses. Derive overdue tasks from `due_at` and unfinished status. Monetary amounts use nonnegative `numeric(14,2)` plus an uppercase three-letter currency code; order quantities are positive integers. Timestamps use `timestamptz` with creation defaults and Drizzle-managed `updated_at` updates; raw SQL writers must set `updated_at` explicitly.

## Initial migration lifecycle

Generate the initial schema into `drizzle/`; apply migrations as the owner, then execute `src/db/grants.ts`. The initial migration has no destructive down script: use forward migrations for subsequent changes. Disposable test databases may be removed; persistent development databases must not be reset automatically. RLS, AI tables, authentication flows, and the assignment's synthetic-data generator are outside this database change.

## Tenant row-level security

The next migration enables RLS on all 18 tenant-scoped tables, superseding the initial database stage's RLS deferral. Use the installed Drizzle 0.45 API: `pgRole(...).existing()`, `pgPolicy`, and `.enableRLS()`. Bootstrap roles remain managed by `docker/init.sql`, and the initial migration stays unchanged. Each tenant table has one `FOR ALL` policy naming `app_user` and `analytics_ro`, with identical USING/WITH CHECK predicates. Command permissions remain separate: `app_user` has table DML, while `analytics_ro` must receive only explicit SELECT grants before analytical access is enabled. This change does not broaden analytics table privileges.

Compare `tenant_id` to `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Missing settings and PostgreSQL's empty-string reset state both become NULL, yielding no visible rows and rejecting writes. `NULLIF` is required for safe connection reuse after transaction-local settings reset.

## Application database context and credentials

Use a separate, Zod-validated `DATABASE_URL` that names `app_user`; reject query-string `user` overrides and never fall back to `MIGRATION_DATABASE_URL`. Provision the app login password through the owner's interactive `psql \password` command, outside the intentionally limited bootstrap SQL, and keep it in the local environment. The default pool is created lazily on first tenant operation and closed with Fastify. A small client factory supports isolated pools in tests.

`withTenant(ctx, fn)` accepts server-side UUID `tenant_id` and `user_id`, validates them, and opens one Drizzle transaction. Parameterized `set_config` calls install both IDs transaction-locally before the callback runs. Successful callbacks commit; failures roll back and reset context. The application role is neither the owner nor a superuser and has no BYPASSRLS, so ordinary ENABLE ROW LEVEL SECURITY applies without FORCE. This boundary does not replace JWT authentication, RBAC, or deterministic SQL validation.

## Authentication contracts and credential lookup

Use Argon2 password verification, `jose` for JWTs, and `@fastify/rate-limit` for login throttling. Login accepts `{ tenantId, email, password }`; refresh/logout accept `{ tenantId, refreshToken }`. Tokens are returned as JSON and access tokens are sent using Bearer authorization. Do not introduce cookies or browser token storage in this API change. The supplied tenant ID is a credential-lookup selector, not an authenticated context. Keep RLS enabled and use `app_user` in a tenant-only transaction with an empty user setting until credentials resolve to a database user; never invent a user UUID or use owner credentials for authentication.

## Access tokens and request context

Sign HS256 JWTs with a required environment secret of at least 32 characters, an issuer, an audience, and a 15-minute expiry. Defaults are issuer `ops-copilot` and audience `ops-copilot-api`; accept only HS256 and validate required claims. Include `tenantId`, `userId`, and role names from the database. The shared Fastify preHandler validates the JWT, verifies the user still exists, and reloads roles, permissions, employee, and department from PostgreSQL on every authenticated request. JWT role claims are informational snapshots, not the authorization authority. Request IDs remain server-generated. Preserve lazy database connection creation so `/health` needs no database access.

## Refresh families and logout

Generate 32-byte random base64url refresh tokens and store only SHA-256 hashes. Add `family_id` and `used_at` to existing token rows; retain consumed rows for reuse detection. Each login creates a family with a fixed seven-day lifetime; rotations inherit that expiry. Serialize refresh/logout per tenant and family with a PostgreSQL transaction advisory lock, then re-read/lock the token. Mark consumed tokens and insert replacements atomically. Reusing a consumed token revokes all family members and records an audit event; return the authentication error only after committing revocation. Logout revokes the presented token's family, including when an ancestor token is presented, and is idempotent. These operations do not revoke other sessions or immediately revoke existing access JWTs; those expire within 15 minutes. Simultaneous refresh attempts are treated as reuse and revoke the family.

## RBAC and record scoping

Permission checks require tenant-local database permission codes, with no implicit admin permission bypass. Roles determine record scope: admin covers the tenant, sales_manager covers employees in their department, sales_rep covers records assigned to their employee, and viewer supports tenant aggregates only. Use the broadest applicable scope when multiple roles are assigned. Unknown roles and missing required employee/department links fail closed. `can` rejects viewer row/action permissions even if accidentally assigned. Initial provisioning grants admins `deals:read`, `deals:aggregate`, `departments:read`, and `audit_logs:read`; managers get the first three; reps get the two deal permissions; viewers get only `deals:aggregate`. Audit-log listing requires both `audit_logs:read` and whole-tenant row scope, so it is admin-only for these roles. Query callers must check permission and apply the scope filter; only actual aggregate queries may request aggregate scope. Test-only routes demonstrate manager denial and deal filtering without adding unrequested production CRM endpoints.

## Transactional auditing and API limits

The audit writer receives the action's existing transaction and takes tenant, actor, and request ID from server context. Keep JSON metadata in the existing `details` JSONB column and add nullable `request_id` for historical/system compatibility. New request events require a UUID request ID; login, rotation, reuse revocation, and logout write their events inside the same transaction as session changes. Failed credential checks have no authenticated actor and remain HTTP request logs, not attributed database audit events. Audit listing has deterministic ordering and bounded limit/offset pagination. Login is limited to five attempts per minute per connection IP using an in-memory limiter; forwarded IP headers are not trusted. Redact authorization/cookie/token/password logging fields, avoid logging bodies or raw database errors, and return generic credential and internal-error messages. Keep bootstrap SQL and analytics grants unchanged.

## Shared database test setup

Share PostgreSQL container bootstrap and migration CLI execution through two functions in `tests/helpers/database.ts`. Each integration suite keeps its own disposable container, connections, fixtures, and cleanup. Run migrations explicitly so the database suite can still inspect the empty database and verify repeated migration runs. Keep the RLS suite's single-connection application pool for deterministic connection-reuse checks.

## Test scope and duplication

Keep tests focused on application behavior and security boundaries. Remove standalone environment-parser non-object checks, successful URL pass-through assertions already exercised by real database connections, and repeated file-validation assertions covered by server startup tests. Consolidate RLS metadata assertions in the RLS suite, including the unscoped root tenant table; retain exact schema inventory checks in migration tests. Preserve credential, permission, isolation, token lifecycle, transaction, and startup failure coverage.

## Approval workflow MVP scope

Keep mock Bitrix operations inside the existing Fastify app and reuse CRM tables. Do not add a separate app, container, database, `bitrix_` tables, workers, queues, or dependencies. Support only `task.create` proposals with title, description, assignee, and deadline. Reuse the existing audit writer for each state transition in the same transaction as that transition. Mock task writes must not provide a way to bypass approval.

## Approval authorization

Use tenant-local `tasks:create`, `approvals:read`, and `approvals:decide` permissions for admins, sales managers, and sales reps. Viewers cannot create or decide actions. An approver must additionally be the requester, a sales manager in the requester's department, or a tenant admin. Enforce tenant and assignment/department scope, and revalidate current permissions before execution. These rules are approved for subsequent service and route steps; this schema step does not provision permissions or implement authorization handlers.

## Approval execution and idempotency

Execute synchronously with atomic state changes: pending → approved → executing → executed or failed, with rejected and expired terminal alternatives. Claim execution through a Drizzle UPDATE guarded by `status = 'approved'`, returning the claimed row, so concurrent approvals cannot execute twice. Allow three total attempts, retrying only 5xx responses and timeouts with exponential backoff. Use the proposal's UUID as its idempotency key, not a payload hash: separately created identical proposals are allowed. Do not add a redundant `idempotency_key` column; the proposal primary key already supplies the unique UUID.

## Approval database foundation — first step

Add only `pending_actions` in this step, following existing UUID, tenant, timestamp, composite foreign-key, and RLS conventions. Store the requester user ID, action type, object JSONB payload, status, attempt count, nullable error/decision/execution timestamps, and required expiry defaulting to 24 hours after creation. Constrain type to `task.create`, status to the seven approved states, and attempts to 0–3. Keep only the primary-key and `(tenant_id, id)` constraint indexes for now. Field-level payload validation, authorization, audited state transitions, retry behavior, mock integration, and routes remain subsequent test-first steps. Verify this foundation against real Postgres, then stop for user review.

## Approval services and decisions

Complete the remaining workflow after the user's subsequent authorization. Proposal creation remains a service entry point for the future agent/tool, with no extra creation HTTP endpoint. Validate strict `{ type: 'task.create', payload: { title, description, assigneeEmployeeId, dueAt } }` input with Zod; trim title/description and normalize timezone-qualified deadlines to UTC. Derive requester identity from current server context and reload database permissions. Reps may assign themselves, managers their department, and admins any employee in the tenant.

Lock each proposal while deciding. Approval and the guarded `approved` → `executing` claim commit together with both audit events; execution follows after commit. Concurrent/repeated approvals return the existing state when another caller already claimed or completed the action. Rejected actions return 409; expired actions return 410. Reject only pending actions, with repeated rejection returning the existing result. Expire pending/approved actions lazily on an authorized decision attempt, committing that transition before returning 410. Listing defaults to unexpired pending actions and supports bounded status/limit/offset filters within the caller's approval scope.

## In-app mock task execution

Use one CRM-backed mock service shared by the executor and `/rest/` routes, avoiding loopback HTTP, a second app, extra credentials, or new tables. Require an executing/executed proposal and matching normalized task fields before `tasks.task.add` can write or return a task. Use `tasks.id = pending_actions.id` for durable idempotency with existing UUID primary keys. Reload both contexts and validate both requester's and approver's task-creation/assignment permissions before claiming and immediately before insertion. This prevents managers from using a privileged requester's proposal to assign outside their own department. Audit task creation in the same transaction as the task insert. Existing-key repeats return the existing matching task without another insert or creation audit.

Add a nullable `tasks.title` for legacy-record compatibility; newly created tasks always receive a validated nonempty title. Mock responses use the description as a display fallback for older null titles. Expose `crm.deal.list`, `crm.contact.list`, `tasks.task.add`, and `tasks.task.get` as authenticated POST methods under `/rest/`, with UUID identifiers and a documented minimal field set. Contact scope is derived from visible linked deals for managers/reps; admins may read tenant contacts. Add explicit `contacts:read` and `tasks:read` permissions for these new read methods. The data migration provisions these and the three approval/task-write permissions separately per existing tenant, granting them only to existing admin/sales_manager/sales_rep roles. New role/account provisioning must include the applicable grants; viewers never receive them automatically.

## Retries, auditing, and limits

Retry only typed HTTP 5xx/timeout failures, using three total attempts with 250/500 ms backoff. Other 4xx, permission/validation failures, and unexpected errors fail immediately. Record attempt/error updates and terminal transitions with the existing transactional audit writer; store only safe static failure messages. Failed actions are terminal and are not retried by another approval request. Independently proposed actions get new UUIDs and may execute even with identical payloads.

No worker, queue, scheduler, or automatic crash recovery is introduced. A crash or final audit/commit failure can leave an action executing, possibly with its task already stored. A repeated approval does not take over that claim; manual inspection/recovery is required. The task's unique proposal UUID prevents duplicate inserts, but execution and task persistence span transactions and are not one distributed transaction.

## Remove runtime failure simulation

At the user's request, remove the mock failure environment flag, delayed/forced failures, and configuration tests. The in-app mock runs normally and still enforces validation, authorization, and approval checks. Preserve required executor retry, failure-auditing, and duplicate-prevention tests using test-only injected HTTP errors; no runtime failure simulator or mock-specific error class remains.

## Deterministic development seed

Use `@faker-js/faker` 10.6.0 as a development dependency; its installed `hy` locale supplies Armenian names with `en` fallback. Seed each tenant with a separate fixed Faker seed and stable tenant/admin UUIDs. Capture one reference time per run and use fixed relative date offsets, as confirmed by the user; keep normally salted Argon2 password hashes and generated audit request IDs. Keep generation, tenant inserts, and the command entry point under `src/db/seed/`; no extra seeding framework or schema migration is needed.

Use `DATABASE_URL` as `app_user` and `withTenant` per tenant, including root tenant insertion, so the root and all dependent rows commit or roll back together. Skip a whole demo tenant when its UUID or name already exists, as confirmed by the user; do not overwrite existing data or refresh dates. A primary-key conflict also skips a concurrent run's tenant. A later tenant's failure does not undo an earlier committed tenant. The CLI refuses production mode because its known development passwords are public fixtures.

Create exactly 12 employees/users per tenant: one admin, five managers, five reps, and one viewer, across two departments (admin has no department). This supplies the five managers required by the overdue-task scenario. Match existing tenant-local permission grants, including viewer aggregate-only access. Generate two order items per order with consistent AMD totals, yielding 9,336 rows including identities, memberships, tenants, and seed audit events.

## Seeded analytics and untrusted content

Plant exactly 20 recently lost deals with reasons and related cause notes, three managers with overdue unfinished tasks and two without, and ten contacts whose latest activity is 21–30 days old per tenant. Keep all other contacts recently active and other lost deals outside the 30-day window. At the user's confirmation, place the tenant-A prompt-injection fixture in an existing contact-linked activity note rather than adding a contact-note column. Store it as untrusted data; future agent defenses remain separate work. Document identifiers, credentials, reference dates, and expected results in `docs/seed-scenarios.md` and verify using real PostgreSQL as `app_user`.

## Scoped invoker analytics views and derived grants

The user approved `v_deals`/`v_tasks` redacted rows, `v_contacts_activity` contact identity/company/latest activity, and `v_employee_performance` per-employee/currency deal counts and won revenue. Implement with Drizzle `pgView`, securityInvoker and securityBarrier. Exclude email/phone, activity notes, task descriptions, lost-reason text, employee login links, credentials, and audit/execution data. Preserve tenant RLS and apply server-bound tenant/department/employee scope in the views; missing scope fails closed. Contacts follow visible linked deals for managers/reps, with a contact-wide latest activity timestamp.

Invoker views require base-column SELECT. The user explicitly accepted that direct reads of those granted columns work; raw database tests instead prove excluded columns, SELECT *, unrelated tables, writes, and other-tenant rows are blocked under fixed context. The validator provides view-only access. Derive grants by walking Drizzle's view SQL and column objects, including joins/filters, and compare against PostgreSQL dependency metadata in tests. The migration owner's grants step revokes stale table/column privileges on managed tables before applying derived grants; no bootstrap changes or duplicated base-column allowlist.

## AST SQL validation and parameterization

Use pgsql-ast-parser 12.0.2 with a closed AST/function/operator/type/relation policy. Accept one read-only SELECT, validated nonrecursive read CTEs, unions, and subqueries. Reject unsupported syntax, writing/recursive CTEs, DML/DDL, SELECT INTO, locks, session/role changes, functions in FROM, system relations/columns, base tables, and user placeholders. Bound inputs to 20,000 characters, 2,000 nodes, and depth 40. Keep a conservative ASCII identifier vocabulary. Bind value literals and serialize only the validated AST, with an outer LIMIT 200. Preserve numeric token text and builtin numeric types instead of JavaScript-rounded values; retain GROUP BY/ORDER BY ordinals as syntax. Qualify real views to public, ordinary allowed functions/operators to pg_catalog, and restrict the execution search path to pg_catalog, pg_temp to prevent shadowing or implicit fallback to public functions/operators. Restore the default search path before logging.

## Analytics RBAC and execution logs

Reuse `deals:aggregate` as the initial analytics capability. Proven aggregate queries use existing aggregate scope; detail queries additionally need their view's resource read permission and use row scope. The viewer-safe aggregate subset allows one direct view, count/sum/avg/min/max, safe dimensional/date grouping, and no returned record/person identifiers; deny joins/CTEs/unions/subqueries/windows to viewers. This conservative classification also prevents mixed viewer/rep roles from turning tenant aggregate access into tenant detail access. Reload database identity and permissions for every execution; never trust supplied role/permission arrays.

Expose the requested `runAnalyticsQuery(ctx, sql, question?)` as an internal function without adding an HTTP endpoint. The user approved the optional third argument and NULL logging when absent. Use the app_user tenant transaction and a query savepoint, install trusted analytics scope, switch locally to analytics_ro, apply a five-second timeout, and execute. Restore application role or roll back the savepoint before inserting the tenant-scoped `sql_execution_log` row. Commit rejection/error logs before throwing; logging failure propagates. Store the submitted SQL, optional question, actor/request IDs, accepted/rejected/error verdict, returned count, duration, and only safe static error messages. Do not grant analytics access to this table. Standard PostgreSQL system visibility and the ability of an unrestricted raw SQL channel to change settings/roles are not claimed to be eliminated; AST restrictions and trusted execution remain necessary.
