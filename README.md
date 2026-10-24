# ops-copilot

Node.js 24, ESM, strict TypeScript, Fastify, Zod, pino, Vitest, and ESLint. Uses npm.

## Development

```sh
nvm use
npm ci
```

The local `.env` file is required and is already provided. On a fresh checkout, create it with `cp .env.example .env`, generate a signing secret with the command below, and set `JWT_SECRET` and `REFRESH_TOKEN_PEPPER` (run the command twice, once for each) before starting. Local environment files are ignored by Git. Process environment settings override values in `.env`; Zod validates the result before the server listens. Invalid configuration or a missing file prevents startup.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

After setting `JWT_SECRET` and `REFRESH_TOKEN_PEPPER`, start the API with `npm run dev`.

Development logs use `pino-pretty`: INFO is green, WARN is yellow, and ERROR is red, with readable local timestamps and request IDs. `npm start` outputs structured JSON for production.

Defaults: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, `LOG_LEVEL=info`.

```sh
curl -i http://127.0.0.1:3000/health
```

Returns HTTP 200 with `{"status":"ok"}`. Each request receives a server-generated UUID in the `X-Request-ID` response header and pino's `reqId` log field.

## PostgreSQL

The `.env` and `.env.example` contain local PostgreSQL development settings. Start PostgreSQL 18 with pgvector and apply the committed migrations:

```sh
docker compose up -d --wait postgres
npm run db:migrate
```

Generate a migration after changing the Drizzle schema with `npm run db:generate`. Migrations use the owner-only `MIGRATION_DATABASE_URL`, followed by the derived analytics column/view grants. Tenant tables enforce RLS; application operations use `withTenant(ctx, fn)` and a separate `DATABASE_URL` naming `app_user`. Provision that login's password before using database operations, following [docs/security.md](docs/security.md). Analytics queries use four redacted invoker views, scoped context, AST validation, a 200-row cap, and a five-second timeout; see [docs/security.md](docs/security.md#guarded-sql-analytics). See [docs/database.md](docs/database.md) for the schema, indexes, roles, and migration lifecycle.

## Authentication and audit

Implemented endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, and permission-gated `GET /audit-logs`. Login returns a 15-minute JWT and a random opaque refresh token. Refresh tokens rotate on each use; reuse revokes the entire family. Families expire seven days after login. Logout revokes the refresh family; access tokens retain their original expiry.

Configure `JWT_SECRET` (at least 32 characters), `REFRESH_TOKEN_PEPPER` (also at least 32 characters; keys refresh-token hashing separately from the JWT signing key), `JWT_ISSUER` (default `ops-copilot`), and `JWT_AUDIENCE` (default `ops-copilot-api`). The local `.env` contains both secrets; the example deliberately leaves them blank. Accounts are not created on startup. Use the development seed below or provision tenant users with Argon2 password hashes and tenant-local role/permission memberships before logging in. The approval migration grants the new workflow/read permissions to existing admin/manager/rep roles; roles created later need their grants provisioned explicitly. [docs/api.md](docs/api.md) contains request examples, the permission matrix, and a minimal local account-provisioning example. [docs/security.md](docs/security.md) explains request context, scoping, rate limiting, and token lifecycle limitations.

## Development data

After migrations and `app_user` password setup, run:

```sh
npm run db:seed
```

This creates **9,344 rows** across Ararat Trade and Sevan Logistics, using fixed-seed Armenian/English Faker data. It runs as `app_user` through one tenant transaction each and skips existing demo tenants without changing them. Dates are relative to the initial seed run. The CLI refuses production mode. [docs/seed-scenarios.md](docs/seed-scenarios.md) lists tenant UUIDs, development passwords, exact counts, and planted analytics/security scenarios.

## Task approvals and mock Bitrix

The approval service creates validated `task.create` proposals without creating tasks. Eligible requesters, department managers, or tenant admins can list, approve, or reject them through `/approvals`. Approval claims execution atomically; repeated/concurrent approvals cannot insert duplicate tasks. The executor revalidates permissions and allows three total attempts for typed 5xx/timeout errors, with 250/500 ms backoff. Every state transition and task creation is audited transactionally.

