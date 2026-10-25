# Database

## Local startup and migrations

Required `.env`: `POSTGRES_DB`, `POSTGRES_PORT`, `POSTGRES_PASSWORD`, `MIGRATION_DATABASE_URL` (keep the URL's DB/port/password consistent with Compose). `docker-compose.override.yml` (auto-merged locally) binds Postgres to `127.0.0.1` for host-side dev; the base `docker-compose.yml` used for real deployment doesn't publish it at all ([operations.md](operations.md)).

```sh
docker compose up -d --wait postgres
npm run db:migrate
```

`docker/init.sql` runs only on an empty data directory: enables `vector`, creates the two roles, grants `analytics_ro` membership, sets the owner's default table privileges — no application tables or seed data. Postgres 18 persists under `/var/lib/postgresql`.

`npm run db:generate` builds SQL from `src/db/schema/*.ts` with no DB connection — commit it under `drizzle/`. `npm run db:migrate` validates `MIGRATION_DATABASE_URL`, applies pending SQL as the owner, then runs `src/db/grants.ts`: removes stale analytics privileges on managed tables, derives column SELECT grants from the Drizzle view definitions, and grants SELECT on the four views. Rerunning preserves data and reapplies grants. Forward-only, no destructive down script.

## Accounts and permissions

`migration_owner` is the bootstrap superuser, owns migrated objects, and is for migration tooling only. `app_user` (`NOSUPERUSER`/`NOBYPASSRLS`) gets default SELECT/INSERT/UPDATE/DELETE on future owner-created `public` tables. `analytics_ro` (`NOLOGIN`/`NOBYPASSRLS`) lets `app_user` `SET LOCAL ROLE` to it, with SELECT only on the four analytics views and their referenced base columns — no writes, no other tables. Bootstrap intentionally sets no `app_user` password; provision it interactively ([security.md](security.md)). The app uses `DATABASE_URL` (never `MIGRATION_DATABASE_URL`).

`users`/`roles`/`permissions` tables implement application RBAC — separate from these Postgres roles, and never shared between tenants.

## Schema conventions

All 23 tables: generated UUID PK, `created_at`/`updated_at` (Drizzle sets `updated_at` on update; raw SQL must set it explicitly). Every table but `tenants` requires `tenant_id` plus a unique `(tenant_id, id)`; references to tenant-scoped rows use explicit composite FKs (e.g. `contacts(tenant_id, company_id)` → `companies(tenant_id, id)`). Deletion is Postgres's restrictive default, except document deletion cascades to chunks.

| Table | Fields and relationships |
| --- | --- |
| `tenants` | Organization name. |
| `users` | Name, email (unique per tenant), password hash. |
| `roles` | Role name (unique per tenant). |
| `permissions` | Permission code (unique per tenant), description. |
| `role_permissions` | Role + permission, one per tenant/role/permission. |
| `user_roles` | User + role, one per tenant/user/role. |
| `departments` | Department name (unique per tenant). |
| `employees` | Name, optional department/user (≤1 employee per login per tenant). |
| `companies` | Customer organization name. |
| `contacts` | Name, optional email/phone/company. |
| `leads` | Title, optional company/contact/responsible employee. |
| `deals` | Title, status, amount/currency, optional lost reason/closed time/company/contact/lead/responsible employee. |
| `activities` | Type, occurred time, note, required contact, optional deal/employee. |
| `tasks` | Title (nullable for legacy rows — new approved writes require one), description, required assignee+deadline, status, optional contact/deal. |
| `products` | Name, SKU (unique per tenant), price/currency. |
| `orders` | Amount/currency, optional company/contact/deal. |
| `order_items` | Required order+product, positive quantity, unit price/currency. |
| `audit_logs` | Action, entity type, optional actor/entity UUID (polymorphic, no FK)/request UUID, JSON `details`. |
| `refresh_tokens` | Required user, SHA-256 hash (unique per tenant), family UUID, expiry, optional used/revoked times — raw tokens never stored. |
| `pending_actions` | Requester, `task.create` type, JSONB payload, status, attempts (0–3), nullable error/decision/execution timestamps, 24h default expiry. Its own UUID is the idempotency key. |
| `sql_execution_log` | User+request UUIDs, nullable question, submitted SQL, verdict, row count (0–200), duration, nullable safe error. |
| `documents` | Title, source filename (unique per tenant), nonempty `allowed_roles`, content hash, embedding-model metadata; tenant RLS. |
| `chunks` | Composite tenant/document FK (cascade), ordinal (unique per document), text/content hash, `vector(1536)`; tenant RLS. |

Deal status: `open`/`won`/`lost`; task status: `todo`/`in_progress`/`done`/`cancelled`; activity type: `call`/`email`/`meeting` — all CHECK-constrained. Leads/orders have no status column. Overdue tasks: `due_at < now() AND status IN ('todo','in_progress')`. Money is `numeric(14,2)` (returned as a string to preserve precision); CHECKs reject negative amounts, bad 3-letter currency codes, and nonpositive quantities — totals/currency conversion aren't computed, writers must supply consistent values. Redacted analytics views exclude free-form lost-reason text.

Approval states: `pending`/`approved`/`executing`/`executed`/`failed`/`rejected`/`expired` (default `pending`, 0 attempts), CHECK-constrained along with payload shape. A proposal's UUID becomes its task's UUID — durable insert uniqueness with no extra key. The approval/mock *services* (not the schema) enforce permissions, transitions, expiry, and audit.

Migrations: the task-title one preserves legacy null titles; the approval-permission one idempotently grants its new codes to existing `admin`/`sales_manager`/`sales_rep` roles (excluding viewer) — tenants/roles created later need provisioning, there's no auto-seed.

## Indexes

Query indexes:

- `deals_tenant_status_created_at_idx` `(tenant_id, status, created_at)` — deal status/date filtering.
- `tasks_tenant_status_created_at_idx` `(tenant_id, status, created_at)` — task status/date filtering.
- `activities_tenant_contact_occurred_at_idx` `(tenant_id, contact_id, occurred_at DESC)` — latest-activity/inactivity queries.
- `tasks_tenant_due_at_idx` `(tenant_id, due_at)` — deadline ranges, overdue tasks.
- `refresh_tokens_tenant_family_idx` `(tenant_id, family_id)` — revoking a whole refresh family.

Constraint indexes follow two generic patterns across all 23 tables (named `<table>_pkey` and `<table>_tenant_id_id_unique`): every table gets a `(id)` primary-key index, and every table except `tenants` additionally gets a `(tenant_id, id)` unique index backing composite tenant-scoped FKs. Beyond that generic pair, these columns carry their own uniqueness:

- `users_tenant_email_unique` `(tenant_id, email)`
- `roles_tenant_name_unique` `(tenant_id, name)`
- `permissions_tenant_code_unique` `(tenant_id, code)`
- `role_permissions_membership_unique` `(tenant_id, role_id, permission_id)`
- `user_roles_membership_unique` `(tenant_id, user_id, role_id)`
- `departments_tenant_name_unique` `(tenant_id, name)`
- `employees_tenant_user_unique` `(tenant_id, user_id)` — null user links still allowed
- `products_tenant_sku_unique` `(tenant_id, sku)`
- `refresh_tokens_tenant_hash_unique` `(tenant_id, token_hash)`

KB tables (see below) follow the same two generic patterns plus their own source/ordinal uniqueness.

## Analytics views

`src/db/schema/analytics.ts` — `pgView` with `securityInvoker: true` + `securityBarrier: true`:

| View | Contents |
| --- | --- |
| `v_deals` | ID/tenant/title/status, amount/currency, created/closed times, company/contact/responsible-employee IDs, department. |
| `v_tasks` | ID/tenant/title/status, assignee/department, deadline/created times, contact/deal IDs. |
| `v_contacts_activity` | ID/tenant/name/company + `last_activity_at` (NULL if none). Managers/reps see only contacts linked to scoped deals. |
| `v_employee_performance` | `employee_id`, tenant, name, department, currency, `deal_count`/`open_count`/`won_count`/`lost_count`, `won_amount` (zero/NULL currency if no deals). |

Never sums money across currencies in one row. No view exposes email, phone, notes, task descriptions, lost-reason text, login links, hashes, tokens, or audit/execution data. Column grants are derived by walking each view's own SQL (not a maintained second list); tests cross-check them against Postgres's recorded dependencies. Tenant RLS still applies underneath; view predicates additionally require server-bound scope (tenant/department/employee) — missing scope fails closed. See [security.md](security.md#guarded-sql-analytics) for the full boundary (granted base columns are still directly readable, which is expected and accepted).

## Database tests and current boundaries

`npm test` needs a running Docker daemon — Testcontainers spins up `pgvector/pgvector:pg18`, applies the real bootstrap + migration CLI, then disposes it; no developer database is touched. Coverage: empty-DB and repeat migrations, bootstrap roles/grants, role switching, cross-tenant FK rejection, mandatory tenant IDs, unique/status/money CHECKs, the five query indexes, all 22 tenant tables' single RLS policy via `withTenant`, JWT/refresh/RBAC/audit through a real `app_user` connection, approval constraints/authorization/concurrency/retries/expiry/rollback, deterministic seed generation ([seed-scenarios.md](seed-scenarios.md)), and the SQL guard's AST/grants/scopes/logging/real 5s timeout. See [security.md](security.md) and [api.md](api.md) for the security/endpoint contracts these tests back.

## Knowledge indexes

- `documents_pkey` `(id)`, `documents_tenant_id_id_unique` `(tenant_id, id)` — identity, composite chunk FKs.
- `documents_tenant_source_unique` `(tenant_id, source)` — no duplicate sources, supports incremental lookup.
- `chunks_pkey` `(id)`, `chunks_tenant_id_id_unique` `(tenant_id, id)` — identity.
- `chunks_document_ordinal_unique` `(tenant_id, document_id, ordinal)` — passage order, document/chunk lookup.
- `chunks_embedding_hnsw_idx` — HNSW `vector_cosine_ops`; current small corpus uses exact ordering instead, to avoid filtered approximate-candidate loss.

KB ingestion/retrieval enforce tenant RLS and role ACLs — see [knowledge-base.md](knowledge-base.md). Analytics grants exclude every document/chunk column.
