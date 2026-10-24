import { createGoogle } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGateway, type LanguageModel } from 'ai';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { loadEnvironment } from '../config.js';
import { tracer } from '../observability/tracing.js';
import { computeCostUsd } from '../observability/cost.js';
import { llmTokenCounter } from '../observability/metrics.js';

/** The single provider boundary for agent, SQL generation, and KB answering. */
export function createChatModel(environment = loadEnvironment()): LanguageModel {
  const config = z.object({
    LLM_PROVIDER: z.enum(['ollama', 'google', 'gateway', 'vertex']).default('ollama'),
    LLM_MODEL: z.string().trim().min(1).optional(),
  }).parse(environment);
  const modelId = config.LLM_MODEL ?? (config.LLM_PROVIDER === 'ollama' ? 'gemma4:26b' : 'gemini-3.8-flash');
  if (config.LLM_PROVIDER === 'ollama') {
    const baseURL = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'OLLAMA_BASE_URL must use HTTP or HTTPS').default('http://127.0.0.1:11434/v1').parse(environment.OLLAMA_BASE_URL);
    return createOpenAICompatible({ name: 'ollama', baseURL }).chatModel(modelId);
  }
  if (config.LLM_PROVIDER === 'gateway') {
    const apiKey = z.string().trim().min(1).parse(environment.AI_GATEWAY_API_KEY);
    const model = modelId.includes('/') ? modelId : `google/${modelId}`;
    return createGateway({ apiKey })(model);
  }
  if (config.LLM_PROVIDER === 'vertex') {
    const { project, location } = z.object({
      GOOGLE_VERTEX_PROJECT: z.string().trim().min(1),
      GOOGLE_VERTEX_LOCATION: z.string().trim().min(1),
    }).transform((value) => ({ project: value.GOOGLE_VERTEX_PROJECT, location: value.GOOGLE_VERTEX_LOCATION })).parse(environment);
    // Credentials come from Application Default Credentials (attached service account on GCP, or GOOGLE_APPLICATION_CREDENTIALS), never from this app's own env validation.
    return createVertex({ project, location })(modelId);
  }
  const apiKey = z.string().trim().min(1).parse(environment.GOOGLE_GENERATIVE_AI_API_KEY);
  return createGoogle({ apiKey })(modelId);
}

// SDK retries each failed model request, never the whole agent/tool workflow.
export const MODEL_TIMEOUT_MS = 300000;
// Local reasoning models otherwise spend the whole output budget on chain-of-thought and never emit a tool call; ignored by non-Ollama providers.
export const modelSettings = (abortSignal?: AbortSignal) => ({ maxRetries: 2, maxOutputTokens: 2000, abortSignal: abortSignal ?? AbortSignal.timeout(MODEL_TIMEOUT_MS), providerOptions: { ollama: { think: false } } });

/** An abort signal alone cannot settle a provider or tool that ignores it. */
export async function beforeModelDeadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Model operation aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([run(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export type TelemetrySetting = { isEnabled: true; functionId: string; recordInputs: false; recordOutputs: false };
// Some provider adapters report {total} detail objects instead of a bare number; this reads either.
function tokenCount(value: number | { total: number } | undefined): number {
  if (typeof value === 'number') return value;
  return value?.total ?? 0;
}

/** Wraps a generateText call (agent planning, SQL generation, KB answering) in an llm.call span with model, token, latency, and cost attributes, and records token metrics. Takes a callback rather than generateText's own params so this stays independent of its TOOLS/OUTPUT generics; pass experimental_telemetry through to enable the AI SDK's own telemetry without recording raw prompt/completion content, which may contain CRM data. */
export async function tracedGenerateText<T extends { usage: { inputTokens: number | { total: number } | undefined; outputTokens: number | { total: number } | undefined } }>(
  functionId: string, modelId: string, run: (telemetry: TelemetrySetting) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan('llm.call', { attributes: { 'llm.model': modelId, 'llm.function_id': functionId } }, async (span) => {
    const started = performance.now();
    try {
      const result = await run({ isEnabled: true, functionId, recordInputs: false, recordOutputs: false });
      const promptTokens = tokenCount(result.usage.inputTokens);
      const completionTokens = tokenCount(result.usage.outputTokens);
      const costUsd = computeCostUsd(modelId, promptTokens, completionTokens);
      span.setAttributes({
        'llm.prompt_tokens': promptTokens, 'llm.completion_tokens': completionTokens,
        'llm.latency_ms': performance.now() - started, 'llm.cost_usd': costUsd,
      });
      llmTokenCounter.add(promptTokens, { model: modelId, type: 'prompt' });
      llmTokenCounter.add(completionTokens, { model: modelId, type: 'completion' });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  });
}
