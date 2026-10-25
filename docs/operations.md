# Operations

Single-host Docker Compose deployment: `postgres`, one-shot `migrate`, `api`, `jaeger`. See [README.md](../README.md#run-in-containers) for a quick start and [security.md](security.md) for the controls referenced below.

## First-time setup

```sh
cp .env.example .env            # host-side defaults only; containers get config below
./scripts/generate-secrets.sh   # writes secrets/*.txt (gitignored): postgres/jwt/pepper + a placeholder database_url.txt
docker compose up -d --wait postgres migrate
```

`migrate` applies migrations + derived analytics grants as `migration_owner`, then exits. `--wait` only waits on healthchecked services, so check `migrate`'s exit code separately if scripting this (`docker compose up migrate` in the foreground propagates it).

`app_user`'s password is deliberately never auto-generated ([security.md](security.md#local-login-setup)) — set it, then replace the placeholder:

```sh
docker compose exec postgres psql -U migration_owner -d "$POSTGRES_DB" -c "\password app_user"
printf 'postgresql://app_user:<the password you just set>@postgres:5432/%s' "$POSTGRES_DB" > secrets/database_url.txt
docker compose up -d --wait api
```

Optionally seed demo data ([seed-scenarios.md](seed-scenarios.md); refuses `NODE_ENV=production`):

```sh
NODE_ENV=test docker compose run --rm seed
```

## Start / stop

```sh
docker compose up -d --wait        # api waits on migrate + postgres health
docker compose ps
docker compose logs -f api
docker compose down                # stop, keep postgres_data
docker compose down -v             # stop and delete all data — destructive
```

`api`/`postgres` restart `unless-stopped`; `migrate`/`seed` are one-shot. `jaeger` also restarts `unless-stopped` but has no `healthcheck:` (its image ships no shell/curl/wget).

## Migrations

`npm run db:generate` on the host after changing the Drizzle schema, commit the SQL under `drizzle/`, redeploy — `migrate` reruns automatically since `api` depends on `migrate: service_completed_successfully`. Forward-only; no automatic rollback ([decisions.md](decisions.md) "Initial migration lifecycle").

## Secret rotation

Every secret resolves from `VAR` or `VAR_FILE` (`src/secrets.ts`); Compose mounts `secrets:` at `/run/secrets/*`, `_FILE` wins if both are set. To rotate: write the new value to `secrets/*.txt`, then `docker compose up -d --build api migrate` (or just `api`).

| Secret | Effect of rotation |
| --- | --- |
| `jwt_secret.txt` | Invalidates every outstanding access token immediately — users must re-login. |
| `refresh_token_pepper.txt` | Invalidates every outstanding refresh token; access tokens already issued stay valid until they expire (≤15 min). |
| `postgres_password.txt` | Only takes effect on a fresh volume (the image sets it at first init only) — on an existing one, `ALTER ROLE migration_owner WITH PASSWORD ...` instead, then update the file to match. |
| `database_url.txt` / `migration_database_url.txt` | Update together with the matching role's real password, then restart the affected service(s). |

`GOOGLE_APPLICATION_CREDENTIALS` (Vertex) isn't part of this loader by design ([decisions.md](decisions.md) "Add Vertex AI as a chat model provider") — point it at a mounted secret path directly, e.g. a `vertex_sa_json` entry in `secrets:` with `GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/vertex_sa_json` on `api`.

## Backups

Not implemented. `postgres_data` is a named volume; a minimal single-host approach is a periodic `docker compose exec postgres pg_dump -U migration_owner "$POSTGRES_DB"` piped to storage outside the volume — scheduling, retention, and restore verification are intentionally out of scope.

## Known limits

- **Single instance** — one `api`, one `postgres`. No load balancing, replicas, or failover.
- **In-memory rate limits** — per-process, resets on restart, doesn't coordinate across replicas ([security.md](security.md#rate-limiting)); fine for one instance, needs a shared store (e.g. Redis) to scale horizontally.
- **No reverse proxy / TLS termination** — `api`'s port is published directly on `127.0.0.1`. Fronting it with a proxy needs `TRUST_PROXY` set so rate limiting keys on the real client IP, plus TLS termination there.
- **No automated backup/restore** (above).
- **`jaeger` has no healthcheck** and isn't on the critical path — `/health/ready` doesn't check it.
- **`app_user`'s password isn't automated** — deliberately set via interactive `psql` ([security.md](security.md#local-login-setup)); `scripts/smoke.sh` scripts this step for disposable CI/smoke runs only, never a real deployment.