The four authenticated `/rest/` mock Bitrix methods run in this app and reuse CRM tables. Task-add requires the approved proposal UUID as `Idempotency-Key`; independent identical proposals have different UUIDs. See [docs/api.md](docs/api.md) for service/route examples and [docs/security.md](docs/security.md) for crash-recovery limitations. The chat agent calls proposal creation when drafting is explicitly enabled; no additional proposal-creation HTTP route is exposed.

Run `npx vitest run tests/approvals.test.ts` for the complete proposal → approval → task → audit integration scenarios. Tests use disposable PostgreSQL and do not alter the development database.

## Knowledge base

Ten synthetic Armenian/English documents are provided in `kb/`, including one manager/admin-only policy. Configure the Google key and explicit project embedding quotas in `.env`, run `npm run embed:check`, and choose `KB_REFUSAL_THRESHOLD` before answering. Then ingest with `npm run kb:ingest -- ./kb --tenant-id <uuid> --user-id <admin-uuid>`. Ingestion reuses unchanged vectors; retrieval applies tenant/current-role ACLs in SQL; answers include citations or refuse insufficient evidence without a chat call. See [docs/knowledge-base.md](docs/knowledge-base.md) for setup and verification. Knowledge answers are available through the chat agent; there is no standalone KB HTTP endpoint.

The live calibration run on 2026-10-23 returned **1536 dimensions**. Each language used five related query/passage pairs and twenty unrelated comparisons:

| Language | Related cosine similarity | Unrelated cosine similarity |
| --- | --- | --- |
| Armenian | 0.744–0.852 | 0.516–0.623 |
| English | 0.713–0.820 | 0.459–0.577 |

Use this provisional setting in `.env`:

```dotenv
KB_REFUSAL_THRESHOLD=0.67
```

It separates every related and unrelated comparison in this small sample: the highest unrelated score was 0.623, and the lowest related score was 0.713. Similarity is not a probability or a confidence percentage. Validate this threshold against actual, longer KB chunks using answerable, unrelated, and closely related but unanswerable questions in Armenian and English, plus cross-language retrieval. Recalibrate when changing the embedding model or dimension.

After database setup and seeding, ingest the KB for Ararat Trade:

```sh
npm run db:migrate
npm run kb:ingest -- ./kb \
  --tenant-id a0000000-0000-4000-8000-000000000001 \
  --user-id a0000000-0000-4000-8000-000000000002
```

Repeat the ingestion command without changing the documents; expect `documents: 10, skipped: 10, embedded: 0`.

## Chat agent

`POST /chat` uses a single Vercel AI SDK agent with five scoped tools: CRM search, SQL analytics, task drafting, knowledge search, and audit reading. It replies in Armenian or English and stops after at most six outer model steps. SQL generation/correction and KB answering may make additional bounded model calls. Tool data is untrusted and capped to 8,000 UTF-8 bytes per model-visible result (roughly 2,000 English tokens).

Default chat configuration uses **local Ollama with `gemma4:26b`** through the Vercel AI SDK's OpenAI-compatible adapter:

