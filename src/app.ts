import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFound, ah } from './http/middleware';
import { chatRouter } from './http/routes/chat.routes';
import { jobsRouter } from './http/routes/jobs.routes';
import { miscRouter, simulateReplyHandler } from './http/routes/misc.routes';
import { opsRouter } from './http/routes/ops.routes';
import { bookingPageRouter } from './http/bookingPage';
import { setMockChatHandler } from './llm';
import { mockChat } from './agent/mockRouter';

/**
 * CORS allow-list from a comma-separated env value. Tolerant of the usual deploy mistakes:
 * trailing slashes and stray spaces are ignored, `*` allows any origin, and a `*` inside an entry
 * is a wildcard (e.g. `https://*.vercel.app` covers every Vercel preview deployment).
 */
export function corsOrigin(list: string): (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void {
  const entries = list
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  const anyOrigin = entries.includes('*');
  const patterns = entries.map((e) => new RegExp(`^${e.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`));
  return (origin, cb) => {
    // Same-origin requests, curl and server-to-server calls send no Origin header.
    if (!origin || anyOrigin) return cb(null, true);
    const o = origin.replace(/\/+$/, '').toLowerCase();
    cb(null, patterns.some((p) => p.test(o)));
  };
}

export function createApp() {
  setMockChatHandler(mockChat);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: corsOrigin(env.CORS_ORIGINS),
      credentials: false,
      exposedHeaders: ['Content-Type'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' || (req.url ?? '').startsWith('/api/events') } }));
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', chatRouter, jobsRouter, miscRouter, opsRouter);
  // The brief names the endpoint `POST /simulate-reply`; keep that exact path as an alias.
  app.post('/simulate-reply', ah(simulateReplyHandler));
  app.use(bookingPageRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
