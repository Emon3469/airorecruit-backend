import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration is read once, validated with Zod and frozen.
 * A bad value fails fast at boot with a readable message instead of
 * surfacing as a confusing runtime error deep inside a worker.
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),

  MONGO_URI: z.string().optional(),
  REDIS_URL: z.string().optional(),
  /** Alternative, split-style settings (e.g. MongoDB Atlas / Redis Cloud dashboards). Used when MONGO_URI / REDIS_URL are unset. */
  DATABASE_URL: z.string().optional(),
  DATABASE_USERNAME: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_NAME: z.string().default('airorecruit'),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().positive().optional(),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: bool,

  FRONTEND_URL: z.string().default('http://localhost:5173'),
  /** Base URL used to build booking links that go out in emails. */
  PUBLIC_BOOKING_BASE_URL: z.string().default('http://localhost:5173/booking'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * anthropic | openai | gemini | groq | mock. Auto-detected when unset: LLM_API_KEY → anthropic,
   * else GEMINI_API_KEY → gemini, else GROQ_API_KEY → groq, else mock (offline).
   */
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini', 'groq', 'mock']).optional(),
  LLM_API_KEY: z.string().optional(),
  /** Vendor-specific keys (standard names), used when LLM_API_KEY is not set. */
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),

  /** Vector store for talent rediscovery. Qdrant when configured, otherwise an in-Mongo index. */
  QDRANT_URL: z.string().optional(),
  QDRANT_CLUSTER_ENDPOINT: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().default('airorecruit_candidates'),
  /** local = on-device embeddings (transformers.js, all-MiniLM-L6-v2); off = disable talent rediscovery. */
  EMBEDDINGS: z.enum(['local', 'off']).default('local'),
  TALENT_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.5),
  /** Optional base URL, e.g. Gemini's OpenAI-compatible endpoint when LLM_PROVIDER=openai. */
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL_AGENT: z.string().optional(),
  LLM_MODEL_FAST: z.string().optional(),
  /** Client-side requests/minute cap for the LLM (defaults to 12 for Gemini free tier, unlimited otherwise). */
  LLM_MAX_RPM: z.coerce.number().int().min(0).optional(),
  /** Max agent loop iterations per user turn. */
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(12).default(6),
  /** JSON map model -> { input, output } USD per 1M tokens. Overrides/extends the built-in table. */
  PRICE_TABLE_JSON: z.string().optional(),

  SERPER_API_KEY: z.string().optional(),
  SERPER_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(20),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool,
  MAIL_FROM: z.string().default('AiroRecruit Talent Team <talent@airorecruit.dev>'),

  /** Per-job LLM budget (USD). Above it, structured calls fall back to the deterministic heuristics. */
  JOB_BUDGET_USD: z.coerce.number().min(0).default(5),
  DAILY_SEND_LIMIT: z.coerce.number().int().min(1).default(50),
  /**
   * Length of one "day" in campaign sequences, in ms. 86400000 in production.
   * Set to e.g. 60000 for demos so "Day 3" follow-ups fire after 3 minutes.
   */
  OUTREACH_DAY_MS: z.coerce.number().int().min(1000).default(86_400_000),

  /** Run BullMQ workers inside the API process (handy for local dev without a second terminal). */
  RUN_WORKERS_IN_API: bool,
});

export type Env = z.infer<typeof EnvSchema>;

/** Build a Mongo URI from DATABASE_URL (+ optional separate credentials) when MONGO_URI isn't given. */
function resolveMongoUri(e: Env): string {
  if (e.MONGO_URI) return e.MONGO_URI;
  if (!e.DATABASE_URL) return 'mongodb://localhost:27017/airorecruit';
  let raw = e.DATABASE_URL.trim();
  if (!/^mongodb(\+srv)?:\/\//.test(raw)) raw = `mongodb+srv://${raw}`;
  try {
    const url = new URL(raw);
    if (!url.username && e.DATABASE_USERNAME) {
      url.username = encodeURIComponent(e.DATABASE_USERNAME);
      url.password = encodeURIComponent(e.DATABASE_PASSWORD ?? '');
    }
    if (!url.pathname || url.pathname === '/') url.pathname = `/${e.DATABASE_NAME}`;
    return url.toString();
  } catch {
    return raw;
  }
}

/** Build a Redis URL from REDIS_HOST/PORT/USERNAME/PASSWORD when REDIS_URL isn't given. */
function resolveRedisUrl(e: Env): string {
  if (e.REDIS_URL) return e.REDIS_URL;
  if (!e.REDIS_HOST) return 'redis://localhost:6379';
  // Tolerate dashboard copy-paste artefacts: quotes, a scheme, "host:port" or "host", port".
  const cleaned = e.REDIS_HOST.replace(/^rediss?:\/\//, '').replace(/["'\s]/g, '');
  const m = cleaned.match(/^([A-Za-z0-9.-]+)(?:[:,]+(\d+))?/);
  const host = m?.[1] ?? cleaned;
  const port = Number(m?.[2]) || e.REDIS_PORT || 6379;
  const auth = e.REDIS_PASSWORD ? `${encodeURIComponent(e.REDIS_USERNAME ?? 'default')}:${encodeURIComponent(e.REDIS_PASSWORD)}@` : '';
  return `${e.REDIS_TLS ? 'rediss' : 'redis'}://${auth}${host}:${port}`;
}

export type LlmVendor = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'mock';

/** OpenAI-compatible endpoints for vendors served through the OpenAI adapter. */
const VENDOR_BASE_URL: Partial<Record<LlmVendor, string>> = {
  // Explicit, so a stray ANTHROPIC_BASE_URL / OPENAI_BASE_URL in the shell can never reroute traffic.
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
};

function load(): Env & { llmProvider: LlmVendor; llmApiKey?: string; llmBaseUrl?: string; qdrantUrl?: string; MONGO_URI: string; REDIS_URL: string } {
  // Treat empty strings as unset so `.env.example` placeholders don't count as values.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;
  const requested: LlmVendor =
    env.LLM_PROVIDER ??
    (env.LLM_API_KEY || env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : env.OPENAI_API_KEY
        ? 'openai'
        : env.GEMINI_API_KEY
          ? 'gemini'
          : env.GROQ_API_KEY
            ? 'groq'
            : 'mock');
  const keyFor: Record<LlmVendor, string | undefined> = {
    anthropic: env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY,
    openai: env.LLM_API_KEY ?? env.OPENAI_API_KEY,
    gemini: env.LLM_API_KEY ?? env.GEMINI_API_KEY,
    groq: env.LLM_API_KEY ?? env.GROQ_API_KEY,
    mock: undefined,
  };
  const llmApiKey = keyFor[requested];
  // A real provider without a key degrades to the deterministic mock instead of crashing,
  // so the whole flow stays demoable offline.
  const llmProvider: LlmVendor = requested !== 'mock' && !llmApiKey ? 'mock' : requested;
  const llmBaseUrl = env.LLM_BASE_URL ?? VENDOR_BASE_URL[llmProvider];
  const qdrantUrl = env.QDRANT_URL ?? env.QDRANT_CLUSTER_ENDPOINT;
  return Object.freeze({
    ...env,
    llmProvider,
    llmApiKey,
    llmBaseUrl,
    qdrantUrl: qdrantUrl ? (/^https?:\/\//.test(qdrantUrl) ? qdrantUrl : `https://${qdrantUrl}`) : undefined,
    MONGO_URI: resolveMongoUri(env),
    REDIS_URL: resolveRedisUrl(env),
  });
}

export const env = load();
export const isTest = env.NODE_ENV === 'test';
