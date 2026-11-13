import { logger } from './lib/logger';
import { connectDb, disconnectDb } from './lib/db';
import { closeRedis } from './lib/redis';
import { useRedisTransport } from './services/events';
import { closeQueues } from './queues/queues';
import { startWorkers, stopWorkers } from './queues/workers';
import { llmInfo } from './llm';

/** Standalone worker process (docker compose service `worker`). Scale horizontally with replicas. */
async function main() {
  await connectDb();
  useRedisTransport(); // publish-only; the API process fans events out to SSE clients
  const workers = startWorkers();
  logger.info({ llm: llmInfo }, 'AiroRecruit worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down (finishing active jobs)');
    await stopWorkers(workers);
    await closeQueues();
    await closeRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start worker');
  process.exit(1);
});
