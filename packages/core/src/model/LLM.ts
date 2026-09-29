/**
 * LLM - Provider interface
 *
 * Abstract interface for model providers.
 * Keeps adapters pluggable.
 */

export interface LLMResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'error';
}

export interface LLM {
  complete(prompt: string, options?: LLMOptions): Promise<LLMResponse>;
  stream?(prompt: string, options?: LLMOptions): AsyncIterable<string>;
}

export interface LLMOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  contextLimit?: number;
  stop?: string[];
  structuredOutput?: {
    schema: Record<string, unknown>;
    fallbackToPrompt?: boolean;
  };
}
