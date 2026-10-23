import { z } from 'zod';
import { loadEnvironment } from '../config.js';

export const dimensionSchema = z.coerce.number().int().min(1).max(2000).default(1536);
// Schema generation, ingestion, search, and the diagnostic share this dimension.
export const EMBED_DIM = dimensionSchema.parse(loadEnvironment().EMBED_DIM);
const positiveLimit = z.coerce.number().int().positive();
const embeddingSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().trim().min(1),
  EMBED_MODEL: z.string().trim().min(1).default('gemini-embedding-001'),
  EMBED_DIM: dimensionSchema,
  EMBED_RPM: positiveLimit,
  EMBED_RPD: positiveLimit,
  EMBED_TPM: positiveLimit,
});
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export function parseEmbeddingConfig(input: unknown): EmbeddingConfig {
  return embeddingSchema.parse(input);
}
export function parseAnswerConfig(input: unknown) {
  return z.object({
    LLM_MODEL: z.string().trim().min(1).default('gemini-3.8-flash'),
    KB_REFUSAL_THRESHOLD: z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().min(-1).max(1)),
  }).parse(input);
}
