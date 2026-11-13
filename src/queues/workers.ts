import { DelayedError, Worker, type Job as BullJob } from 'bullmq';
import { createRedis } from '../lib/redis';
import { logger } from '../lib/logger';
import { Candidate, Reply, SourcingRun, Campaign } from '../models';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './queues';
import { runSourcing, recordScoreProgress, finalizeRun } from '../services/sourcing.service';
import { scoreCandidate } from '../services/scoring.service';
import { processOutreachStep } from '../services/campaign.service';
import { processReply, sendReplyNow } from '../services/reply.service';
import { logActivity } from '../services/activity.service';
import { appendMessage } from '../services/chat.service';
import { publish } from '../services/events';

const isFinalAttempt = (job: BullJob | undefined) => !!job && job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts ?? 1);

export function startWorkers(): Worker[] {
  const workers: Worker[] = [];

  /* ---------------------------------------------------------------- sourcing */
  const sourcing = new Worker(
    QUEUE_NAMES.sourcing,
    async (job) => {
      await runSourcing(job.data.runId as string);
    },
    { connection: createRedis('w-sourcing'), concurrency: 2 },
  );
  sourcing.on('failed', async (job, err) => {
    logger.error({ runId: job?.data.runId, err: err.message, attempt: job?.attemptsMade }, 'sourcing failed');
    if (!isFinalAttempt(job)) return;
    const run = await SourcingRun.findByIdAndUpdate(job!.data.runId, { $set: { status: 'failed', error: err.message } }, { new: true });
    if (run?.conversationId) {
      await appendMessage(run.conversationId, {
        role: 'assistant',
        jobId: run.jobId,
        content: `Sourcing failed after 3 attempts: ${err.message}. You can try again with "start sourcing".`,
      });
    }
    await publish('sourcing.progress', { runId: String(run?._id), phase: 'failed', error: err.message }, { jobId: run?.jobId });
  });
  workers.push(sourcing);

  /* ---------------------------------------------------------------- scoring */
  const scoring = new Worker(
    QUEUE_NAMES.scoring,
    async (job) => {
      const { candidateId, runId } = job.data as { candidateId: string; runId: string };
      const outcome = await scoreCandidate(candidateId, runId);
      if (outcome !== 'skipped') await recordScoreProgress(runId, outcome === 'scored');
      return outcome;
    },
    { connection: createRedis('w-scoring'), concurrency: 5 },
  );
  scoring.on('failed', async (job, err) => {
    logger.warn({ candidateId: job?.data.candidateId, err: err.message, attempt: job?.attemptsMade }, 'scoring attempt failed');
    if (!isFinalAttempt(job)) return;
    const { candidateId, runId } = job!.data as { candidateId: string; runId: string };
    const res = await Candidate.updateOne(
      { _id: candidateId, scoredRunId: { $ne: runId } },
      { $set: { scoringStatus: 'failed', scoredRunId: runId }, $addToSet: { missingData: 'scoring_failed' } },
    );
    if (res.modifiedCount) await recordScoreProgress(runId, false);
    else await finalizeRun(runId).catch(() => undefined);
  });
  workers.push(scoring);

  /* ---------------------------------------------------------------- outreach */
  const outreach = new Worker(
    QUEUE_NAMES.outreach,
    async (job, token) => {
      if (job.name === 'send-reply') {
        const { replyId, subject, body, auto } = job.data as { replyId: string; subject: string; body: string; auto?: boolean };
        return sendReplyNow(replyId, subject, body, !!auto);
      }
      const { campaignId, candidateId, step } = job.data as { campaignId: string; candidateId: string; step: number };
      const outcome = await processOutreachStep(campaignId, candidateId, step);
      if (outcome.action === 'delay') {
        logger.info({ campaignId, candidateId, step, until: new Date(outcome.until).toISOString(), reason: outcome.reason }, 'outreach delayed');
        await job.moveToDelayed(outcome.until, token);
        throw new DelayedError();
      }
      return outcome;
    },
    {
      connection: createRedis('w-outreach'),
      concurrency: 3,
      // Throughput guard for the SMTP provider. The *daily* quota is enforced in Mongo (SendQuota).
      limiter: { max: 10, duration: 1000 },
    },
  );
  outreach.on('failed', async (job, err) => {
    if (err instanceof DelayedError || err?.name === 'DelayedError') return;
    logger.error({ data: job?.data, err: err.message, attempt: job?.attemptsMade }, 'outreach attempt failed');
    if (!isFinalAttempt(job)) return;
    if (job!.name === 'send-reply') {
      await Reply.updateOne({ _id: job!.data.replyId }, { $set: { draftStatus: 'pending', error: err.message } });
      return;
    }
    const { campaignId, candidateId, step } = job!.data as { campaignId: string; candidateId: string; step: number };
    const camp = await Campaign.findOneAndUpdate(
      { _id: campaignId, 'recipients.candidateId': candidateId },
      { $set: { 'recipients.$.state': 'stopped', 'recipients.$.stoppedReason': `send failed: ${err.message}`, 'recipients.$.nextRunAt': null } },
    );
    if (camp) {
      await logActivity({ jobId: camp.jobId, candidateId, actor: 'worker', action: 'email_failed', message: `Step ${step + 1} failed after retries: ${err.message}` });
      await publish('campaign.progress', { campaignId }, { jobId: camp.jobId });
    }
  });
  workers.push(outreach);

  /* ---------------------------------------------------------------- replies */
  const replies = new Worker(
    QUEUE_NAMES.replies,
    async (job) => {
      await processReply(job.data.replyId as string);
    },
    { connection: createRedis('w-replies'), concurrency: 3 },
  );
  replies.on('failed', async (job, err) => {
    logger.error({ replyId: job?.data.replyId, err: err.message }, 'reply processing failed');
    if (!isFinalAttempt(job)) return;
    const reply = await Reply.findByIdAndUpdate(job!.data.replyId, { $set: { status: 'failed', error: err.message } }, { new: true });
    if (reply) {
      await logActivity({ jobId: reply.jobId, candidateId: reply.candidateId, actor: 'worker', action: 'reply_processing_failed', message: err.message });
      await publish('reply.processed', { replyId: String(reply._id), failed: true }, { jobId: reply.jobId });
    }
  });
  workers.push(replies);

  for (const w of workers) {
    w.on('error', (err) => logger.error({ queue: w.name, err: err.message }, 'worker error'));
  }
  logger.info({ queues: workers.map((w) => w.name) }, 'workers started');
  return workers;
}

export async function stopWorkers(workers: Worker[]) {
  await Promise.allSettled(workers.map((w) => w.close()));
}
