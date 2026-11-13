import { env } from './config/env';
import { logger } from './lib/logger';
import { connectDb, disconnectDb } from './lib/db';
import { closeRedis } from './lib/redis';
import { createApp } from './app';
import { useRedisTransport } from './services/events';
import { closeQueues } from './queues/queues';
import { llmInfo } from './llm';

async function main() {
  await connectDb();
  const transport = useRedisTransport();
  await transport.subscribe();

  let workers: import('bullmq').Worker[] = [];
  if (env.RUN_WORKERS_IN_API) {
    const { startWorkers } = await import('./queues/workers');
    workers = startWorkers();
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, llm: llmInfo, serper: !!env.SERPER_API_KEY, workersInProcess: !!env.RUN_WORKERS_IN_API },
      `AiroRecruit API listening on http://localhost:${env.PORT}`,
    );
    if (llmInfo.provider === 'mock') logger.warn('No LLM_API_KEY set: running with the deterministic offline mock agent.');
  });
  // SSE connections are long-lived; don't let the default timeouts cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    if (workers.length) {
      const { stopWorkers } = await import('./queues/workers');
      await stopWorkers(workers);
    }
    await closeQueues();
    await closeRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start API');
  process.exit(1);
});
