import crypto from 'node:crypto';
import type { z } from 'zod';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { Job, LlmUsage } from '../models';
import { publish } from '../services/events';
import { AppError } from '../lib/errors';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { costUsd } from './pricing';
import { extractJson } from './schema';
import type { ChatParams, ChatResult, LlmProvider, Usage } from './types';

/**
 * LLM gateway. Every model call in the app goes through `chat()` or `json()` here, which:
 *  - picks the provider and the model tier (agent vs fast),
 *  - records tokens + USD cost to LlmUsage and $inc's Job.usage (per-job cost tracking),
 *  - validates structured output with Zod and runs ONE repair retry on schema failure,
 *  - in mock mode, uses the caller's deterministic fallback so the app works with no key.
 */

export type Tier = 'agent' | 'fast';

const DEFAULT_MODELS: Record<'anthropic' | 'openai' | 'gemini' | 'groq' | 'mock', Record<Tier, string>> = {
  gemini: { agent: 'gemini-3.5-flash', fast: 'gemini-3.5-flash-lite' },
  groq: { agent: 'llama-3.3-70b-versatile', fast: 'llama-3.1-8b-instant' },
  anthropic: { agent: 'claude-opus-5-5', fast: 'claude-haiku-5-5' },
  openai: { agent: 'gpt-4.1', fast: 'gpt-4.1-mini' },
  mock: { agent: 'mock-agent', fast: 'mock-fast' },
};

export const llmInfo = {
  provider: env.llmProvider,
  models: {
    agent: env.llmProvider === 'mock' ? DEFAULT_MODELS.mock.agent : env.LLM_MODEL_AGENT ?? DEFAULT_MODELS[env.llmProvider].agent,
    fast: env.llmProvider === 'mock' ? DEFAULT_MODELS.mock.fast : env.LLM_MODEL_FAST ?? DEFAULT_MODELS[env.llmProvider].fast,
  },
};

export type MockChatHandler = (p: ChatParams) => Promise<ChatResult> | ChatResult;
let mockChatHandler: MockChatHandler | null = null;
/** The agent registers its deterministic rule-based router used when no LLM key is configured. */
export function setMockChatHandler(fn: MockChatHandler) {
  mockChatHandler = fn;
}

let provider: LlmProvider | null = null;
function getProvider(): LlmProvider | null {
  if (env.llmProvider === 'mock') return null;
  if (!provider) {
    provider =
      env.llmProvider === 'anthropic'
        ? new AnthropicProvider(env.llmApiKey!, env.llmBaseUrl)
        : new OpenAIProvider(env.llmApiKey!, env.llmBaseUrl, env.llmProvider === 'gemini', env.LLM_MAX_RPM ?? (env.llmProvider === 'gemini' ? 12 : 0));
  }
  return provider;
}

export const isMockLlm = () => env.llmProvider === 'mock';

export interface CallContext {
  purpose: string;
  jobId?: Types.ObjectId | string | null;
  conversationId?: Types.ObjectId | string | null;
}

/** Prompt version = hash of the stable part of the system prompt (the live context is excluded). */
export const promptVersion = (system: string) =>
  crypto.createHash('sha256').update(system.replace(/Current context:[\s\S]*$/, '')).digest('hex').slice(0, 10);

type CallStatus = 'ok' | 'repaired' | 'schema_error' | 'error' | 'mock' | 'budget_fallback';

