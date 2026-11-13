import { z } from 'zod';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Campaign, Candidate, ChatMessage, CsvUpload, Job, PendingAction, Reply, type ConversationDoc, type JobDoc } from '../models';
import { AppError, ValidationError } from '../lib/errors';
import type { Card } from '../domain/cards';
import { STATUS_LABELS, canTransition, parseStatus, type CandidateStatus } from '../domain/pipeline';
import { extractUrls } from '../domain/untrusted';
import { toToolJsonSchema } from '../llm/schema';
import type { ToolDefinition } from '../llm/types';
import { extractJobDraft, fetchJobDescription, jobBrief, resolveJob } from '../services/job.service';
import { buildSearchQuery } from '../services/sourcing.service';
import { buildCampaignProposal } from '../services/campaign.service';
import { jobStats, jobSummary, recentActivity } from '../services/stats.service';
import { createProposal } from '../services/proposals';
import { setActiveJob } from '../services/chat.service';
import { SelectorSchema, describeUnresolved, resolveCandidates } from './resolve';
import { isMockLlm } from '../llm';
import { recordFindings, sanitizeToolResult } from '../guardrails/engine';
import { scanFairness } from '../guardrails/fairness';
import { checkOutboundEmail } from '../guardrails/outbound';
import { normalizeEmail } from '../domain/normalize';
import { searchTalentPool, talentEnabled } from '../services/talent.service';

export interface ToolContext {
  conversation: ConversationDoc;
  conversationId: Types.ObjectId;
  userMessage: string;
}

export interface ToolOutput {
  /** Sent back to the model as the tool result (JSON). */
  result: Record<string, unknown>;
  cards?: Card[];
  actionIds?: string[];
  jobId?: string;
}

interface AgentTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

function tool<S extends z.ZodTypeAny>(t: AgentTool<S>): AgentTool<S> {
  return t;
}

const jobRef = z.string().max(200).optional().describe('Job id or title words ("React"). Omit to use the active job.');

async function requireJob(ref: string | undefined, ctx: ToolContext): Promise<JobDoc> {
  const job = await resolveJob(ref, ctx.conversation.activeJobId);
  if (!job) {
    throw new AppError(
      404,
      'NO_JOB',
      ref ? `No job matches "${ref}". Use list_jobs to see jobs.` : 'There is no active job yet. Ask the recruiter for a job description first.',
    );
  }
  if (!ctx.conversation.activeJobId || String(ctx.conversation.activeJobId) !== String(job._id)) {
    await setActiveJob(ctx.conversationId, job._id);
    ctx.conversation.activeJobId = job._id;
  }
  return job;
}

function compactCandidate(c: InstanceType<typeof Candidate>) {
  return {
    id: String(c._id),
    name: c.name,
    status: c.status,
    score: c.score,
    reason: c.scoreReason,
    email: c.email ? 'on file' : 'MISSING',
    source: c.source,
    headline: c.headline,
    missingData: c.missingData,
    injectionFlag: c.injectionFlag || undefined,
  };
}

