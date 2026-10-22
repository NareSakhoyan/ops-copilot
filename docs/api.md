# API

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

## Task proposal service

The future agent/tool calls `createApprovalsService(database, mock).createProposal(request.context, input)` from authenticated server code. There is no separate proposal-creation HTTP endpoint. The strict input is:

```json
{
  "type": "task.create",
  "payload": {
    "title": "Call customer",
    "description": "Discuss renewal",
    "assigneeEmployeeId": "<employee UUID>",
    "dueAt": "2027-01-10T10:00:00Z"
  }
}
```

Tenant, requester, role, permissions, and request ID come from server context, never proposal input. The service trims text, normalizes timezone-qualified deadlines to UTC, validates the assignee's scope, stores a pending action with a 24-hour expiry, and writes `approval.created` atomically. It does not create a task. Reps can assign themselves, managers their department, and admins employees in their tenant. Identical inputs create independent proposal UUIDs.

## Approvals

All three routes require Bearer authentication.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/approvals?status=pending&limit=50&offset=0` | List visible proposals with `approvals:read`. |
| POST | `/approvals/:id/approve` | Approve and synchronously execute if not already claimed/completed. |
| POST | `/approvals/:id/reject` | Reject a pending proposal. |

Decision requests have no body (or `{}`). A caller must have `approvals:decide` and be the requester, a manager in the requester's current department, or a tenant admin. Listing applies that ownership/department/admin scope. `status` accepts any of the seven action states; defaults are pending, limit 50, offset 0. Limit is 1–100; offset is 0–100000. Tenant filters and unknown fields are rejected. Pending/approved lists omit elapsed proposals; an authorized decision attempt persists their expired transition.

```sh
curl http://127.0.0.1:3000/approvals \
  -H "Authorization: Bearer <access JWT>"

curl -X POST http://127.0.0.1:3000/approvals/<proposal UUID>/approve \
  -H "Authorization: Bearer <access JWT>"
```

Decisions return the proposal record. Successful execution has `status: "executed"`, `executedAt`, and the attempt count; a completed unsuccessful execution returns HTTP 200 with `status: "failed"` and a safe `error`. Clients must inspect the action status. Concurrent/repeated approvals return the current state without restarting execution; a concurrent caller may observe `executing`. Rejection is idempotent. Approval also requires `tasks:create` and assignment scope for both requester and approver; a manager cannot approve an admin's proposal targeting another department. Unauthorized decisions return 403, other-tenant/missing proposals 404, invalid state changes 409, and expired decisions 410. Failed/rejected/expired proposals are terminal; requesting the same task again requires a new proposal UUID.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> approved
    approved --> executing
    executing --> executed
    executing --> failed
    pending --> rejected
    pending --> expired
    approved --> expired
```

Approval and the conditional execution claim commit together with both audits. Each attempt is recorded. Only typed 5xx/timeout errors retry, with three total attempts and 250/500 ms backoff. Other 4xx, authorization/validation failures, and unexpected errors stop immediately. Permissions and assignment scope are rechecked before task insertion. Each state transition has an audit event with `details.from`/`details.to` (creation has only `to`); attempts and failures have separate events.

## Mock Bitrix methods

These authenticated POST methods run in the same app and database; no separate container or credentials are required. This is a minimal compatibility subset with UUID identifiers, not the full Bitrix API. Task input field naming follows [Bitrix24 tasks.task.add](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html).

| Route | Body | Permission/scope |
| --- | --- | --- |
| `/rest/crm.deal.list` | `{ "limit": 50, "start": 0 }` or `{}` | `deals:read`; tenant/department/assigned deals. |
| `/rest/crm.contact.list` | Same pagination | `contacts:read`; admin tenant contacts, otherwise contacts linked to visible deals. |
| `/rest/tasks.task.get` | `{ "taskId": "<task UUID>" }` | `tasks:read`; tenant/department/assignee scope. |
| `/rest/tasks.task.add` | Task fields below | Eligible approver, an executing/executed proposal, and current requester assignment permissions. |

List limits are 1–100 and starts 0–100000, with defaults 50 and 0; unknown fields are rejected. List responses use `{ "result": [...] }`. Task get/add responses use `{ "result": { "task": { "id", "title", "description", "responsibleId", "deadline", "status" } } }`.

Task add requires `Idempotency-Key: <proposal UUID>` and this body:

```json
{
  "fields": {
    "TITLE": "Call customer",
    "DESCRIPTION": "Discuss renewal",
    "RESPONSIBLE_ID": "<employee UUID>",
    "DEADLINE": "2027-01-10T10:00:00Z"
  }
}
```

