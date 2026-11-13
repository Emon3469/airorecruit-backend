import type { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';
import { ChatMessage, Job, PendingAction, type ConversationDoc } from '../models';
import type { Card } from '../domain/cards';
import { matchConfirmIntent } from '../domain/confirmation';
import { chat } from '../llm';
import { checkAgentOutput, checkRateLimit, recordFindings, runInputRails } from '../guardrails/engine';
import { llmIntentClassifier } from '../guardrails/llmClassifier';
import { publish } from '../services/events';
import { ConflictError } from '../lib/errors';

/* ------------------------------------------------------------------ one turn at a time per conversation */
const running = new Set<string>();

const TOOL_STATUS: Record<string, string> = {
  propose_create_job: 'Extracting the job from the description',
  propose_start_sourcing: 'Preparing the sourcing plan',
  propose_review_decisions: 'Selecting candidates',
  propose_campaign: 'Drafting personalised outreach emails',
  propose_status_change: 'Checking the pipeline rules',
  get_stats: 'Crunching the funnel numbers',
  get_candidates: 'Loading candidates',
  search_talent_pool: 'Searching the talent pool',
};

function status(conversationId: string, data: Record<string, unknown>) {
  return publish('agent.status', data, { conversationId });
}

/**
 * Async turn (default for the UI): validates + persists the user message synchronously via the rails,
 * then runs the agent in the background. Progress and the reply arrive over SSE (`agent.status`,
 * `message.created`). Returns immediately, so slow models never hit HTTP timeouts.
 */
export async function startUserTurn(conversationId: string, content: string): Promise<{ turnId: string }> {
  if (running.has(conversationId)) throw new ConflictError('TURN_IN_PROGRESS', 'I am still working on your previous message.');
  await getConversation(conversationId);
  running.add(conversationId);
  const turnId = `${conversationId}-${Date.now()}`;
  void status(conversationId, { turnId, phase: 'started' });
  handleUserMessage(conversationId, content, { lockHeld: true })
    .catch(async (err) => {
      logger.error({ err: (err as Error).message }, 'background turn failed');
      await appendMessage(conversationId, { role: 'assistant', content: `Something went wrong while handling that: ${(err as Error).message}. Nothing was changed.` }).catch(() => undefined);
    })
    .finally(() => {
      running.delete(conversationId);
      void status(conversationId, { turnId, phase: 'done' });
    });
  return { turnId };
}

export function isTurnRunning(conversationId: string) {
  return running.has(conversationId);
}
import { agentSystemPrompt } from '../llm/prompts';
import type { NeutralMessage } from '../llm/types';
import { appendMessage, getConversation } from '../services/chat.service';
import { cancelAction, confirmAction } from '../services/actions.service';
import { linkProposalsToMessage } from '../services/proposals';
import { buildContext, runTool, toolDefinitions, type ToolContext } from './tools';

/**
 * Agent loop (plain tool calling, no framework).
 *
 *   user message ─┬─ pure "yes/confirm/cancel" + exactly one pending proposal → commit/cancel (no LLM involved)
 *                 └─ otherwise → LLM with read_* + propose_* tools, max N iterations
 *
 * The model can read and propose, never commit. Proposals become cards; the recruiter's
 * click (or an unambiguous chat confirmation, matched deterministically) is the only way
 * anything is written or sent.
 */

const HISTORY_LIMIT = 24;

function cardSummary(cards: { type: string; pendingActionId?: unknown }[]): string {
  if (!cards.length) return '';
  return `\n[Cards shown: ${cards.map((c) => `${c.type}${c.pendingActionId ? ` (proposal ${String(c.pendingActionId)})` : ''}`).join(', ')}]`;
}

/** Rebuild provider-neutral history from persisted chat (cards summarised as text). */
async function buildHistory(conversationId: Types.ObjectId): Promise<NeutralMessage[]> {
  const msgs = await ChatMessage.find({ conversationId }).sort({ createdAt: -1, _id: -1 }).limit(HISTORY_LIMIT).lean();
  msgs.reverse();
  const out: NeutralMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const content = `${m.content}${cardSummary(m.cards ?? [])}`.trim() || '(card)';
    const last = out[out.length - 1];
    if (last && last.role === m.role && (last.role === 'user' || last.role === 'assistant')) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      out.push({ role: m.role as 'user' | 'assistant', content });
    }
  }
  while (out.length && out[0]!.role !== 'user') out.shift(); // providers require a user turn first
  return out;
}