async function statusCounts(jobId: Types.ObjectId) {
  const agg = await Candidate.aggregate<{ _id: string; n: number }>([{ $match: { jobId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  return Object.fromEntries(agg.map((a) => [a._id, a.n]));
}

/* ======================================================================= READ TOOLS */

const listJobs = tool({
  name: 'list_jobs',
  description: 'List all jobs with candidate counts per status.',
  schema: z.object({}),
  async run() {
    const jobs = await Job.find({}).sort({ createdAt: -1 }).limit(50);
    const out = [];
    for (const j of jobs) out.push({ id: String(j._id), title: j.title, company: j.company, createdAt: j.createdAt, counts: await statusCounts(j._id) });
    return { result: { jobs: out } };
  },
});

const getJob = tool({
  name: 'get_job',
  description: 'Get a job\'s requirements, settings and candidate counts.',
  schema: z.object({ job: jobRef }),
  async run({ job }, ctx) {
    const j = await requireJob(job, ctx);
    return { result: { job: jobBrief(j), counts: await statusCounts(j._id), usage: j.usage }, jobId: String(j._id) };
  },
});

const getCandidates = tool({
  name: 'get_candidates',
  description: 'List candidates for a job (sorted by score) and show the interactive candidate table card to the recruiter.',
  schema: z.object({
    job: jobRef,
    status: z.string().optional().describe('Filter by status, e.g. "Sourced", "Accepted", "Interested"'),
    minScore: z.number().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async run({ job, status, minScore, limit }, ctx) {
    const j = await requireJob(job, ctx);
    const st = status ? parseStatus(status) : null;
    const q: Record<string, unknown> = { jobId: j._id };
    if (st) q.status = st;
    if (minScore !== undefined) q.score = { $gte: minScore };
    const list = await Candidate.find(q).sort({ score: -1 }).limit(limit ?? 25);
    const total = await Candidate.countDocuments(q);
    return {
      result: { total, shown: list.length, candidates: list.map(compactCandidate), note: 'The recruiter can see the full interactive table card.' },
      cards: [{ type: 'CANDIDATE_TABLE', payload: { jobId: String(j._id), filter: { status: st, minScore: minScore ?? null }, view: st === 'Sourced' ? 'review' : 'pipeline' } }],
      jobId: String(j._id),
    };
  },
});

const getCandidate = tool({
  name: 'get_candidate',
  description: 'Get everything known about one candidate (profile, score, email availability, replies, recent activity).',
  schema: z.object({ job: jobRef, name: z.string().min(1) }),
  async run({ job, name }, ctx) {
    const j = await requireJob(job, ctx);
    const res = await resolveCandidates(j._id, { names: [name] });
    if (res.unresolved.length) return { result: { error: describeUnresolved(res.unresolved) } };
    const c = res.candidates[0]!;
    const [replies, activity] = await Promise.all([
      Reply.find({ candidateId: c._id }).sort({ createdAt: -1 }).limit(5).lean(),
      recentActivity(String(j._id), 10, String(c._id)),
    ]);
    return {
      result: {
        candidate: {
          ...compactCandidate(c),
          email: c.email ?? 'UNKNOWN (not in any source; add via CSV or edit)',
          emailSource: c.emailSource,
          profileUrl: c.profileUrl,
          location: c.location ?? 'unknown',
          yearsExperience: c.yearsExperience ?? 'unknown',
          skills: c.skills,
          matchedSkills: c.matchedSkills,
          outreachStopped: c.outreachStopped,
        },
        replies: replies.map((r) => ({ id: String(r._id), classification: r.classification, summary: r.summary, draftStatus: r.draftStatus, at: r.createdAt })),
        activity: activity.map((a) => ({ action: a.action, from: a.from, to: a.to, actor: a.actor, at: a.createdAt })),
      },
      jobId: String(j._id),
    };
  },
});

const getStats = tool({
  name: 'get_stats',
  description: 'Get funnel metrics for a job (counts per status, reply rate, interested rate, meetings, hires, cost) and show the stats card. Use for "how is the X job going?".',
  schema: z.object({ job: jobRef }),
  async run({ job }, ctx) {
    const j = await requireJob(job, ctx);
    const stats = await jobStats(j._id);
    const result: Record<string, unknown> = {
      totals: stats.totals,
      byStatus: stats.byStatus,
      rates: stats.rates,
      outreach: stats.outreach,
      replies: stats.replies,
      scoring: stats.scoring,
      costUsd: stats.usage.costUsd,
    };
    if (isMockLlm()) result.summary = (await jobSummary(String(j._id), { conversationId: ctx.conversationId })).summary;
    return { result, cards: [{ type: 'STATS_SUMMARY', payload: { jobId: String(j._id) } }], jobId: String(j._id) };
  },
});

const getActivity = tool({
  name: 'get_activity',
  description: 'Recent activity log entries for a job, optionally for one candidate.',
  schema: z.object({ job: jobRef, candidate: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  async run({ job, candidate, limit }, ctx) {
    const j = await requireJob(job, ctx);
    let cid: string | undefined;
    if (candidate) {
      const r = await resolveCandidates(j._id, { names: [candidate] });
      if (r.unresolved.length) return { result: { error: describeUnresolved(r.unresolved) } };
      cid = String(r.candidates[0]!._id);
    }
    const log = await recentActivity(String(j._id), limit ?? 20, cid);
    return {
      result: { entries: log.map((a) => ({ action: a.action, candidate: a.candidateName, from: a.from, to: a.to, actor: a.actor, message: a.message, at: a.createdAt })) },
      jobId: String(j._id),
    };
  },
});

const listReplies = tool({
  name: 'list_replies',
  description: 'List recent candidate replies for a job with their classification and draft status.',
  schema: z.object({ job: jobRef }),
  async run({ job }, ctx) {
    const j = await requireJob(job, ctx);
    const replies = await Reply.find({ jobId: j._id }).sort({ createdAt: -1 }).limit(20).populate<{ candidateId: { name: string } }>('candidateId', 'name');
    return {
      result: {
        replies: replies.map((r) => ({
          id: String(r._id),
          candidate: r.candidateId?.name,
          classification: r.classification,
          confidence: r.confidence,
          summary: r.summary,
          draftStatus: r.draftStatus,
          injectionFlag: r.injectionFlag || undefined,
        })),
      },
      jobId: String(j._id),
    };
  },
});

/* ======================================================================= PROPOSE TOOLS */

const proposeCreateJob = tool({
  name: 'propose_create_job',
  description:
    'Extract a job from the job description the recruiter pasted (source "message") or from a link (source "url") and show an editable confirmation card. Do NOT copy the JD into the call.',
  schema: z.object({
    source: z.enum(['message', 'url']),
    url: z.string().optional().describe('Required when source is "url"'),
  }),
  async run({ source, url }, ctx) {
    let rawJD: string;
    let sourceUrl: string | null = null;
    const link = url ?? extractUrls(ctx.userMessage)[0];
    if (source === 'url' || (link && ctx.userMessage.trim().length < 300)) {
      if (!link) throw new ValidationError('No URL found. Ask the recruiter for the link or the JD text.');
      rawJD = await fetchJobDescription(link);
      sourceUrl = link;
    } else {
      // Use the longest recent user message (the JD may have been pasted one turn earlier).
      const recent = await ChatMessage.find({ conversationId: ctx.conversationId, role: 'user' }).sort({ createdAt: -1 }).limit(4);
      const texts = [ctx.userMessage, ...recent.map((m) => m.content)];
      rawJD = texts.reduce((a, b) => (b.length > a.length ? b : a), '');
    }
    if (rawJD.trim().length < 80) {
      return { result: { error: 'That is too short to be a job description. Ask the recruiter to paste the full JD text or a link.' } };
    }
    const draft = await extractJobDraft(rawJD, { conversationId: ctx.conversationId });
    // Fair-hiring rail on the JD itself: warnings are shown on the job card for the recruiter to fix.
    const fairness = scanFairness(rawJD, 'jd');
    await recordFindings('jd', fairness.findings, { conversationId: ctx.conversationId }, rawJD);
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      type: 'CREATE_JOB',
      payload: { draft, rawJD: rawJD.slice(0, 60_000), sourceUrl },
      display: { guardrails: fairness.findings },
    });
    return {
      result: {
        proposalId: String(action._id),
        extracted: draft,
        fairnessWarnings: fairness.findings.map((f) => f.reason),
        note: 'Editable job card shown. The job is created only after the recruiter confirms. Mention any fairness warnings.',
      },
      cards: [card],
      actionIds: [String(action._id)],
    };
  },
});

const proposeStartSourcing = tool({
  name: 'propose_start_sourcing',
  description: 'Propose starting a background sourcing run for a job: web search for public LinkedIn profiles (via Serper) and/or import of uploaded CSVs. Shows a confirmation card.',
  schema: z.object({
    job: jobRef,
    useWebSearch: z.boolean().optional(),
    query: z.string().max(300).optional().describe('Custom search query; default is built from the job'),
    maxResults: z.number().int().min(1).max(100).optional(),
    includeTalentPool: z.boolean().optional().describe('Rediscover matching candidates from earlier jobs. Default: on when there are matches.'),
  }),
  async run(input, ctx) {
    const j = await requireJob(input.job, ctx);
    const uploads = await CsvUpload.find({ jobId: j._id, status: 'uploaded' }, { _id: 1, filename: 1, rowCount: 1 });
    const webOk = !!env.SERPER_API_KEY;
    const useWeb = input.useWebSearch ?? webOk;
    const pool = talentEnabled() ? await searchTalentPool({ jobId: String(j._id), limit: 10 }).catch(() => []) : [];
    const includePool = input.includeTalentPool ?? pool.length > 0;
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'START_SOURCING',
      payload: {
        jobId: String(j._id),
        useWebSearch: useWeb,
        query: input.query ?? buildSearchQuery(j),
        maxResults: input.maxResults ?? env.SERPER_MAX_RESULTS,
        csvUploadIds: uploads.map((u) => String(u._id)),
        includeTalentPool: includePool,
      },
      display: {
        jobTitle: j.title,
        webSearchAvailable: webOk,
        uploads: uploads.map((u) => ({ id: String(u._id), filename: u.filename, rows: u.rowCount })),
        talentPool: pool.slice(0, 5),
      },
    });
    return {
      result: {
        proposalId: String(action._id),
        webSearchAvailable: webOk,
        csvUploadsAttached: uploads.length,
        talentPoolMatches: pool.length,
        note: webOk ? 'Card shown. The recruiter can also attach a CSV on the card.' : 'Web search is NOT configured (no Serper key). Tell the recruiter to upload a CSV on the card.',
      },
      cards: [card],
      actionIds: [String(action._id)],
      jobId: String(j._id),
    };
  },
});

const proposeReviewDecisions = tool({
  name: 'propose_review_decisions',
  description:
    'Propose accepting and/or rejecting candidates after review (e.g. "accept the top 5", "reject everyone below 40", "accept Rahim"). Groups default to candidates still in Sourced. Shows a confirm card listing exactly who changes.',
  schema: z.object({ job: jobRef, accept: SelectorSchema.optional(), reject: SelectorSchema.optional() }),
  async run({ job, accept, reject }, ctx) {
    const j = await requireJob(job, ctx);
    if (!accept && !reject) throw new ValidationError('Specify who to accept or reject.');
    const decisions: { candidateId: string; name: string; decision: 'accept' | 'reject'; score: number | null; currentStatus: string }[] = [];
    const problems: string[] = [];
    for (const [sel, decision] of [[accept, 'accept'], [reject, 'reject']] as const) {
      if (!sel) continue;
      const res = await resolveCandidates(j._id, sel, { defaultStatus: 'Sourced' });
      if (res.unresolved.length) problems.push(describeUnresolved(res.unresolved));
      for (const c of res.candidates) {
        const target: CandidateStatus = decision === 'accept' ? 'Accepted' : 'Rejected';
        if (c.status === target) {
          problems.push(`${c.name} is already ${target}.`);
          continue;
        }
        if (!canTransition(c.status as CandidateStatus, target, c.rejectedStage as 'review' | 'final' | null)) {
          problems.push(`${c.name} can't be ${decision}ed from ${STATUS_LABELS[c.status as CandidateStatus]}.`);
          continue;
        }
        if (!decisions.some((d) => d.candidateId === String(c._id)))
          decisions.push({ candidateId: String(c._id), name: c.name, decision, score: c.score ?? null, currentStatus: c.status });
      }
    }
    if (!decisions.length) return { result: { error: problems.join(' ') || 'No matching candidates.' }, jobId: String(j._id) };
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'REVIEW_DECISIONS',
      payload: { jobId: String(j._id), decisions },
      display: { problems },
    });
    return {
      result: { proposalId: String(action._id), decisions: decisions.map((d) => `${d.decision} ${d.name} (${d.score ?? 'unscored'})`), problems },
      cards: [card],
      actionIds: [String(action._id)],
      jobId: String(j._id),
    };
  },
});

const proposeCampaign = tool({
  name: 'propose_campaign',
  description:
    'Draft a personalised outreach campaign (single email or multi-step sequence) for Accepted candidates with an email, and show an editable preview card. Candidates without an email or not Accepted are listed as excluded.',
  schema: z.object({
    job: jobRef,
    candidates: SelectorSchema.optional().describe('Defaults to all Accepted candidates'),
    stepDays: z.array(z.number().min(0).max(60)).min(1).max(5).optional().describe('Send days, e.g. [0,3,7]; [0] for a single email'),
    dailyLimit: z.number().int().min(1).max(1000).optional(),
    tone: z.string().max(100).optional(),
  }),
  async run(input, ctx) {
    const j = await requireJob(input.job, ctx);
    let candidateIds: string[] | undefined;
    if (input.candidates) {
      const res = await resolveCandidates(j._id, input.candidates, { defaultStatus: 'Accepted' });
      if (res.unresolved.length) return { result: { error: describeUnresolved(res.unresolved) }, jobId: String(j._id) };
      candidateIds = res.candidates.map((c) => String(c._id));
      if (!candidateIds.length) return { result: { error: 'No candidates match that selection.' }, jobId: String(j._id) };
    }
    const payload = await buildCampaignProposal({
      jobId: String(j._id),
      candidateIds,
      steps: input.stepDays?.map((d) => ({ delayDays: d })),
      dailyLimit: input.dailyLimit,
      tone: input.tone,
    });
    // Outbound rail on every draft: findings are shown per recipient; blocking ones also stop the commit.
    const guardrails: Record<string, unknown[]> = {};
    for (const r of payload.recipients) {
      const findings = r.drafts.flatMap((d) =>
        checkOutboundEmail({ subject: d.subject, body: d.body, recipientEmail: r.email, job: { salaryRaw: j.salary?.raw, title: j.title, company: j.company } }).findings.map((f) => ({ ...f, stepNumber: d.stepNumber })),
      );
      if (findings.length) guardrails[r.candidateId] = findings;
      await recordFindings('outbound', findings, { conversationId: ctx.conversationId, jobId: j._id, candidateId: r.candidateId });
    }
    const { action, card } = await createProposal({ conversationId: ctx.conversationId, jobId: j._id, type: 'CREATE_CAMPAIGN', payload, display: { guardrails } });
    return {
      result: {
        proposalId: String(action._id),
        recipients: payload.recipients.map((r) => r.name),
        excluded: payload.excluded,
        steps: payload.steps,
        dailyLimit: payload.dailyLimit,
        note: 'Preview card shown with editable drafts. Nothing is sent until the recruiter approves.',
      },
      cards: [card],
      actionIds: [String(action._id)],
      jobId: String(j._id),
    };
  },
});

const proposeStatusChange = tool({
  name: 'propose_status_change',
  description:
    'Propose moving candidates to a new pipeline status, e.g. "mark Rahim as hired", "move Sara to interviewed". Statuses: Interested, NotInterested, MeetingBooked, Interviewed, Shortlisted, Hired, Rejected, Unsubscribed, Accepted. Shows a confirm card.',
  schema: z.object({ job: jobRef, candidates: SelectorSchema, to: z.string().describe('Target status'), note: z.string().max(300).optional() }),
  async run({ job, candidates, to, note }, ctx) {
    const j = await requireJob(job, ctx);
    const target = parseStatus(to);
    if (!target) return { result: { error: `Unknown status "${to}".` } };
    if (target === 'Contacted') return { result: { error: 'Contacted is set automatically when the first email is sent.' } };
    const res = await resolveCandidates(j._id, candidates);
    if (res.unresolved.length && !res.candidates.length) return { result: { error: describeUnresolved(res.unresolved) }, jobId: String(j._id) };
    const changes: { candidateId: string; name: string; from: string }[] = [];
    const illegal: string[] = [];
    for (const c of res.candidates) {
      if (canTransition(c.status as CandidateStatus, target, c.rejectedStage as 'review' | 'final' | null)) changes.push({ candidateId: String(c._id), name: c.name, from: c.status });
      else illegal.push(`${c.name} is ${STATUS_LABELS[c.status as CandidateStatus]} and can't move to ${STATUS_LABELS[target]}`);
    }
    if (!changes.length) return { result: { error: [illegal.join('; '), describeUnresolved(res.unresolved)].filter(Boolean).join(' ') }, jobId: String(j._id) };
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'STATUS_CHANGE',
      payload: { jobId: String(j._id), to: target, changes, note: note ?? null },
      display: { illegal, unresolved: describeUnresolved(res.unresolved) || null, toLabel: STATUS_LABELS[target] },
    });
    return {
      result: { proposalId: String(action._id), changes: changes.map((c) => `${c.name}: ${c.from} → ${target}`), notPossible: illegal, unresolved: describeUnresolved(res.unresolved) || undefined },
      cards: [card],
      actionIds: [String(action._id)],
      jobId: String(j._id),
    };
  },
});

