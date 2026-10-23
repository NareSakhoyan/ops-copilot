import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createChatModel } from '../src/agent/model.js';

afterEach(() => vi.unstubAllGlobals());

describe('single chat-model factory', () => {
  it('defaults to local Ollama without requiring cloud credentials and preserves tool-call round trips', async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url, init) => {
      requests.push({ url: url instanceof Request ? url.url : url instanceof URL ? url.toString() : url, body: JSON.parse(z.string().parse(init?.body)) as unknown,
        authorization: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(Response.json({ id: 'local-response', object: 'chat.completion', created: 1, model: 'gemma4:26b',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'local-call', type: 'function', function: { name: 'lookup', arguments: '{"query":"Հայերեն"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const execute = vi.fn((input: { query: string }) => Promise.resolve({ found: input.query }));
    const model = createChatModel({});
    if (typeof model === 'string') throw new Error('Expected a model instance');
    expect(model.modelId).toBe('gemma4:26b');
    expect(model.provider).toContain('ollama');
    const result = await generateText({ model, prompt: 'Find this word', maxRetries: 0,
      tools: { lookup: tool({ inputSchema: z.object({ query: z.string() }).strict(), execute }) } });
    expect(execute).toHaveBeenCalledWith({ query: 'Հայերեն' }, expect.objectContaining({ toolCallId: 'local-call' }));
    expect(result.toolResults).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'http://127.0.0.1:11434/v1/chat/completions', authorization: null,
      body: { model: 'gemma4:26b', tools: [{ type: 'function', function: { name: 'lookup' } }] } });
  });

  it('accepts a configured Ollama endpoint and rejects non-HTTP URLs', () => {
    const model = createChatModel({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'gemma4:26b', OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
    if (typeof model === 'string') throw new Error('Expected a model instance');
    expect(model.modelId).toBe('gemma4:26b');
    expect(() => createChatModel({ LLM_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'ftp://localhost/v1' })).toThrow();
    expect(() => createChatModel({ LLM_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'invalid' })).toThrow();
  });

  it('switches between direct Google and the Vercel gateway using only the selected provider credentials', () => {
    const google = createChatModel({ LLM_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'test-only-key' });
    const gateway = createChatModel({ LLM_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'test-only-key', LLM_MODEL: 'example/test-model' });
    if (typeof google === 'string' || typeof gateway === 'string') throw new Error('Expected model instances');
    expect(google.modelId).toBe('gemini-3.8-flash');
    expect(google.provider).toContain('google');
    expect(gateway.modelId).toBe('example/test-model');
    expect(gateway.provider).toContain('gateway');
    expect(() => createChatModel({ LLM_PROVIDER: 'unknown' })).toThrow();
    expect(() => createChatModel({ LLM_PROVIDER: 'gateway', GOOGLE_GENERATIVE_AI_API_KEY: 'wrong-provider-key' })).toThrow();
  });

  it('builds a Vertex AI model from project/location config without requiring an API key', () => {
    const vertex = createChatModel({ LLM_PROVIDER: 'vertex', GOOGLE_VERTEX_PROJECT: 'test-project', GOOGLE_VERTEX_LOCATION: 'us-central1' });
    if (typeof vertex === 'string') throw new Error('Expected a model instance');
    expect(vertex.modelId).toBe('gemini-3.8-flash');
    expect(vertex.provider).toContain('vertex');
    expect(() => createChatModel({ LLM_PROVIDER: 'vertex', GOOGLE_VERTEX_LOCATION: 'us-central1' })).toThrow();
    expect(() => createChatModel({ LLM_PROVIDER: 'vertex', GOOGLE_VERTEX_PROJECT: 'test-project' })).toThrow();
  });
});
