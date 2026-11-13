/**
 * npm run llm:smoke
 * Verifies the configured LLM provider end to end (credentials never printed):
 * lists available models (OpenAI-compatible vendors), then runs one tool call and one
 * JSON-schema call through the production adapters.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { chat, json, llmInfo } from '../src/llm';

async function main() {
  mongoose.set('bufferCommands', false); // usage logging is optional here
  console.log('provider:', llmInfo.provider, '| models:', llmInfo.models, '| base:', env.llmBaseUrl ?? '(default)');
  if (llmInfo.provider === 'mock') return console.log('No key configured: offline mode.');

  if (llmInfo.provider !== 'anthropic') {
    try {
      const client = new OpenAI({ apiKey: env.llmApiKey, baseURL: env.llmBaseUrl });
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id.replace(/^models\//, ''));
      const relevant = ids.filter((i) => /gemini-(2|3)|llama|gpt|claude/i.test(i) && !/embed|tts|image|audio|live|veo|imagen/i.test(i));
      console.log(`models available (${ids.length}):`, relevant.slice(0, 40).join(', '));
    } catch (e) {
      console.log('model listing failed:', (e as Error).message.slice(0, 200));
    }
  }

  const t0 = Date.now();
  const res = await chat(
    {
      tier: 'agent',
      system: 'You are a test agent. Use the tool when asked.',
      messages: [{ role: 'user', content: 'Call get_weather for Dhaka.' }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      maxTokens: 500,
    },
    { purpose: 'smoke' },
  );
  console.log(`agent tool call (${Date.now() - t0} ms):`, JSON.stringify(res.toolCalls), '| stop:', res.stopReason, '| model:', res.model, '| usage:', res.usage);

  const t1 = Date.now();
  const out = await json(
    {
      tier: 'fast',
      system: 'Classify sentiment.',
      prompt: 'Text: "I love this role, happy to chat!"',
      schema: z.object({ label: z.enum(['positive', 'negative', 'neutral']), confidence: z.number().min(0).max(1) }),
      schemaName: 'sentiment',
      maxTokens: 300,
      mock: () => ({ label: 'neutral' as const, confidence: 0 }),
    },
    { purpose: 'smoke' },
  );
  console.log(`fast json call (${Date.now() - t1} ms):`, JSON.stringify(out));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('SMOKE FAILED:', (e as Error).message.slice(0, 500));
    process.exit(1);
  });
