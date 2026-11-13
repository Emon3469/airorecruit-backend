import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env';
import { Booking, Campaign, Candidate, CsvUpload, DispatchLog, Job, LlmUsage, PendingAction, Reply, SourcingRun, isValidId, oid } from '../../models';
import { importRows } from '../../services/sourcing.service';
import { enqueue, jobIds, QUEUE_NAMES } from '../../queues/queues';
import { ValidationError } from '../../lib/errors';
import { CANDIDATE_STATUSES, allowedNext, parseStatus, type CandidateStatus } from '../../domain/pipeline';
import { ah, idParam, parse } from '../middleware';
import { getJob } from '../../services/job.service';
import { jobStats, jobSummary, recentActivity } from '../../services/stats.service';
import { storeCsvUpload } from '../../services/sourcing.service';
import { createProposal } from '../../services/proposals';
import { updateActionPayload } from '../../services/actions.service';
import { applyDecisions, transition, updateCandidateEmail } from '../../services/pipeline.service';
import { campaignView, setCampaignPaused } from '../../services/campaign.service';
import { logActivity } from '../../services/activity.service';
import { reindexAll, searchTalentPool } from '../../services/talent.service';
import { vectorStore } from '../../vector/store';
import { publish } from '../../services/events';

export const jobsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || ['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new ValidationError('Please upload a .csv file'));
  },
});

/* --------------------------------------------------------------- jobs */
jobsRouter.get(
  '/jobs',
  ah(async (_req, res) => {
    const jobs = await Job.find({}, { rawJD: 0 }).sort({ createdAt: -1 }).limit(100).lean();
    const counts = await Candidate.aggregate<{ _id: unknown; n: number; hired: number }>([
      { $group: { _id: '$jobId', n: { $sum: 1 }, hired: { $sum: { $cond: [{ $eq: ['$status', 'Hired'] }, 1, 0] } } } },
    ]);
    res.json({
      jobs: jobs.map((j) => {
        const c = counts.find((x) => String(x._id) === String(j._id));
        return { ...j, candidateCount: c?.n ?? 0, hiredCount: c?.hired ?? 0 };
      }),
    });
  }),
);

jobsRouter.get('/jobs/:id', ah(async (req, res) => res.json({ job: await getJob(idParam(req)) })));
jobsRouter.get('/jobs/:id/stats', ah(async (req, res) => res.json(await jobStats(idParam(req)))));
jobsRouter.get('/jobs/:id/summary', ah(async (req, res) => res.json(await jobSummary(idParam(req)))));

jobsRouter.get(
  '/jobs/:id/activity',
  ah(async (req, res) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), candidateId: z.string().optional() }), req.query);
    if (q.candidateId && !isValidId(q.candidateId)) throw new ValidationError('Invalid candidateId');
    res.json({ activity: await recentActivity(idParam(req), q.limit ?? 100, q.candidateId) });
  }),
);

