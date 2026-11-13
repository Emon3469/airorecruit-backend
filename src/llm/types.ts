import type { z } from 'zod';

/** Provider-neutral message format used by the agent loop. Adapters translate to each SDK. */
export type NeutralMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /** Provider-native content (e.g. Anthropic blocks incl. thinking) replayed verbatim within a turn. */
      raw?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object). */
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatParams {
  model: string;
  system: string;
  messages: NeutralMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Token streaming: called with text deltas as the model writes them. */
  onText?: (delta: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  usage: Usage;
  model: string;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  /** True when text was already delivered through onText while generating. */
  streamed?: boolean;
}

export interface JsonParams<T extends z.ZodTypeAny> {
  model: string;
  system: string;
  prompt: string;
  schema: T;
  schemaName: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface JsonResult {
  /** Raw model text; the caller validates it with Zod (and may run one repair retry). */
  text: string;
  usage: Usage;
  model: string;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'gemini' | 'groq' | 'mock';
  chat(params: ChatParams): Promise<ChatResult>;
  json<T extends z.ZodTypeAny>(params: JsonParams<T>): Promise<JsonResult>;
}
