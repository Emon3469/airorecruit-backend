/**
 * npm run check:connections
 * Read-only connectivity check for MongoDB and Redis. Credentials are masked everywhere,
 * including inside driver error messages.
 */
import IORedis from 'ioredis';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { llmInfo } from '../src/llm';

const mask = (s: string) => s.replace(/\/\/([^@/\s]+)@/g, '//***:***@');

async function main() {
  console.log('mongo :', mask(env.MONGO_URI));
  console.log('redis :', mask(env.REDIS_URL));
  console.log('llm   :', llmInfo.provider, llmInfo.models);
  console.log('serper:', env.SERPER_API_KEY ? 'configured' : 'not configured (CSV only)');

  let r: IORedis | null = null;
  try {
    r = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 8000, lazyConnect: true, retryStrategy: () => null });
    r.on('error', () => undefined);
    await r.connect();
    const info = await r.info('server');
    const policy = (await r.config('GET', 'maxmemory-policy').catch(() => ['', 'n/a (CONFIG not permitted)'])) as string[];
    console.log(`redis OK  : ping=${await r.ping()} version=${info.match(/redis_version:(\S+)/)?.[1]} maxmemory-policy=${policy[1]}`);
    if (policy[1] && !['noeviction', 'n/a (CONFIG not permitted)'].includes(policy[1])) {
      console.log('  warning: BullMQ needs maxmemory-policy=noeviction, otherwise queued jobs can be evicted.');
    }
  } catch (e) {
    console.log('redis FAIL:', mask((e as Error).message));
  } finally {
    r?.disconnect();
  }

  try {
    await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const ping = await mongoose.connection.db!.admin().ping();
    console.log(`mongo OK  : ping=${ping.ok} db=${mongoose.connection.db!.databaseName}`);
  } catch (e) {
    console.log('mongo FAIL:', mask((e as Error).message).slice(0, 300));
  } finally {
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0));