jobsRouter.get(
  '/jobs/:id/candidates',
  ah(async (req, res) => {
    const id = idParam(req);
    const q = parse(
      z.object({
        status: z.string().optional(),
        minScore: z.coerce.number().min(0).max(100).optional(),
        search: z.string().max(100).optional(),
        sort: z.enum(['score', 'name', 'updated', 'created']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
      }),
      req.query,
    );
    const filter: Record<string, unknown> = { jobId: id };
    if (q.status) {
      const statuses = q.status.split(',').map((s) => parseStatus(s)).filter(Boolean) as CandidateStatus[];
      if (statuses.length) filter.status = { $in: statuses };
    }
    if (q.minScore !== undefined) filter.score = { $gte: q.minScore };
    if (q.search) filter.name = { $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const sort: Record<string, 1 | -1> =
      q.sort === 'name' ? { name: 1 } : q.sort === 'updated' ? { updatedAt: -1 } : q.sort === 'created' ? { createdAt: 1 } : { score: -1, createdAt: 1 };
    const candidates = await Candidate.find(filter, { snippet: 0 }).sort(sort).limit(q.limit ?? 500).lean();
    // Outreach progress per candidate (latest campaign): powers the Step / Next step columns.
    const camps = await Campaign.find({ jobId: id }, { steps: 1, recipients: 1, status: 1, name: 1 }).sort({ createdAt: -1 }).lean();
    const sent = await DispatchLog.aggregate<{ _id: { c: unknown; k: unknown }; n: number }>([
      { $match: { jobId: oid(id), status: 'sent' } },
      { $group: { _id: { c: '$campaignId', k: '$candidateId' }, n: { $sum: 1 } } },
    ]);
    const outreachOf = (cid: string) => {
      for (const camp of camps) {
        const r = camp.recipients.find((x) => String(x.candidateId) === cid);
        if (!r) continue;
        const done = sent.find((s) => String(s._id.c) === String(camp._id) && String(s._id.k) === cid)?.n ?? 0;
        const total = camp.steps.length;
        const nextIdx = Math.min(done, total - 1);
        return {
          campaignId: String(camp._id),
          campaignStatus: camp.status,
          state: r.state,
          sentSteps: done,
          totalSteps: total,
          currentLabel: camp.steps[Math.max(0, done - 1)]?.label ?? camp.steps[0]?.label ?? 'Intro',
          nextLabel: r.state === 'active' ? camp.steps[nextIdx]?.label ?? null : null,
          nextRunAt: r.state === 'active' ? r.nextRunAt : null,
          stoppedReason: r.stoppedReason ?? null,
        };
      }
      return null;
    };
    res.json({
      candidates: candidates.map((c) => ({
        ...c,
        allowedNext: allowedNext(c.status as CandidateStatus, c.rejectedStage as 'review' | 'final' | null),
        outreach: outreachOf(String(c._id)),
      })),
      statuses: CANDIDATE_STATUSES,
    });
  }),
);

/**
 * CSV upload. Parsing/validation happens now; the import itself is a START_SOURCING proposal
 * (it attaches to the pending sourcing card if there is one, otherwise a new card is posted).
 */
jobsRouter.post(
  '/jobs/:id/candidates/upload',
  upload.single('file'),
  ah(async (req, res) => {
    const jobId = idParam(req);
    if (!req.file) throw new ValidationError('Attach a CSV file in the "file" field');
    const conversationId = typeof req.body?.conversationId === 'string' && isValidId(req.body.conversationId) ? req.body.conversationId : null;
    const { upload: up, parsed } = await storeCsvUpload(jobId, req.file.originalname, req.file.buffer.toString('utf8'));
    const job = await getJob(jobId);
    const convId = conversationId ?? (job.conversationId ? String(job.conversationId) : null);

    let pendingActionId: string | null = null;
    if (convId) {
      const pending = await PendingAction.findOne({ conversationId: convId, jobId, type: 'START_SOURCING', status: 'pending' }).sort({ createdAt: -1 });
      if (pending) {
        const ids = [...new Set([...((pending.payload as { csvUploadIds?: string[] }).csvUploadIds ?? []), String(up._id)])];
        await updateActionPayload(String(pending._id), { csvUploadIds: ids });
        pendingActionId = String(pending._id);
      } else {
        const { action } = await createProposal({
          conversationId: convId,
          jobId,
          type: 'START_SOURCING',
          proposedBy: 'user_ui',
          payload: { jobId, useWebSearch: false, query: null, maxResults: env.SERPER_MAX_RESULTS, csvUploadIds: [String(up._id)] },
          display: { jobTitle: job.title, webSearchAvailable: !!env.SERPER_API_KEY },
          message: `I received ${req.file.originalname}: ${parsed.rows.length} valid row(s)${parsed.invalid.length ? `, ${parsed.invalid.length} invalid (${parsed.invalid.slice(0, 3).map((r) => `line ${r.line}: ${r.reason}`).join('; ')})` : ''}. Confirm to import, deduplicate and score them.`,
        });
        pendingActionId = String(action._id);
      }
    }
    await logActivity({ jobId, actor: 'user_ui', action: 'csv_uploaded', message: `${req.file.originalname}: ${parsed.rows.length} valid, ${parsed.invalid.length} invalid rows` });
    res.status(201).json({
      uploadId: String(up._id),
      filename: up.filename,
      validRows: parsed.rows.length,
      invalidRows: parsed.invalid,
      headers: parsed.headers,
      preview: parsed.rows.slice(0, 5).map((r) => ({ name: r.name, email: r.email, headline: r.headline })),
      pendingActionId,
    });
  }),
);

jobsRouter.get('/jobs/:id/uploads', ah(async (req, res) => res.json({ uploads: await CsvUpload.find({ jobId: idParam(req) }, { rows: 0 }).sort({ createdAt: -1 }).lean() })));

jobsRouter.get(
  '/jobs/:id/campaigns',
  ah(async (req, res) => {
    const camps = await Campaign.find({ jobId: idParam(req) }, { _id: 1 }).sort({ createdAt: -1 }).lean();
    res.json({ campaigns: await Promise.all(camps.map((c) => campaignView(String(c._id)))) });
  }),
);

jobsRouter.get(
  '/jobs/:id/replies',
  ah(async (req, res) => {
    const replies = await Reply.find({ jobId: idParam(req) }).sort({ createdAt: -1 }).limit(100).populate('candidateId', 'name email status').lean();
    res.json({ replies });
  }),
);

jobsRouter.get(
  '/jobs/:id/usage',
  ah(async (req, res) => {
    const id = idParam(req);
    const job = await getJob(id);
    const recent = await LlmUsage.find({ jobId: id }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ usage: job.usage, recent });
  }),
);

jobsRouter.get('/jobs/:id/sourcing-runs', ah(async (req, res) => res.json({ runs: await SourcingRun.find({ jobId: idParam(req) }).sort({ createdAt: -1 }).limit(20).lean() })));
jobsRouter.get('/sourcing-runs/:id', ah(async (req, res) => res.json({ run: await SourcingRun.findById(idParam(req)).lean() })));

/** UI toggle = explicit recruiter action (no proposal needed). */
jobsRouter.patch(
  '/jobs/:id/settings',
  ah(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ autoReply: z.enum(['off', 'meetings_only']) }), req.body);
    const job = await Job.findByIdAndUpdate(id, { $set: { 'settings.autoReply': body.autoReply } }, { new: true });
    await logActivity({ jobId: id, actor: 'user_ui', action: 'settings_updated', to: `autoReply=${body.autoReply}` });
    await publish('job.updated', { jobId: id }, { jobId: id });
    res.json({ job });
  }),
);