```dotenv
LLM_PROVIDER=ollama
LLM_MODEL=gemma4:26b
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

On a fresh machine, install [Ollama](https://ollama.com), start its local service with a larger context window than Ollama's CPU default (see below), and download the model:

```sh
OLLAMA_CONTEXT_LENGTH=6144 ollama serve &
ollama pull gemma4:26b
ollama list
npm run dev
```

The model is already installed on the current development machine. No API key is needed for local chat. Agent planning, SQL generation, and KB answer generation all use the shared Ollama model factory. The agent deadline is 300 seconds (five minutes), covering context refresh, generation, and tool waits after authentication. SQL/KB generation shares the agent's remaining time. The handler returns a timeout even if a provider/tool ignores cancellation; it does not wait indefinitely for that call to settle. The existing six-step limit, result caps, tenant/RBAC checks, and approval boundaries still apply. Local generation speed depends on the machine and model warm-up.

**`OLLAMA_CONTEXT_LENGTH` must be raised above Ollama's CPU-inferred default (4096) for this model.** With the default, the agent's system prompt, five tool schemas, and a tool result together frequently exceed the window; `--context-shift` then silently evicts earlier context (sometimes the user's own question), and the model responds with a generic, ungrounded reply instead of using the tool's data. `OLLAMA_CONTEXT_LENGTH=6144` (set on `ollama serve`, not in this project's `.env`) was confirmed sufficient for the `sql_analytics`/`crm_search` flows without pushing the full three-call pipeline (tool selection, SQL generation, final answer) past the 300-second deadline on CPU-only hardware; raise it further only if grounding failures persist, and watch for the deadline trade-off if you do.

**KB embeddings still use Google** (`EMBED_MODEL`, Google key, and embedding quotas), so KB ingestion/search are not fully offline. Existing embeddings and the refusal threshold do not change when switching only the chat model.

Optional cloud configurations remain available: `LLM_PROVIDER=google` with a Google `LLM_MODEL` and `GOOGLE_GENERATIVE_AI_API_KEY`, `LLM_PROVIDER=gateway` with `AI_GATEWAY_API_KEY` and `LLM_MODEL=provider/model`, or `LLM_PROVIDER=vertex` with `GOOGLE_VERTEX_PROJECT` and `GOOGLE_VERTEX_LOCATION`. A bare gateway model receives a `google/` prefix. See [Ollama's compatibility API](https://docs.ollama.com/api/openai-compatibility) and the [AI SDK compatible-provider documentation](https://ai-sdk.dev/providers/openai-compatible-providers).

### Vertex AI (hosted, faster than local CPU inference)

```dotenv
LLM_PROVIDER=vertex
LLM_MODEL=gemini-3-flash-preview
GOOGLE_VERTEX_PROJECT=<your-gcp-project-id>
GOOGLE_VERTEX_LOCATION=global
```

Vertex AI takes **no API key** in this app's `.env`. Authentication uses Google's Application Default Credentials (ADC): an attached service account when the app runs on GCP infrastructure (Cloud Run, GCE, GKE), or a service account key file referenced by a real `GOOGLE_APPLICATION_CREDENTIALS` process environment variable (set at the OS/shell/deploy level, never committed to this repo) when running elsewhere. The GCP project's own service account needs the Vertex AI User role (`roles/aiplatform.user`) at minimum. Switching to Vertex only changes the chat model; KB embeddings keep using the separately configured Google AI Studio key.

The exact model ID and location available depend on your project's Vertex AI Model Garden access, which can take a few minutes to propagate on a brand-new project; `global` avoided a regional 404 in testing. If `LLM_MODEL` 404s with "Publisher model ... not found or your project does not have access to it", check the Model Garden console for that project rather than assuming the model name is wrong.

After logging in, use the returned access token:

```sh
curl -X POST http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Որքա՞ն է գործարքների ընդհանուր քանակը։"}'
```

The response contains `answer`, `toolCalls`, and `pendingActionIds`. SQL summaries include the accepted SQL and returned row count. Apply `npm run db:migrate` to grant the new `companies:read` permission to existing admin/manager/rep roles. New seeds include it; viewers cannot read company rows.

Chat is read-only by default. A task proposal requires `allowTaskDraft: true`, an explicit drafting request, and sufficient task details. Only a pending action is inserted, with a deterministic preview indicating approval is required; the agent cannot approve or execute it. Approve or reject the returned UUID through the existing `/approvals/:id/approve` or `/reject` routes. Tool-step limits and 429 retries never approve a proposal. See [docs/api.md](docs/api.md#chat) for payloads and safety boundaries.

## Observability

Start Jaeger alongside PostgreSQL and open its UI once the app has handled a request:

```sh
docker compose up -d --wait postgres jaeger
npm run dev
```

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=ops-copilot
```