const proposeCampaignControl = tool({
  name: 'propose_campaign_control',
  description: 'Propose pausing or resuming the latest active outreach campaign of a job.',
  schema: z.object({ job: jobRef, action: z.enum(['pause', 'resume']) }),
  async run({ job, action: act }, ctx) {
    const j = await requireJob(job, ctx);
    const camp = await Campaign.findOne({ jobId: j._id, status: act === 'pause' ? 'running' : 'paused' }).sort({ createdAt: -1 });
    if (!camp) return { result: { error: `There is no ${act === 'pause' ? 'running' : 'paused'} campaign for ${j.title}.` }, jobId: String(j._id) };
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'CAMPAIGN_CONTROL',
      payload: { campaignId: String(camp._id), campaignName: camp.name, action: act },
    });
    return { result: { proposalId: String(action._id), campaign: camp.name, action: act }, cards: [card], actionIds: [String(action._id)], jobId: String(j._id) };
  },
});

const proposeReplySend = tool({
  name: 'propose_reply_send',
  description:
    'Propose sending (or re-drafting) a reply to a candidate who wrote back. Use when the recruiter asks to change a pending reply draft; pass the full new subject/body you wrote following their instructions.',
  schema: z.object({ job: jobRef, candidate: z.string(), subject: z.string().max(200).optional(), body: z.string().max(4000).optional() }),
  async run({ job, candidate, subject, body }, ctx) {
    const j = await requireJob(job, ctx);
    const res = await resolveCandidates(j._id, { names: [candidate] });
    if (res.unresolved.length) return { result: { error: describeUnresolved(res.unresolved) } };
    const cand = res.candidates[0]!;
    const reply = await Reply.findOne({ candidateId: cand._id, draftStatus: 'pending' }).sort({ createdAt: -1 });
    if (!reply?.draft?.body) return { result: { error: `There is no pending reply draft for ${cand.name}.` } };
    if (!cand.email) return { result: { error: `${cand.name} has no email on file.` } };
    const finalBody = body ?? reply.draft.body;
    const allowed = reply.bookingToken ? (await import('../services/booking.service')).bookingUrl(reply.bookingToken) : null;
    if (extractUrls(finalBody).some((u) => u !== allowed)) return { result: { error: 'Drafts may only contain the booking link; remove other links.' } };
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'SEND_REPLY',
      supersedeKey: 'replyId',
      payload: { replyId: String(reply._id), to: cand.email, candidateName: cand.name, subject: subject ?? reply.draft.subject ?? `Re: ${j.title}`, body: finalBody },
      display: { classification: reply.classification, confidence: reply.confidence, summary: reply.summary, original: reply.body, injectionFlag: reply.injectionFlag },
    });
    return { result: { proposalId: String(action._id) }, cards: [card], actionIds: [String(action._id)], jobId: String(j._id) };
  },
});

