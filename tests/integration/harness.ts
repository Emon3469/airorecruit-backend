import { MongoMemoryServer } from 'mongodb-memory-server';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import type { JobsOptions } from 'bullmq';
import { connectDb } from '../../src/lib/db';
import { setQueueAdapter, type QueueName } from '../../src/queues/queues';
import { setMockChatHandler } from '../../src/llm';
import { mockChat } from '../../src/agent/mockRouter';
import { setTransportForTests } from '../../src/services/mailer';
import { runSourcing, recordScoreProgress } from '../../src/services/sourcing.service';
import { scoreCandidate } from '../../src/services/scoring.service';
import { processOutreachStep, type StepOutcome } from '../../src/services/campaign.service';
import { processReply, sendReplyNow } from '../../src/services/reply.service';
import { setEmbedder } from '../../src/vector/embeddings';
import { mongoVectorStore, setVectorStore } from '../../src/vector/store';

/** Deterministic bag-of-words embedder (384 dims) so tests never download a model or call Qdrant. */
export function hashEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Array(384).fill(0) as number[];
      for (const w of t.toLowerCase().match(/[a-z0-9.+#]+/g) ?? []) {
        let h = 2166136261;
        for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
        v[Math.abs(h) % 384]! += 1;
      }
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / n);
    }),
  );
}

export interface QueuedJob {
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  opts?: JobsOptions;
}

/** In-memory stand-in for BullMQ that keeps the same semantics we rely on (deterministic ids dedupe, remove by id). */
export class MemoryQueue {
  jobs = new Map<string, QueuedJob>();
  removed: string[] = [];
  private seq = 0;
  adapter = {
    add: async (queue: QueueName, name: string, data: Record<string, unknown>, opts?: JobsOptions) => {
      const id = opts?.jobId ?? `auto-${++this.seq}`;
      if (!this.jobs.has(id)) this.jobs.set(id, { queue, name, data, opts });
    },
    remove: async (_q: QueueName, id: string) => {
      const had = this.jobs.delete(id);
      if (had) this.removed.push(id);
      return had;
    },
    promote: async () => true,
  };
  pending(queue: QueueName) {
    return [...this.jobs.entries()].filter(([, j]) => j.queue === queue);
  }
  /** Run jobs of a queue the way the workers would. Delayed outreach jobs run only when includeDelayed. */
  async drain(queue: QueueName, { includeDelayed = false, now }: { includeDelayed?: boolean; now?: number } = {}) {
    const outcomes: { id: string; outcome: unknown }[] = [];
    for (let guard = 0; guard < 500; guard++) {
      const next = this.pending(queue).find(([, j]) => includeDelayed || !j.opts?.delay);
      if (!next) break;
      const [id, job] = next;
      this.jobs.delete(id);
      outcomes.push({ id, outcome: await runJob(job, now) });
      includeDelayed = false; // only one "time jump" per call
    }
    return outcomes;
  }
}

async function runJob(job: QueuedJob, now?: number): Promise<unknown> {
  const d = job.data as Record<string, string & number & boolean>;
  switch (job.queue) {
    case 'sourcing':
      return runSourcing(d.runId);
    case 'scoring': {
      const o = await scoreCandidate(d.candidateId, d.runId);
      if (o !== 'skipped') await recordScoreProgress(d.runId, o === 'scored');
      return o;
    }
    case 'outreach':
      if (job.name === 'send-reply') return sendReplyNow(d.replyId, d.subject, d.body, !!d.auto);
      return processOutreachStep(d.campaignId, d.candidateId, d.step, now) as Promise<StepOutcome>;
    case 'replies':
      return processReply(d.replyId);
  }
}

export async function startHarness() {
  const mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  const queue = new MemoryQueue();
  setQueueAdapter(queue.adapter);
  setMockChatHandler(mockChat);
  if (!process.env.EVAL_REAL_EMBEDDINGS) {
    setEmbedder(hashEmbedder);
    setVectorStore(mongoVectorStore());
  }
  setTransportForTests(nodemailer.createTransport({ jsonTransport: true }), 'log');
  return {
    queue,
    async stop() {
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}
