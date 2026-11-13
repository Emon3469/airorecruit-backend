import { Router } from 'express';
import { z } from 'zod';
import { Conversation } from '../../models';
import { ah, idParam, parse } from '../middleware';
import { createConversation, getConversation, listMessages } from '../../services/chat.service';
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
