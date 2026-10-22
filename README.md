# ops-copilot

Node.js 24, ESM, strict TypeScript, Fastify, Zod, pino, Vitest, and ESLint. Uses npm.

## Development

```sh
nvm use
npm ci
npm run dev
```

The local `.env` file is required and is already provided. On a fresh checkout, create it with `cp .env.example .env` before starting. Local environment files are ignored by Git. Process environment settings override values in `.env`; Zod validates the result before the server listens. Invalid configuration or a missing file prevents startup.

Defaults: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, `LOG_LEVEL=info`.

```sh
curl -i http://127.0.0.1:3000/health
```

Returns HTTP 200 with `{"status":"ok"}`. Each request receives a server-generated UUID in the `X-Request-ID` response header and pino's `reqId` log field.

## Verification and production build

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm start
```

The build emits ESM into `dist/`. `npm start` requires a `.env` file in the working directory too.

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

Module directories are placeholders for future features. See [AGENTS.md](AGENTS.md) for development rules and [docs/decisions.md](docs/decisions.md) for recorded decisions.
