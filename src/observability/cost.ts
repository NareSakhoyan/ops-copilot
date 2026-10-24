import { z } from 'zod';

const priceEntrySchema = z.object({ promptPerMillion: z.number().min(0), completionPerMillion: z.number().min(0) });
const priceTableSchema = z.record(z.string(), priceEntrySchema);

// Empty by default: an unpriced model costs $0 rather than guessing. Configure real prices
// via LLM_PRICE_TABLE_JSON, e.g. {"gemini-3-flash-preview":{"promptPerMillion":0.1,"completionPerMillion":0.4}}.
function loadPriceTable(environment: NodeJS.ProcessEnv): Record<string, { promptPerMillion: number; completionPerMillion: number }> {
  const raw = environment.LLM_PRICE_TABLE_JSON;
  if (!raw) return {};
  try { return priceTableSchema.parse(JSON.parse(raw)); }
  catch { return {}; }
}

export function computeCostUsd(modelId: string, promptTokens: number, completionTokens: number, environment: NodeJS.ProcessEnv = process.env): number {
  const price = loadPriceTable(environment)[modelId];
  if (!price) return 0;
  return (promptTokens / 1_000_000) * price.promptPerMillion + (completionTokens / 1_000_000) * price.completionPerMillion;
}
