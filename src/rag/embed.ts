import { createHash } from 'node:crypto';
import { createGoogle } from '@ai-sdk/google';
import { embed, embedMany } from 'ai';
import { z } from 'zod';
import { loadEnvironment } from '../config.js';
import { EMBED_DIM, parseEmbeddingConfig } from './config.js';
import { createQuotaLimiter, delay } from './quota.js';
import { computeBackoffMs } from '../net/retry.js';

export interface Embedder {
  readonly model: string;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
export function validateEmbedding(value: unknown): number[] {
  const vector = z.array(z.number().finite()).parse(value);
  if (vector.length !== EMBED_DIM) throw new Error(`Embedding dimension mismatch: expected ${EMBED_DIM}, received ${vector.length}.`);
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error('Embedding must have a nonzero norm.');
  return vector.map((number) => number / norm);
}
const textSchema = z.string().trim().min(1).max(100000);
// UTF-8 bytes plus overhead conservatively bound text tokens without a tokenizer dependency.
const tokenBudget = (text: string) => Buffer.byteLength(text, 'utf8') + 32;
interface GoogleOptions {
  file?: string; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
export function createGoogleEmbedder(config = parseEmbeddingConfig(loadEnvironment()), options: GoogleOptions = {}): Embedder {
  if (config.EMBED_DIM !== EMBED_DIM) throw new Error('Embedding configuration dimension differs from the shared schema dimension.');
  const google = createGoogle({ apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const model = google.embedding(config.EMBED_MODEL);
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const quota = createQuotaLimiter({ rpm: config.EMBED_RPM, rpd: config.EMBED_RPD, tpm: config.EMBED_TPM, model: config.EMBED_MODEL, ...options });
  async function request(texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      await quota.reserve(texts.length, texts.reduce((sum, text) => sum + tokenBudget(text), 0));
      try {
        const settings = { model, maxRetries: 0, abortSignal: AbortSignal.timeout(30000), providerOptions: { google: { taskType, outputDimensionality: EMBED_DIM } } };
        const embeddings = texts.length === 1
          ? [(await embed({ ...settings, value: texts[0] ?? '' })).embedding]
          : (await embedMany({ ...settings, values: texts, maxParallelCalls: 1 })).embeddings;
        if (embeddings.length !== texts.length) throw new Error('Embedding response count mismatch.');
        return embeddings.map(validateEmbedding);
      } catch (error) {
        // Never attach raw SDK errors: their request data can contain credentials.
        if (error instanceof Error && /^Embedding (dimension|response|must)/.test(error.message)) throw error;
        const details = z.object({ statusCode: z.number().optional(), responseHeaders: z.record(z.string(), z.string()).optional() }).safeParse(error);
        const status = details.success ? details.data.statusCode : undefined;
        if (attempt >= 2 || !(status === 429 || (status !== undefined && status >= 500 && status <= 599))) {
          // eslint-disable-next-line preserve-caught-error -- SDK causes may include the API key and request body.
          throw new Error(`Embedding provider request failed${status ? ` (HTTP ${status})` : ''}.`);
        }
        const header = details.success ? details.data.responseHeaders?.['retry-after'] : undefined;
        const retryAfter = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - now())) : 0;
        const wait = Math.max(computeBackoffMs(attempt), Number.isFinite(retryAfter) ? retryAfter : 0);
        if (wait > 60000) {
          await quota.blockUntil(now() + wait);
          // eslint-disable-next-line preserve-caught-error -- Do not retain credential-bearing SDK causes.
          throw new Error('Embedding provider requested a long cooldown; retry later.');
        }
        await sleep(wait);
      }
    }
  }
  return {
    model: config.EMBED_MODEL,
    async embedPassages(input) {
      const texts = z.array(textSchema).parse(input);
      const result: number[][] = [];
      let batch: string[] = [];
      let tokens = 0;
      for (const text of texts) {
        const cost = tokenBudget(text);
        if (cost > config.EMBED_TPM) throw new Error('One passage exceeds the configured per-minute embedding token budget.');
        if (batch.length && (batch.length >= Math.min(100, config.EMBED_RPM, config.EMBED_RPD) || tokens + cost > config.EMBED_TPM)) {
          result.push(...await request(batch, 'RETRIEVAL_DOCUMENT')); batch = []; tokens = 0;
        }
        batch.push(text); tokens += cost;
      }
      if (batch.length) result.push(...await request(batch, 'RETRIEVAL_DOCUMENT'));
      return result;
    },
    async embedQuery(input) {
      const text = textSchema.parse(input);
      if (tokenBudget(text) > config.EMBED_TPM) throw new Error('Query exceeds the configured per-minute embedding token budget.');
      const [vector] = await request([text], 'RETRIEVAL_QUERY');
      if (!vector) throw new Error('Embedding response count mismatch.');
      return vector;
    },
  };
}

/** Deterministic lexical vectors for tests, never a production semantic model. */
export class FakeEmbedder implements Embedder {
  constructor(readonly model = 'fake-embedding-v1') {}
  private vector(text: string): number[] {
    const result = Array<number>(EMBED_DIM).fill(0);
    for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ['empty']) {
      const hash = createHash('sha256').update(token).digest();
      const index = hash.readUInt32BE() % EMBED_DIM;
      result[index] = (result[index] ?? 0) + 1;
    }
    return validateEmbedding(result);
  }
  embedPassages(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map((text) => this.vector(text))); }
  embedQuery(text: string): Promise<number[]> { return Promise.resolve(this.vector(text)); }
}
