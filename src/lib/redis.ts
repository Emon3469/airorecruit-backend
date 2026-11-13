import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers.
 * We hand out separate connections for commands, pub/sub subscribing and BullMQ.
 */
const connections: Redis[] = [];

export function createRedis(name: string): Redis {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
  conn.on('error', (err) => logger.warn({ err: err.message, conn: name }, 'redis error'));
  connections.push(conn);
  return conn;
}

let shared: Redis | null = null;
export function redis(): Redis {
  if (!shared) shared = createRedis('shared');
  return shared;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.quit()));
  connections.length = 0;
  shared = null;
}
