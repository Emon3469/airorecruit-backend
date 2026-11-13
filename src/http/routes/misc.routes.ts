import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { Reply, isValidId } from '../../models';
import { NotFoundError } from '../../lib/errors';
import { redis } from '../../lib/redis';
import { ah, idParam, parse } from '../middleware';
import { receiveReply } from '../../services/reply.service';
import { chooseSlot, getBookingView } from '../../services/booking.service';
import { onEvent, replaySince, type AppEvent } from '../../services/events';
import { llmInfo } from '../../llm';
import { queueHealth } from '../../queues/queues';

export const miscRouter = Router();

/* --------------------------------------------------------------- simulate-reply */
const SimulateReplySchema = z
  .object({
    candidateId: z.string().refine(isValidId, 'invalid candidateId').optional(),
    email: z.string().email().optional(),
    jobId: z.string().refine(isValidId, 'invalid jobId').optional(),
    subject: z.string().max(300).optional(),
    body: z.string().trim().min(1).max(20_000),
  })
  .refine((v) => v.candidateId || v.email, { message: 'Provide candidateId or email' });

/**
 * Stand-in for a real inbox webhook. Follow-ups are cancelled synchronously before this
 * returns; classification and drafting run in the `replies` queue (watch SSE / the chat).
 */
export async function simulateReplyHandler(req: Request, res: Response) {
  const body = parse(SimulateReplySchema, req.body);
  const { reply, candidate, stoppedFollowUps } = await receiveReply(body);
  res.status(202).json({
    replyId: String(reply._id),
    candidate: { id: String(candidate._id), name: candidate.name },
    stoppedFollowUps,
    injectionFlag: reply.injectionFlag,
    status: 'processing',
    poll: `/api/replies/${String(reply._id)}`,
  });
}
miscRouter.post('/simulate-reply', ah(simulateReplyHandler));

miscRouter.get(
  '/replies/:id',
  ah(async (req, res) => {
    const reply = await Reply.findById(idParam(req)).populate('candidateId', 'name email status').lean();
    if (!reply) throw new NotFoundError('Reply');
    res.json({ reply });
  }),
);

/* --------------------------------------------------------------- booking (JSON API for the frontend page) */
miscRouter.get('/booking/:token', ah(async (req, res) => res.json(await getBookingView(String(req.params.token)))));
miscRouter.post(
  '/booking/:token',
  ah(async (req, res) => {
    const { slot } = parse(z.object({ slot: z.string() }), req.body);
    res.json(await chooseSlot(String(req.params.token), slot));
  }),
);

/* --------------------------------------------------------------- SSE */
/**
 * GET /api/events?conversationId=...&jobId=...
 * Server-Sent Events. Supports `Last-Event-ID` replay. Events are hints; the client refetches.
 */
miscRouter.get(
  '/events',
  ah(async (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : null;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const relevant = (e: AppEvent) =>
      (!conversationId && !jobId) ||
      (conversationId && e.conversationId === conversationId) ||
      (jobId && e.jobId === jobId) ||
      // job-scoped events are relevant to whichever conversation is watching that job
      (conversationId && !e.conversationId && !!e.jobId && (!jobId || e.jobId === jobId));
    const send = (e: AppEvent) => {
      if (!relevant(e)) return;
      res.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    const lastId = Number(req.header('Last-Event-ID') ?? req.query.lastEventId ?? 0);
    if (lastId > 0) for (const e of await replaySince(lastId)) send(e);

    const off = onEvent(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  }),
);

/* --------------------------------------------------------------- meta + health */
miscRouter.get('/meta', (_req, res) => {
  res.json({
    app: 'AiroRecruit',
    llm: llmInfo,
    webSearch: !!env.SERPER_API_KEY,
    talentPool: { enabled: env.EMBEDDINGS !== 'off', store: env.qdrantUrl ? 'qdrant' : 'mongo' },
    outreach: { dayMs: env.OUTREACH_DAY_MS, defaultDailyLimit: env.DAILY_SEND_LIMIT },
    email: env.SMTP_HOST ? 'smtp' : 'ethereal',
  });
});

miscRouter.get(
  '/health',
  ah(async (_req, res) => {
    const mongo = mongoose.connection.readyState === 1 ? 'up' : 'down';
    const redisUp = await redis()
      .ping()
      .then(() => 'up')
      .catch(() => 'down');
    const ok = mongo === 'up' && redisUp === 'up';
    res.status(ok ? 200 : 503).json({ ok, mongo, redis: redisUp, queues: ok ? await queueHealth() : undefined, llm: llmInfo.provider });
  }),
);
