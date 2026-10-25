# Knowledge base

`kb/` has ten short synthetic Markdown documents, Armenian and English, no real customer data. `05-manager-policy-en.md` is `sales_manager`/`admin`-only; the rest allow all four roles.

## Configure and calibrate

Required in `.env`:

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-private-ai-studio-key
EMBED_MODEL=gemini-embedding-001
EMBED_DIM=1536
EMBED_RPM=your-project-limit
EMBED_RPD=your-project-limit
EMBED_TPM=your-project-limit
LLM_PROVIDER=ollama
LLM_MODEL=gemma4:26b
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
KB_REFUSAL_THRESHOLD=your-evaluated-number
```

Quota placeholders need real positive integers from your AI Studio limits — no defaults. Leave the threshold blank until evaluated (answering requires one between -1 and 1; ingestion/checking don't). Tests need neither a Google key nor network access.

```sh
npm run embed:check
```

Makes live Google calls — five passage/query pairs per language (ten AM + ten EN sentences), passages as `RETRIEVAL_DOCUMENT`, queries as `RETRIEVAL_QUERY`. Prints dimension, every cosine score, and count/min/max/mean per group. Confirm Armenian related scores clearly beat unrelated ones, then pick `KB_REFUSAL_THRESHOLD` from these results plus representative real questions — this diagnostic informs the threshold, it doesn't set it. Chat itself runs on local Ollama (no cloud key); embeddings stay a separate Google call, unaffected by which chat provider is configured.

## Migrate and ingest

```sh
docker compose up -d --wait postgres
npm run db:migrate
npm run db:seed
npm run kb:ingest -- ./kb --tenant-id a0000000-0000-4000-8000-000000000001 --user-id a0000000-0000-4000-8000-000000000002
```

Flags must name an existing tenant admin; run again with `b0000000-...-000000000001`/`...002` for Sevan Logistics. Ingestion isn't automatic — run it per tenant. Runs as `app_user` through `withTenant`, checking current memberships.

Output: `{ documents, skipped, embedded }`. Re-running unchanged input gives `embedded: 0` (all skipped) — only changed chunks consume quota; title/role edits update metadata without re-embedding; changing `EMBED_MODEL` re-embeds and search excludes other model versions; deleting a file does *not* delete its DB document.

Each top-level `.md` file needs front matter (filenames must be unique per tenant across ingested directories, symlinks aren't followed):

```markdown
---
title: Example policy
allowed_roles: [admin, sales_manager]
---
# Policy heading
Synthetic text.
```

Empty/unknown roles, malformed YAML, extra keys, and citation-delimiter characters in the title are all rejected. Chunking starts at headings, targets ~500 English tokens with a small overlap (Armenian byte estimates differ). Each document + its chunks + an audit event commit together — a failed document rolls back while earlier ones in the same run stay committed.

`EMBED_DIM` must match the committed `vector(1536)` migration (cap 2000) — changing it needs a real migration and re-embedding, not just an env edit. Ingestion checks the DB's vector type before spending quota and fails on a dimension mismatch.

## Search and answer

Called only from the chat agent (`POST /chat`) — no standalone HTTP endpoint:

```ts
import { answerFromKb } from './src/rag/answer.js';
const result = await answerFromKb(request.context, 'Ե՞րբ կարելի է ստեղծել հանձնարարություն։');
// { answer, refused, citations: [{ chunkId, title, ordinal, source }] }
```

`createKbSearch` takes a query vector and returns up to 5 matches by default; SQL applies tenant + current roles + document ACL + embedding-model filter before ordering/limiting (exact cosine ordering — fine at this corpus size; an HNSW index exists for later tuning). Membership changes apply on the very next search even with a stale token.

`answerFromKb` returns a fixed bilingual refusal — no chat call — when there's no authorized evidence or the best score is below threshold. Answers require valid citations like `[Հանձնարարության հաստատում §1]`; a missing/invented label causes refusal (this verifies citation *identity*, not that every claim actually follows from its source). Retrieved text is delimited as untrusted data; the answering call gets no executable tools.

## Quotas and verification

Ignored `.cache/embedding-quota.json` tracks per-model usage with atomic file-lock reservations, surviving restarts and resetting daily at midnight Pacific. Each input counts as one request, with UTF-8 bytes + overhead as a conservative token estimate — other hosts/AI-Studio-direct calls aren't tracked; Google's real quota stays authoritative ([rate-limit docs](https://ai.google.dev/gemini-api/docs/rate-limits)).

429/5xx get ≤3 attempts with backoff + Retry-After; other failures are immediate; exhausted daily quota fails immediately; invalid JSON fails closed. If a crash leaves a stale `.cache/embedding-quota.json.lock`, confirm nothing's running, then remove only that lock directory (keep the counter file).

```sh
npx vitest run tests/embedding.test.ts tests/rag.test.ts
```

Mocked Google/chat responses + disposable Postgres cover RLS, role ACLs before top-k, composite FKs, model isolation, incremental ingestion, dimension checks, citations/refusals, and quota/retry behavior — not live semantic quality or a calibrated threshold.
