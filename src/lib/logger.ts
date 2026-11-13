import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: { paths: ['req.headers.authorization', '*.apiKey', '*.LLM_API_KEY', '*.llmApiKey', '*.GEMINI_API_KEY', '*.GROQ_API_KEY', '*.ANTHROPIC_API_KEY', '*.OPENAI_API_KEY', '*.QDRANT_API_KEY', '*.SMTP_PASS'], remove: true },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});