const proposeJobSettings = tool({
  name: 'propose_job_settings',
  description: 'Propose changing a job\'s auto-reply setting: "off" (every reply waits for approval) or "meetings_only" (auto-send low-risk meeting-request replies).',
  schema: z.object({ job: jobRef, autoReply: z.enum(['off', 'meetings_only']) }),
  async run({ job, autoReply }, ctx) {
    const j = await requireJob(job, ctx);
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'UPDATE_JOB_SETTINGS',
      payload: { jobId: String(j._id), autoReply },
      display: { current: j.settings?.autoReply ?? 'off', jobTitle: j.title },
    });
    return { result: { proposalId: String(action._id) }, cards: [card], actionIds: [String(action._id)], jobId: String(j._id) };
  },
});

const searchPool = tool({
  name: 'search_talent_pool',
  description:
    'Semantic search over candidates sourced for EARLIER jobs (talent rediscovery). Use for "anyone from previous searches who fits?", "find people similar to Rahim", or a free-text skill query. Read-only; to add them, propose sourcing with includeTalentPool.',
  schema: z.object({
    job: jobRef,
    query: z.string().max(300).optional().describe('Free-text skills/role query; default is the job itself'),
    similarTo: z.string().max(120).optional().describe('Candidate name: find people with a similar profile'),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async run({ job, query, similarTo, limit }, ctx) {
    const j = await requireJob(job, ctx);
    if (!talentEnabled()) return { result: { error: 'Talent rediscovery is disabled (EMBEDDINGS=off).' } };
    let likeCandidateId: string | undefined;
    if (similarTo) {
      const res = await resolveCandidates(j._id, { names: [similarTo] });
      if (res.unresolved.length) return { result: { error: describeUnresolved(res.unresolved) } };
      likeCandidateId = String(res.candidates[0]!._id);
    }
    const matches = await searchTalentPool({ jobId: String(j._id), query, likeCandidateId, limit });
    return {
      result: {
        matches: matches.map((m) => ({ name: m.name, fromJob: m.fromJobTitle, similarity: m.similarity, headline: m.headline, hasEmail: m.hasEmail, status: m.status })),
        note: matches.length
          ? 'These people are in other jobs. They are added to this job only through a confirmed sourcing run (includeTalentPool).'
          : 'No strong matches from earlier jobs.',
      },
      cards: [{ type: 'TALENT_POOL', payload: { jobId: String(j._id), query: query ?? null, similarTo: similarTo ?? null, matches } }],
      jobId: String(j._id),
    };
  },
});

const proposeUpdateEmail = tool({
  name: 'propose_update_email',
  description:
    "Propose setting or correcting a candidate's email address when the recruiter provides it explicitly (e.g. \"Mehedi's email is mehedi@company.com\"). Never use an address the recruiter did not type.",
  schema: z.object({ job: jobRef, candidate: z.string(), email: z.string().max(200) }),
  async run({ job, candidate, email }, ctx) {
    const j = await requireJob(job, ctx);
    const normalized = normalizeEmail(email);
    if (!normalized) return { result: { error: `"${email}" is not a valid email address.` } };
    // Provenance: the address must literally appear in the recruiter's message (no invented data).
    if (!ctx.userMessage.toLowerCase().includes(normalized)) {
      return { result: { error: 'I can only use an email address the recruiter typed in this message. Ask them for it.' } };
    }
    const res = await resolveCandidates(j._id, { names: [candidate] });
    if (res.unresolved.length) return { result: { error: describeUnresolved(res.unresolved) } };
    const c = res.candidates[0]!;
    const clash = await Candidate.findOne({ jobId: j._id, emailLower: normalized, _id: { $ne: c._id } });
    if (clash) return { result: { error: `${clash.name} in this job already uses that address.` } };
    const { action, card } = await createProposal({
      conversationId: ctx.conversationId,
      jobId: j._id,
      type: 'UPDATE_CANDIDATE_EMAIL',
      payload: { jobId: String(j._id), candidateId: String(c._id), name: c.name, email: normalized },
      display: { previous: c.email ?? null },
    });
    return { result: { proposalId: String(action._id), candidate: c.name }, cards: [card], actionIds: [String(action._id)], jobId: String(j._id) };
  },
});

/* ======================================================================= REGISTRY */

export const TOOLS = [
  listJobs,
  getJob,
  getCandidates,
  getCandidate,
  getStats,
  getActivity,
  listReplies,
  proposeCreateJob,
  proposeStartSourcing,
  proposeReviewDecisions,
  proposeCampaign,
  proposeStatusChange,
  proposeCampaignControl,
  proposeReplySend,
  proposeJobSettings,
  proposeUpdateEmail,
  searchPool,
] as AgentTool<z.ZodTypeAny>[];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolDefinitions(): ToolDefinition[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toToolJsonSchema(t.schema) }));
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const t = BY_NAME.get(name);
  if (!t) return { result: { error: `Unknown tool ${name}` } };
  const parsed = t.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { result: { error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` } };
  }
  const out = await t.run(parsed.data, ctx);
  // Retrieval rail: scrub candidate-authored text and contact details before they reach the agent.
  const stats = { withheld: 0, masked: 0 };
  out.result = sanitizeToolResult(out.result, stats);
  if (stats.withheld) {
    await recordFindings(
      'retrieval',
      [{ rail: 'retrieval', verdict: 'warn', reason: `Withheld ${stats.withheld} candidate-supplied text field(s) flagged as possible prompt injection from tool "${name}".` }],
      { conversationId: ctx.conversationId, jobId: out.jobId ?? ctx.conversation.activeJobId },
    );
  }
  return out;
}

/** Compact live context injected into the system prompt each turn. */
export async function buildContext(conv: ConversationDoc): Promise<string> {
  const lines: string[] = [`Today: ${new Date().toISOString().slice(0, 10)}`, `Web search (Serper): ${env.SERPER_API_KEY ? 'configured' : 'NOT configured, CSV upload only'}`];
  if (conv.activeJobId) {
    const job = await Job.findById(conv.activeJobId);
    if (job) {
      lines.push(`Active job: ${JSON.stringify(jobBrief(job))}`);
      lines.push(`Candidates by status: ${JSON.stringify(await statusCounts(job._id))}`);
      const camp = await Campaign.findOne({ jobId: job._id }).sort({ createdAt: -1 }).lean();
      if (camp) lines.push(`Latest campaign: "${camp.name}" (${camp.status}, ${camp.recipients.length} recipients)`);
    }
  } else {
    lines.push('Active job: none yet');
  }
  const jobsCount = await Job.countDocuments();
  lines.push(`Total jobs: ${jobsCount}`);
  const pending = await PendingAction.find({ conversationId: conv._id, status: 'pending' }).sort({ createdAt: -1 }).limit(5).lean();
  if (pending.length) lines.push(`Pending proposals awaiting the recruiter: ${pending.map((p) => `${p.type} (${String(p._id)})`).join(', ')}`);
  return lines.join('\n');
}
