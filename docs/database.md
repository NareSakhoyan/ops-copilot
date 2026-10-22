# Database

## Local startup and migrations

The required `.env` contains `POSTGRES_DB`, `POSTGRES_PORT`, `POSTGRES_PASSWORD`, and `MIGRATION_DATABASE_URL`; `.env.example` includes local development values. Keep the URL's database, port, and password consistent with the Compose settings. Compose binds PostgreSQL to `127.0.0.1`.

```sh
docker compose up -d --wait db
npm run db:migrate
```

`docker/init.sql` runs only when PostgreSQL initializes an empty data directory. It enables `vector`, creates the two database roles, grants analytics-role membership, and sets the migration owner's default table privileges. It does not create application tables or seed records. PostgreSQL 18 persists data in the named volume mounted at `/var/lib/postgresql`.

`npm run db:generate` generates SQL from `src/db/schema/*.ts` without connecting to a database. Commit the SQL and Drizzle metadata in `drizzle/`. `npm run db:migrate` validates `MIGRATION_DATABASE_URL`, applies pending SQL as the owner, then executes the empty Drizzle SQL statement exported by `src/db/grants.ts`. Add future explicit grants there using the `sql` tag. Re-running the migration command preserves existing data.

The initial migration is forward-only, with no destructive down script. Use a new migration for subsequent changes. Stopping Compose with `docker compose down` preserves the database volume; tests own and dispose of separate containers.

## Accounts and permissions

`migration_owner` is the local image's bootstrap superuser and owns migrated objects. Its credentials are for migration tooling, not application queries. Bootstrap gives the separate `app_user` login `NOSUPERUSER`, `NOBYPASSRLS`, and default SELECT/INSERT/UPDATE/DELETE privileges on future owner-created tables in `public`.

`analytics_ro` has `NOLOGIN` and `NOBYPASSRLS`; membership lets `app_user` use `SET LOCAL ROLE analytics_ro` inside a transaction. Explicit analytics table grants are deferred, so switching roles does not yet provide table access. Bootstrap intentionally does not set an `app_user` password; provision it interactively as described in [security.md](security.md). The application uses the separate `DATABASE_URL` naming `app_user`; never reuse `MIGRATION_DATABASE_URL` as the application credential.

The `users`, `roles`, and `permissions` tables describe application RBAC; they are separate from these PostgreSQL roles. Users and permission definitions are not shared between tenants.

## Schema conventions

All 19 tables have a generated UUID primary key and `created_at`/`updated_at` timestamps with time zones. Drizzle sets `updated_at` on updates; raw SQL must set it explicitly. All tables except `tenants` require `tenant_id` and have a unique `(tenant_id, id)` constraint. References to tenant-scoped rows use explicit composite foreign keys, for example `contacts(tenant_id, company_id)` to `companies(tenant_id, id)`. References to the root tenant use its primary key. Deletion uses PostgreSQL's restrictive default; nothing cascades automatically.

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
| `tasks` | Description, required assignee employee and deadline, status, optional contact and deal. |
| `products` | Name, SKU unique within the tenant, price/currency. |
| `orders` | Amount/currency, optional company, contact, deal. |
| `order_items` | Required order and product, positive integer quantity, unit price/currency. |
| `audit_logs` | Action, entity type, optional actor user and entity UUID, request UUID, JSON details containing event metadata; polymorphic entity UUIDs have no foreign key. Legacy/system rows may have no request UUID. |
| `refresh_tokens` | Required user, SHA-256 token hash unique within the tenant, family UUID, absolute expiration time, optional used/revoked times; raw tokens are not stored. |

Deal statuses are `open`, `won`, `lost`; task statuses are `todo`, `in_progress`, `done`, `cancelled`; activity types are `call`, `email`, `meeting`. SQL CHECK constraints enforce these values. Leads and orders have no workflow status columns. Overdue tasks are derived using `due_at < now()` and `status IN ('todo', 'in_progress')`.

Money uses `numeric(14,2)` and is returned as a string by the driver to preserve decimal precision. SQL checks reject negative amounts, invalid three-uppercase-letter currency formats, and nonpositive quantities. Order totals and cross-record currency conversion are not computed or enforced in this initial schema; writers must supply consistent values. Lost-reason and closed-time fields are available for analytics, without workflow transition enforcement yet.

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
- `users_tenant_email_unique` on `(tenant_id, email)` prevents duplicate account emails within a tenant.
- `roles_tenant_name_unique` on `(tenant_id, name)` prevents duplicate role names within a tenant.
- `permissions_tenant_code_unique` on `(tenant_id, code)` prevents duplicate permission codes within a tenant.
- `role_permissions_membership_unique` on `(tenant_id, role_id, permission_id)` prevents duplicate role-permission assignments.
- `user_roles_membership_unique` on `(tenant_id, user_id, role_id)` prevents duplicate user-role assignments.
- `departments_tenant_name_unique` on `(tenant_id, name)` prevents duplicate department names within a tenant.
- `employees_tenant_user_unique` on `(tenant_id, user_id)` prevents multiple employees using the same login in one tenant; null user links remain allowed.
- `products_tenant_sku_unique` on `(tenant_id, sku)` prevents duplicate product SKUs within a tenant.
- `refresh_tokens_tenant_hash_unique` on `(tenant_id, token_hash)` prevents duplicate token hashes within a tenant.

## Database tests and current boundaries

`npm test` requires a running Docker-compatible daemon. Testcontainers starts `pgvector/pgvector:pg18` on a dynamically allocated port, copies the same bootstrap SQL, applies the committed migration through the real CLI, and removes the disposable container afterward. No developer database is reset or reused. First-run image download may take longer than subsequent runs.

Tests cover empty-database migrations, repeat migration runs, bootstrap roles and DML grants, role switching, cross-tenant foreign-key rejection in CRM and RBAC, mandatory tenant IDs, unique identifiers, status/type/money checks, and the four query indexes.

All 18 tenant-scoped tables enable RLS with one tenant policy each, and authenticated application queries use transaction-local context through `withTenant`. Composite foreign keys additionally prevent cross-tenant references. Authentication uses a separate tenant-only transaction for credential lookup, then sets the verified user ID. JWT authentication, refresh rotation/reuse detection, RBAC, and transactional audit writing are implemented and tested through a real `app_user` connection. There are no AI-related tables; explicit analytics table grants and synthetic data generation remain deferred. See [security.md](security.md) for security boundaries and [api.md](api.md) for authentication contracts.