async function recordUsage(
  ctx: CallContext,
  model: string,
  usage: Usage,
  latencyMs: number,
  meta: { status?: CallStatus; promptVersion?: string; error?: string } = {},
) {
  const cost = costUsd(model, usage.promptTokens, usage.completionTokens);
  try {
    await LlmUsage.create({
      promptVersion: meta.promptVersion ?? null,
      status: meta.status ?? 'ok',
      error: meta.error?.slice(0, 300) ?? null,
      jobId: ctx.jobId ?? null,
      conversationId: ctx.conversationId ?? null,
      purpose: ctx.purpose,
      provider: env.llmProvider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: cost,
      latencyMs,
    });
    if (ctx.jobId) {
      const job = await Job.findByIdAndUpdate(
        ctx.jobId,
        {
          $inc: {
            'usage.promptTokens': usage.promptTokens,
            'usage.completionTokens': usage.completionTokens,
            'usage.costUsd': cost,
            'usage.calls': 1,
          },
        },
        { new: true, projection: { usage: 1 } },
      );
      if (job) await publish('usage.updated', { usage: job.usage }, { jobId: ctx.jobId });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to record llm usage');
  }
}

/** Cost guard: true when the job has spent its LLM budget. */
export async function overBudget(jobId?: Types.ObjectId | string | null): Promise<boolean> {
  if (!jobId || !env.JOB_BUDGET_USD) return false;
  const job = await Job.findById(jobId, { usage: 1 }).lean();
  return (job?.usage?.costUsd ?? 0) >= env.JOB_BUDGET_USD;
}

export async function chat(params: Omit<ChatParams, 'model'> & { tier?: Tier }, ctx: CallContext): Promise<ChatResult> {
  const model = llmInfo.models[params.tier ?? 'agent'];
  const started = Date.now();
  const version = promptVersion(params.system);
  const p = getProvider();
  if (p && (await overBudget(ctx.jobId))) {
    await recordUsage(ctx, model, { promptTokens: 0, completionTokens: 0 }, 0, { status: 'budget_fallback', promptVersion: version });
    throw new AppError(
      402,
      'BUDGET_EXCEEDED',
      `This job reached its AI budget of $${env.JOB_BUDGET_USD}. Raise JOB_BUDGET_USD to keep chatting; buttons and background jobs keep working (on heuristics).`,
    );
  }
  let res: ChatResult;
  try {
    if (!p) {
      if (!mockChatHandler) throw new Error('No LLM configured and no mock handler registered');
      res = await mockChatHandler({ ...params, model });
    } else {
      res = await p.chat({ ...params, model });
    }
  } catch (err) {
    await recordUsage(ctx, model, { promptTokens: 0, completionTokens: 0 }, Date.now() - started, { status: 'error', promptVersion: version, error: (err as Error).message });
    throw err;
  }
  await recordUsage(ctx, res.model || model, res.usage, Date.now() - started, { status: p ? 'ok' : 'mock', promptVersion: version });
  return res;
}

export interface JsonCallParams<T extends z.ZodTypeAny> {
  tier?: Tier;
  system: string;
  prompt: string;
  schema: T;
  schemaName: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Deterministic fallback used in mock mode (no API key). Must never invent candidate facts. */
  mock: () => z.infer<T>;
}

export class LlmSchemaError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
  }
}

/**
 * Structured call with Zod validation. On a schema failure we retry ONCE with the
 * validation error appended; if that still fails we throw LlmSchemaError and the
 * caller decides (e.g. scoring marks `scoring_failed` rather than inventing a score).
 */
export async function json<T extends z.ZodTypeAny>(params: JsonCallParams<T>, ctx: CallContext): Promise<z.infer<T>> {
  const p = getProvider();
  const version = promptVersion(params.system);
  if (!p) {
    const value = params.schema.parse(params.mock());
    await recordUsage(ctx, llmInfo.models[params.tier ?? 'fast'], { promptTokens: 0, completionTokens: 0 }, 0, { status: 'mock', promptVersion: version });
    return value;
  }
  const model = llmInfo.models[params.tier ?? 'fast'];
  // Graceful degradation: over budget → deterministic heuristic instead of failing the pipeline.
  if (await overBudget(ctx.jobId)) {
    const value = params.schema.parse(params.mock());
    await recordUsage(ctx, model, { promptTokens: 0, completionTokens: 0 }, 0, { status: 'budget_fallback', promptVersion: version });
    return value;
  }
  let prompt = params.prompt;
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let res;
    try {
      res = await p.json({ ...params, model, prompt });
    } catch (err) {
      await recordUsage(ctx, model, { promptTokens: 0, completionTokens: 0 }, Date.now() - started, { status: 'error', promptVersion: version, error: (err as Error).message });
      throw err;
    }
    lastRaw = res.text;
    try {
      const value = params.schema.parse(extractJson(res.text));
      await recordUsage(ctx, res.model || model, res.usage, Date.now() - started, { status: attempt ? 'repaired' : 'ok', promptVersion: version });
      return value;
    } catch (err) {
      await recordUsage(ctx, res.model || model, res.usage, Date.now() - started, { status: 'schema_error', promptVersion: version, error: (err as Error).message });
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ purpose: ctx.purpose, attempt, msg: msg.slice(0, 300) }, 'llm json validation failed');
      prompt = `${params.prompt}\n\nYour previous output was invalid:\n${msg.slice(0, 800)}\nReturn ONLY a JSON object that matches the schema.`;
    }
  }
  throw new LlmSchemaError(`Model output for ${params.schemaName} failed validation twice`, lastRaw);
}
