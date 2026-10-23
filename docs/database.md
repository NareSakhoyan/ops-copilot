# Database

## Local startup and migrations

The required `.env` contains `POSTGRES_DB`, `POSTGRES_PORT`, `POSTGRES_PASSWORD`, and `MIGRATION_DATABASE_URL`; `.env.example` includes local development values. Keep the URL's database, port, and password consistent with the Compose settings. Compose binds PostgreSQL to `127.0.0.1`.

```sh
docker compose up -d --wait db
npm run db:migrate
```

`docker/init.sql` runs only when PostgreSQL initializes an empty data directory. It enables `vector`, creates the two database roles, grants analytics-role membership, and sets the migration owner's default table privileges. It does not create application tables or seed records. PostgreSQL 18 persists data in the named volume mounted at `/var/lib/postgresql`.

`npm run db:generate` generates SQL from `src/db/schema/*.ts` without connecting to a database. Commit the SQL and Drizzle metadata in `drizzle/`. `npm run db:migrate` validates `MIGRATION_DATABASE_URL`, applies pending SQL as the owner, then executes `src/db/grants.ts` using the `sql` tag. This removes stale analytics table/column privileges on managed tables, derives column SELECT grants from Drizzle view definitions, and grants SELECT on the four views. Re-running the command preserves data and reapplies grants.

The initial migration is forward-only, with no destructive down script. Use a new migration for subsequent changes. Stopping Compose with `docker compose down` preserves the database volume; tests own and dispose of separate containers.

## Accounts and permissions

`migration_owner` is the local image's bootstrap superuser and owns migrated objects. Its credentials are for migration tooling, not application queries. Bootstrap gives the separate `app_user` login `NOSUPERUSER`, `NOBYPASSRLS`, and default SELECT/INSERT/UPDATE/DELETE privileges on future owner-created tables in `public`.

`analytics_ro` has `NOLOGIN` and `NOBYPASSRLS`; membership lets `app_user` use `SET LOCAL ROLE analytics_ro` inside a transaction. It receives SELECT on the four analytics views and only the underlying columns their definitions reference, including joins and filters. It receives no writes or access to other application tables. Bootstrap intentionally does not set an `app_user` password; provision it interactively as described in [security.md](security.md). The application uses the separate `DATABASE_URL` naming `app_user`; never reuse `MIGRATION_DATABASE_URL` as the application credential.

The `users`, `roles`, and `permissions` tables describe application RBAC; they are separate from these PostgreSQL roles. Users and permission definitions are not shared between tenants.

## Schema conventions

All 23 tables have a generated UUID primary key and `created_at`/`updated_at` timestamps with time zones. Drizzle sets `updated_at` on updates; raw SQL must set it explicitly. All tables except `tenants` require `tenant_id` and have a unique `(tenant_id, id)` constraint. References to tenant-scoped rows use explicit composite foreign keys, for example `contacts(tenant_id, company_id)` to `companies(tenant_id, id)`. References to the root tenant use its primary key. Deletion uses PostgreSQL's restrictive default except document deletion cascades to its chunks.

Nullable reference columns allow incomplete CRM records. Required references are marked below. UUIDs and timestamps are omitted from the table descriptions because they are common to all records.

| Table | Fields and relationships |
| --- | --- |
| `tenants` | Organization name. |
| `users` | Name, email unique within the tenant, password hash. |
| `roles` | Role name unique within the tenant. |
| `permissions` | Permission code unique within the tenant, description. |
| `role_permissions` | Required role and permission; one assignment per tenant/role/permission. |
| `user_roles` | Required user and role; one assignment per tenant/user/role. |
| `departments` | Department name unique within the tenant. |
| `employees` | Name, optional department and user; a login maps to at most one employee per tenant. |
| `companies` | Customer organization name. |
| `contacts` | Name, optional email, phone, company. |
| `leads` | Title, optional company, contact, responsible employee. |
| `deals` | Title, status, amount/currency, optional lost reason, closed time, company, contact, lead, responsible employee. |
| `activities` | Type, occurred time, note, required contact, optional deal and employee. |
| `tasks` | Title (nullable for legacy records), description, required assignee employee and deadline, status, optional contact and deal. New approved task writes require a title. |
| `products` | Name, SKU unique within the tenant, price/currency. |
| `orders` | Amount/currency, optional company, contact, deal. |
| `order_items` | Required order and product, positive integer quantity, unit price/currency. |
| `audit_logs` | Action, entity type, optional actor user and entity UUID, request UUID, JSON details containing event metadata; polymorphic entity UUIDs have no foreign key. Legacy/system rows may have no request UUID. |
| `refresh_tokens` | Required user, SHA-256 token hash unique within the tenant, family UUID, absolute expiration time, optional used/revoked times; raw tokens are not stored. |
| `pending_actions` | Required requester user, `task.create` type, object JSONB payload, status, attempts (0–3), nullable error/decision/execution timestamps, expiry defaulting to 24 hours after creation. The proposal UUID is its idempotency key. |
| `sql_execution_log` | Required user/request UUIDs, nullable question, submitted SQL, verdict (`accepted`/`rejected`/`error`), returned rows (0–200), nonnegative duration in milliseconds, nullable safe error. Required composite reference to the tenant-local user. |
| `documents` | Title, tenant-unique source filename, nonempty allowed role array, content hash, embedding model metadata; tenant RLS. |
| `chunks` | Composite tenant/document FK with cascade, positive ordinal unique per document, text/content hash, non-null `vector(1536)`; tenant RLS. |

