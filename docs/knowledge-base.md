# Knowledge base

`kb/` contains ten short synthetic Markdown documents in Armenian and English. `05-manager-policy-en.md` allows only `sales_manager` and `admin`. Other examples explicitly allow all four roles. No real customer data is included.

## Configure and calibrate

The required local `.env` and `.env.example` include:

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

Replace quota placeholders with positive integers from your project's AI Studio limits; there are no defaults. Leave the threshold blank until evaluated. Answering requires an explicit threshold between -1 and 1; the check and ingestion do not. Tests require neither a Google key nor network access to Google.

```sh
npm run embed:check
```

This makes live Google calls: five passage/query pairs per language, ten Armenian sentences and ten English. Passages use `RETRIEVAL_DOCUMENT`; queries use `RETRIEVAL_QUERY`. It prints returned dimension, every related/unrelated cosine score, and count/min/max/mean for each group/language. Confirm Armenian related scores clearly beat unrelated scores. Choose `KB_REFUSAL_THRESHOLD` using these results and representative actual KB questions; this diagnostic does not select it or guarantee answer quality.

The exact options are `providerOptions: { google: { taskType, outputDimensionality: EMBED_DIM } }`; see the [Google provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/google). Vectors are validated and normalized. The chat model is local Ollama `gemma4:26b` through the shared model factory; embedding calls remain Google calls. Ollama needs no cloud key for answer generation. Switching only the chat model does not require re-embedding or changing the vector dimension.

## Migrate and ingest

```sh
docker compose up -d --wait db
npm run db:migrate
npm run db:seed
npm run kb:ingest -- ./kb \
  --tenant-id a0000000-0000-4000-8000-000000000001 \
  --user-id a0000000-0000-4000-8000-000000000002
```

Flags must identify an existing tenant admin. Ingestion uses `DATABASE_URL` as `app_user`, checks current memberships, and processes documents through `withTenant`. For Sevan Logistics run again using tenant/user IDs `b0000000-0000-4000-8000-000000000001` and `b0000000-0000-4000-8000-000000000002`. Documents are not ingested automatically.

Output is `{ documents, skipped, embedded }`. Repeating unchanged ingestion produces `embedded: 0` and skips all documents. Changed chunks alone consume embeddings. Title/role changes update metadata without re-embedding unchanged text. Changing `EMBED_MODEL` re-embeds affected documents; search excludes other model versions. Removing a file does not remove its database document.

Each top-level `.md` file requires this front matter. Filenames identify sources and must be unique within a tenant across ingested directories:

```markdown
---
title: Example policy
allowed_roles: [admin, sales_manager]
---
# Policy heading
Synthetic text.
```

Empty/unknown roles, malformed YAML, extra metadata keys, and titles containing citation delimiters are rejected. Symlinks are not followed. Chunks start at headings and target about 500 English tokens with a small overlap; byte-based estimates differ for Armenian. Each document, chunks, and audit event commit together; a failure rolls back that document while earlier documents remain committed.

`EMBED_DIM` must match the committed `vector(1536)` migration and cannot exceed 2000. To change it, create a deliberate migration and regenerate vectors; editing `.env` alone is insufficient. Ingestion checks the database type before embedding and fails on API dimension mismatches.

## Search and answer

These functions are called by the chat agent (`POST /chat`); there is no standalone KB HTTP endpoint:

```ts
import { answerFromKb } from './src/rag/answer.js';

const result = await answerFromKb(request.context, 'Ե՞րբ կարելի է ստեղծել հանձնարարություն։');
// { answer, refused, citations: [{ chunkId, title, ordinal, source }] }
```

`createKbSearch` accepts a vector from `embedder.embedQuery(question)` and returns up to five matches by default. SQL applies tenant, current database roles, document ACL, and embedding model before ordering/limiting. Exact cosine ordering avoids approximate-index candidate loss in this small corpus; the requested HNSW index is present for future tuning. Membership changes apply on the next search even with stale token/context roles.

`answerFromKb` returns fixed Armenian/English refusal when no authorized evidence exists or the best score is below threshold, without calling the chat model. Answers require valid citations such as `[Հանձնարարության հաստատում §1]`; returned metadata includes source filenames. Missing/invented labels cause refusal. Source-label validation cannot prove every claim follows from its source. Retrieved text is explicitly delimited as untrusted data, and the model receives no executable tools.

## Quotas and verification

Ignored `.cache/embedding-quota.json` holds model names, timestamps, counters, and conservative token estimates. Local processes coordinate through atomic reservations; counters survive restarts, include retries, and reset daily at midnight Pacific time. Each input counts conservatively as one request, with UTF-8 bytes plus overhead as the token budget. Processes must use this working directory for shared accounting. Calls on other hosts or through AI Studio are not tracked; Google's actual quota remains authoritative. See [Google's rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits).

429/5xx failures receive at most three total attempts with exponential backoff and Retry-After; other failures are immediate. Provider cooldowns over one minute are saved and surfaced for a later rerun. Exhausted daily quota fails immediately. Invalid JSON fails closed. After a crash while holding `.cache/embedding-quota.json.lock`, first ensure no embedding process is running, then remove only that stale lock directory and preserve the counter file.

```sh
npx vitest run tests/embedding.test.ts tests/rag.test.ts
```

Tests mock Google/chat responses and use disposable PostgreSQL for RLS, role ACLs before top-k, composite FKs, model isolation, incremental ingestion, dimension checks, citations/refusals, and quota/retry behavior. They do not establish live semantic quality or a calibrated threshold.
