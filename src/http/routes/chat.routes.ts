import { Router } from 'express';
import { z } from 'zod';
import { Conversation } from '../../models';
import { ah, idParam, parse } from '../middleware';
import { NotFoundError } from '../../lib/errors';
import { appendMessage, createConversation, getConversation, listMessages } from '../../services/chat.service';
import { handleUserMessage, isTurnRunning, startUserTurn } from '../../agent/agent';
import { cancelAction, confirmAction, getAction, pendingActions, updateActionPayload } from '../../services/actions.service';

export const chatRouter = Router();

/* --------------------------------------------------------------- conversations */
chatRouter.post(
  '/conversations',
  ah(async (_req, res) => {
    const conv = await createConversation();
    res.status(201).json({ conversation: conv, messages: await listMessages(String(conv._id)) });
  }),
);

chatRouter.get(
  '/conversations',
  ah(async (_req, res) => {
    res.json({ conversations: await Conversation.find({}).sort({ updatedAt: -1 }).limit(50).lean() });
  }),
);

chatRouter.get(
  '/conversations/:id',
  ah(async (req, res) => {
    const conv = await getConversation(idParam(req));
    res.json({ conversation: conv, pendingActions: await pendingActions(String(conv._id)), turnInProgress: isTurnRunning(String(conv._id)) });
  }),
);

/**
 * Collaboration: "Message" (shared with teammates) and "Note" (private, pinned) entries live in the
 * session timeline but are never sent to the agent. Secrets are still redacted before storage.
 */
chatRouter.post(
  '/conversations/:id/notes',
  ah(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ kind: z.enum(['message', 'note']), content: z.string().trim().min(1).max(10_000), authorName: z.string().max(80).optional() }), req.body);
    const conv = await getConversation(id);
    const { redact } = await import('../../guardrails/pii');
    const msg = await appendMessage(conv._id, { role: 'user', content: redact(body.content).text, kind: body.kind, authorName: body.authorName ?? 'You', jobId: conv.activeJobId });
    res.status(201).json({ message: msg });
  }),
);

/** Session rename (the session title in the UI header). */
chatRouter.patch(
  '/conversations/:id/title',
  ah(async (req, res) => {
    const { title } = parse(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    const conv = await Conversation.findByIdAndUpdate(idParam(req), { $set: { title } }, { new: true });
    if (!conv) throw new NotFoundError('Conversation');
    res.json({ conversation: conv });
  }),
);

/** Job switcher in the UI: the agent's context follows the job the recruiter is looking at. */
chatRouter.patch(
  '/conversations/:id',
  ah(async (req, res) => {
    const id = idParam(req);
    const { activeJobId } = parse(z.object({ activeJobId: z.string().regex(/^[a-f0-9]{24}$/i) }), req.body);
    const conv = await Conversation.findByIdAndUpdate(id, { $set: { activeJobId } }, { new: true });
    if (!conv) throw new NotFoundError('Conversation');
    res.json({ conversation: conv });
  }),
);

chatRouter.get(
  '/conversations/:id/messages',
  ah(async (req, res) => {
    const id = idParam(req);
    await getConversation(id);
    res.json({ messages: await listMessages(id) });
  }),
);

chatRouter.post(
  '/conversations/:id/messages',
  ah(async (req, res) => {
    const id = idParam(req);
    const { content, async: runAsync } = parse(z.object({ content: z.string().trim().min(1).max(60_000), async: z.boolean().optional() }), req.body);
    if (runAsync) {
      // UI mode: returns at once; the reply and live agent status stream over SSE.
      res.status(202).json(await startUserTurn(id, content));
      return;
    }
    res.status(201).json(await handleUserMessage(id, content));
  }),
);

/* --------------------------------------------------------------- proposals (commit side) */
chatRouter.get(
  '/actions/:id',
  ah(async (req, res) => {
    res.json({ action: await getAction(idParam(req)) });
  }),
);

/** Edit a proposal before confirming (editable cards). */
chatRouter.patch(
  '/actions/:id',
  ah(async (req, res) => {
    const { payload } = parse(z.object({ payload: z.record(z.string(), z.unknown()) }), req.body);
    res.json({ action: await updateActionPayload(idParam(req), payload) });
  }),
);

/** The card's Confirm button. A click is an explicit approval by the recruiter. */
chatRouter.post(
  '/actions/:id/confirm',
  ah(async (req, res) => {
    const body = parse(z.object({ payload: z.record(z.string(), z.unknown()).optional() }), req.body ?? {});
    const { action, outcome } = await confirmAction(idParam(req), 'user_ui', body.payload);
    res.json({ action, outcome });
  }),
);

chatRouter.post(
  '/actions/:id/cancel',
  ah(async (req, res) => {
    res.json({ action: await cancelAction(idParam(req), 'user_ui') });
  }),
);