Open `http://127.0.0.1:16686` for the Jaeger UI. Every request produces a trace with nested spans: the HTTP request (`request_id` attribute, via `@fastify/otel`), the agent run, each agent step, each tool call (name, redacted input, status, duration), each LLM call (model, prompt/completion tokens, latency, `cost_usd`), and each SQL guard verdict. The AI SDK's own telemetry (`experimental_telemetry`) is enabled on every model call and nests under that call's `llm.call` span, with prompt/completion content excluded since it may contain CRM data. Agent/tool errors are recorded as span exceptions with `ERROR` status.

`cost_usd` is `0` by default; configure real per-model prices with `LLM_PRICE_TABLE_JSON` (see `.env.example`). Emails, phone numbers, token-shaped strings, and known-sensitive field names (password, token, authorization, apiKey, cookie) are redacted from span attributes and from structured logs before they're recorded.

`GET /metrics` returns Prometheus-format text: `http_server_request_count` and `http_server_request_duration_ms` (by route/method/status), `tool_error_count` (by tool name), and `llm_tokens_total` (by model and prompt/completion). No authentication is required, matching `/health`.

## Verification and production build

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm start
```

The build emits ESM into `dist/`. `npm start` requires a `.env` file in the working directory too. Tests require a running Docker-compatible daemon; database tests use disposable PostgreSQL containers and do not use the development database.

## Run in containers

```sh
cp .env.example .env
./scripts/generate-secrets.sh
docker compose up -d --wait postgres migrate
docker compose exec postgres psql -U migration_owner -d "$POSTGRES_DB" -c "\password app_user"
# replace secrets/database_url.txt with the password you just set, then:
docker compose up -d --wait api
curl http://127.0.0.1:3000/health/ready
```

This builds the multi-stage `Dockerfile` (non-root user, pinned `node:24.11.1-bookworm-slim`), runs the one-shot `migrate` service, and starts `api` plus `jaeger`. `postgres` is not published to the host; only `api` (`PORT`, default 3000) and Jaeger's UI (16686) are. Secrets (`JWT_SECRET`, `REFRESH_TOKEN_PEPPER`, DB passwords) are read from `VAR_FILE`s under `secrets/` (gitignored, mounted as Docker secrets), never baked into the image or passed as plain environment values; see [docs/operations.md](docs/operations.md) for the full setup, secret rotation, and known limits, and [docs/security.md](docs/security.md) for how each control works.

`scripts/smoke.sh` runs this whole flow end-to-end from a clean state (including `docker compose down -v` first and last), using `LLM_PROVIDER=mock` and a disposable generated `app_user` password so it needs no external model credentials:

```sh
npm run build   # or: npm run lint && npm run typecheck && npm test
scripts/smoke.sh
```

## Git hooks

Husky installs the pre-commit hook through npm's `prepare` lifecycle when this directory is a Git repository. Before each commit, lint-staged runs `eslint --fix` on staged TypeScript and JavaScript files. Successful fixes are staged automatically; remaining lint errors block the commit.

Run the staged-file checks manually with `npm run lint:staged`. If Git is initialized after dependencies were installed, run `npm run prepare` to activate the hook.

## Layout

```text
src/
  app.ts
  server.ts
  config.ts
  db/
  auth/
  agent/
  sql-guard/
  rag/
  approvals/
  mock-bitrix/
  observability/
  routes/
evals/
tests/
docs/
```

The database module contains the Drizzle schema, tenant client, and migration tooling. `auth/` contains authentication and RBAC; `approvals/` validates and executes approved proposals; `mock-bitrix/` provides CRM-backed mock operations; `observability/audit.ts` writes transactional audit events. The SQL guard validates and runs scoped analytics; `rag/` provides KB ingestion, retrieval, and cited answers. The single agent exposes these services through authenticated `POST /chat`. See [AGENTS.md](AGENTS.md) for development rules and [docs/decisions.md](docs/decisions.md) for recorded decisions.