The fields must match the normalized proposal. Pending, rejected, expired, or failed proposals cannot create tasks through this route. A task's UUID is its proposal UUID; repeats return the existing matching task without another insert/audit. The executor uses the same operation in process, so no loopback HTTP client is needed. Old tasks with a null title display their description as a title fallback.

A process crash or final audit failure can leave an action executing; there is no background takeover or automatic recovery. See [security.md](security.md).

## Initial permissions and scopes

Provision permissions in each tenant's `permissions`, `roles`, `role_permissions`, and `user_roles` tables. There is no implicit admin permission bypass. The approval data migration augments existing admin/manager/rep roles with the five new workflow/read codes. Tenants/roles created afterward need explicit provisioning. The matrix is:

| Permission | admin | sales_manager | sales_rep | viewer |
| --- | --- | --- | --- | --- |
| `deals:read` | Tenant | Department | Assigned records | Denied |
| `deals:aggregate` | Tenant | Department | Assigned records | Tenant aggregates |
| `departments:read` | Tenant | Own department | Denied | Denied |
| `audit_logs:read` | Tenant | Denied | Denied | Denied |
| `tasks:create` | Tenant assignees | Department assignees | Self | Denied |
| `tasks:read` | Tenant | Department | Assigned tasks | Denied |
| `contacts:read` | Tenant | Contacts of visible deals | Contacts of visible deals | Denied |
| `approvals:read` | Tenant | Own/department requesters | Own | Denied |
| `approvals:decide` | Tenant | Own/department requesters | Own | Denied |

The shared preHandler constructs `RequestContext { tenantId, userId, employeeId, departmentId, roles, permissions, requestId }`. Employee/department IDs may be null. Missing required scope links and unknown roles deny access; multiple roles use the broadest applicable scope. Viewer-only users cannot read individual records even if accidentally granted `deals:read`.

The mock routes demonstrate scoped CRM reads. Future routes/tools must call `can` and apply `scopeFilter` to queries. Only aggregate-producing queries may request aggregate scope; passing that mode does not itself convert a row query into an aggregate. The caller supplies the appropriate assignment column, for example `deals.responsibleEmployeeId` or `tasks.assigneeEmployeeId`. Without an assignment column, employee/department row scopes fail closed.

## Minimal local admin account

For ready-made development accounts, run `npm run db:seed` after migrations and database password setup; see [seed-scenarios.md](seed-scenarios.md) for tenant UUIDs and credentials. The following is an optional manual provisioning alternative. First run migrations and provision the PostgreSQL `app_user` password as described in [security.md](security.md). Generate an Argon2 hash interactively (the password is read from terminal input, not passed in shell arguments):

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

Run this command **alone**, then paste the complete generated hash at its prompt:

```text
\prompt 'Argon2 hash: ' password_hash
```

Run each following block separately, pressing Enter after each `\gset` before pasting the next block. Do not bulk-paste the prompt together with SQL. Run once to create a demo tenant and admin; if an insert fails, use `ROLLBACK;` before starting again.

```sql
BEGIN;
INSERT INTO tenants (name) VALUES ('Demo tenant') RETURNING id AS tenant_id
\gset
```

```sql
INSERT INTO users (tenant_id, email, name, password_hash)
VALUES (:'tenant_id', 'admin@example.invalid', 'Demo admin', :'password_hash')
RETURNING id AS user_id
\gset
```

```sql
INSERT INTO roles (tenant_id, name) VALUES (:'tenant_id', 'admin')
RETURNING id AS role_id
\gset
```

```sql
INSERT INTO permissions (tenant_id, code, description)
SELECT :'tenant_id'::uuid, code, code FROM unnest(ARRAY[
  'deals:read', 'deals:aggregate', 'departments:read', 'audit_logs:read',
  'contacts:read', 'tasks:read', 'tasks:create', 'approvals:read', 'approvals:decide'
]) AS codes(code);
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT tenant_id, :'role_id'::uuid, id FROM permissions WHERE tenant_id = :'tenant_id';
INSERT INTO user_roles (tenant_id, user_id, role_id)
VALUES (:'tenant_id', :'user_id', :'role_id');
INSERT INTO employees (tenant_id, user_id, name)
VALUES (:'tenant_id', :'user_id', 'Demo admin') RETURNING id AS assignee_employee_id;
COMMIT;
```

Run the final command separately to print your tenant ID:

```text
\echo Login tenantId: :tenant_id
```

Start `npm run dev`, then log in with the printed tenant UUID, `admin@example.invalid`, and the original password. Save the returned employee UUID for task-proposal input. The PostgreSQL account password and this CRM user's password are separate credentials.
