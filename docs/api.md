# Authentication and audit API

Base URL: `http://127.0.0.1:3000`. Requests and responses use JSON. All responses carry a server-generated `X-Request-ID`. Token responses use `Cache-Control: no-store`.

## Login

`POST /auth/login`

```json
{ "tenantId": "<tenant UUID>", "email": "admin@example.invalid", "password": "<password>" }
```

HTTP 200:

```json
{ "accessToken": "<JWT>", "refreshToken": "<opaque token>", "expiresIn": 900 }
```

The email is matched exactly within the selected tenant. Passwords are verified against stored Argon2 hashes. Missing users, unknown tenants, and incorrect passwords all return HTTP 401 with `{"error":"Invalid credentials"}`. Malformed bodies and unexpected fields return 400. Five attempts per minute are allowed per connection IP; further attempts return 429. Forwarded-IP headers do not bypass this limit.

Access JWTs include `tenantId`, `userId`, `roles`, `iss`, `aud`, `iat`, `exp`, and `jti`. The signature algorithm is HS256 and the lifetime is 15 minutes. Role claims are snapshots; authorization uses current database memberships and permissions, not those snapshots. Do not send identity/role fields beyond the documented login fields.

## Refresh

`POST /auth/refresh`

```json
{ "tenantId": "<tenant UUID>", "refreshToken": "<most recently issued refresh token>" }
```

HTTP 200 returns the same token-response shape as login, with a new refresh token. Replace the old token immediately and serialize refresh calls. Tokens in a family expire seven days after its initial login; rotation does not extend that deadline. Unknown, expired, revoked, or reused tokens return 401 with `{"error":"Invalid token"}`. Reuse of any consumed token revokes the entire family, including newer descendants. Concurrent use of the same token is also reuse and invalidates the family. Other login sessions remain independent.

## Logout

`POST /auth/logout` accepts the same body as refresh. It revokes the token's family and returns 204 with no body. A consumed ancestor can also revoke its family. Repeating logout, or presenting an unknown well-formed token, still returns 204. Invalid bodies return 400.

Logout and refresh-family revocation do not invalidate existing access JWTs; they retain their original expiry. Revoked database permissions take effect on the next authenticated request because context is reloaded.

## Audit logs

`GET /audit-logs?limit=50&offset=0`

```sh
curl http://127.0.0.1:3000/audit-logs \
  -H "Authorization: Bearer <access JWT>"
```

Requires `audit_logs:read` and whole-tenant row scope (admin for the defined roles). Missing/invalid/expired Bearer tokens return 401; insufficient authorization returns 403. The response is an array of the current tenant's audit records, ordered by newest `createdAt`, then `id`. `limit` is 1–100; `offset` is 0–100000. Defaults are 50 and 0. Unknown query fields, including tenant selectors, return 400.

Each record contains `id`, `tenantId`, `actorUserId`, `action`, `entityType`, `entityId`, `requestId`, `details` (event metadata), `createdAt`, and `updatedAt`. Historical/system records may have null actor/entity/request IDs. Authentication events are `auth.login`, `auth.refresh`, `auth.refresh_reuse`, and `auth.logout`. No raw credentials or tokens are included in those events.

## Initial permissions and scopes

Provision permissions in each tenant's `permissions`, `roles`, `role_permissions`, and `user_roles` tables. There is no implicit admin permission bypass or automatic seed. The initial matrix is:

| Permission | admin | sales_manager | sales_rep | viewer |
| --- | --- | --- | --- | --- |
| `deals:read` | Tenant | Department | Assigned records | Denied |
| `deals:aggregate` | Tenant | Department | Assigned records | Tenant aggregates |
| `departments:read` | Tenant | Own department | Denied | Denied |
| `audit_logs:read` | Tenant | Denied | Denied | Denied |

The shared preHandler constructs `RequestContext { tenantId, userId, employeeId, departmentId, roles, permissions, requestId }`. Employee/department IDs may be null. Missing required scope links and unknown roles deny access; multiple roles use the broadest applicable scope. Viewer-only users cannot read individual records even if accidentally granted `deals:read`.

Production deal and department endpoints are not added by this change. Tests register temporary routes to verify authorization and actual scoped deal queries. Future routes/tools must call `can` and apply `scopeFilter` to queries. Only aggregate-producing queries may request aggregate scope; passing that mode does not itself convert a row query into an aggregate. The caller supplies the appropriate assignment column, for example `deals.responsibleEmployeeId` or `tasks.assigneeEmployeeId`. Without an assignment column, employee/department row scopes fail closed.

## Minimal local admin account

No default account exists. This is an optional one-off provisioning example, separate from the later synthetic-data generator. First run migrations and provision the PostgreSQL `app_user` password as described in [security.md](security.md). Generate an Argon2 hash interactively (the password is read from terminal input, not passed in shell arguments):

```sh
node --input-type=module -e '
import { hash } from "argon2";
import { createInterface } from "node:readline/promises";
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const password = await terminal.question("CRM password: ");
terminal.close();
console.log(await hash(password));
'
```

Then open the administrative database console:

```sh
docker compose exec db psql -U migration_owner -d ops_copilot
```

Paste the following SQL and supply the generated hash at the prompt. `\gset` saves the returned IDs as psql variables. Run once to create a new demo tenant and admin:

```sql
\prompt 'Argon2 hash: ' password_hash
BEGIN;
INSERT INTO tenants (name) VALUES ('Demo tenant') RETURNING id AS tenant_id \gset
INSERT INTO users (tenant_id, email, name, password_hash)
VALUES (:'tenant_id', 'admin@example.invalid', 'Demo admin', :'password_hash')
RETURNING id AS user_id \gset
INSERT INTO roles (tenant_id, name) VALUES (:'tenant_id', 'admin')
RETURNING id AS role_id \gset
INSERT INTO permissions (tenant_id, code, description)
SELECT :'tenant_id'::uuid, code, code FROM unnest(ARRAY[
  'deals:read', 'deals:aggregate', 'departments:read', 'audit_logs:read'
]) AS codes(code);
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT tenant_id, :'role_id'::uuid, id FROM permissions WHERE tenant_id = :'tenant_id';
INSERT INTO user_roles (tenant_id, user_id, role_id)
VALUES (:'tenant_id', :'user_id', :'role_id');
COMMIT;
\echo Login tenantId: :tenant_id
\q
```

Start `npm run dev`, then log in with the printed tenant UUID, `admin@example.invalid`, and the original password. The PostgreSQL account password and this CRM user's password are separate credentials.
