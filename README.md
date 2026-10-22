# ops-copilot

Node.js 24, ESM, strict TypeScript, Fastify, Zod, pino, Vitest, and ESLint. Uses npm.

## Development

```sh
nvm use
npm ci
```

The local `.env` file is required and is already provided. On a fresh checkout, create it with `cp .env.example .env`, generate a signing secret with the command below, and set `JWT_SECRET` to its output before starting. Local environment files are ignored by Git. Process environment settings override values in `.env`; Zod validates the result before the server listens. Invalid configuration or a missing file prevents startup.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

After setting `JWT_SECRET`, start the API with `npm run dev`.

Development logs use `pino-pretty`: INFO is green, WARN is yellow, and ERROR is red, with readable local timestamps and request IDs. `npm start` outputs structured JSON for production.

Defaults: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, `LOG_LEVEL=info`.

```sh
curl -i http://127.0.0.1:3000/health
```

Returns HTTP 200 with `{"status":"ok"}`. Each request receives a server-generated UUID in the `X-Request-ID` response header and pino's `reqId` log field.

## PostgreSQL

The `.env` and `.env.example` contain local PostgreSQL development settings. Start PostgreSQL 18 with pgvector and apply the committed migrations:

```sh
docker compose up -d --wait db
npm run db:migrate
```

Generate a migration after changing the Drizzle schema with `npm run db:generate`. Migrations use the owner-only `MIGRATION_DATABASE_URL`, followed by the currently empty grants step. Tenant tables enforce RLS; application operations use `withTenant(ctx, fn)` and a separate `DATABASE_URL` naming `app_user`. Provision that login's password before using database operations, following [docs/security.md](docs/security.md). Explicit analytics table grants remain deferred. See [docs/database.md](docs/database.md) for the schema, indexes, roles, and migration lifecycle.

## Authentication and audit

Implemented endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, and permission-gated `GET /audit-logs`. Login returns a 15-minute JWT and a random opaque refresh token. Refresh tokens rotate on each use; reuse revokes the entire family. Families expire seven days after login. Logout revokes the refresh family; access tokens retain their original expiry.

Configure `JWT_SECRET` (at least 32 characters), `JWT_ISSUER` (default `ops-copilot`), and `JWT_AUDIENCE` (default `ops-copilot-api`). The local `.env` contains a signing secret; the example deliberately leaves it blank. There are no default CRM accounts or automatic RBAC seeds. Provision tenant users with Argon2 password hashes and tenant-local role/permission memberships before logging in. [docs/api.md](docs/api.md) contains request examples, the permission matrix, and a minimal local account-provisioning example. [docs/security.md](docs/security.md) explains request context, scoping, rate limiting, and token lifecycle limitations.

## Verification and production build

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm start
```

The build emits ESM into `dist/`. `npm start` requires a `.env` file in the working directory too. Tests require a running Docker-compatible daemon; database tests use disposable PostgreSQL containers and do not use the development database.

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

The database module contains the Drizzle schema, tenant client, and migration tooling. `auth/` contains authentication and RBAC; `observability/audit.ts` writes transactional audit events. Other module directories remain placeholders for future features. See [AGENTS.md](AGENTS.md) for development rules and [docs/decisions.md](docs/decisions.md) for recorded decisions.
