import type { Types } from 'mongoose';
import { ActivityLog } from '../models';
import type { Actor } from '../domain/cards';
import { publish } from './events';

export interface ActivityInput {
  jobId?: Types.ObjectId | string | null;
  candidateId?: Types.ObjectId | string | null;
  candidateName?: string | null;
  actor: Actor;
  action: string;
  from?: string | null;
  to?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Append-only audit trail. Every write path (chat, UI, worker, candidate) records here. */
export async function logActivity(input: ActivityInput) {
  const doc = await ActivityLog.create({
    jobId: input.jobId ?? null,
    candidateId: input.candidateId ?? null,
    candidateName: input.candidateName ?? null,
    actor: input.actor,
    action: input.action,
    from: input.from ?? null,
    to: input.to ?? null,
    message: input.message ?? null,
    meta: input.meta ?? null,
  });
  await publish(
    'activity.created',
    { id: String(doc._id), action: doc.action, actor: doc.actor, candidateId: input.candidateId ? String(input.candidateId) : null },
    { jobId: input.jobId },
  );
  return doc;
}
