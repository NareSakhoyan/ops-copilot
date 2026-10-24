# syntax=docker/dockerfile:1.7
# Multi-stage build for the ops-copilot API. The same final image also runs the one-shot
# "migrate" service in docker-compose.yml (overriding CMD), so dist/db and drizzle/ are included.

FROM node:24.11.1-bookworm-slim AS deps
WORKDIR /app
# argon2 ships prebuilt native bindings for linux glibc; build-essential/python3 are a fallback
# in case npm ever needs to compile it from source for this platform, and never reach the final
# runtime image below.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --ignore-scripts: the only lifecycle script here is "prepare" (husky, a dev-only git hook
# installer irrelevant to a container with no .git directory); argon2's native binding is
# resolved by node-gyp-build at require() time regardless, from its bundled prebuilds.
RUN npm ci --ignore-scripts

FROM node:24.11.1-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# So dist/db/seed/run.js can also run directly from this stage (docker-compose.yml's "seed"
# service, which needs devDependencies like @faker-js/faker that the pruned runtime image below
# excludes); see docker/container.env.
COPY docker/container.env ./.env

FROM node:24.11.1-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle
# Deliberately empty; see docker/container.env. Real config/secrets come only from the
# container's actual environment (docker-compose.yml's environment:/secrets:), never this file.
COPY --chown=node:node docker/container.env ./.env
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]