Deal statuses are `open`, `won`, `lost`; task statuses are `todo`, `in_progress`, `done`, `cancelled`; activity types are `call`, `email`, `meeting`. SQL CHECK constraints enforce these values. Leads and orders have no workflow status columns. Overdue tasks are derived using `due_at < now()` and `status IN ('todo', 'in_progress')`.

Money uses `numeric(14,2)` and is returned as a string by the driver to preserve decimal precision. SQL checks reject negative amounts, invalid three-uppercase-letter currency formats, and nonpositive quantities. Order totals and cross-record currency conversion are not computed or enforced in this initial schema; writers must supply consistent values. Deals retain lost-reason and closed-time fields without workflow transition enforcement; redacted analytics views exclude free-form lost reasons.

Approval states are `pending`, `approved`, `executing`, `executed`, `failed`, `rejected`, and `expired`, with `pending` and zero attempts as defaults. CHECK constraints enforce the state/type values, attempt bounds, and object-shaped payload. Proposal UUIDs also become the IDs of tasks created by the executor, providing durable insert uniqueness without an extra key column or table. Independent identical proposals remain allowed. The approval and mock services validate task fields, enforce permissions and transitions, expire stale proposals on decision attempts, and audit state changes in their action transactions; the schema alone does not implement those rules.

The task-title migration preserves existing records with null titles. The approval-permission data migration inserts tenant-local permission definitions and grants them to existing `admin`, `sales_manager`, and `sales_rep` roles. It is idempotent and excludes viewers. Tenants/roles created later must receive their grants during provisioning; migrations do not install an automatic account-seeding mechanism.

## Query indexes

- `deals_tenant_status_created_at_idx` on `(tenant_id, status, created_at)` supports tenant-specific deal status and creation-date filtering.
- `tasks_tenant_status_created_at_idx` on `(tenant_id, status, created_at)` supports tenant-specific task status and creation-date filtering.
- `activities_tenant_contact_occurred_at_idx` on `(tenant_id, contact_id, occurred_at DESC)` supports latest contact activity and inactivity queries.
- `tasks_tenant_due_at_idx` on `(tenant_id, due_at)` supports tenant-specific deadline ranges and overdue-task queries.
- `refresh_tokens_tenant_family_idx` on `(tenant_id, family_id)` supports revoking every token in a tenant's refresh family.

## Constraint indexes

PostgreSQL creates the following unique B-tree indexes for primary keys and unique constraints. Composite `(tenant_id, id)` indexes back tenant-scoped foreign-key targets even though UUID IDs are also globally unique within each table.

- `tenants_pkey` on `(id)` identifies tenant records.
- `users_pkey` on `(id)` identifies user records.
- `roles_pkey` on `(id)` identifies role records.
- `permissions_pkey` on `(id)` identifies permission records.
- `role_permissions_pkey` on `(id)` identifies role-permission assignments.
- `user_roles_pkey` on `(id)` identifies user-role assignments.
- `departments_pkey` on `(id)` identifies department records.
- `employees_pkey` on `(id)` identifies employee records.
- `companies_pkey` on `(id)` identifies company records.
- `contacts_pkey` on `(id)` identifies contact records.
- `leads_pkey` on `(id)` identifies lead records.
- `deals_pkey` on `(id)` identifies deal records.
- `activities_pkey` on `(id)` identifies activity records.
- `tasks_pkey` on `(id)` identifies task records.
- `products_pkey` on `(id)` identifies product records.
- `orders_pkey` on `(id)` identifies order records.
- `order_items_pkey` on `(id)` identifies order-item records.
- `audit_logs_pkey` on `(id)` identifies audit records.
- `refresh_tokens_pkey` on `(id)` identifies refresh-token records.
- `pending_actions_pkey` on `(id)` identifies proposals and supplies their unique UUID idempotency keys.
- `sql_execution_log_pkey` on `(id)` identifies analytical query execution records.
- `users_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to users.
- `roles_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to roles.
- `permissions_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to permissions.
- `role_permissions_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped assignment identity.
- `user_roles_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped assignment identity.
- `departments_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to departments.
- `employees_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to employees.
- `companies_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to companies.
- `contacts_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to contacts.
- `leads_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to leads.
- `deals_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to deals.
- `activities_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped activity identity.
- `tasks_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped task identity.
- `products_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to products.
- `orders_tenant_id_id_unique` on `(tenant_id, id)` backs tenant-scoped references to orders.
- `order_items_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped order-item identity.
- `audit_logs_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped audit identity.
- `refresh_tokens_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped token identity.
- `pending_actions_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped proposal identity for composite references.
- `sql_execution_log_tenant_id_id_unique` on `(tenant_id, id)` provides a tenant-scoped SQL execution identity.
- `users_tenant_email_unique` on `(tenant_id, email)` prevents duplicate account emails within a tenant.
- `roles_tenant_name_unique` on `(tenant_id, name)` prevents duplicate role names within a tenant.
- `permissions_tenant_code_unique` on `(tenant_id, code)` prevents duplicate permission codes within a tenant.
- `role_permissions_membership_unique` on `(tenant_id, role_id, permission_id)` prevents duplicate role-permission assignments.
- `user_roles_membership_unique` on `(tenant_id, user_id, role_id)` prevents duplicate user-role assignments.
- `departments_tenant_name_unique` on `(tenant_id, name)` prevents duplicate department names within a tenant.
- `employees_tenant_user_unique` on `(tenant_id, user_id)` prevents multiple employees using the same login in one tenant; null user links remain allowed.
- `products_tenant_sku_unique` on `(tenant_id, sku)` prevents duplicate product SKUs within a tenant.
- `refresh_tokens_tenant_hash_unique` on `(tenant_id, token_hash)` prevents duplicate token hashes within a tenant.

