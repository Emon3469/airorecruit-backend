import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { createRedis, redis } from '../lib/redis';
import { logger } from '../lib/logger';

/**
 * Event bus. SSE is a *hint*, never the source of truth: every event says
 * "something changed" (plus a small payload for live counters); the client
 * refetches from REST, so a dropped event or a page refresh loses nothing.
 *
 * Workers and the API publish through Redis Pub/Sub, so workers can run in a
 * separate process/container. Each event gets a monotonic id (Redis INCR), and
 * the last N events are kept in a capped list so a reconnecting client can
 * replay from `Last-Event-ID`.
 */
export type EventName =
  | 'message.created'
  | 'action.updated'
  | 'job.updated'
  | 'sourcing.progress'
  | 'sourcing.done'
  | 'campaign.progress'
  | 'reply.received'
  | 'reply.processed'
  | 'state_sync'
  | 'usage.updated'
  | 'activity.created'
  | 'guardrail.triggered'
  | 'agent.status';

export interface AppEvent {
  id: number;
  name: EventName;
  conversationId?: string | null;
  jobId?: string | null;
  data: Record<string, unknown>;
  at: string;
}

const CHANNEL = 'airo:events';
const SEQ_KEY = 'airo:events:seq';
const LOG_KEY = 'airo:events:log';
const LOG_SIZE = 500;

interface Transport {
  publish(e: Omit<AppEvent, 'id'>): Promise<void>;
  replaySince(lastId: number): Promise<AppEvent[]>;
}

const local = new EventEmitter();
local.setMaxListeners(1000);

/** In-process transport (tests, or single-process dev without Redis pub/sub). */
class MemoryTransport implements Transport {
  private seq = 0;
  private log: AppEvent[] = [];
  async publish(e: Omit<AppEvent, 'id'>) {
    const event = { ...e, id: ++this.seq };
    this.log.push(event);
    if (this.log.length > LOG_SIZE) this.log.shift();
    local.emit('event', event);
  }
  async replaySince(lastId: number) {
    return this.log.filter((e) => e.id > lastId);
  }
}

class RedisTransport implements Transport {
  private sub: Redis | null = null;
  async publish(e: Omit<AppEvent, 'id'>) {
    const r = redis();
    const id = await r.incr(SEQ_KEY);
    const event: AppEvent = { ...e, id };
    const json = JSON.stringify(event);
    await r.multi().lpush(LOG_KEY, json).ltrim(LOG_KEY, 0, LOG_SIZE - 1).publish(CHANNEL, json).exec();
  }
  async replaySince(lastId: number) {
    const raw = await redis().lrange(LOG_KEY, 0, LOG_SIZE - 1);
    return raw
      .map((s) => JSON.parse(s) as AppEvent)
      .filter((e) => e.id > lastId)
      .sort((a, b) => a.id - b.id);
  }
  /** One shared subscriber per process, fanned out in memory to SSE clients. */
  async subscribe() {
    if (this.sub) return;
    this.sub = createRedis('events-sub');
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_ch, msg) => {
      try {
        local.emit('event', JSON.parse(msg) as AppEvent);
      } catch (err) {
        logger.warn({ err }, 'bad event payload');
      }
    });
  }
}

let transport: Transport = new MemoryTransport();

export function useRedisTransport(): RedisTransport {
  const t = new RedisTransport();
  transport = t;
  return t;
}

export async function publish(
  name: EventName,
  data: Record<string, unknown>,
  scope: { conversationId?: unknown; jobId?: unknown } = {},
): Promise<void> {
  try {
    await transport.publish({
      name,
      data,
      conversationId: scope.conversationId ? String(scope.conversationId) : null,
      jobId: scope.jobId ? String(scope.jobId) : null,
      at: new Date().toISOString(),
    });
  } catch (err) {
    // Events are hints; never fail a business operation because a hint could not be sent.
    logger.warn({ err: (err as Error).message, name }, 'event publish failed');
  }
}

export function onEvent(listener: (e: AppEvent) => void): () => void {
  local.on('event', listener);
  return () => local.off('event', listener);
}

export function replaySince(lastId: number): Promise<AppEvent[]> {
  return transport.replaySince(lastId);
}