export interface TurnResult {
  messages: unknown[];
}

async function messagesSince(conversationId: Types.ObjectId, since: Date) {
  return ChatMessage.find({ conversationId, createdAt: { $gte: since } }).sort({ createdAt: 1, _id: 1 }).lean();
}

export async function handleUserMessage(conversationId: string, content: string, opts: { lockHeld?: boolean } = {}): Promise<TurnResult> {
  if (!opts.lockHeld) {
    if (running.has(conversationId)) throw new ConflictError('TURN_IN_PROGRESS', 'I am still working on your previous message.');
    running.add(conversationId);
    try {
      return await handleUserMessage(conversationId, content, { lockHeld: true });
    } finally {
      running.delete(conversationId);
    }
  }
  const conv = await getConversation(conversationId);
  const started = new Date();
  const ev = { conversationId: conv._id, jobId: conv.activeJobId };

  // 0) Systematic rails: rate limit, then secrets/PII, fair-hiring, intent and dialog rails.
  const limited = checkRateLimit(String(conv._id));
  if (limited) {
    await recordFindings('input', [limited], ev);
    throw new AppError(429, 'RATE_LIMITED', limited.reason);
  }
  const activeJob = conv.activeJobId ? await Job.findById(conv.activeJobId, { title: 1 }) : null;
  const decision = await runInputRails(content, { activeJobTitle: activeJob?.title, llmClassify: llmIntentClassifier });
  // Only the sanitized text is ever persisted or shown to a model (secrets never hit the DB or the LLM).
  await appendMessage(conv._id, { role: 'user', content: decision.sanitized, jobId: conv.activeJobId });
  await recordFindings('input', decision.findings, ev, decision.sanitized);
  if (decision.action !== 'allow') {
    await appendMessage(conv._id, {
      role: 'assistant',
      content: decision.response ?? '',
      jobId: conv.activeJobId,
      toolTrace: [`guardrail:${decision.rail ?? decision.intent}`],
      cards:
        decision.action === 'block'
          ? [{ type: 'GUARDRAIL', payload: { rail: decision.rail, verdict: decision.verdict, findings: decision.findings.filter((f) => f.verdict !== 'pass') } }]
          : [],
    });
    return { messages: await messagesSince(conv._id, started) };
  }
  content = decision.sanitized;

  // 1) Deterministic confirmation path (never decided by the LLM).
  const intent = matchConfirmIntent(content);
  if (intent) {
    const pending = await PendingAction.find({ conversationId: conv._id, status: 'pending' }).sort({ createdAt: -1 });
    // Target resolution, deterministic and unambiguous to the recruiter:
    //  - exactly one pending proposal → that one;
    //  - several pending → the single proposal on the assistant message the recruiter just saw
    //    (immediately before this "yes"); anything else is refused and they use the card buttons.
    let action = pending.length === 1 ? pending[0]! : null;
    if (!action && pending.length > 1) {
      const lastAssistant = await ChatMessage.findOne({ conversationId: conv._id, role: 'assistant', createdAt: { $lt: started } }).sort({ createdAt: -1, _id: -1 });
      const shown = new Set((lastAssistant?.cards ?? []).map((c) => (c.pendingActionId ? String(c.pendingActionId) : '')).filter(Boolean));
      const onLast = pending.filter((p) => shown.has(String(p._id)));
      if (onLast.length === 1) action = onLast[0]!;
    }
    if (action) {
      const others = pending.length - 1;
      const label = action.type.toLowerCase().replace(/_/g, ' ');
      const waiting = others ? ` (${others} other proposal${others === 1 ? ' is' : 's are'} still waiting on ${others === 1 ? 'its card' : 'their cards'})` : '';
      try {
        if (intent === 'confirm') {
          const { outcome } = await confirmAction(String(action._id), 'user_chat');
          // Handlers usually post their own result message; add a short ack when none was posted or others wait.
          const posted = await messagesSince(conv._id, started);
          if (posted.filter((m) => m.role === 'assistant').length === 0 || others) {
            await appendMessage(conv._id, { role: 'assistant', content: `Confirmed: ${outcome.summary}${waiting}.`, jobId: conv.activeJobId });
          }
        } else {
          await cancelAction(String(action._id), 'user_chat');
          await appendMessage(conv._id, { role: 'assistant', content: `Okay, I cancelled the ${label} proposal. Nothing was changed${waiting}.`, jobId: conv.activeJobId });
        }
      } catch (err) {
        await appendMessage(conv._id, {
          role: 'assistant',
          content: `I couldn't ${intent} that: ${(err as Error).message}`,
          jobId: conv.activeJobId,
        });
      }
      return { messages: await messagesSince(conv._id, started) };
    }
    if (pending.length > 1) {
      await appendMessage(conv._id, {
        role: 'assistant',
        content: `There are ${pending.length} proposals waiting for you (${pending.map((p) => p.type.toLowerCase().replace(/_/g, ' ')).join(', ')}). To be safe, please use the Confirm or Cancel button on the specific card.`,
        jobId: conv.activeJobId,
      });
      return { messages: await messagesSince(conv._id, started) };
    }
    // No pending proposal: fall through and let the agent respond normally.
  }

  // 2) Agent loop.
  await runAgentTurn(conv, content, decision.note);
  return { messages: await messagesSince(conv._id, started) };
}