## Analytics views

`src/db/schema/analytics.ts` defines these `pgView` objects with `securityInvoker: true` and `securityBarrier: true`:

| View | Contents |
| --- | --- |
| `v_deals` | Deal ID/tenant/title/status, amount/currency, creation/closure times, company/contact/responsible employee IDs, department ID. |
| `v_tasks` | Task ID/tenant/title/status, assignee/department, deadline/creation times, contact/deal IDs. |
| `v_contacts_activity` | Contact ID/tenant/name/company and `last_activity_at`, including contacts with no activities (NULL). Managers/reps see contacts linked to scoped deals. |
| `v_employee_performance` | `employee_id`, tenant, `employee_name`, department, currency, `deal_count`, `open_count`, `won_count`, `lost_count`, and `won_amount`. Employees without deals have zero totals and NULL currency. |

Money is never summed across currencies within a performance row. No view exposes email, phone, activity note, task description, lost-reason text, login links, password hashes, tokens, or execution/audit metadata. Underlying column grants are discovered by walking each Drizzle view's SQL/column references, rather than maintaining a second list. Database tests independently compare those grants with PostgreSQL's recorded view dependencies.

Tenant RLS applies to every underlying table. View predicates additionally require server-bound analytics scope: whole tenant, department, or employee. Missing scope settings fail closed. Column grants necessarily also permit direct reads of the granted base columns; the validator enforces the view-only query contract. See [security.md](security.md#guarded-sql-analytics) for the boundary.

## Database tests and current boundaries

`npm test` requires a running Docker-compatible daemon. Testcontainers starts `pgvector/pgvector:pg18` on a dynamically allocated port, copies the same bootstrap SQL, applies the committed migration through the real CLI, and removes the disposable container afterward. No developer database is reset or reused. First-run image download may take longer than subsequent runs.

Tests cover empty-database migrations, repeat migration runs, bootstrap roles and DML grants, role switching, cross-tenant foreign-key rejection in CRM and RBAC, mandatory tenant IDs, unique identifiers, status/type/money checks, and the four query indexes.

All 22 tenant-scoped tables enable RLS with one tenant policy each, and authenticated application queries use transaction-local context through `withTenant`. Composite foreign keys additionally prevent cross-tenant references. Authentication uses a separate tenant-only transaction for credential lookup, then sets the verified user ID. JWT authentication, refresh rotation/reuse detection, RBAC, and transactional audit writing are implemented and tested through a real `app_user` connection. Approval tests cover database constraints, tenant/department authorization, concurrent/conflicting decisions, permission revalidation, three-attempt retry limits, timeout-after-write idempotency, expiry, rejection, and audit rollback. The mock reuses CRM tables inside the existing app. `npm run db:seed` creates deterministic synthetic CRM data through `withTenant` as `app_user`; [seed-scenarios.md](seed-scenarios.md) lists counts, accounts, and verified scenario results. Analytics tests cover the AST guard, exact grants, role scopes, logging, and a real five-second timeout. See [security.md](security.md) for security boundaries and [api.md](api.md) for endpoint contracts.

## Knowledge indexes

- `documents_pkey` on `(id)` identifies a KB document.
- `documents_tenant_id_id_unique` on `(tenant_id, id)` supports composite chunk foreign keys.
- `documents_tenant_source_unique` on `(tenant_id, source)` prevents duplicate document sources and supports incremental lookup.
- `chunks_pkey` on `(id)` identifies a retrieved passage.
- `chunks_tenant_id_id_unique` on `(tenant_id, id)` supplies tenant-scoped chunk identity.
- `chunks_document_ordinal_unique` on `(tenant_id, document_id, ordinal)` enforces passage order and supports document/chunk lookups.
- `chunks_embedding_hnsw_idx` uses HNSW `vector_cosine_ops` for cosine search; current small-corpus retrieval uses exact ordering to avoid filtered approximate-candidate loss.

KB ingestion and retrieval enforce tenant RLS and role ACLs; see [knowledge-base.md](knowledge-base.md). Analytics grants exclude all document/chunk columns.
