import { Router } from 'express';
import { z } from 'zod';
import { isValidId } from '../../models';
import { ah, parse } from '../middleware';
import { guardrailEvents, opsMetrics } from '../../services/ops.service';
import { runInputRails } from '../../guardrails/engine';
import { checkOutboundEmail } from '../../guardrails/outbound';
import { scanFairness } from '../../guardrails/fairness';
import { detectUrgency } from '../../guardrails/urgency';
import { classifyIntent } from '../../guardrails/intents';

export const opsRouter = Router();
const id = z.string().refine(isValidId, 'invalid id');

/** LLMOps / MLOps / HITL metrics. */
opsRouter.get(
  '/ops/metrics',
  ah(async (req, res) => {
    const q = parse(z.object({ jobId: id.optional(), sinceHours: z.coerce.number().min(1).max(24 * 365).optional() }), req.query);
    res.json(await opsMetrics(q));
  }),
);

/** Audit log of guardrail triggers. */
opsRouter.get(
  '/guardrails/events',
  ah(async (req, res) => {
    const q = parse(z.object({ jobId: id.optional(), conversationId: id.optional(), rail: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
    res.json({ events: await guardrailEvents(q) });
  }),
);

/**
 * Guardrail playground: run a rail on arbitrary text without side effects (no events recorded).
 * Used by the UI (live warnings while editing drafts) and by the eval harness.
 */
opsRouter.post(
  '/guardrails/check',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        mode: z.enum(['input', 'email', 'jd', 'reply']),
        text: z.string().max(60_000),
        subject: z.string().max(300).optional(),
        recipientEmail: z.string().max(200).optional(),
        allowedLinks: z.array(z.string().max(500)).max(5).optional(),
        salaryRaw: z.string().max(200).optional(),
      }),
      req.body,
    );
    switch (body.mode) {
      case 'input': {
        const d = await runInputRails(body.text);
        res.json({ ...d, intent: classifyIntent(d.sanitized) });
        return;
      }
      case 'email':
        res.json(checkOutboundEmail({ subject: body.subject ?? '', body: body.text, recipientEmail: body.recipientEmail, allowedLinks: body.allowedLinks, job: { salaryRaw: body.salaryRaw } }));
        return;
      case 'jd':
        res.json(scanFairness(body.text, 'jd'));
        return;
      case 'reply':
        res.json({ urgency: detectUrgency(body.text) });
        return;
    }
  }),
);
