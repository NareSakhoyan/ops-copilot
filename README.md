# ops-copilot

Node.js 24, ESM, strict TypeScript, Fastify, Zod, pino, Vitest, ESLint. Uses npm.

## Development

```sh
nvm use
npm ci
```

The required local `.env` is already provided. On a fresh checkout: `cp .env.example .env`, then set `JWT_SECRET` and `REFRESH_TOKEN_PEPPER` (run the command below twice, once per secret) before starting — Zod validates config before the server listens, and a missing file or invalid value prevents startup. Local env files are gitignored; process env overrides `.env`.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then `npm run dev`. Dev logs use `pino-pretty` (colorized, readable timestamps); `npm start` outputs structured JSON. Defaults: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, `LOG_LEVEL=info`.

```sh
curl -i http://127.0.0.1:3000/health
```

→ 200 `{"status":"ok"}`. Every request gets a server-generated UUID in `X-Request-ID` and pino's `reqId`.

## PostgreSQL

`.env`/`.env.example` hold local Postgres settings. Start Postgres 18 + pgvector and migrate:

```sh
docker compose up -d --wait postgres
npm run db:migrate
```

`npm run db:generate` after schema changes. Migrations run as the owner-only `MIGRATION_DATABASE_URL`, then apply derived analytics grants. Tenant tables enforce RLS; app operations go through `withTenant(ctx, fn)` on a separate `app_user`-named `DATABASE_URL` — provision that password first ([docs/security.md](docs/security.md)). Analytics queries run through four redacted invoker views with AST validation, a 200-row cap, and a 5s timeout ([docs/security.md#guarded-sql-analytics](docs/security.md#guarded-sql-analytics)). Full schema/index/role/migration reference: [docs/database.md](docs/database.md).

## Authentication and audit

`POST /auth/login`, `/auth/refresh`, `/auth/logout`, and permission-gated `GET /audit-logs`. Login returns a 15-minute JWT + an opaque refresh token that rotates on every use (reuse revokes its whole family; families expire 7 days after login). Logout revokes the family; already-issued access tokens keep their original expiry.

Configure `JWT_SECRET`/`REFRESH_TOKEN_PEPPER` (≥32 chars each, keyed separately), `JWT_ISSUER` (default `ops-copilot`), `JWT_AUDIENCE` (default `ops-copilot-api`). No accounts are created on startup — use the dev seed below, or provision users manually with Argon2 hashes and tenant-local role/permission grants. See [docs/api.md](docs/api.md) for request examples and the permission matrix, and [docs/security.md](docs/security.md) for context/scoping/rate-limit/token details.

## Development data

After migrating and setting the `app_user` password:

```sh
npm run db:seed
```

**9,344 rows** across Ararat Trade and Sevan Logistics, fixed-seed Armenian/English Faker data, run as `app_user` in one transaction per tenant — skips existing demo tenants unchanged, refuses production mode. [docs/seed-scenarios.md](docs/seed-scenarios.md) has tenant UUIDs, dev passwords, counts, and planted scenarios.

## Task approvals and mock Bitrix

The approval service creates validated `task.create` proposals without creating tasks. Requesters, their department managers, or tenant admins can list/approve/reject via `/approvals`; approval claims execution atomically, so repeated/concurrent calls can't insert duplicate tasks. The executor revalidates permissions and retries only typed 5xx/timeouts (3 attempts, 250/500ms backoff). Every transition and task creation is audited transactionally.

The four authenticated `/rest/` mock Bitrix methods run in-process against the same CRM tables — `tasks.task.add` needs the approved proposal UUID as `Idempotency-Key`. See [docs/api.md](docs/api.md) for routes and [docs/security.md](docs/security.md) for crash-recovery limits. The chat agent calls proposal creation only when drafting is explicitly enabled; there's no separate creation HTTP route.

```sh
npx vitest run tests/approvals.test.ts
```

## Knowledge base

Ten synthetic Armenian/English documents in `kb/` (one manager/admin-only). Configure the Google key + project quotas, run `npm run embed:check`, choose `KB_REFUSAL_THRESHOLD`, then ingest:

```sh
npm run kb:ingest -- ./kb --tenant-id <uuid> --user-id <admin-uuid>
```

Reuses unchanged vectors on re-ingest; retrieval applies tenant/role ACLs in SQL; answers cite sources or refuse without a chat call. [docs/knowledge-base.md](docs/knowledge-base.md) has setup/verification. No standalone KB HTTP endpoint — only the chat agent answers from it.

The 2026-10-23 live calibration returned **1536 dimensions**, five related pairs + twenty unrelated comparisons per language:

| Language | Related cosine | Unrelated cosine |
| --- | --- | --- |
| Armenian | 0.744–0.852 | 0.516–0.623 |
| English | 0.713–0.820 | 0.459–0.577 |

```dotenv
KB_REFUSAL_THRESHOLD=0.67
```

Separates every related/unrelated pair in this small sample (highest unrelated 0.623, lowest related 0.713) — similarity isn't a probability, and this is provisional: validate against real KB chunks and cross-language questions, and recalibrate if the embedding model/dimension changes.

```sh
npm run db:migrate
npm run kb:ingest -- ./kb --tenant-id a0000000-0000-4000-8000-000000000001 --user-id a0000000-0000-4000-8000-000000000002
```

Re-running unchanged should give `documents: 10, skipped: 10, embedded: 0`.

## Chat agent

`POST /chat` — one Vercel AI SDK agent, five scoped tools (CRM search, SQL analytics, task drafting, knowledge search, audit reading), Armenian or English, ≤6 outer model steps (SQL/KB generation may make their own bounded calls). Tool data is untrusted and capped at 8,000 UTF-8 bytes per result (~2,000 English tokens).

Default: **local Ollama, `gemma4:26b`**, via the AI SDK's OpenAI-compatible adapter:

```dotenv
LLM_PROVIDER=ollama
LLM_MODEL=gemma4:26b
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

```sh
OLLAMA_CONTEXT_LENGTH=6144 ollama serve &
ollama pull gemma4:26b
ollama list
npm run dev
```

No API key needed. Agent planning, SQL generation, and KB answering share one model factory and one 300-second deadline (covers context refresh, generation, tool waits) — the handler races the whole workflow against it, so an uncooperative provider/tool can't hang indefinitely. The existing 6-step cap, result caps, RBAC, and approval boundaries all still apply; local speed depends on hardware/warm-up.

**Raise `OLLAMA_CONTEXT_LENGTH` above Ollama's CPU default (4096).** At 4096, the system prompt + 5 tool schemas + a tool result can exceed the window, `--context-shift` silently evicts earlier context (sometimes the question itself), and the model answers generically without using tool data. `6144` (set on `ollama serve`, not in `.env`) is confirmed sufficient for `sql_analytics`/`crm_search` without pushing the 3-call pipeline past the 300s deadline on CPU — raise further only if grounding failures persist, watching that trade-off.

**KB embeddings still use Google** (`EMBED_MODEL` + key + quotas) regardless of chat provider — not fully offline. Switching only the chat model doesn't touch existing embeddings or the refusal threshold.

Other options: `LLM_PROVIDER=google` (+`LLM_MODEL`, `GOOGLE_GENERATIVE_AI_API_KEY`), `gateway` (+`AI_GATEWAY_API_KEY`, `LLM_MODEL=provider/model`), or `vertex` (below). See [Ollama's compatibility API](https://docs.ollama.com/api/openai-compatibility) and the [AI SDK provider docs](https://ai-sdk.dev/providers/openai-compatible-providers).

### Vertex AI (hosted, faster than local CPU)

```dotenv
LLM_PROVIDER=vertex
LLM_MODEL=gemini-3-flash-preview
GOOGLE_VERTEX_PROJECT=<your-gcp-project-id>
GOOGLE_VERTEX_LOCATION=global
```

**No API key** — uses Google Application Default Credentials (an attached service account on GCP infra, or a key file via a real `GOOGLE_APPLICATION_CREDENTIALS` env var elsewhere, never committed). The service account needs `roles/aiplatform.user`. Only the chat model changes; KB embeddings keep using the separate AI Studio key.

Exact model/location access depends on your project's Model Garden (`global` avoided a regional 404 in testing) — a 404 on `LLM_MODEL` usually means Model Garden access, not a wrong name.

```sh
curl -X POST http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Որքա՞ն է գործարքների ընդհանուր քանակը։"}'
```

Response: `answer`, `toolCalls`, `pendingActionIds`; SQL summaries include the accepted SQL + row count. (`npm run db:migrate` grants the newer `companies:read` permission to existing roles; viewers still can't read companies.)

Chat is read-only by default. A task proposal needs `allowTaskDraft: true` plus an explicit, detailed drafting request — it only inserts a pending action with a deterministic "approval required" preview; the agent itself can never approve/execute. Approve/reject via `/approvals/:id/approve` or `/reject`. See [docs/api.md#chat](docs/api.md#chat) for payloads and safety boundaries.

## API documentation

`GET /docs` (interactive Swagger UI) and `GET /docs/json` (raw OpenAPI 3.0), both unauthenticated like `/health`/`/metrics`. The document ([src/docs/openapi.ts](src/docs/openapi.ts)) is hand-written and static — no Fastify route-level schemas are added, so it can't double-validate against the existing inline Zod checks. See [docs/api.md](docs/api.md) for the same contract with runnable `curl` examples.

## MCP server

`POST /mcp` exposes the same five tools to external MCP clients over Streamable HTTP, reusing the chat agent's factories/RBAC/SQL guard/KB ACLs — one source of truth. Same auth as REST (`POST /auth/login`, then Bearer). `task_draft` only creates a `pending_action`; no approve/execute tool exists in MCP. Try `npm run mcp:demo` or `npx @modelcontextprotocol/inspector`. Full transport/auth/governance/scope details: [docs/mcp.md](docs/mcp.md).

## Observability

```sh
docker compose up -d --wait postgres jaeger
npm run dev
```

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=ops-copilot
```

Jaeger UI at `http://127.0.0.1:16686`. Every request traces nested spans: HTTP request → agent run → each step → each tool call (redacted input, status, duration) → each LLM call (model, tokens, latency, `cost_usd`) → each SQL guard verdict. Prompt/completion content is excluded from spans (may contain CRM data), not just redacted.

`cost_usd` is `0` unless `LLM_PRICE_TABLE_JSON` sets real per-model prices. Emails, phones, token-shaped strings, and sensitive field names are redacted from spans and logs before recording.

`GET /metrics` — Prometheus text: `http_server_request_count`/`_duration_ms` (route/method/status), `tool_error_count` (tool), `llm_tokens_total` (model/token type). Unauthenticated, like `/health`.

## Verification and production build

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm start
```

Build emits ESM to `dist/`; `npm start` also needs a `.env` in the working directory. Tests need a Docker daemon (disposable Postgres containers, never the dev database).

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

Multi-stage `Dockerfile` (non-root, pinned `node:24.11.1-bookworm-slim`), one-shot `migrate`, then `api` + `jaeger`. Only `api` and Jaeger's UI (16686) are published — not `postgres`. Secrets (`JWT_SECRET`, `REFRESH_TOKEN_PEPPER`, DB passwords) load from gitignored `VAR_FILE`s under `secrets/`, mounted as Docker secrets, never baked into the image. Details: [docs/operations.md](docs/operations.md) (setup/rotation/limits), [docs/security.md](docs/security.md) (how each control works).

```sh
npm run build   # or: npm run lint && npm run typecheck && npm test
scripts/smoke.sh
```

`scripts/smoke.sh` runs this whole flow end-to-end from a clean state with `LLM_PROVIDER=mock` and a disposable `app_user` password — no external credentials needed.

## Git hooks

Husky installs the pre-commit hook via npm's `prepare` lifecycle; lint-staged runs `eslint --fix` on staged TS/JS files (successful fixes auto-stage, remaining errors block the commit). Run checks manually with `npm run lint:staged`; run `npm run prepare` if Git was initialized after `npm ci`.

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

`db/` — Drizzle schema, tenant client, migrations. `auth/` — authentication, RBAC. `approvals/` — validates/executes approved proposals. `mock-bitrix/` — CRM-backed mock operations. `observability/audit.ts` — transactional audit events. `sql-guard/` — validates/runs scoped analytics. `rag/` — KB ingestion, retrieval, cited answers. The single agent exposes all of this through authenticated `POST /chat`.

See [AGENTS.md](AGENTS.md) for development rules, [docs/decisions.md](docs/decisions.md) for the recorded decision log, [docs/architecture.md](docs/architecture.md) for system/data-flow/ER diagrams, and [docs/ai-tools.md](docs/ai-tools.md) for AI-tool-usage disclosure.
