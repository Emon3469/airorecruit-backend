import { Queue, type JobsOptions } from 'bullmq';
import { createRedis } from '../lib/redis';
import { logger } from '../lib/logger';

/**
 * Queue topology
 *  - sourcing : one job per SourcingRun (Serper search + CSV import + dedupe), then fans out scoring
 *  - scoring  : one job per candidate (LLM 0-100 score), progress counted on the SourcingRun
 *  - outreach : one job per (campaign, candidate, step). Step N+1 is enqueued only after step N is sent,
 *               so each candidate has at most ONE pending job, which makes cancellation trivial.
 *               Also carries `send-reply` jobs for approved reply drafts.
 *  - replies  : one job per inbound reply (classify + draft), after synchronous follow-up preemption
 */
export const QUEUE_NAMES = {
  sourcing: 'sourcing',
  scoring: 'scoring',
  outreach: 'outreach',
  replies: 'replies',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** BullMQ custom job ids must not contain ':' — use dashes. Deterministic ids give us dedupe + targeted removal. */
export const jobIds = {
  sourcing: (runId: string) => `src-${runId}`,
  scoring: (candidateId: string, runId: string) => `score-${runId}-${candidateId}`,
  outreach: (campaignId: string, candidateId: string, step: number) => `out-${campaignId}-${candidateId}-${step}`,
  sendReply: (replyId: string) => `reply-send-${replyId}`,
  reply: (replyId: string) => `reply-${replyId}`,
};

export interface QueueAdapter {
  add(queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions): Promise<void>;
  remove(queue: QueueName, jobId: string): Promise<boolean>;
  promote(queue: QueueName, jobId: string): Promise<boolean>;
}

const queues = new Map<QueueName, Queue>();

function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: createRedis(`queue-${name}`), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, q);
  }
  return q;
}

const bullAdapter: QueueAdapter = {
  async add(queue, name, data, opts) {
    await getQueue(queue).add(name, data, opts);
  },
  async remove(queue, jobId) {
    const job = await getQueue(queue).getJob(jobId);
    if (!job) return false;
    try {
      // remove() fails for an active (locked) job; the worker's state re-check covers that case.
      await job.remove();
      return true;
    } catch (err) {
      logger.debug({ jobId, err: (err as Error).message }, 'could not remove job (probably active)');
      return false;
    }
  },
  async promote(queue, jobId) {
    const job = await getQueue(queue).getJob(jobId);
    if (!job || !(await job.isDelayed())) return false;
    await job.promote();
    return true;
  },
};

let adapter: QueueAdapter = bullAdapter;

/** Tests swap in an in-memory adapter so services can be exercised without Redis. */
export function setQueueAdapter(a: QueueAdapter): void {
  adapter = a;
}

export const enqueue = (queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions) =>
  adapter.add(queue, name, data, opts);
export const removeJob = (queue: QueueName, jobId: string) => adapter.remove(queue, jobId);
export const promoteJob = (queue: QueueName, jobId: string) => adapter.promote(queue, jobId);

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export async function queueHealth(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      out[name] = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    } catch (err) {
      out[name] = { error: (err as Error).message };
    }
  }
  return out;
}