/** "+ Add Candidate" (explicit UI action): dedupe like any import, then score in the background. */
jobsRouter.post(
  '/jobs/:id/candidates',
  ah(async (req, res) => {
    const jobId = idParam(req);
    const job = await getJob(jobId);
    const b = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().max(200).nullable().optional(),
        profileUrl: z.string().trim().max(300).nullable().optional(),
        headline: z.string().trim().max(200).nullable().optional(),
        location: z.string().trim().max(120).nullable().optional(),
        company: z.string().trim().max(120).nullable().optional(),
        skills: z.array(z.string().trim().max(60)).max(40).optional(),
        yearsExperience: z.number().min(0).max(60).nullable().optional(),
      }),
      req.body,
    );
    if (!b.email && !b.profileUrl) throw new ValidationError('Add an email or a profile URL so duplicates can be detected.');
    const stats = await importRows(job._id, [
      {
        name: b.name,
        email: b.email ?? null,
        profileUrl: b.profileUrl ?? null,
        headline: b.headline ?? null,
        location: b.location ?? null,
        skills: b.skills ?? [],
        yearsExperience: b.yearsExperience ?? null,
        company: b.company ?? null,
        snippet: null,
        source: 'manual',
      },
    ]);
    const created = stats.createdIds[0];
    if (created) {
      await enqueue(QUEUE_NAMES.scoring, 'score', { candidateId: String(created), runId: null }, { jobId: jobIds.scoring(String(created), 'manual') });
      await logActivity({ jobId, candidateId: created, candidateName: b.name, actor: 'user_ui', action: 'candidate_added', message: 'Added manually' });
      await publish('state_sync', { reason: 'candidate_added', candidateIds: [String(created)] }, { jobId });
    }
    res.status(created ? 201 : 200).json({ created: !!created, duplicate: !created, candidateId: created ? String(created) : null });
  }),
);

