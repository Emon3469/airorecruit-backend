import type { Types } from 'mongoose';
import { ChatMessage, PendingAction, type PendingActionDoc } from '../models';
import { ACTION_CARD, type ActionType, type Card } from '../domain/cards';
import { appendMessage } from './chat.service';
import { publish } from './events';

/**
 * The "Proposal" half of Proposal-Commit. A proposal is a PendingAction document plus a
 * chat card. Nothing in the business collections changes until the recruiter confirms.
 *
 * A new proposal of the same type for the same job (and same subject, e.g. the same reply)
 * supersedes the old one, so stale cards can't be confirmed by accident.
 */
export interface ProposeInput {
  conversationId: Types.ObjectId | string;
  jobId?: Types.ObjectId | string | null;
  type: ActionType;
  payload: Record<string, unknown>;
  /** Extra, non-editable data shown on the card (e.g. excluded candidates, diff). */
  display?: Record<string, unknown>;
  proposedBy?: 'agent' | 'system' | 'user_ui';
  /** Supersede only proposals whose payload[key] matches (e.g. replyId). */
  supersedeKey?: string;
  /** Post the card as its own chat message (system-initiated proposals). */
  message?: string;
}

export async function createProposal(input: ProposeInput): Promise<{ action: PendingActionDoc; card: Card }> {
  const filter: Record<string, unknown> = {
    conversationId: input.conversationId,
    type: input.type,
    status: 'pending',
    ...(input.jobId ? { jobId: input.jobId } : {}),
  };
  if (input.supersedeKey) filter[`payload.${input.supersedeKey}`] = input.payload[input.supersedeKey];
  const stale = await PendingAction.find(filter, { _id: 1 });
  if (stale.length) {
    await PendingAction.updateMany({ _id: { $in: stale.map((s) => s._id) } }, { $set: { status: 'superseded', resolvedAt: new Date() } });
    for (const s of stale) await publish('action.updated', { actionId: String(s._id), status: 'superseded' }, { conversationId: input.conversationId });
  }

  const action = await PendingAction.create({
    conversationId: input.conversationId,
    jobId: input.jobId ?? null,
    type: input.type,
    payload: input.payload,
    proposedBy: input.proposedBy ?? 'agent',
  });
  const card: Card = {
    type: ACTION_CARD[input.type],
    pendingActionId: String(action._id),
    payload: { ...input.payload, ...(input.display ? { display: input.display } : {}) },
  };
  if (input.message !== undefined) {
    const msg = await appendMessage(input.conversationId, { role: 'assistant', content: input.message, cards: [card], jobId: input.jobId });
    action.messageId = msg._id;
    await action.save();
  }
  return { action, card };
}

/** Attach the message id after the agent persists its reply (agent-initiated proposals). */
export async function linkProposalsToMessage(actionIds: string[], messageId: Types.ObjectId) {
  if (!actionIds.length) return;
  await PendingAction.updateMany({ _id: { $in: actionIds } }, { $set: { messageId } });
}

/** Keep the card's payload in sync after an edit so a refreshed chat shows the edited proposal. */
export async function syncCardPayload(action: PendingActionDoc) {
  if (!action.messageId) return;
  const msg = await ChatMessage.findById(action.messageId);
  if (!msg) return;
  let changed = false;
  for (const card of msg.cards) {
    if (String(card.pendingActionId) === String(action._id)) {
      const display = (card.payload as { display?: unknown })?.display;
      card.payload = { ...(action.payload as object), ...(display ? { display } : {}) };
      changed = true;
    }
  }
  if (changed) {
    msg.markModified('cards');
    await msg.save();
  }
}
