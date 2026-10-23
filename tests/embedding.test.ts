import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EMBED_DIM, dimensionSchema, parseEmbeddingConfig, parseAnswerConfig } from '../src/rag/config.js';
import { createGoogleEmbedder, FakeEmbedder } from '../src/rag/embed.js';
import { createQuotaLimiter } from '../src/rag/quota.js';
import { calibration, checkEmbeddings } from '../scripts/embed-check.js';

const directories: string[] = [];
const limits = { EMBED_RPM: 100, EMBED_RPD: 1000, EMBED_TPM: 100000 };
async function temporaryFile() {
  const directory = await mkdtemp(join(tmpdir(), 'embedding-'));
  directories.push(directory);
  return join(directory, 'quota.json');
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('embedding configuration', () => {
  it('requires explicit quotas and answer threshold, and rejects HNSW-incompatible dimensions', () => {
    expect(() => parseEmbeddingConfig({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' })).toThrow();
    for (const invalid of ['', '0', '2001', '3.5']) expect(() => dimensionSchema.parse(invalid)).toThrow();
    expect(dimensionSchema.parse(undefined)).toBe(1536);
    expect(dimensionSchema.parse('2000')).toBe(2000);
    expect(() => parseAnswerConfig({ LLM_MODEL: 'gemini-3.8-flash' })).toThrow();
    expect(() => parseAnswerConfig({ LLM_MODEL: 'gemini-3.8-flash', KB_REFUSAL_THRESHOLD: '' })).toThrow();
    expect(parseAnswerConfig({ LLM_MODEL: 'gemini-3.8-flash', KB_REFUSAL_THRESHOLD: '0.7' }).KB_REFUSAL_THRESHOLD).toBe(0.7);
  });
});

describe('Google embeddings without network', () => {
  it('uses retrieval task types, dimensions, batches, and retries a 429 honoring Retry-After', async () => {
    let now = Date.parse('2026-10-23T08:00:00Z');
    const sleep = vi.fn((ms: number) => { now += ms; return Promise.resolve(); });
    const requests: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body: unknown = JSON.parse(z.string().parse(init?.body));
      requests.push(body);
      if (requests.length === 1) return Promise.resolve(Response.json({ error: { code: 429, message: 'busy', status: 'RESOURCE_EXHAUSTED' } }, { status: 429, headers: { 'retry-after': '2' } }));
      const parsed = z.object({ requests: z.array(z.unknown()).optional() }).parse(body);
      const vector = { values: Array.from({ length: EMBED_DIM }, (_, index) => index === 0 ? 1 : 0) };
      return Promise.resolve(Response.json(parsed.requests ? { embeddings: parsed.requests.map(() => vector) } : { embedding: vector }));
    });
    const file = await temporaryFile();
    const embedder = createGoogleEmbedder(parseEmbeddingConfig({ ...limits, GOOGLE_GENERATIVE_AI_API_KEY: 'secret-test-key' }), { file, fetch: fetchMock, now: () => now, sleep });
    expect(await embedder.embedPassages(['Հայերեն հատված', 'English passage'])).toHaveLength(2);
    expect(await embedder.embedQuery('Հարցում')).toHaveLength(EMBED_DIM);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);
    const batch = z.object({ requests: z.array(z.object({ taskType: z.string(), outputDimensionality: z.number() })) }).parse(requests[1]);
    expect(batch.requests).toHaveLength(2);
    expect(batch.requests.every((request) => request.taskType === 'RETRIEVAL_DOCUMENT' && request.outputDimensionality === EMBED_DIM)).toBe(true);
    expect(requests[2]).toMatchObject({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: EMBED_DIM });
    expect(await readFile(file, 'utf8')).not.toContain('secret-test-key');
  });

  it('fails loudly on returned dimension mismatch without retrying it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ embedding: { values: [1, 0] } }));
    const embedder = createGoogleEmbedder(parseEmbeddingConfig({ ...limits, GOOGLE_GENERATIVE_AI_API_KEY: 'test' }), { file: await temporaryFile(), fetch: fetchMock });
    await expect(embedder.embedQuery('query')).rejects.toThrow(/dimension/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('persistent local quota limits', () => {
  it('throttles a rolling minute and persists per-day consumption across instances', async () => {
    let now = Date.parse('2026-10-23T08:00:00Z');
    const sleep = vi.fn((ms: number) => { now += ms; return Promise.resolve(); });
    const file = await temporaryFile();
    const config = { rpm: 1, rpd: 2, tpm: 100, model: 'test-model', file, now: () => now, sleep };
    await createQuotaLimiter(config).reserve(1, 50);
    await createQuotaLimiter(config).reserve(1, 50);
    expect(sleep).toHaveBeenCalledWith(60000);
    await expect(createQuotaLimiter(config).reserve(1, 1)).rejects.toThrow(/daily/i);
    now += 86400000;
    await expect(createQuotaLimiter(config).reserve(1, 1)).resolves.toBeUndefined();
  });

  it('atomically reserves daily budget for concurrent callers and fails closed on corrupted state', async () => {
    const file = await temporaryFile();
    const options = { rpm: 100, rpd: 1, tpm: 100, model: 'test-model', file };
    const results = await Promise.allSettled([createQuotaLimiter(options).reserve(1, 1), createQuotaLimiter(options).reserve(1, 1)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'broken');
    await expect(createQuotaLimiter(options).reserve(1, 1)).rejects.toThrow();
  });
});

describe('embedding calibration report', () => {
  it('checks ten sentences per language and reports related/unrelated cosine groups without an API key', async () => {
    for (const language of ['hy', 'en']) expect(calibration.filter((pair) => pair.language === language)).toHaveLength(5);
    const report = await checkEmbeddings(new FakeEmbedder());
    expect(report.dimension).toBe(EMBED_DIM);
    expect(report.groups.map((group) => [group.language, group.kind, group.count])).toEqual([
      ['hy', 'related', 5], ['hy', 'unrelated', 20], ['en', 'related', 5], ['en', 'unrelated', 20],
    ]);
    expect(report.groups.every((group) => group.min <= group.mean && group.mean <= group.max)).toBe(true);
  });
});
