import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { ChatParams, ChatResult, JsonParams, JsonResult, LlmProvider, NeutralMessage, ToolCall } from './types';
import { toStrictJsonSchema } from './schema';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/**
 * Models that support server-side refusal fallbacks. On a policy decline the API re-runs
 * the request on a fallback model inside the same call (`fallbacks: "default"`).
 */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;

/**
 * Claude adapter.
 * - Uses the beta Messages endpoint so we can opt into server-side refusal fallbacks.
 * - Never sends temperature/top_p (rejected on current models); depth is controlled via `effort`.
 * - Replays assistant content blocks verbatim (incl. thinking blocks) within a turn.
 * - tool_choice stays `auto`; forced tool choice is rejected on current models.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 2, timeout: 120_000 });
  }

  private fallbackOpts(model: string) {
    return FALLBACK_MODELS.test(model)
      ? { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const }
      : {};
  }

  private toMessages(messages: NeutralMessage[]): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        if (m.raw) {
          out.push({ role: 'assistant', content: m.raw as BetaContentBlockParam[] });
        } else {
          const blocks: BetaContentBlockParam[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          out.push({ role: 'assistant', content: blocks.length ? blocks : m.content || '(no content)' });
        }
      } else {
        const block: BetaToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
          ...(m.isError ? { is_error: true } : {}),
        };
        // All tool results for one assistant turn go back in a SINGLE user message.
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
          (prev.content as BetaContentBlockParam[]).push(block);
        } else {
          out.push({ role: 'user', content: [block] });
        }
      }
    }
    return out;
  }

  async chat(p: ChatParams): Promise<ChatResult> {
    const body = {
      model: p.model,
      max_tokens: p.maxTokens ?? 16000,
      system: p.system,
      messages: this.toMessages(p.messages),
      ...(p.tools?.length
        ? {
            tools: p.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
            })),
          }
        : {}),
      ...(p.effort ? { output_config: { effort: p.effort } } : {}),
      ...this.fallbackOpts(p.model),
    };
    // Real token streaming when the caller wants deltas (the agent loop forwards them over SSE).
    const res = p.onText
      ? await this.client.beta.messages.stream(body).on('text', (delta) => p.onText!(delta)).finalMessage()
      : await this.client.beta.messages.create(body);

    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
    const stop = res.stop_reason;
    return {
      text: text.trim(),
      toolCalls,
      raw: res.content,
      usage: { promptTokens: res.usage.input_tokens ?? 0, completionTokens: res.usage.output_tokens ?? 0 },
      model: res.model,
      streamed: !!p.onText,
      stopReason:
        stop === 'tool_use' ? 'tool_use' : stop === 'end_turn' ? 'end' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'other',
    };
  }

  async json<T extends z.ZodTypeAny>(p: JsonParams<T>): Promise<JsonResult> {
    const res = await this.client.beta.messages.create({
      model: p.model,
      max_tokens: p.maxTokens ?? 4000,
      system: p.system,
      messages: [{ role: 'user', content: p.prompt }],
      output_config: {
        ...(p.effort ? { effort: p.effort } : {}),
        format: { type: 'json_schema', schema: toStrictJsonSchema(p.schema) },
      },
      ...this.fallbackOpts(p.model),
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request');
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      text,
      usage: { promptTokens: res.usage.input_tokens ?? 0, completionTokens: res.usage.output_tokens ?? 0 },
      model: res.model,
    };
  }
}