export async function runAgentTurn(conv: ConversationDoc, userMessage: string, note?: string): Promise<void> {
  const ctx: ToolContext = { conversation: conv, conversationId: conv._id, userMessage };
  const messages = await buildHistory(conv._id);
  const tools = toolDefinitions();
  const cards: Card[] = [];
  const actionIds: string[] = [];
  const trace: string[] = [];
  let finalText = '';
  let jobId: string | null = conv.activeJobId ? String(conv.activeJobId) : null;

  try {
    for (let i = 0; i < env.AGENT_MAX_ITERATIONS; i++) {
      void status(String(conv._id), { phase: 'thinking', step: i + 1 });
      const system = agentSystemPrompt(await buildContext(conv));
      const res = await chat(
        { tier: 'agent', system, messages, tools, maxTokens: 8000, effort: 'medium' },
        { purpose: 'agent', jobId, conversationId: conv._id },
      );
      if (res.stopReason === 'refusal') {
        finalText = "I can't help with that request.";
        break;
      }
      if (!res.toolCalls.length) {
        finalText = res.text;
        break;
      }
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, raw: res.raw });
      for (const call of res.toolCalls) {
        trace.push(call.name);
        void status(String(conv._id), { phase: 'tool', tool: call.name, label: TOOL_STATUS[call.name] ?? 'Working' });
        let output;
        try {
          output = await runTool(call.name, call.input, ctx);
        } catch (err) {
          const msg = err instanceof AppError ? err.message : `Tool failed: ${(err as Error).message}`;
          if (!(err instanceof AppError)) logger.error({ err, tool: call.name }, 'tool error');
          output = { result: { error: msg } };
        }
        if (output.cards) cards.push(...output.cards);
        if (output.actionIds) actionIds.push(...output.actionIds);
        if (output.jobId) jobId = output.jobId;
        const text = JSON.stringify(output.result);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: text.length > 12_000 ? `${text.slice(0, 12_000)}…(truncated)` : text,
          isError: 'error' in output.result,
        });
      }
      finalText = res.text; // keep any interim text in case we hit the iteration cap
    }
    if (!finalText) {
      finalText = cards.some((c) => c.pendingActionId)
        ? 'I prepared the card above. Please review it and confirm.'
        : 'Done. Let me know what you would like to do next.';
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'agent turn failed');
    finalText =
      err instanceof AppError
        ? err.message
        : `I couldn't reach the AI model just now (${(err as Error).message.slice(0, 160)}). Nothing was changed; please try again.`;
  }

  // De-duplicate cards (e.g. the model listed candidates twice).
  const seen = new Set<string>();
  const unique = cards.filter((c) => {
    const key = `${c.type}:${c.pendingActionId ?? JSON.stringify(c.payload)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Output rail: no secrets, no claims that something already happened while it is only proposed.
  const out = checkAgentOutput(finalText, { proposedThisTurn: actionIds.length > 0 });
  await recordFindings('output', out.findings, { conversationId: conv._id, jobId }, finalText);
  finalText = note ? `${out.text}\n\n${note}` : out.text;

  const msg = await appendMessage(conv._id, { role: 'assistant', content: finalText, cards: unique, jobId, toolTrace: trace });
  await linkProposalsToMessage(actionIds, msg._id);
}
