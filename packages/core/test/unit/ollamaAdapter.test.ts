/**
 * Ollama adapter contract tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaAdapter } from '../../src/model/adapters/ollama';

describe('OllamaAdapter', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends chat completion requests with expected shape', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: {
            content: '{"plan":"ok","patch":null,"commands":[],"done":true,"tool_calls":[]}',
          },
          done_reason: 'stop',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'qwen2.5-coder:14b',
      temperature: 0.1,
      contextLimit: 4096,
      maxRetries: 0,
    });

    const result = await adapter.complete('hello', {
      systemPrompt: 'system',
      maxTokens: 256,
    });

    expect(result.finishReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.local/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
    );

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    expect(body.model).toBe('qwen2.5-coder:14b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.options).toMatchObject({
      temperature: 0.1,
      num_ctx: 4096,
      num_predict: 256,
    });
  });

  it('retries transient failures before succeeding', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 500 });
      }

      return new Response(JSON.stringify({ message: { content: 'ok' }, done_reason: 'stop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'qwen2.5-coder:14b',
      maxRetries: 1,
    });
    const result = await adapter.complete('hello');

    expect(result.content).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('returns actionable model-not-found errors', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'missing-model',
      maxRetries: 0,
    });

    await expect(adapter.complete('hello')).rejects.toThrow('ollama pull missing-model');
  });

  it('passes provider-neutral JSON Schema output to Ollama format', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'qwen2.5-coder:14b',
      maxRetries: 0,
    });
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    };
    await adapter.complete('json', { structuredOutput: { schema } });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.format).toEqual(schema);
  });

  it('falls back to prompt-only JSON when an older server rejects format', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unknown field format' }), { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'qwen2.5-coder:14b',
      maxRetries: 0,
    });
    await adapter.complete('json', {
      structuredOutput: { schema: { type: 'object' }, fallbackToPrompt: true },
    });
    const fallbackBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(fallbackBody.format).toBeUndefined();
  });

  it('uses the same structured-output fallback for streaming', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unknown field format' }), { status: 400 })
      )
      .mockResolvedValueOnce(new Response('{"message":{"content":"ok"}}\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OllamaAdapter({
      baseUrl: 'http://ollama.local',
      model: 'qwen2.5-coder:14b',
      maxRetries: 0,
    });
    const chunks: string[] = [];
    for await (const chunk of adapter.stream('json', {
      structuredOutput: { schema: { type: 'object' }, fallbackToPrompt: true },
    }))
      chunks.push(chunk);
    expect(chunks).toEqual(['ok']);
    const fallbackBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(fallbackBody.format).toBeUndefined();
  });

  it.skipIf(process.env.OLLAMA_TESTS !== '1')(
    'can hit a local Ollama server when OLLAMA_TESTS=1',
    async () => {
      const adapter = new OllamaAdapter({
        baseUrl: 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b',
        maxRetries: 0,
      });

      const response = await adapter.complete('Return {"ok": true} as JSON only.');
      expect(response.content.length).toBeGreaterThan(0);
    }
  );
});
