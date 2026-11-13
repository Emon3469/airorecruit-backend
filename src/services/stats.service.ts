import type { Types } from 'mongoose';
import { z } from 'zod';
import { ActivityLog, Campaign, Candidate, DispatchLog, Job, LlmUsage, Reply } from '../models';
import { NotFoundError } from '../lib/errors';
import { CANDIDATE_STATUSES, FUNNEL_STAGES, STATUS_LABELS } from '../domain/pipeline';
import { json } from '../llm';
import { SUMMARY_SYSTEM } from '../llm/prompts';

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Funnel metrics per job (MongoDB aggregation).
 *  - byStatus:   current count per status
 *  - funnel:     cumulative count of candidates that REACHED each stage (via `milestones`)
 *  - rates:      reply rate = replied / contacted, interested rate = interested / replied, ...
 */
export async function jobStats(jobId: Types.ObjectId | string) {
  const job = await Job.findById(jobId);
  if (!job) throw new NotFoundError('Job');
  const id = job._id;

  const [byStatusAgg, funnelAgg, rejectedAgg, scoreAgg, emailsAgg, replyAgg, campaigns, usageAgg, missingEmail] = await Promise.all([
    Candidate.aggregate<{ _id: string; n: number }>([{ $match: { jobId: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Candidate.aggregate<{ _id: string; n: number }>([{ $match: { jobId: id } }, { $unwind: '$milestones' }, { $group: { _id: '$milestones', n: { $sum: 1 } } }]),
    Candidate.aggregate<{ _id: string; n: number }>([{ $match: { jobId: id, status: 'Rejected' } }, { $group: { _id: '$rejectedStage', n: { $sum: 1 } } }]),
    Candidate.aggregate<{ avg: number; max: number; scored: number; failed: number }>([
      { $match: { jobId: id } },
      {
        $group: {
          _id: null,
          avg: { $avg: '$score' },
          max: { $max: '$score' },
          scored: { $sum: { $cond: [{ $eq: ['$scoringStatus', 'scored'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$scoringStatus', 'failed'] }, 1, 0] } },
        },
      },
    ]),
    DispatchLog.aggregate<{ _id: string; n: number }>([{ $match: { jobId: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Reply.aggregate<{ _id: string; n: number }>([{ $match: { jobId: id, status: 'processed' } }, { $group: { _id: '$classification', n: { $sum: 1 } } }]),
    Campaign.find({ jobId: id }, { name: 1, status: 1, recipients: 1, dailyLimit: 1, createdAt: 1 }).lean(),
    LlmUsage.aggregate<{ _id: string; cost: number; tokens: number; calls: number }>([
      { $match: { jobId: id } },
      { $group: { _id: '$purpose', cost: { $sum: '$costUsd' }, tokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } }, calls: { $sum: 1 } } },
    ]),
    Candidate.countDocuments({ jobId: id, status: 'Accepted', email: null }),
  ]);

  const byStatus = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, byStatusAgg.find((x) => x._id === s)?.n ?? 0])) as Record<string, number>;
  const reached = (s: string) => funnelAgg.find((x) => x._id === s)?.n ?? 0;
  const funnel = FUNNEL_STAGES.map((s) => ({ stage: s, label: STATUS_LABELS[s], count: reached(s) }));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const contacted = reached('Contacted');
  const replied = reached('Replied');
  const interested = reached('Interested');
  const meetings = reached('MeetingBooked');
  const hires = reached('Hired');
  const emails = Object.fromEntries(emailsAgg.map((e) => [e._id, e.n]));
  const replies = Object.fromEntries(replyAgg.map((r) => [r._id, r.n]));
  const score = scoreAgg[0];

  return {
    job: { id: String(job._id), title: job.title, company: job.company, createdAt: job.createdAt },
    totals: { candidates: total, hires, meetings, contacted, replied, interested, unsubscribed: byStatus.Unsubscribed ?? 0 },
    byStatus,
    rejected: { review: rejectedAgg.find((r) => r._id === 'review')?.n ?? 0, final: rejectedAgg.find((r) => r._id === 'final')?.n ?? 0 },
    funnel,
    rates: {
      acceptRate: pct(reached('Accepted'), total),
      replyRate: pct(replied, contacted),
      interestedRate: pct(interested, replied),
      meetingRate: pct(meetings, interested),
      hireRate: pct(hires, contacted),
    },
    scoring: { avgScore: score?.avg != null ? Math.round(score.avg) : null, maxScore: score?.max ?? null, scored: score?.scored ?? 0, failed: score?.failed ?? 0 },
    outreach: {
      campaigns: campaigns.length,
      activeCampaigns: campaigns.filter((c) => c.status !== 'completed').length,
      emailsSent: emails.sent ?? 0,
      emailsFailed: emails.failed ?? 0,
      followUpsCancelled: (emails.cancelled ?? 0) + (emails.skipped ?? 0),
      acceptedWithoutEmail: missingEmail,
    },
    replies,
    usage: {
      ...(job.usage ? { promptTokens: job.usage.promptTokens, completionTokens: job.usage.completionTokens, costUsd: Number((job.usage.costUsd ?? 0).toFixed(4)), calls: job.usage.calls } : {}),
      byPurpose: usageAgg.map((u) => ({ purpose: u._id, costUsd: Number(u.cost.toFixed(4)), tokens: u.tokens, calls: u.calls })),
    },
  };
}

export type JobStats = Awaited<ReturnType<typeof jobStats>>;

function heuristicSummary(s: JobStats): string {
  if (!s.totals.candidates) return `No candidates sourced yet for ${s.job.title}. Next step: start sourcing (web search and/or CSV upload).`;
  const lines = [
    `${s.job.title}: ${s.totals.candidates} candidates in the pipeline, ${s.funnel.find((f) => f.stage === 'Accepted')?.count ?? 0} accepted, ${s.totals.contacted} contacted.`,
    s.totals.contacted
      ? `Reply rate is ${s.rates.replyRate ?? 0}% (${s.totals.replied}/${s.totals.contacted}); ${s.totals.interested} interested, ${s.totals.meetings} meeting${s.totals.meetings === 1 ? '' : 's'} booked, ${s.totals.hires} hired.`
      : 'No outreach has been sent yet.',
  ];
  if (s.outreach.acceptedWithoutEmail) lines.push(`${s.outreach.acceptedWithoutEmail} accepted candidate(s) have no email, so they can't be contacted yet.`);
  const next = !s.totals.contacted
    ? 'Next: create an outreach campaign for accepted candidates.'
    : s.totals.meetings && !s.totals.hires
      ? 'Next: move interviewed candidates forward to shortlist or hire.'
      : s.totals.replied < s.totals.contacted
        ? 'Next: wait for replies; follow-ups are scheduled.'
        : 'Next: review replies and book meetings.';
  lines.push(next);
  return lines.join(' ');
}

export async function jobSummary(jobId: string, ctx: { conversationId?: string | Types.ObjectId | null } = {}) {
  const stats = await jobStats(jobId);
  const out = await json(
    {
      tier: 'agent',
      system: SUMMARY_SYSTEM,
      prompt: `METRICS:\n${JSON.stringify({ ...stats, usage: undefined })}`,
      schema: z.object({ summary: z.string().min(10).max(2000) }),
      schemaName: 'job_summary',
      effort: 'low',
      maxTokens: 1500,
      mock: () => ({ summary: heuristicSummary(stats) }),
    },
    { purpose: 'job_summary', jobId, conversationId: ctx.conversationId },
  );
  return { stats, summary: out.summary };
}

export async function recentActivity(jobId: string, limit = 100, candidateId?: string) {
  return ActivityLog.find({ jobId, ...(candidateId ? { candidateId } : {}) })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 500))
    .lean();
}
