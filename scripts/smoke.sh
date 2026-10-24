#!/usr/bin/env bash
# End-to-end container smoke test: brings the full stack up from a clean state, waits for
# readiness, logs in as a seeded demo user, and sends one /chat request against the
# deterministic mock LLM (no external model credentials required). Intended for CI and local
# verification before a real deployment; never run against a production stack.
set -euo pipefail
cd "$(dirname "$0")/.."

# Exclude docker-compose.override.yml's local-dev port publish: this exercises the actual
# production-safe config, where postgres is not reachable from outside the compose network.
export COMPOSE_FILE=docker-compose.yml
export POSTGRES_DB="${POSTGRES_DB:-ops_copilot}"
# Smoke-test overrides: non-production so the seed CLI and LLM_PROVIDER=mock are both allowed
# (see src/db/seed/run.ts and src/agent/model.ts, which refuse/block these in NODE_ENV=production).
export NODE_ENV=test
export LLM_PROVIDER=mock
BASE_URL="http://127.0.0.1:${PORT:-3000}"

cleanup() {
  echo "==> Tearing down"
  docker compose down -v --remove-orphans || true
}
trap cleanup EXIT

echo "==> Starting from a clean state"
docker compose down -v --remove-orphans 2>/dev/null || true

echo "==> Generating local secrets (skips any that already exist)"
./scripts/generate-secrets.sh

echo "==> Bringing up postgres"
docker compose up -d --build --wait postgres

echo "==> Running migrations"
# Not included in the --wait above: migrate is a one-shot container that's expected to exit
# (compose's --wait treats a non-"running"/"healthy" state as a failure, which a clean exit(0)
# from a one-shot service would trip). Run it in the foreground and check its own exit code.
docker compose up --build migrate

echo "==> Provisioning app_user's password for this run"
OWNER_PASSWORD="$(cat secrets/postgres_password.txt)"
APP_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")"
docker compose exec -T postgres env PGPASSWORD="$OWNER_PASSWORD" \
  psql -U migration_owner -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_user WITH PASSWORD '${APP_PASSWORD}'" >/dev/null
printf 'postgresql://app_user:%s@postgres:5432/%s' "$APP_PASSWORD" "$POSTGRES_DB" > secrets/database_url.txt
chmod 600 secrets/database_url.txt

echo "==> Starting the API"
docker compose up -d --build --wait api

echo "==> Checking /health/ready"
READY_STATUS="$(curl -sf -o /tmp/smoke-ready.json -w '%{http_code}' "${BASE_URL}/health/ready")"
cat /tmp/smoke-ready.json
if [ "$READY_STATUS" != "200" ]; then
  echo "FAIL: /health/ready returned HTTP ${READY_STATUS}" >&2
  exit 1
fi

echo "==> Seeding demo data"
docker compose run --rm seed

echo "==> Logging in as the seeded admin user"
LOGIN_RESPONSE="$(curl -sf -X POST "${BASE_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"a0000000-0000-4000-8000-000000000001","email":"admin@example.invalid","password":"DevAdmin!2026"}')"
ACCESS_TOKEN="$(node -e "console.log(JSON.parse(process.argv[1]).accessToken)" "$LOGIN_RESPONSE")"
if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "undefined" ]; then
  echo "FAIL: login did not return an accessToken: ${LOGIN_RESPONSE}" >&2
  exit 1
fi

echo "==> Sending one /chat request against the mock model"
CHAT_STATUS="$(curl -s -o /tmp/smoke-chat.json -w '%{http_code}' -X POST "${BASE_URL}/chat" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"message":"Smoke test: say hello.","allowTaskDraft":false}')"
cat /tmp/smoke-chat.json
if [ "$CHAT_STATUS" != "200" ]; then
  echo "FAIL: /chat returned HTTP ${CHAT_STATUS}" >&2
  exit 1
fi

echo "==> Smoke test passed"
