import { z } from 'zod';
import { env } from '../config/env';
import { Job, PendingAction, type PendingActionDoc } from '../models';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { CANDIDATE_STATUSES, STATUS_LABELS, type CandidateStatus } from '../domain/pipeline';
import type { ActionType, Actor } from '../domain/cards';
import { CreateJobPayloadSchema, createJob } from './job.service';
import { StartSourcingPayloadSchema, buildSearchQuery, startSourcing } from './sourcing.service';
import { CampaignPayloadSchema, commitCampaign, setCampaignPaused } from './campaign.service';
import { SendReplyPayloadSchema, approveReplySend, discardReplyDraft } from './reply.service';
import { applyDecisions, transition, updateCandidateEmail } from './pipeline.service';
import { appendMessage, setActiveJob } from './chat.service';
import { createProposal, syncCardPayload } from './proposals';
import { logActivity } from './activity.service';
import { searchTalentPool } from './talent.service';
import { publish } from './events';

/* ------------------------------------------------------------- Payload schemas (per type) */

export const ReviewDecisionsSchema = z.object({
  jobId: z.string(),
  decisions: z
    .array(
      z.object({
        candidateId: z.string(),
        name: z.string(),
        decision: z.enum(['accept', 'reject']),
        score: z.number().nullable().optional(),
        currentStatus: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const StatusChangeSchema = z.object({
  jobId: z.string(),
  to: z.enum(CANDIDATE_STATUSES),
  changes: z.array(z.object({ candidateId: z.string(), name: z.string(), from: z.string() })).min(1).max(200),
  note: z.string().max(300).nullable().optional(),
});

export const CampaignControlSchema = z.object({
  campaignId: z.string(),
  campaignName: z.string().optional(),
  action: z.enum(['pause', 'resume']),
});

export const UpdateEmailSchema = z.object({
  jobId: z.string(),
  candidateId: z.string(),
  name: z.string(),
  email: z.string().email(),
});

export const JobSettingsSchema = z.object({
  jobId: z.string(),
  autoReply: z.enum(['off', 'meetings_only']),
});

const SCHEMAS: Record<ActionType, z.ZodTypeAny> = {
  CREATE_JOB: CreateJobPayloadSchema,
  START_SOURCING: StartSourcingPayloadSchema,
  REVIEW_DECISIONS: ReviewDecisionsSchema,
  CREATE_CAMPAIGN: CampaignPayloadSchema,
  STATUS_CHANGE: StatusChangeSchema,
  SEND_REPLY: SendReplyPayloadSchema,
  CAMPAIGN_CONTROL: CampaignControlSchema,
  UPDATE_JOB_SETTINGS: JobSettingsSchema,
  UPDATE_CANDIDATE_EMAIL: UpdateEmailSchema,
};

export function validatePayload(type: ActionType, payload: unknown) {
  const parsed = SCHEMAS[type].safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; '),
      parsed.error.issues,
    );
  }
  return parsed.data as Record<string, unknown>;
}

/* ------------------------------------------------------------- Commit handlers */

interface CommitContext {
  action: PendingActionDoc;
  actor: Actor;
}
interface CommitOutcome {
  summary: string;
  data?: Record<string, unknown>;
}

const handlers: Record<ActionType, (payload: any, ctx: CommitContext) => Promise<CommitOutcome>> = {
  async CREATE_JOB(p: z.infer<typeof CreateJobPayloadSchema>, { action, actor }) {
    const job = await createJob(p, action.conversationId);
    await setActiveJob(action.conversationId, job._id, job.title);
    await logActivity({ jobId: job._id, actor, action: 'job_created', message: `Job "${job.title}" created` });
    // The AI asks before sourcing: propose it as the natural next step.
    const pool = await searchTalentPool({ jobId: String(job._id), limit: 10 }).catch(() => []);
    await createProposal({
      conversationId: action.conversationId,
      jobId: job._id,
      type: 'START_SOURCING',
      proposedBy: 'system',
      payload: {
        jobId: String(job._id),
        useWebSearch: !!env.SERPER_API_KEY,
        query: buildSearchQuery(job),
        maxResults: env.SERPER_MAX_RESULTS,
        csvUploadIds: [],
        includeTalentPool: pool.length > 0,
      },
      display: { jobTitle: job.title, webSearchAvailable: !!env.SERPER_API_KEY, talentPool: pool.slice(0, 5) },
      message: `Job "${job.title}" is created. Shall I start sourcing? I can search public LinkedIn profiles via web search${env.SERPER_API_KEY ? '' : ' (not configured: no SERPER_API_KEY)'} and/or import a CSV of candidates.${pool.length ? ` I also found ${pool.length} strong match(es) from earlier jobs in your talent pool (e.g. ${pool.slice(0, 3).map((p) => p.name).join(', ')}); they're included unless you untick it.` : ''} Edit the search query or attach a CSV on the card, then confirm.`,
    });
    return { summary: `Created job "${job.title}"`, data: { jobId: String(job._id) } };
  },

  async START_SOURCING(p: z.infer<typeof StartSourcingPayloadSchema>, { action }) {
    const otherSource = p.csvUploadIds.length > 0 || p.includeTalentPool;
    if (!p.useWebSearch && !otherSource) throw new ValidationError('Enable web search, the talent pool, or attach a CSV before starting.');
    if (p.useWebSearch && !env.SERPER_API_KEY && !otherSource)
      throw new ValidationError('Web search is not configured (no SERPER_API_KEY). Upload a CSV of candidates or include the talent pool instead.');
    const run = await startSourcing(p, action.conversationId);
    const job = await Job.findById(p.jobId);
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: p.jobId,
      content: `Sourcing started for ${job?.title ?? 'the job'}. It runs in the background; you'll see live progress here.`,
      cards: [{ type: 'SOURCING_PROGRESS', payload: { runId: String(run._id), jobId: p.jobId } }],
    });
    return { summary: 'Sourcing started', data: { runId: String(run._id) } };
  },

  async REVIEW_DECISIONS(p: z.infer<typeof ReviewDecisionsSchema>, { action, actor }) {
    const res = await applyDecisions(p.jobId, p.decisions.map((d) => ({ candidateId: d.candidateId, decision: d.decision })), actor);
    const acc = res.applied.filter((a) => a.to === 'Accepted').map((a) => a.name);
    const rej = res.applied.filter((a) => a.to === 'Rejected').map((a) => a.name);
    const parts = [acc.length ? `Accepted ${acc.length}: ${acc.join(', ')}.` : null, rej.length ? `Rejected ${rej.length}: ${rej.join(', ')}.` : null];
    if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((s) => `${s.name ?? s.candidateId} (${s.reason})`).join('; ')}.`);
    if (acc.length) parts.push('Want me to draft an outreach campaign for the accepted candidates?');
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: p.jobId,
      content: parts.filter(Boolean).join(' '),
      cards: [{ type: 'ACTION_RESULT', payload: { kind: 'review', applied: res.applied, skipped: res.skipped } }],
    });
    return { summary: `Applied ${res.applied.length} decision(s)`, data: { ...res } };
  },

  async CREATE_CAMPAIGN(p, { action, actor }) {
    const { campaign, dropped } = await commitCampaign(p, action.conversationId, actor);
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: String(campaign.jobId),
      content: `Campaign approved. Sending to ${campaign.recipients.length} candidate(s) in the background (daily limit ${campaign.dailyLimit}).${dropped.length ? ` Dropped ${dropped.length}: ${dropped.map((d) => `${d.name} (${d.reason})`).join('; ')}.` : ''} Follow-ups stop automatically for anyone who replies or unsubscribes.`,
      cards: [{ type: 'CAMPAIGN_PROGRESS', payload: { campaignId: String(campaign._id), jobId: String(campaign.jobId) } }],
    });
    return { summary: 'Campaign approved', data: { campaignId: String(campaign._id), dropped } };
  },

  async STATUS_CHANGE(p: z.infer<typeof StatusChangeSchema>, { action, actor }) {
    const ok: string[] = [];
    const failed: string[] = [];
    for (const c of p.changes) {
      try {
        await transition(c.candidateId, p.to as CandidateStatus, { actor, reason: p.note ?? undefined });
        ok.push(c.name);
      } catch (err) {
        failed.push(`${c.name}: ${(err as Error).message}`);
      }
    }
    const label = STATUS_LABELS[p.to as CandidateStatus];
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: p.jobId,
      content: [ok.length ? `Marked ${ok.join(', ')} as ${label}.` : null, failed.length ? `Not changed: ${failed.join('; ')}` : null].filter(Boolean).join(' '),
      cards: [{ type: 'ACTION_RESULT', payload: { kind: 'status', to: p.to, ok, failed } }],
    });
    if (!ok.length) throw new ConflictError('NO_CHANGES', failed.join('; '));
    return { summary: `Updated ${ok.length} candidate(s)`, data: { ok, failed } };
  },

  async SEND_REPLY(p: z.infer<typeof SendReplyPayloadSchema>, { actor }) {
    await approveReplySend(p, actor === 'user_chat' ? 'user_chat' : 'user_ui');
    return { summary: `Reply to ${p.candidateName ?? p.to} queued for sending` };
  },

  async CAMPAIGN_CONTROL(p: z.infer<typeof CampaignControlSchema>, { action, actor }) {
    const camp = await setCampaignPaused(p.campaignId, p.action === 'pause', actor);
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: String(camp.jobId),
      content: p.action === 'pause' ? `Campaign "${camp.name}" is paused. No emails will go out until you resume it.` : `Campaign "${camp.name}" resumed.`,
    });
    return { summary: `Campaign ${p.action}d` };
  },

  async UPDATE_CANDIDATE_EMAIL(p: z.infer<typeof UpdateEmailSchema>, { action, actor }) {
    const cand = await updateCandidateEmail(p.candidateId, p.email, actor);
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: p.jobId,
      content: `Saved ${cand.email} for ${cand.name} (source: manual).${cand.status === 'Accepted' ? ' They can now be added to an outreach campaign.' : ''}`,
    });
    return { summary: `Email updated for ${cand.name}` };
  },

  async UPDATE_JOB_SETTINGS(p: z.infer<typeof JobSettingsSchema>, { action, actor }) {
    const job = await Job.findByIdAndUpdate(p.jobId, { $set: { 'settings.autoReply': p.autoReply } }, { new: true });
    if (!job) throw new NotFoundError('Job');
    await logActivity({ jobId: job._id, actor, action: 'settings_updated', to: `autoReply=${p.autoReply}` });
    await publish('job.updated', { jobId: p.jobId }, { jobId: p.jobId });
    await appendMessage(action.conversationId, {
      role: 'assistant',
      jobId: p.jobId,
      content:
        p.autoReply === 'meetings_only'
          ? 'Auto-reply is on for meeting requests only. A reply is sent automatically only when it is classified "Wants a meeting" with at least 80% confidence, has no prompt-injection flag, and the draft contains no links except our booking link. Everything else still waits for your approval.'
          : 'Auto-reply is off. Every reply draft waits for your approval.',
    });
    return { summary: 'Settings updated' };
  },
};

/* ------------------------------------------------------------- Public API */

export async function getAction(id: string) {
  const a = await PendingAction.findById(id);
  if (!a) throw new NotFoundError('Proposal');
  return a;
}

/** Edit a proposal before confirming (editable cards). The full payload is re-validated. */
export async function updateActionPayload(id: string, payload: Record<string, unknown>) {
  const action = await getAction(id);
  if (action.status !== 'pending') throw new ConflictError('NOT_PENDING', `This proposal is already ${action.status}.`);
  const merged = validatePayload(action.type as ActionType, { ...(action.payload as object), ...payload });
  action.payload = merged;
  action.markModified('payload');
  await action.save();
  await syncCardPayload(action);
  await publish('action.updated', { actionId: id, status: 'pending', edited: true }, { conversationId: action.conversationId, jobId: action.jobId });
  return action;
}

/**
 * Commit a proposal. The ONLY path from a proposal to a real write/send.
 * Reached from the card's Confirm button (actor user_ui) or a deterministic chat confirmation (user_chat).
 * Atomic pending→confirmed claim prevents double execution from double clicks.
 */
export async function confirmAction(id: string, actor: Actor, editedPayload?: Record<string, unknown>) {
  if (editedPayload && Object.keys(editedPayload).length) await updateActionPayload(id, editedPayload);
  const current = await getAction(id);
  const payload = validatePayload(current.type as ActionType, current.payload);

  const action = await PendingAction.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'confirmed', resolvedAt: new Date(), resolvedBy: actor } },
    { new: true },
  );
  if (!action) throw new ConflictError('NOT_PENDING', `This proposal is already ${current.status}.`);

  try {
    const outcome = await handlers[action.type as ActionType](payload, { action, actor });
    action.result = outcome;
    await action.save();
    await publish('action.updated', { actionId: id, status: 'confirmed', summary: outcome.summary }, { conversationId: action.conversationId, jobId: action.jobId });
    return { action, outcome };
  } catch (err) {
    // Fixable input problems go back to pending so the recruiter can edit and retry.
    const recoverable = err instanceof AppError && err.status === 400;
    await PendingAction.updateOne(
      { _id: id },
      { $set: recoverable ? { status: 'pending', resolvedAt: null, resolvedBy: null, error: err.message } : { status: 'failed', error: (err as Error).message } },
    );
    await publish('action.updated', { actionId: id, status: recoverable ? 'pending' : 'failed', error: (err as Error).message }, { conversationId: action.conversationId });
    throw err;
  }
}

export async function cancelAction(id: string, actor: Actor) {
  const action = await PendingAction.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'cancelled', resolvedAt: new Date(), resolvedBy: actor } },
    { new: true },
  );
  if (!action) {
    const a = await getAction(id);
    throw new ConflictError('NOT_PENDING', `This proposal is already ${a.status}.`);
  }
  if (action.type === 'SEND_REPLY') await discardReplyDraft(String((action.payload as { replyId: string }).replyId));
  await publish('action.updated', { actionId: id, status: 'cancelled' }, { conversationId: action.conversationId, jobId: action.jobId });
  return action;
}

export async function pendingActions(conversationId: string) {
  return PendingAction.find({ conversationId, status: 'pending' }).sort({ createdAt: -1 });
}
