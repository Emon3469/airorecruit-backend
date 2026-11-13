import type { Types } from 'mongoose';
import { Campaign, Candidate, DispatchLog, type CandidateDoc } from '../models';
import {
  type CandidateStatus,
  STATUS_LABELS,
  resolveTransition,
  allowedNext,
} from '../domain/pipeline';
import type { Actor } from '../domain/cards';
import { IllegalTransitionError, NotFoundError, ConflictError } from '../lib/errors';
import { logActivity } from './activity.service';
import { publish } from './events';
import { QUEUE_NAMES, jobIds, removeJob } from '../queues/queues';
import { logger } from '../lib/logger';

/**
 * PipelineService: the ONE write path for candidate state.
 *
 * Chat commands (after confirmation), UI buttons, workers and inbound replies all go
 * through here, so the state machine, the activity log and the `state_sync` event
 * behave identically no matter which surface triggered the change.
 */

export interface TransitionOptions {
  actor: Actor;
  reason?: string;
  meta?: Record<string, unknown>;
  /** Optimistic concurrency: fail if the candidate is no longer in this state. */
  expectedFrom?: CandidateStatus;
}

export interface TransitionResult {
  candidateId: string;
  name: string;
  from: CandidateStatus;
  to: CandidateStatus;
}

async function loadCandidate(id: Types.ObjectId | string): Promise<CandidateDoc> {
  const c = await Candidate.findById(id);
  if (!c) throw new NotFoundError('Candidate');
  return c;
}

export async function transition(
  candidateId: Types.ObjectId | string,
  to: CandidateStatus,
  opts: TransitionOptions,
): Promise<TransitionResult> {
  const cand = await loadCandidate(candidateId);
  const from = cand.status as CandidateStatus;
  if (opts.expectedFrom && opts.expectedFrom !== from) {
    throw new ConflictError('STALE_STATE', `${cand.name} is now ${STATUS_LABELS[from]}, not ${STATUS_LABELS[opts.expectedFrom]}.`, {
      from,
    });
  }
  const target = resolveTransition(from, cand.rejectedStage as 'review' | 'final' | null, to);
  if (!target) throw new IllegalTransitionError(STATUS_LABELS[from], STATUS_LABELS[to], cand.name);

  // Guard: nobody can be accepted for outreach-relevant states without the review gate,
  // and Contacted is only ever set by the outreach worker after an email actually went out.
  if (to === 'Contacted' && opts.actor !== 'worker') {
    throw new ConflictError('CONTACTED_IS_AUTOMATIC', 'Contacted is set automatically when the first email is sent.');
  }

  // Atomic compare-and-set on the current status protects against two surfaces racing.
  const updated = await Candidate.findOneAndUpdate(
    { _id: cand._id, status: from },
    {
      $set: {
        status: target.status,
        rejectedStage: target.rejectedStage ?? (target.status === 'Rejected' ? cand.rejectedStage : null),
        ...(target.status === 'Contacted' ? { lastContactedAt: new Date() } : {}),
      },
      $addToSet: { milestones: target.status },
    },
    { new: true },
  );
  if (!updated) {
    throw new ConflictError('STALE_STATE', `${cand.name} was changed by someone else just now. Please retry.`);
  }

  await logActivity({
    jobId: cand.jobId,
    candidateId: cand._id,
    candidateName: cand.name,
    actor: opts.actor,
    action: 'status_changed',
    from,
    to: target.status === 'Rejected' && target.rejectedStage ? `Rejected (${target.rejectedStage})` : target.status,
    message: opts.reason ?? null,
    meta: opts.meta ?? null,
  });

  // Side effects that must follow certain transitions.
  if (target.status === 'Unsubscribed') {
    await stopOutreach(cand._id, 'unsubscribed', opts.actor);
  } else if (target.status === 'Rejected' || target.status === 'Hired' || target.status === 'NotInterested') {
    await stopOutreach(cand._id, `status ${target.status}`, opts.actor, { quiet: true });
  }

  await publish('state_sync', { reason: 'status_changed', candidateIds: [String(cand._id)] }, { jobId: cand.jobId });
  return { candidateId: String(cand._id), name: cand.name, from, to: target.status as CandidateStatus };
}

export interface DecisionInput {
  candidateId: string;
  decision: 'accept' | 'reject';
}

export interface DecisionResult {
  applied: TransitionResult[];
  skipped: { candidateId: string; name?: string; reason: string }[];
}

/** Batch accept/reject from the review table or a confirmed chat proposal. Partial success is reported, never hidden. */
export async function applyDecisions(jobId: string, decisions: DecisionInput[], actor: Actor): Promise<DecisionResult> {
  const result: DecisionResult = { applied: [], skipped: [] };
  for (const d of decisions) {
    const cand = await Candidate.findOne({ _id: d.candidateId, jobId });
    if (!cand) {
      result.skipped.push({ candidateId: d.candidateId, reason: 'not found in this job' });
      continue;
    }
    const to: CandidateStatus = d.decision === 'accept' ? 'Accepted' : 'Rejected';
    if (cand.status === to) {
      result.skipped.push({ candidateId: d.candidateId, name: cand.name, reason: `already ${STATUS_LABELS[to]}` });
      continue;
    }
    try {
      result.applied.push(await transition(cand._id, to, { actor, reason: 'review decision' }));
    } catch (err) {
      result.skipped.push({ candidateId: d.candidateId, name: cand.name, reason: (err as Error).message });
    }
  }
  return result;
}

