import type { ProviderConfig } from '../../shared/types';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  reasoning?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema (object)
}

export type DeltaType = 'text' | 'reasoning' | 'tool';

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (type: DeltaType, text: string) => void;
  idleTimeoutMs?: number;
}

export interface LlmResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; cached: number };
  usageReported: boolean;
  stopReason: string;
  requestId?: string;
}

export interface ProviderRuntime {
  config: ProviderConfig;
  apiKey: string;
}

export type FetchLike = (url: string, init: RequestInit & { signal?: AbortSignal }) => Promise<Response>;

export class LlmHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'LlmHttpError';
  }
  get retryable() {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}