/** Interview page: booked meetings and outstanding booking links. */
jobsRouter.get(
  '/jobs/:id/meetings',
  ah(async (req, res) => {
    const jobId = idParam(req);
    const bookings = await Booking.find({ jobId }).sort({ chosenSlot: 1, createdAt: -1 }).lean();
    const cands = await Candidate.find({ _id: { $in: bookings.map((b) => b.candidateId) } }, { name: 1, headline: 1, status: 1, email: 1, currentCompany: 1 }).lean();
    res.json({
      meetings: bookings.map((b) => ({
        token: b.token,
        candidate: cands.find((c) => String(c._id) === String(b.candidateId)) ?? null,
        slots: b.slots,
        chosenSlot: b.chosenSlot,
        bookedAt: b.bookedAt,
        createdAt: b.createdAt,
      })),
    });
  }),
);

/* --------------------------------------------------------------- talent rediscovery (read-only) */
jobsRouter.get(
  '/jobs/:id/talent-pool',
  ah(async (req, res) => {
    const q = parse(z.object({ q: z.string().max(300).optional(), like: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }), req.query);
    if (q.like && !isValidId(q.like)) throw new ValidationError('Invalid like');
    res.json({ matches: await searchTalentPool({ jobId: idParam(req), query: q.q, likeCandidateId: q.like, limit: q.limit }) });
  }),
);
jobsRouter.get('/talent/status', ah(async (_req, res) => res.json({ store: vectorStore().kind, vectors: await vectorStore().count(), embeddings: env.EMBEDDINGS })));
jobsRouter.post('/talent/reindex', ah(async (_req, res) => res.json(await reindexAll())));

/* --------------------------------------------------------------- candidates (UI buttons = explicit approval) */
jobsRouter.get(
  '/candidates/:id',
  ah(async (req, res) => {
    const id = idParam(req);
    const cand = await Candidate.findById(id).lean();
    if (!cand) throw new ValidationError('Candidate not found');
    const [replies, dispatches, activity] = await Promise.all([
      Reply.find({ candidateId: id }).sort({ createdAt: -1 }).lean(),
      DispatchLog.find({ candidateId: id }).sort({ createdAt: 1 }).lean(),
      recentActivity(String(cand.jobId), 100, id),
    ]);
    res.json({ candidate: { ...cand, allowedNext: allowedNext(cand.status as CandidateStatus, cand.rejectedStage as 'review' | 'final' | null) }, replies, dispatches, activity });
  }),
);

jobsRouter.patch(
  '/candidates/:id',
  ah(async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().max(200).nullable() }), req.body);
    res.json({ candidate: await updateCandidateEmail(idParam(req), body.email, 'user_ui') });
  }),
);

jobsRouter.post(
  '/candidates/:id/status',
  ah(async (req, res) => {
    const body = parse(z.object({ to: z.string(), note: z.string().max(300).optional() }), req.body);
    const to = parseStatus(body.to);
    if (!to) throw new ValidationError(`Unknown status "${body.to}"`);
    res.json({ result: await transition(idParam(req), to, { actor: 'user_ui', reason: body.note }) });
  }),
);

jobsRouter.post(
  '/candidates/decisions',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        jobId: z.string().refine(isValidId, 'invalid jobId'),
        decisions: z.array(z.object({ candidateId: z.string().refine(isValidId, 'invalid id'), decision: z.enum(['accept', 'reject']) })).min(1).max(500),
      }),
      req.body,
    );
    res.json(await applyDecisions(body.jobId, body.decisions, 'user_ui'));
  }),
);

/* --------------------------------------------------------------- campaigns */
jobsRouter.get('/campaigns/:id', ah(async (req, res) => res.json({ campaign: await campaignView(idParam(req)) })));
jobsRouter.post('/campaigns/:id/pause', ah(async (req, res) => res.json({ campaign: await setCampaignPaused(idParam(req), true, 'user_ui') })));
jobsRouter.post('/campaigns/:id/resume', ah(async (req, res) => res.json({ campaign: await setCampaignPaused(idParam(req), false, 'user_ui') })));
