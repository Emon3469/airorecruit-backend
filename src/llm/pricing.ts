import { env } from '../config/env';
import { logger } from '../lib/logger';

/** USD per 1M tokens. Override or extend with PRICE_TABLE_JSON. */
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-2': { input: 8, output: 40 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'mock-agent': { input: 0, output: 0 },
  'mock-fast': { input: 0, output: 0 },
};

function loadPrices() {
  if (!env.PRICE_TABLE_JSON) return DEFAULT_PRICES;
  try {
    return { ...DEFAULT_PRICES, ...(JSON.parse(env.PRICE_TABLE_JSON) as typeof DEFAULT_PRICES) };
  } catch {
    logger.warn('PRICE_TABLE_JSON is not valid JSON; using defaults');
    return DEFAULT_PRICES;
  }
}

const PRICES = loadPrices();

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1];
  if (!p) return 0;
  return Number(((promptTokens * p.input + completionTokens * p.output) / 1_000_000).toFixed(6));
}
