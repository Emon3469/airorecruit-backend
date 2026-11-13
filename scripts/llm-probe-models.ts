/** Probe which models answer a 1-token request on the configured OpenAI-compatible vendor (keys never printed). */
import OpenAI from 'openai';
import { env } from '../src/config/env';

const candidates = process.argv.slice(2);
(async () => {
  const client = new OpenAI({ apiKey: env.llmApiKey, baseURL: env.llmBaseUrl, maxRetries: 0, timeout: 30_000 });
  for (const model of candidates) {
    const t = Date.now();
    try {
      const r = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 50 });
      console.log(`OK   ${model.padEnd(32)} ${Date.now() - t} ms  -> ${JSON.stringify(r.choices[0]?.message.content?.slice(0, 20))}`);
    } catch (e) {
      console.log(`FAIL ${model.padEnd(32)} ${(e as { status?: number }).status ?? ''} ${(e as Error).message.slice(0, 90)}`);
    }
  }
  process.exit(0);
})();
