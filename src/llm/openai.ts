import OpenAI from 'openai';
import type { z } from 'zod';
import type { ChatParams, ChatResult, JsonParams, JsonResult, LlmProvider, NeutralMessage, ToolCall } from './types';
import { toStrictJsonSchema } from './schema';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenAI-compatible adapter (OpenAI, or Gemini/Groq/etc. through LLM_BASE_URL).
 * Exists so evaluators can run the project with whichever key they have.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private client: OpenAI;

  /**
   * @param reasoning true for reasoning models (Gemini 3.x): thinking tokens count against the output
   *   limit, so we add headroom, and map our `effort` to `reasoning_effort`.
   */
  private nextSlot = 0;

  /**
   * @param maxRpm client-side requests-per-minute cap (0 = unlimited). Free tiers (e.g. Gemini) return
   *   429 without Retry-After, so we pace requests ourselves instead of hammering the API.
   */
  constructor(apiKey: string, baseURL?: string, private readonly reasoning = false, private readonly maxRpm = 0) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2, timeout: 180_000 });
  }

  /** Rate gate + patient 429 backoff (30s, 60s, 90s, 120s) on top of the SDK's own retries. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.maxRpm > 0) {
        const interval = 60_000 / this.maxRpm;
        const now = Date.now();
        const slot = Math.max(now, this.nextSlot);
        this.nextSlot = slot + interval;
        if (slot > now) await sleep(slot - now);
      }
      try {
        return await fn();
      } catch (err) {
        if (err instanceof OpenAI.RateLimitError && attempt < 4) {
          await sleep(30_000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  private toMessages(system: string, messages: NeutralMessage[]): Msg[] {
    const out: Msg[] = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant' && m.raw)
        // Replay the provider's own message verbatim: Gemini 3.x attaches thought signatures to tool calls
        // (extra_content.google.thought_signature) that must be sent back or the next turn is rejected.
        out.push(m.raw as Msg);
      else if (m.role === 'assistant')
        out.push({
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                })),
              }
            : {}),
        });
      else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    return out;
  }

  private limit(n: number) {
    return this.reasoning ? n + 8000 : n;
  }

  private effort(e?: 'low' | 'medium' | 'high') {
    return this.reasoning && e ? { reasoning_effort: e } : {};
  }

  async chat(p: ChatParams): Promise<ChatResult> {
    const res = await this.call(() => this.client.chat.completions.create({
      model: p.model,
      max_completion_tokens: this.limit(p.maxTokens ?? 4000),
      ...this.effort(p.effort),
      messages: this.toMessages(p.system, p.messages),
      ...(p.tools?.length
        ? {
            tools: p.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }));
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        return { id: tc.id, name: tc.function.name, input };
      });
    const finish = choice?.finish_reason;
    return {
      text: (choice?.message.content ?? '').trim(),
      toolCalls,
      raw: choice?.message,
      usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
      model: res.model,
      stopReason: finish === 'tool_calls' ? 'tool_use' : finish === 'stop' ? 'end' : finish === 'length' ? 'max_tokens' : 'other',
    };
  }

  async json<T extends z.ZodTypeAny>(p: JsonParams<T>): Promise<JsonResult> {
    const res = await this.call(() => this.client.chat.completions.create({
      model: p.model,
      max_completion_tokens: this.limit(p.maxTokens ?? 2000),
      ...this.effort(p.effort),
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: p.schemaName, strict: true, schema: toStrictJsonSchema(p.schema) },
      },
    }));
    return {
      text: res.choices[0]?.message.content ?? '',
      usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
      model: res.model,
    };
  }
}
