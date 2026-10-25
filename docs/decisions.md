# Decisions

## Runtime and modules

Node.js 24, ESM.

## Package manager

npm, not pnpm. Required verification: `npm test`, `npm run lint`.

## Project layout and execution

Workspace root is the project root, package `ops-copilot`. App modules under `src/`; `evals/`, `tests/`, `docs/` at root. `tsx` for dev, `tsc` to compile, Node runs the compiled ESM output.

## Configuration

A `.env` file must exist (with a matching gitignored `.env.example`). Load it via Node's env parsing, then validate with Zod before the server starts — process env overrides file values. Defaults: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, `LOG_LEVEL=info`. Invalid config prevents startup.

## Health and request logging

`GET /health` → 200 `{"status":"ok"}`. Request UUIDs are server-generated, logged as pino's `reqId`, and returned as `X-Request-ID` — never taken from client headers.

## Development log display

`npm run dev` pipes through `pino-pretty` (colored severity, local timestamps, no PID/hostname). Production (`npm start`) and tests keep structured Pino JSON — same redaction, no request bodies/tokens/raw DB errors, no second logger.

## Application foundation

`ops-copilot`: Fastify, strict TypeScript (no `any`), Zod for input/env validation, pino with a per-request ID, Vitest, ESLint. `GET /health` ships from day one.

## Trust boundaries

`tenant_id`/`user_id`/role always come from server-side request context, never LLM output. SQL always uses parameters — user or LLM text is never concatenated into SQL.

## Change process

Every feature needs tests; run the required verification commands before finishing. Ask about ambiguous requirements; append a short entry here for each non-trivial choice.

## Tooling compatibility

