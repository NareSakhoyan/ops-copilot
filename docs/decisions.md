# Decisions

## Runtime and modules

Use Node.js 24 and ECMAScript modules (ESM).

## Package manager

Use npm instead of pnpm. Required verification commands are `npm test` and `npm run lint`.

## Project layout and execution

Use the current workspace as the project root, with package name `ops-copilot`. Keep application modules under `src/`, and `evals/`, `tests/`, and `docs/` at the root. Use `tsx` for development, `tsc` for compilation, and Node.js to run the compiled ESM application.

## Configuration

A `.env` file must exist. Include a local `.env` and a matching `.env.example`; ignore local environment files in version control. Load the required file using Node.js environment parsing, then validate configuration using Zod before starting the server. Process environment values take precedence over file values. Defaults are `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3000`, and `LOG_LEVEL=info`. Invalid configuration prevents startup.

## Health and request logging

`GET /health` returns HTTP 200 and `{"status":"ok"}`. Generate request UUIDs on the server, include them in pino request logs as `reqId`, and return them in the `X-Request-ID` response header. Client headers do not set request IDs.

## Application foundation

The project is named `ops-copilot`. Use Fastify, strict TypeScript without `any`, Zod for external input and environment validation, pino for logging with a request ID per request, Vitest for tests, and ESLint for linting. Provide `GET /health`.

## Trust boundaries

Obtain `tenant_id`, `user_id`, and role only from server-side request context, never LLM output. Use SQL parameters; never concatenate user or LLM text into SQL.

## Change process

Every feature needs tests. Run the required verification commands before finishing. Ask the user about ambiguous requirements or architectural choices not recorded here, and append a short entry for each non-trivial choice.

## Tooling compatibility

Use TypeScript 6.0 because the installed typescript-eslint release supports TypeScript versions below 6.1. Use ESLint flat configuration with type-aware rules, including an explicit ban on `any`. Keep the npm lockfile for reproducible dependency installation.

## Pre-commit checks

Use Husky to run lint-staged before commits. The npm `prepare` lifecycle installs Git hooks. Run `eslint --fix` on staged TypeScript and JavaScript files; lint-staged stages successful fixes and blocks commits on remaining lint errors. Full tests and lint remain required before finishing feature work.

## Cleanup

Keep files and configuration relevant to this Node.js/Fastify project. Remove the unrelated Next.js snippet documents, unused Vitest mock settings, and the redundant `noImplicitAny` setting already enabled by `strict`. Preserve the requested scaffold directories and tests for existing behavior.
