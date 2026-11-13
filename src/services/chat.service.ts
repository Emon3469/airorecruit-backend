import type { Types } from 'mongoose';
import { ChatMessage, Conversation } from '../models';
import type { Card } from '../domain/cards';
import { NotFoundError } from '../lib/errors';
import { publish } from './events';

export const GREETING = `Hi! I'm AiroRecruit, your AI recruiting co-worker. Paste a job description (or a link to one) and I'll set up the job, source and score candidates, run outreach, handle replies and track everyone through to hire.

Nothing gets created or sent without your confirmation.`;

export async function createConversation() {
  const conv = await Conversation.create({});
  await appendMessage(conv._id, { role: 'assistant', content: GREETING });
  return conv;
}

export async function getConversation(id: string) {
  const conv = await Conversation.findById(id);
  if (!conv) throw new NotFoundError('Conversation');
  return conv;
}

export interface AppendInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  cards?: Card[];
  jobId?: Types.ObjectId | string | null;
  toolTrace?: string[];
}

export async function appendMessage(conversationId: Types.ObjectId | string, input: AppendInput) {
  const msg = await ChatMessage.create({
    conversationId,
    role: input.role,
    content: input.content,
    cards: input.cards ?? [],
    jobId: input.jobId ?? null,
    toolTrace: input.toolTrace ?? [],
  });
  await Conversation.updateOne({ _id: conversationId }, { $set: { updatedAt: new Date() } });
  await publish('message.created', { messageId: String(msg._id), role: msg.role }, { conversationId, jobId: input.jobId });
  return msg;
}

export async function listMessages(conversationId: string, limit = 200) {
  return ChatMessage.find({ conversationId }).sort({ createdAt: 1, _id: 1 }).limit(limit).lean();
}

export async function setActiveJob(conversationId: Types.ObjectId | string, jobId: Types.ObjectId | string, title?: string) {
  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { activeJobId: jobId, ...(title ? { title } : {}) } },
  );
}
