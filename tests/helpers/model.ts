import { MockLanguageModelV4 } from 'ai/test';

type Response = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
export const modelText = (text: string): Response => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] });
export const modelTool = (toolName: string, input: unknown, id = 'tool-1'): Response => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] });

export { MockLanguageModelV4 };