TypeScript 6.0 (the installed typescript-eslint release doesn't yet support 6.1+). ESLint flat config with type-aware rules, explicit `any` ban. Lockfile committed for reproducible installs.

## Pre-commit checks

Husky (via npm's `prepare`) runs lint-staged, which runs `eslint --fix` on staged TS/JS — successful fixes auto-stage, remaining errors block the commit. Full tests/lint still required before finishing feature work.

## Cleanup

Removed: unrelated Next.js snippet docs, unused Vitest mock settings, the redundant `noImplicitAny` (already implied by `strict`). Kept: requested scaffold directories and existing-behavior tests.

## Database foundation

`pgvector/pgvector:pg18` via Compose, Drizzle ORM + node-postgres, Drizzle Kit for committed SQL migrations, Testcontainers for disposable test Postgres. Data under `/var/lib/postgresql`; credentials in `.env`/`.env.example`.

## Database ownership and bootstrap

Bootstrap superuser is `migration_owner` (migration tooling only); app access is the separate restricted `app_user`. Bootstrap SQL only: enable `vector`, create `app_user`/`analytics_ro`, grant membership, set the owner's future DML grants to `app_user` — no app password, no analytics SELECT grants, no seed data, no tables, no RLS. Drizzle's (then-empty) grants step runs after migrations.

## Tenant-scoped CRM schema

Every table but `tenants` is tenant-scoped, including users/roles/permissions. UUID PKs, unique `(tenant_id, id)` per tenant table, explicit composite FKs for tenant-scoped references. Natural identifiers and RBAC memberships are unique per tenant. Default restrictive deletion, not cascading.

## Minimal CRM relationships and constraints

Employees: optional login + department link. Contacts: optional company. Leads/deals: optional company/contact/responsible employee; deals also link a lead. Activities: required contact, optional deal/employee. Tasks: required description/deadline/assignee, optional contact/deal. Orders: optional company/contact/deal; order items require order+product. Audit actor/entity IDs may be absent for system events (polymorphic entity ID has no FK). Refresh tokens require a tenant-scoped user, hash, and expiry.

Deal status `open`/`won`/`lost`; task status `todo`/`in_progress`/`done`/`cancelled`; activity type `call`/`email`/`meeting` — CHECK constraints, not Postgres enums. No lead/order status. Overdue tasks derive from `due_at` + unfinished status. Money: nonnegative `numeric(14,2)` + uppercase 3-letter currency; order quantities positive integers. `timestamptz` throughout; Drizzle manages `updated_at` on its own writes, raw SQL must set it explicitly.

## Initial migration lifecycle

Initial schema generated into `drizzle/`, applied as owner, then `src/db/grants.ts` runs. No destructive down script — forward migrations only. Disposable test DBs may be removed; persistent dev DBs are never auto-reset. RLS, AI tables, auth flows, and the seed generator are separate later work.

## Tenant row-level security

RLS enabled on all 18 tenant-scoped tables at the time (Drizzle 0.45's `pgRole(...).existing()`, `pgPolicy`, `.enableRLS()`), superseding the initial deferral. Bootstrap roles stay in `docker/init.sql`. One `FOR ALL` policy per table, naming both `app_user` and `analytics_ro` with identical USING/WITH CHECK. Command permissions stay separate — `app_user` keeps table DML, `analytics_ro` gets only explicit SELECT once analytics is enabled; this doesn't widen analytics privileges.

Policy predicate: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. `NULLIF` turns both "never set" and "reset to empty" into NULL, so both fail closed safely across connection reuse.

## Application database context and credentials

Separate Zod-validated `DATABASE_URL` naming `app_user`; rejects query-string `user` overrides, never falls back to `MIGRATION_DATABASE_URL`. Password is set via the owner's interactive `psql \password`, outside bootstrap SQL. Default pool is lazy (first tenant op) and closes with Fastify; a small factory supports isolated test pools.

`withTenant(ctx, fn)` validates server-side `tenant_id`/`user_id`, opens one transaction, installs both via parameterized `set_config`. Commit on success, rollback + context reset on failure. `app_user` is neither owner nor superuser and has no BYPASSRLS, so ordinary RLS applies without FORCE. This boundary doesn't replace JWT auth, RBAC, or SQL validation.

## Authentication contracts and credential lookup

Argon2 password verification, `jose` for JWTs, `@fastify/rate-limit` for login throttling. Login: `{ tenantId, email, password }`; refresh/logout: `{ tenantId, refreshToken }`. JSON tokens, Bearer auth, no cookies/browser storage. The supplied tenant ID only selects which credentials to look up under RLS — it isn't an authenticated context. Credential lookup runs as `app_user` in a tenant-only transaction with an empty user setting until a real user resolves; never an invented UUID or owner credentials.

## Access tokens and request context

HS256 JWTs, required ≥32-char secret, issuer, audience, 15-minute expiry (defaults `ops-copilot`/`ops-copilot-api`). Claims: `tenantId`, `userId`, role names. The shared preHandler verifies the JWT, confirms the user still exists, and reloads roles/permissions/employee/department from Postgres every request — JWT roles are informational snapshots only. Request IDs stay server-generated; DB connections stay lazy so `/health` needs none.

## Refresh families and logout

32 random bytes → base64url token; only the SHA-256 hash is stored (consumed rows kept for reuse detection, plus `family_id`/`used_at`). Login opens a fixed 7-day family; rotation inherits that expiry. A per-tenant/family advisory lock serializes refresh/logout. Reusing a consumed token revokes the whole family + an audit event, committed before the error returns. Logout revokes the presented family (even via an ancestor token), idempotently. Neither revokes other sessions or already-issued access JWTs (≤15 min left regardless). Simultaneous refresh = reuse = family revocation.

## RBAC and record scoping

Permission checks need a tenant-local DB permission code plus a recognized scope — no implicit admin bypass. Admin = tenant; manager = department; rep = own assigned records; viewer = aggregates only. Broadest applicable scope wins across multiple roles; unknown roles/missing links fail closed; `can` rejects viewer mutations even if mistakenly assigned. Initial grants: admin gets `deals:read`/`deals:aggregate`/`departments:read`/`audit_logs:read`; manager gets the first three; rep gets the two deal permissions; viewer gets only `deals:aggregate`. `audit_logs:read` + whole-tenant scope makes audit listing admin-only. Callers must pair permission checks with the scope filter; only real aggregate queries may request aggregate scope. Test-only routes demonstrate manager denial/deal filtering without adding unrequested production endpoints.

## Transactional auditing and API limits

The audit writer runs inside the action's own transaction, taking tenant/actor/request-ID from context; metadata goes in the existing `details` JSONB (new nullable `request_id` added for legacy compatibility). Login/rotation/reuse/logout each write their event in the same transaction as the session change. Failed credential checks (no actor) stay as HTTP logs only. Audit listing is deterministically ordered with bounded pagination. Login: 5/min/IP, in-memory, proxy headers untrusted. Logs redact auth/cookie/token/password fields, never bodies or raw DB errors, and return generic error messages.

## Shared database test setup

`tests/helpers/database.ts` shares Postgres container bootstrap + migration CLI execution across suites; each suite keeps its own disposable container/fixtures/cleanup, running migrations explicitly so it can still inspect the empty DB and verify repeat runs. The RLS suite keeps a single-connection pool for deterministic reuse checks.

## Test scope and duplication

Removed: standalone env-parser non-object checks, URL pass-through assertions already covered by real DB tests, repeated file-validation checks already covered by startup tests. Consolidated RLS metadata assertions (including the unscoped root tenant) into the RLS suite; kept exact schema-inventory checks in migration tests. Kept credential/permission/isolation/token-lifecycle/transaction/startup-failure coverage.

## Approval workflow MVP scope

Mock Bitrix stays inside the existing app, reusing CRM tables — no separate app/container/DB/`bitrix_` tables/workers/queues. Only `task.create` proposals (title, description, assignee, deadline). Each state transition reuses the existing audit writer in its own transaction. Mock writes can never bypass approval.

## Approval authorization

Tenant-local `tasks:create`/`approvals:read`/`approvals:decide` for admin/manager/rep (not viewer). An approver must also be the requester, the requester's department manager, or a tenant admin. Tenant + assignment/department scope enforced, permissions re-validated before execution. (This entry covers only the approved rules — not yet the schema/handlers.)

## Approval execution and idempotency

Synchronous, atomic: `pending → approved → executing → executed|failed`, plus terminal `rejected`/`expired`. Execution claim is a Drizzle `UPDATE ... WHERE status = 'approved'` returning the claimed row — concurrent approvals can't double-execute. ≤3 attempts, retrying only 5xx/timeouts with backoff. The proposal's own UUID is its idempotency key (not a payload hash) — identical independent proposals are allowed; no extra `idempotency_key` column needed.

## Approval database foundation — first step

Added only `pending_actions`: requester, action type, JSONB payload, status, attempts, nullable error/decision/execution timestamps, 24h default expiry. CHECKs on type/status/attempts. Just the PK and `(tenant_id, id)` indexes for now — validation, authorization, audited transitions, retries, mock integration, and routes are later steps.

## Approval services and decisions

Proposal creation is a service entry point for the future agent/tool, no extra HTTP endpoint. Strict Zod input `{ type: 'task.create', payload: { title, description, assigneeEmployeeId, dueAt } }`; trims text, normalizes deadlines to UTC. Requester identity from server context; reps assign themselves, managers their department, admins any tenant employee.

Decisions lock the proposal. Approval + the guarded `approved→executing` claim commit together with both audits; execution follows after commit. Concurrent/repeat approvals return the existing state. Rejected → 409, expired → 410 on later attempts (only pending can be rejected, repeats return the existing result). Pending/approved lazily expire on a decision attempt, committing before the 410. Listing defaults to unexpired pending, with bounded status/limit/offset filters within the caller's scope.

## In-app mock task execution

One CRM-backed mock service shared by the executor and `/rest/` routes — no loopback HTTP, second app, or new tables. `tasks.task.add` requires an executing/executed proposal with matching normalized fields. `tasks.id = pending_actions.id` gives durable idempotency for free. Both requester's and approver's permissions/scope are re-checked before claiming *and* again before insertion — stopping a manager from riding a privileged requester's proposal outside their department. Task creation and its audit share a transaction; repeats on an existing key return the existing task, no re-insert/re-audit.

Added nullable `tasks.title` (legacy compatibility) — new tasks always get a real title, old null-title tasks fall back to displaying their description. Exposed `crm.deal.list`, `crm.contact.list`, `tasks.task.add`, `tasks.task.get` as authenticated `/rest/` POSTs with UUID IDs. Manager/rep contact scope follows visible linked deals; admins see tenant contacts. New `contacts:read`/`tasks:read` permissions, provisioned per existing tenant to admin/manager/rep only — viewers never get them automatically, and new roles need explicit grants.

## Retries, auditing, and limits

Retry only typed 5xx/timeouts, ≤3 attempts, 250/500ms backoff — everything else fails immediately. Attempt/error updates and terminal transitions go through the existing transactional audit writer with only safe static messages. Failed actions are terminal; independently proposed actions get fresh UUIDs and may still execute with identical payloads.

No worker/queue/scheduler/auto-recovery. A crash or failed final commit can leave an action stuck `executing` even with its task already stored — no automatic takeover, manual inspection required. The proposal UUID prevents a duplicate insert, but execution and persistence aren't one distributed transaction.

## Remove runtime failure simulation

Removed the mock failure env flag, forced delays, and its config tests, at the user's request — the mock now just runs normally with its real checks. Kept executor retry/failure-audit/duplicate-prevention tests via test-only injected HTTP errors; no runtime failure simulator remains.

## Deterministic development seed

`@faker-js/faker` 10.6.0 dev dependency, `hy` locale + `en` fallback. Each tenant gets its own fixed Faker seed and stable UUIDs; one reference timestamp per run drives fixed relative date offsets (Argon2 salts and audit request IDs stay genuinely random). Generation lives under `src/db/seed/` — no extra framework or migration.

Runs as `app_user`, one `withTenant` transaction per tenant including the root row — all-or-nothing per tenant. An existing matching tenant (by UUID or name) is skipped whole, never rewritten; a later tenant's failure doesn't undo an earlier committed one. Refuses production mode (its passwords are public fixtures).

12 employees/users per tenant (1 admin, 5 managers, 5 reps, 1 viewer) across 2 departments — the 5 managers feed the overdue-task scenario. Grants match the existing matrix, including viewer's aggregate-only access. Two order items per order with consistent AMD totals. Yields 9,336 rows (identities/memberships/tenants/seed audit events).

## Seeded analytics and untrusted content

Planted per tenant: 20 recently-lost deals with reasons/notes; 3 managers with overdue tasks, 2 without; 10 contacts inactive 21–30 days. Everything else stays outside those windows. The tenant-A prompt-injection fixture lives in an existing activity note (no new column) — stored as plain untrusted data; agent defenses are separate work. Identifiers/credentials/dates/expected results documented in `docs/seed-scenarios.md`, verified against real Postgres as `app_user`.

## Scoped invoker analytics views and derived grants

Four `pgView`s (`securityInvoker`+`securityBarrier`): redacted `v_deals`/`v_tasks`, `v_contacts_activity` (identity/company/latest activity), `v_employee_performance` (per-employee/currency counts + won revenue). Excluded: email/phone, notes, descriptions, lost-reason text, login links, credentials, audit/execution data. Tenant RLS stays; views add server-bound tenant/department/employee scope, failing closed if missing. Managers/reps see contacts via their visible deals only.

Invoker views need base-column SELECT, so those specific granted columns are directly readable by design — tests instead prove excluded columns/`SELECT *`/other tables/writes/other tenants stay blocked. Grants are derived by walking each view's own Drizzle SQL (not a maintained second list) and cross-checked against Postgres's real dependency metadata in tests. The migration owner's grants step revokes stale privileges before applying derived ones — no bootstrap change, no duplicate allow-list.

## AST SQL validation and parameterization

`pgsql-ast-parser` 12.0.2, closed allow-list. Exactly one read-only SELECT (plus validated non-recursive CTEs/unions/subqueries). Rejects: DML/DDL, `SELECT INTO`, writing/recursive CTEs, locks, session/role changes, functions-in-FROM, system relations/columns, base tables, user placeholders, unknown syntax. Bounds: 20,000 chars / 2,000 nodes / depth 40, ASCII identifiers only. Executes a *regenerated* AST with bound literals and an outer `LIMIT 200` — never the submitted text. Preserves exact numeric token text (no JS rounding); real views and allowed functions/operators pinned to `pg_catalog`; `search_path` locked to `pg_catalog, pg_temp` to block fallback to public overloads, restored before logging.

## Analytics RBAC and execution logs

`deals:aggregate` gates all analytics access; detail queries also need the view's own read permission + row scope. Viewer-safe subset: one direct view, `count`/`sum`/`avg`/`min`/`max`, safe dimensional/date grouping, no returned identities — joins/CTEs/unions/subqueries/windows denied. This also stops a mixed viewer/rep account from laundering tenant-wide aggregate access into tenant-wide detail access. Identity/permissions always reload fresh per execution — never trust a supplied role/permission array.

`runAnalyticsQuery(ctx, sql, question?)` is an internal function, no HTTP endpoint. Runs in the `app_user` tenant transaction + a savepoint: install trusted scope → `SET LOCAL ROLE analytics_ro` → 5s timeout → execute → restore role/search-path (or roll back the savepoint on failure) → log. Logs: SQL, optional question, actor/request IDs, verdict, row count, duration, safe error only — committed before throwing, so a logging failure propagates rather than returning an unaudited result. This table gets no analytics grant itself. Doesn't claim to eliminate standard Postgres catalog visibility or an unrestricted raw-SQL channel's ability to alter settings — the AST restriction and trusted execution path remain the actual control.

## Google embeddings and calibration

Vercel AI SDK (`ai` + `@ai-sdk/google`), `gemini-embedding-001` default, `providerOptions.google.taskType`/`outputDimensionality`. `EMBED_DIM` (default 1536, 1–2000) shared across schema/embedder/ingestion/diagnostic. Vectors validated (length, finite, nonzero) and normalized; ingestion checks DB dimension before spending quota. Migration 0007 uses 1536 — config alone can't resize storage.

Chat model `gemini-3.8-flash` initially selected; KB built before calibration, with an explicit required `KB_REFUSAL_THRESHOLD` (never guessed). Diagnostic: 5 passage/query pairs per language (10 AM + 10 EN), reporting related/unrelated scores + min/max/mean — representative retrieval evaluation is still separately required.

## Single-host embedding quota accounting

Real project limits required in `EMBED_RPM`/`EMBED_RPD`/`EMBED_TPM`. Persisted in ignored `.cache/embedding-quota.json`, shared by app + diagnostic; directory-lock-serialized reservations, atomic file replacement, fail-closed on invalid state, daily reset at midnight Pacific. Each input = 1 request + UTF-8-byte-based token estimate, including retries. Batches ≤100 inputs. Other hosts/clients aren't tracked.

SDK retries disabled (no duplicate retry layer) — 3 total attempts on 429/5xx with 1/2s exponential backoff + Retry-After. Cooldowns over 1 minute are persisted for a later rerun rather than blocked on. No credential-bearing SDK errors are retained/logged. Quota exhaustion rolls back only the current document; earlier ones in the run stay committed.

## Tenant-scoped knowledge ingestion and retrieval

Added `documents`/`chunks` with tenant RLS, composite document FKs, unique tenant/source + document/ordinal constraints, and a cosine HNSW index. `documents.embedding_model` lets model changes re-embed and search exclude stale-model chunks. No KB privileges for analytics. `yaml` for validated front matter — no document framework, no tokenizer dependency.

CLI requires `--tenant-id`/`--user-id` naming an existing admin. Processes sorted top-level Markdown files (filename = source); no symlinks; hashes normalized body/title/roles so unchanged documents skip embedding, and unchanged chunk vectors are reused by content hash even across moved content. Each document + its chunks + an audit event commit atomically under a tenant/source advisory lock. Removed files aren't implicitly deleted from the DB.

Chunking: heading-based, ~500-English-token target (2,000 bytes) with 200-byte overlap, Unicode-safe (Armenian density differs). Search: bound Drizzle cosine expressions + tenant/`allowed_roles`/model predicates in SQL before top-k, fresh memberships every time. Exact cosine ordering at this small corpus size (avoids approximate-index candidate loss after ACL filtering); HNSW index present for later tuning.

## Grounded knowledge answers

`answerFromKb(ctx, question)` is internal, with injected factories for tests — no unrequested HTTP endpoint. Fixed bilingual refusal, no chat call, when there's no authorized evidence or the best score is below threshold. Otherwise: bounded excerpts as JSON between unpredictable delimiters, explicitly framed as untrusted data; the answering call gets no executable tools. Citations must match retrieved `[title §ordinal]` labels — missing/invented ones force refusal (this checks label identity, not semantic entailment). Tests use deterministic lexical embeddings + mocked chat; live calibration is its own separate command.

## Initial refusal-threshold calibration

Documented the 2026-10-23 live check (1536 dims) and the resulting provisional `KB_REFUSAL_THRESHOLD=0.67` — between the highest unrelated score (0.623342) and lowest related score (0.713051) in the AM/EN samples. Explicit config, not a code default; needs validation against real KB chunks, near-topic unanswerable questions, and cross-language retrieval before being treated as truly calibrated.

## Agent model boundary and SQL correction budget

Agent planning, SQL generation, and KB chat share one lazy model factory (`src/agent/model.ts`); embedding config stays separate. Default chat model `gemini-3.8-flash`. Reuses the AI SDK's own per-request retries (`maxRetries: 2`) — the whole workflow is never retried once a tool may have written a proposal.

SQL generation uses only the four analytics views' column metadata, then runs the existing guard. A rejected query (400/403) gets exactly one correction with a generic message (never real DB diagnostics); a second rejection disables SQL for the rest of that request, serialized so concurrent calls can't race the budget. Tool results stay capped at 8,000 UTF-8 bytes (~2,000 English tokens) with an explicit truncation marker (never splitting a Unicode code point); the full structured result is preserved for server-side summaries.

## Single-agent chat and provider selection

AI SDK 7 `generateText` + `stopWhen: isStepCount(6)`, early-stopping after a task draft. One agent — SQL generation and KB answering are bounded helper calls, not separate agents. Each request builds tools closing over a fresh `RequestContext`; strict schemas can't accept tenant/user/role fields from the client. `POST /chat` takes only `message`/`allowTaskDraft`, returns `answer`/bounded tool-call summaries/actual inserted proposal IDs — no message history, no new orchestration dependency.

Vercel SDK over a direct provider package: direct Google stays default, the SDK's own `createGateway` is the env-switchable alternative (`LLM_PROVIDER=google|gateway`, `AI_GATEWAY_API_KEY` + provider/model ID, bare names get a `google/` prefix) — no new dependency. KB answering shares the model factory; embeddings stay separate. Provider failures sanitize to HTTP 503, discarding SDK causes, with no workflow retry.

## Company authorization and CRM search

Separate `companies:read` permission, seeded for admin/manager/rep (migration 0008 backfills existing tenants idempotently) — no new table/column. Admins see tenant companies; managers/reps see companies linked to their scoped deals, reusing existing contact/deal scope logic with RBAC reloaded per tool call. Model-facing CRM results omit email/phone, include responsible-employee name/ID for task planning, and expose bounded activity notes as untrusted data. Fresh seeds: 9,344 total rows (10 permissions + 28 role grants per tenant).

## Explicit draft capability and execution claims

`allowTaskDraft:true`, default false — without it, `task_draft` isn't even offered to the model, so a poisoned read can't create even a pending proposal. With it: reuses `createProposal()` only, approval/Bitrix execution stay outside the agent's reach entirely. A successful draft ends the loop with a deterministic pending-approval preview built from stored IDs/payload (never from model text, so generated prose can't claim execution). Model step-limit or provider failures never auto-approve/execute anything; independent requests get independent proposals, no payload-hash dedup.

If the outer model drops or invents KB citations, chat falls back to the already-validated KB answer; KB/SQL tool failures force a safe refusal. The server entry point loads the app only after base env validation, so KB schema imports stay inside the existing structured startup error handler.

## Local Ollama chat model

Default: `LLM_PROVIDER=ollama`, `LLM_MODEL=gemma4:26b`, `OLLAMA_BASE_URL=http://127.0.0.1:11434/v1` — the official `@ai-sdk/openai-compatible` adapter against Ollama's chat-completions API, no local API key, same shared model factory for planning/SQL/KB. Google/Gateway stay available since env-based provider switching is a requirement. Ollama URL is Zod-validated (HTTP/HTTPS only). No new container, DB change, or orchestration layer.

Preserves the step limit, deadline, retries, output caps, RBAC, and explicit approval unchanged. Google embeddings stay separately configured — switching only the chat model doesn't migrate vectors or reset the calibrated threshold. Tests mock the Ollama HTTP API and verify defaults, credential independence, URL validation, and tool-call execution.

## Clear chat timeout errors

Kept the (then-) 90-second deadline, added clear messages: HTTP 504 naming the limit on deadline expiry, a distinct 504 for a provider `TimeoutError` before that, generic 503 for other provider/config failures — none leaking SDK causes or raw messages. An already-saved draft's approval preview survives a later failure. No workflow retry, no timeout increase. Tests simulate both timeout paths without a live model or a real 90-second wait.

## Longer model deadline

Raised to 300 seconds (five minutes), superseding the 90-second one — one shared constant across planning/SQL/KB, same 504 message source, same provider/retry/approval behavior. Buys more room for CPU-only inference without guaranteeing completion.

## Enforce the agent deadline independently of cancellation

Regression tests reproduced real hangs when a model/tool ignored its abort signal (cooperative signals alone don't guarantee the awaited promise settles). Fix: race the post-auth agent workflow against the existing 300s signal directly, removing the listener on settlement; SQL/KB generation inherit the same signal instead of starting new timers. Cancellation is re-checked before starting new tools, accepting late SQL, or creating a proposal. Expiry still returns the sanitized 504 and keeps any already-recorded preview. Doesn't forcibly roll back an already-running DB transaction — a late-finishing proposal can still land as pending, visible via `/approvals`, never auto-approved. No queues, no longer timeout, no workflow replay.

## Disable Ollama reasoning for tool-calling requests

Live testing on `gemma4` (chosen for Armenian support) found tool schemas balloon its chain-of-thought — reliably consuming the full 2000-token output budget before any tool call/answer, and unboundedly (10+ min) with no cap. Reproduced identically via raw Ollama requests outside the app, so it's model/provider behavior, not an app bug. No verified Armenian-competent alternative with reliable tool-calling was found, so the fix targets the behavior rather than switching models.

Ollama's native `/api/chat` has a `think: false` field that fixes it (confirmed: ~41s to a coherent answer). The OpenAI-compatible endpoint doesn't recognize it as a bare key, but its adapter forwards `providerOptions.ollama` directly — so `providerOptions: { ollama: { think: false } }` on the shared `modelSettings()` fixes it for planning/SQL/KB at once, is ignored (harmlessly) by Google/Gateway, and needs no provider branching. Confirmed: `/chat` now returns in ~93s instead of exceeding 300s.

## Raise local Ollama's context window for tool-calling

After the reasoning fix, a new defect: a correct `sql_analytics` call was followed by an ungrounded final answer. Cause: Ollama's CPU-inferred 4096-token context window — system prompt + 5 tool schemas + a tool result can exceed it, and `--context-shift` silently evicts the oldest tokens (sometimes the question itself).

`OLLAMA_CONTEXT_LENGTH=8192` fixed grounding but pushed the 3-call pipeline to a confirmed 504 at the 300s deadline; `6144` fixed grounding while finishing in ~146s, comfortably inside it. This is an Ollama-server startup env var (set on `ollama serve`, documented in the README), not an app config value — no application code change, `MODEL_TIMEOUT_MS` unchanged. Residual, unrelated limitation: the local model's relative-date SQL interpretation isn't fully consistent run-to-run (observed filtering by `created_at` instead of `closed_at` once).

## Disambiguate created_at from closed_at/due_at in SQL generation

Direct DB verification showed the `created_at`-filtered answer above was factually wrong (this tenant: 205 lost deals total, 20 closed in the last 30 days, 0 *created* in the last 30 days) — the model had no signal that "lost in the last 30 days" binds to `closed_at`, since both columns looked identical in the generated schema metadata.

Fix: one clarifying paragraph in `sql_analytics`'s generation instructions (`src/agent/sql.ts`) — a time window on won/lost deals filters `closed_at`, on due/overdue tasks filters `due_at`, never `created_at` unless creation is explicitly asked about. Re-verified: regenerated SQL correctly used `closed_at`, returned the expected 20 rows. Prompt guidance only, no schema/permission/validator change; `crm_search`'s own `createdAfter`/`closedAfter` carry the same ambiguity and weren't touched here.

## Add Vertex AI as a chat model provider

Added `'vertex'` to the `ollama|google|gateway` provider enum, via the official `@ai-sdk/google-vertex` package — same family as the existing direct-Google provider, no new abstraction. Required: `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, Zod-validated like every other provider. Deliberately no API key field — Vertex authenticates via Google's Application Default Credentials chain (attached service account on GCP, or a real `GOOGLE_APPLICATION_CREDENTIALS` env var elsewhere), so no credential value lives in this project's `.env`/Zod schema. Model factory, deadline, retry, and `providerOptions` stay unchanged; KB embeddings stay on the separate AI Studio key regardless of chat provider.

The project's advertised models (`gemini-3.8-flash`/`gemini-2.5-flash`) 404'd from every region tried despite confirmed billing/API/IAM — resolved on the console side; `location: 'global'` + model `gemini-3-flash-preview` work end-to-end (confirmed `generateText` and a full `/chat` round trip, ~9s). No SDK/code change needed — `@ai-sdk/google-vertex` already builds the correct bare host for `global`.

## Normalize CRM entity synonyms and raise the default row limit

Live Vertex testing surfaced two `crm_search` defects (isolated with an uncommitted diagnostic script, since the app itself never logs raw tool args):

1. `{"entity":"deal"}` (singular) failed every time — the discriminated union only accepts `"deals"`, so the SDK rejects the call before `execute` runs. Fixed with a `z.preprocess` that lowercases and maps known singular/plural synonyms before the union validates; genuinely invalid values are still rejected. Runtime parsing only, no change to the schema shown to the model.
2. `limit` defaulted to 10 against the schema's own cap of 50, so a plain "show X" silently returned half of 20 matching rows with no signal more existed. Fixed by raising the *default* (when the model omits `limit`) to the existing cap — the cap itself didn't change. Verified with new tests (per-entity synonym acceptance, a real-data check for >10 rows on an unqualified query); full suite/lint/typecheck stayed green. `sql_analytics` unaffected.

## OpenTelemetry tracing, metrics, and redaction

Added `src/observability/{tracing,spans,metrics,redact,cost}.ts`, pinned to one mutually-compatible `@opentelemetry/*` release line (unpinned "latest" produced an unresolvable `ERESOLVE`). `startTracing()` (once, in `src/server.ts`, before the deferred app import) builds a `NodeSDK` with an OTLP HTTP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`, default matching the new `jaeger` Compose service) and `autoDetectResources: false` (the only needed resource identity is `OTEL_SERVICE_NAME`).

HTTP spans use `@fastify/otel` (not the deprecated instrumentation package), registered explicitly before any routes rather than via `NodeSDK`'s auto-instrumentation (which relies on require-time patching that wouldn't reliably apply across test files importing `buildApp` in varying orders). `agent.run`/`agent.step`/`tool.call`/`sql_guard.verdict` spans use plain `@opentelemetry/api` calls; `withToolSpan` wraps every tool's `execute`, redacting input and incrementing an error counter on failure.

One wrapper, `tracedGenerateText()`, covers all three `generateText` call sites (planning/SQL/KB) — opens its own `llm.call` span (model, token counts, latency, `cost_usd`) and separately enables the AI SDK's own telemetry as a nested child, with `recordInputs`/`recordOutputs: false` on both paths since prompts/completions may contain CRM data. `cost_usd` is 0 unless `LLM_PRICE_TABLE_JSON` prices a model.

`redactValue` pattern-matches emails/phones/token-shaped strings/sensitive key names, applied to tool-call input before it becomes a span attribute and, via a new pino `formatters.log` hook, to every structured log line as a backstop beyond the existing path-based redact list.

Metrics: a plain `MeterProvider` + Prometheus exporter (`preventServerStart: true`); `GET /metrics` bridges Fastify's raw request/response into the exporter's own handler rather than running a second server. Request count/latency come from an `onResponse` hook; tool-error/token counters record at the same points their spans do.

Two test-only fixes were needed: the global tracer provider can only register once per process, so `tests/observability.test.ts` shares one in-memory provider/exporter for the file and resets it between tests; and span linkage across `await` boundaries needs an explicit `AsyncLocalStorageContextManager` in a bare test `BasicTracerProvider` (production gets it from `NodeSDK` automatically). Two pre-existing fast-fail startup tests also needed their timeout raised (5s→15s) under full-suite parallel load, for the added import-graph cost.

## Containerized production readiness

Kept mock Bitrix in-process (per "Approval workflow MVP scope") rather than extracting a separate container, correcting an initial request that would have reversed that earlier decision. One Dockerfile, API only; `/health/ready` checks DB/migrations/LLM config — no separate "mock-bitrix reachable" check, since it's the same process.

Secrets (`src/secrets.ts`): `VAR` or `VAR_FILE` (file wins if both set), applied to `JWT_SECRET`/`REFRESH_TOKEN_PEPPER` and `DATABASE_URL`/`MIGRATION_DATABASE_URL` (the whole connection string, since the password lives inside it). New required secret `REFRESH_TOKEN_PEPPER` (≥32 chars) moved refresh-token hashing from plain SHA-256 to HMAC-SHA256 keyed by it, so rotating it alone invalidates every outstanding refresh token. DB URL passwords get a production-only deny-list check against known placeholders; `JWT_SECRET`/`REFRESH_TOKEN_PEPPER` skip it deliberately since their ≥32-char requirement already makes every deny-listed value too short to match. `GOOGLE_APPLICATION_CREDENTIALS` (Vertex) stays outside this loader — in containers, point it straight at a mounted secret path.

Rate limiting: `global: true`'s auto-apply relies on an `onRoute` hook attached during the plugin's own deferred registration — since `buildApp` is synchronous and declares routes immediately, that hook wasn't ready in time, silently rate-limiting nothing (confirmed by direct reproduction). Fixed with `global: false` + a hand-written `onRequest` hook resolving the `rateLimit` decorator lazily. `/auth/refresh` got the same 5/min/IP cap `/auth/login` already had; `/chat` got a new per-user cap keyed on `request.context.userId`, requiring the auth hook to run first (added via the same encapsulated context, `hook: 'preHandler'`). `RATE_LIMIT_TEST_BYPASS` is honored only outside production — `evals/run.ts` doesn't need it since it already caches/reuses tokens.

Hard timeouts: DB pool gained `connectionTimeoutMillis` + client-side `query_timeout`. A server-side `statement_timeout` was tried and reverted — it broke a test asserting no connection-level timeout exists outside the SQL guard's own deliberately scoped 5s one. `src/net/retry.ts` centralizes the backoff formula for embeddings/mock-task retries (`computeBackoffMs`) with identical timing — their control flow was judged too risky to restructure further here. LLM calls keep the AI SDK's own `maxRetries`.

`LLM_PROVIDER=mock` (the AI SDK's own `MockLanguageModelV4`, already a transitive dependency) gives a deterministic network-free response for `scripts/smoke.sh`/CI; rejected under `NODE_ENV=production`.

Docker: 4-stage Dockerfile (`deps`/`build`/`prod-deps`/`runtime`), pinned `node:24.11.1-bookworm-slim` (glibc, for `argon2`'s native bindings), non-root user, `npm ci --ignore-scripts`. `loadEnvironment()` still unconditionally requires a `.env` file (existing decision — process env always overrides it anyway); containers ship an empty `docker/container.env` as `/app/.env` to satisfy that without baking in values. Compose: Postgres service renamed `db`→`postgres`; added one-shot `migrate` and a `profiles: [tools]`-gated `seed` (built from the `build` stage, which still has `@faker-js/faker`/`tsx`). Only `api` and Jaeger's UI port are published — not `postgres`, not Jaeger's OTLP port (reached internally). `jaeger`'s image has no shell/curl/wget, so no container healthcheck — documented, not faked.

`scripts/smoke.sh`: `docker compose up --wait` treats a one-shot service's clean exit as a *wait failure*, so `migrate`/`seed` run outside `--wait`, checked by exit code directly. Sets `NODE_ENV=test`/`LLM_PROVIDER=mock` for its own run only, and scripts the `app_user` password non-interactively via `ALTER ROLE` — disposable-run only, never for a real deployment.

Not publishing `postgres` to the host at all (as the spec initially asked) would've broken the existing host-side dev workflow. Resolved with `docker-compose.override.yml` (auto-merged locally, restoring the `127.0.0.1` publish for dev only) while the base file stays unpublished for real deployment; `scripts/smoke.sh` forces `COMPOSE_FILE=docker-compose.yml` to exercise the real config. Live container verification (not just tests) also caught `api`'s `ports:`/`healthcheck:` both hardcoding container port 3000 instead of reading the configurable `PORT` — both fixed to read `${PORT:-3000}` consistently.

## MCP server

Added `POST /mcp` (`src/mcp/{routes,server,tools}.ts`) alongside `/chat` in `buildApp`, via `@modelcontextprotocol/sdk@^1.32.2`. Stateless (`StreamableHTTPServerTransport`, no `sessionIdGenerator`): a fresh `McpServer` + transport per request, after the same preHandler auth every route uses — nothing shared across callers. `GET`/`DELETE /mcp` → `405` (nothing to resume/terminate in stateless mode).

Extracted the REST decorator's Bearer-verify + `loadContext` logic into `authenticateContext(database, authConfig, request)` (`src/auth/routes.ts`), reused by both REST and MCP's preHandler — only difference: MCP also sets `WWW-Authenticate` before the shared `401`.

Origin allowlist (`MCP_ALLOWED_ORIGINS`, same shape as `CORS_ALLOWED_ORIGINS`) checked in an `onRequest` hook before auth/rate-limit/body parsing: a disallowed `Origin` → `403`; no `Origin` header at all (every non-browser client) is allowed, since DNS rebinding is browser-specific. The SDK's own rebinding-protection options are deliberately unused — deprecated in favor of external middleware, which this hook provides. `/mcp` shares the API's existing bind, no separate listener to misconfigure.

The five tools are registered by passing each reused `ai`-SDK tool's own `.description`/`.inputSchema`/`.execute` straight into `McpServer.registerTool` (`tool()` is a pure identity function, confirmed by reading its source) — the exact same Zod schema object MCP validates against, not a re-derived copy. `sql_analytics`/`kb_search` get their `runQuery`/`llm` dependencies bound to the request's own `database`, exactly as `/chat` does — an earlier draft wired `sql_analytics` to the production singleton instead, caught by a new cross-database test.

Every MCP call writes an `audit_logs` row (`action: 'mcp.tool_call'`, `details: { tool, outcome, channel: 'mcp' }`) in the existing JSONB column — no new `channel` column, no migration needed since it only needs JSONB-containment queryability. Each call also gets its own `mcp.tool_call` OTel span nesting the tool's existing `tool.call` span; thrown errors map to a generic `isError` result with no diagnostics, mirroring `safely()`.

`buildApp` gained a test-only `agentKbAnswer` option (mirroring `agentModel`), threaded into both `/chat` and `/mcp` — needed to exercise the "rep denied the manager-only KB doc via `kb_search`" governance test at the HTTP layer without a real embeddings/chat call.

`crm_search`'s advertised `tools/list` schema collapses to `{"type":"object","properties":{}}` since the SDK derives it from the *input* side of the `z.preprocess` wrapper, which can't be statically described — confirmed cosmetic only, `tools/call` still validates fully. No approve/execute tool exists in MCP by construction; full OAuth, `resources/*`/`prompts/*`, and multi-tenant client registration are explicitly out of scope (`docs/mcp.md`); `scripts/mcp-demo.ts`/`mcp-stdio.ts` provide an HTTP demo and a stdio entry point.

`evals/run.ts` didn't gain MCP cases — every existing case routes natural language through the agent's own tool-selection loop and scores *which tool it chose*, which has no MCP equivalent (an MCP client calls a named tool directly, no model decides anything). `tests/mcp.test.ts` already covers the same cross-tenant/SQL-guard scenarios as ordinary integration tests — a second bespoke eval runner would add no scoring value.

## Static OpenAPI document

A spec review found no live API specification existed (Swagger/OpenAPI, also promised in [MVP_SCOPE.md](../MVP_SCOPE.md)'s own checklist) — implemented rather than just documented as a trade-off.

Added `@fastify/swagger`/`@fastify/swagger-ui` in **`mode: 'static'`**, with a hand-written `OpenAPIV3.Document` (`src/docs/openapi.ts`) describing the already-implemented contract. Deliberately not `mode: 'dynamic'` with per-route `schema`: every route already validates with inline Zod, so adding Fastify/ajv schemas too would double-validate against an independently maintained second definition, risking silent drift. The static document has zero effect on request handling (confirmed: full suite stays green) at the cost of needing manual updates when a route's contract changes. Registered unauthenticated at `/docs`/`/docs/json`, matching `/health`/`/metrics`'s precedent. Verified Helmet's default CSP doesn't break it — Swagger UI serves its JS as same-origin `<script src>` files, not inline blocks, so `script-src 'self'` already permits them.

## Architecture diagrams and AI-tools disclosure

The same review found no architecture/ER diagram and no AI-tool-usage disclosure, both required deliverables — the exact tool/role breakdown for the latter came from the user directly, not inferred from commit metadata.

Added `docs/architecture.md` (system flowchart, chat-request sequence diagram, approval-state diagram, core-CRM `erDiagram`, all Mermaid) and `docs/ai-tools.md` (OpenAI Codex for the initial implementation phase through the RAG work, Anthropic Claude Code from there onward, ChatGPT/GPT for planning/research only). Both are documentation-only, no code/behavior impact.

## Redacted `/chat` debug output field

An agent-architecture audit found `toolCalls[].output` (`src/agent/service.ts`) — a truncated preview of each tool's raw result, kept for debugging — bypassed `redactValue`, the same utility already used for logs (`app.ts`) and span attributes (`spans.ts`), and was undocumented in `src/docs/openapi.ts`'s `/chat` response schema alongside `sql`/`rowCount`.

Kept the field (needed for debugging) but passed it through `redactValue` before truncating, so CRM emails/phones/tokens can't reach it, and documented `sql`/`rowCount`/`output` on the OpenAPI schema. No environment gate added: unlike `LLM_PROVIDER=mock` or `EVAL_WEAKEN`, this field is meant to be available everywhere it's needed, so redaction is the control instead of a production block.