/**
 * Stop every pending follow-up for a candidate. Called on reply, unsubscribe, rejection and hire.
 *  1. outreachStopped = true   (the worker re-checks this right before sending: the real guarantee)
 *  2. remove the candidate's single pending BullMQ job (deterministic id)
 *  3. write a `cancelled` ledger row for that step so it can never be sent later
 */
export async function stopOutreach(
  candidateId: Types.ObjectId | string,
  reason: string,
  actor: Actor,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<number> {
  const cand = await Candidate.findByIdAndUpdate(
    candidateId,
    { $set: { outreachStopped: true, outreachStoppedReason: reason } },
    { new: true },
  );
  if (!cand) return 0;

  const campaigns = await Campaign.find({ recipients: { $elemMatch: { candidateId: cand._id, state: 'active' } } });
  let stopped = 0;
  for (const camp of campaigns) {
    const rec = camp.recipients.find((r) => String(r.candidateId) === String(cand._id));
    if (!rec || rec.state !== 'active') continue;
    const step = rec.nextStep ?? 0;
    const removed = await removeJob(QUEUE_NAMES.outreach, jobIds.outreach(String(camp._id), String(cand._id), step)).catch(
      (err) => {
        logger.warn({ err: (err as Error).message }, 'failed to remove outreach job');
        return false;
      },
    );
    // Ledger tombstone for the next step (ignored if that step already has a row).
    await DispatchLog.updateOne(
      { campaignId: camp._id, candidateId: cand._id, stepNumber: step },
      { $setOnInsert: { jobId: camp.jobId, status: 'cancelled', error: `stopped: ${reason}` } },
      { upsert: true },
    );
    const remainingSteps = camp.steps.filter((s) => s.stepNumber >= step).length;
    stopped += remainingSteps;
    await Campaign.updateOne(
      { _id: camp._id, 'recipients.candidateId': cand._id },
      { $set: { 'recipients.$.state': 'stopped', 'recipients.$.stoppedReason': reason, 'recipients.$.nextRunAt': null } },
    );
    await maybeCompleteCampaign(String(camp._id));
    if (!quiet || remainingSteps > 0) {
      await logActivity({
        jobId: cand.jobId,
        candidateId: cand._id,
        candidateName: cand.name,
        actor,
        action: 'outreach_stopped',
        message: `Stopped ${remainingSteps} pending follow-up(s): ${reason}`,
        meta: { campaignId: String(camp._id), removedQueuedJob: removed },
      });
    }
    await publish('campaign.progress', { campaignId: String(camp._id) }, { jobId: cand.jobId });
  }
  return stopped;
}

export async function maybeCompleteCampaign(campaignId: string): Promise<void> {
  const camp = await Campaign.findById(campaignId);
  if (!camp || camp.status === 'completed') return;
  if (camp.recipients.every((r) => r.state !== 'active')) {
    await Campaign.updateOne({ _id: camp._id, status: { $ne: 'completed' } }, { $set: { status: 'completed' } });
    await logActivity({ jobId: camp.jobId, actor: 'system', action: 'campaign_completed', meta: { campaignId } });
    await publish('campaign.progress', { campaignId, status: 'completed' }, { jobId: camp.jobId });
  }
}

export async function updateCandidateEmail(candidateId: string, email: string | null, actor: Actor) {
  const { normalizeEmail } = await import('../domain/normalize');
  const cand = await loadCandidate(candidateId);
  const normalized = email === null ? null : normalizeEmail(email);
  if (email !== null && !normalized) throw new ConflictError('INVALID_EMAIL', `"${email}" is not a valid email address.`);
  if (normalized) {
    const clash = await Candidate.findOne({ jobId: cand.jobId, emailLower: normalized, _id: { $ne: cand._id } });
    if (clash) throw new ConflictError('DUPLICATE_EMAIL', `${clash.name} in this job already uses ${normalized}.`);
  }
  const before = cand.email;
  cand.email = normalized;
  cand.emailLower = normalized ?? undefined;
  cand.emailSource = normalized ? 'manual' : null;
  cand.missingData = (cand.missingData ?? []).filter((m) => m !== 'email');
  if (!normalized) cand.missingData.push('email');
  await cand.save();
  await logActivity({
    jobId: cand.jobId,
    candidateId: cand._id,
    candidateName: cand.name,
    actor,
    action: 'email_updated',
    from: before ?? '(none)',
    to: normalized ?? '(none)',
  });
  await publish('state_sync', { reason: 'email_updated', candidateIds: [String(cand._id)] }, { jobId: cand.jobId });
  return cand;
}

export { allowedNext };
