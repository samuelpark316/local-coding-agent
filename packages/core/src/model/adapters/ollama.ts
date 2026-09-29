/**
 * Ollama adapter - First model provider
 *
 * Connects to local Ollama server for inference.
 */

import { DEFAULT_MODEL_CONFIG, type ModelConfig } from '../config.js';
import type { LLM, LLMOptions, LLMResponse } from '../LLM.js';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export interface OllamaConfig {
  baseUrl?: string;
  model: string;
  temperature?: number;
  contextLimit?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OllamaAdapter implements LLM {
  private readonly config: Required<OllamaConfig>;

  constructor(config: OllamaConfig) {
    this.config = {
      baseUrl: config.baseUrl || DEFAULT_MODEL_CONFIG.baseUrl,
      model: config.model,
      temperature: config.temperature ?? DEFAULT_MODEL_CONFIG.temperature,
      contextLimit: config.contextLimit ?? DEFAULT_MODEL_CONFIG.contextLimit,
      timeoutMs: config.timeoutMs ?? 10_000,
      maxRetries: config.maxRetries ?? 2,
    };
  }

  static fromModelConfig(config: ModelConfig): OllamaAdapter {
    return new OllamaAdapter({
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: config.temperature,
      contextLimit: config.contextLimit,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    let response: OllamaChatResponse;
    try {
      response = await this.requestWithRetry<OllamaChatResponse>('/api/chat', {
        method: 'POST',
        body: JSON.stringify(this.buildChatBody(prompt, false, options)),
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (!options?.structuredOutput?.fallbackToPrompt) throw error;
      response = await this.requestWithRetry<OllamaChatResponse>('/api/chat', {
        method: 'POST',
        body: JSON.stringify(
          this.buildChatBody(prompt, false, { ...options, structuredOutput: undefined })
        ),
        headers: { 'content-type': 'application/json' },
      });
    }

    const content = response.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Ollama returned an invalid response payload: missing message.content.');
    }

    return {
      content,
      finishReason: mapFinishReason(response.done_reason),
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    let response: Response;
    try {
      response = await this.fetchWithRetry('/api/chat', {
        method: 'POST',
        body: JSON.stringify(this.buildChatBody(prompt, true, options)),
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (!options?.structuredOutput?.fallbackToPrompt) throw error;
      response = await this.fetchWithRetry('/api/chat', {
        method: 'POST',
        body: JSON.stringify(
          this.buildChatBody(prompt, true, { ...options, structuredOutput: undefined })
        ),
        headers: { 'content-type': 'application/json' },
      });
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Ollama streaming response body was empty.');
    }

    const decoder = new TextDecoder();
    let buffered = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const parsed = JSON.parse(trimmed) as OllamaChatResponse;
        const content = parsed.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield content;
        }
      }
    }

    const trailing = buffered.trim();
    if (trailing.length > 0) {
      const parsed = JSON.parse(trailing) as OllamaChatResponse;
      const content = parsed.message?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield content;
      }
    }
  }

  async checkServer(): Promise<boolean> {
    try {
      await this.requestWithRetry('/api/tags');
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.requestWithRetry<OllamaTagsResponse>('/api/tags');
    return (response.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }

  private buildChatBody(
    prompt: string,
    stream: boolean,
    options?: LLMOptions
  ): Record<string, unknown> {
    const messages: OllamaChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: prompt,
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream,
      messages,
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        num_ctx: options?.contextLimit ?? this.config.contextLimit,
        num_predict: options?.maxTokens,
        stop: options?.stop,
      },
    };
    if (options?.structuredOutput) body.format = options.structuredOutput.schema;
    return body;
  }

  private async requestWithRetry<T>(requestPath: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchWithRetry(requestPath, init);
    return (await response.json()) as T;
  }

  private async fetchWithRetry(requestPath: string, init?: RequestInit): Promise<Response> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.config.maxRetries) {
      try {
        const response = await this.fetchWithTimeout(requestPath, init);
        if (!response.ok) {
          const bodyText = await response.text();
          throw this.toHttpError(response.status, bodyText);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxRetries) {
          break;
        }

        const delayMs = 100 * 2 ** attempt;
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }

      attempt += 1;
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error('Unknown Ollama request failure.');
  }

  private async fetchWithTimeout(requestPath: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      return await fetch(`${this.config.baseUrl}${requestPath}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Timed out connecting to Ollama at ${this.config.baseUrl}. Is "ollama serve" running?`
        );
      }

      if (error instanceof Error) {
        throw new Error(
          `Unable to reach Ollama at ${this.config.baseUrl}: ${error.message}. Is "ollama serve" running?`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toHttpError(status: number, bodyText: string): Error {
    const message = extractErrorMessage(bodyText);

    if (status === 404 || message.toLowerCase().includes('model')) {
      return new Error(
        `Ollama model "${this.config.model}" was not found. Pull it first with: ollama pull ${this.config.model}`
      );
    }

    return new Error(`Ollama request failed (${status}): ${message}`);
  }
}

function extractErrorMessage(bodyText: string): string {
  if (!bodyText) {
    return 'no response body';
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errorMessage = parsed.error;
    if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
      return errorMessage;
    }
  } catch {
    // fall through to raw body
  }

  return bodyText.trim();
}

function mapFinishReason(doneReason: string | undefined): LLMResponse['finishReason'] {
  if (doneReason === 'length') {
    return 'length';
  }

  if (doneReason === 'error') {
    return 'error';
  }

  return 'stop';
}
