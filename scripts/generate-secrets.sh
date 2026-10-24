#!/usr/bin/env bash
# Generates the local secrets/ directory consumed by docker-compose.yml's `secrets:` block
# (mounted into containers under /run/secrets, read via the app's VAR_FILE convention; see
# src/secrets.ts and docs/operations.md). secrets/ is gitignored; never commit its contents.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p secrets
chmod 700 secrets

write_if_absent() {
  local path="$1" value="$2"
  if [ -s "$path" ]; then
    echo "skip (already exists): $path"
  else
    printf '%s' "$value" > "$path"
    chmod 600 "$path"
    echo "wrote: $path"
  fi
}

random_hex() { node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"; }

write_if_absent secrets/postgres_password.txt "$(random_hex)"
write_if_absent secrets/jwt_secret.txt "$(random_hex)"
write_if_absent secrets/refresh_token_pepper.txt "$(random_hex)"

# These two require the app_user/migration_owner passwords chosen above: migration_database_url
# uses the postgres_password.txt value directly (migration_owner's bootstrap password);
# database_url needs app_user's password, which is provisioned separately (see
# docs/operations.md "First-time setup") and is NOT auto-filled here.
POSTGRES_DB="${POSTGRES_DB:-ops_copilot}"
if [ ! -s secrets/migration_database_url.txt ]; then
  owner_password="$(cat secrets/postgres_password.txt)"
  printf 'postgresql://migration_owner:%s@postgres:5432/%s' "$owner_password" "$POSTGRES_DB" > secrets/migration_database_url.txt
  chmod 600 secrets/migration_database_url.txt
  echo "wrote: secrets/migration_database_url.txt"
else
  echo "skip (already exists): secrets/migration_database_url.txt"
fi

if [ ! -s secrets/database_url.txt ]; then
  # A placeholder so `docker compose up` (which validates every referenced secret file exists
  # before starting anything) can bring postgres up at all. This password does NOT match
  # app_user's real one yet -- the api service will fail to connect until you replace this file
  # after setting app_user's password interactively (see docs/operations.md "First-time setup")
  # and restart the api service: `docker compose up -d api`.
  printf 'postgresql://app_user:REPLACE-AFTER-SETTING-APP-USER-PASSWORD@postgres:5432/%s' "$POSTGRES_DB" > secrets/database_url.txt
  chmod 600 secrets/database_url.txt
  echo "wrote PLACEHOLDER: secrets/database_url.txt (replace after setting app_user's password; see docs/operations.md)"
else
  echo "skip (already exists): secrets/database_url.txt"
fi
