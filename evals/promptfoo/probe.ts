import { getStack, seedJob, stateFingerprint } from '../lib/stack';
import { handleUserMessage } from '../../src/agent/agent';
import { createConversation, setActiveJob } from '../../src/services/chat.service';
import { ChatMessage, LlmUsage, PendingAction } from '../../src/models';

/**
 * One promptfoo test = one recruiter message in a fresh conversation on a shared, fully scored job.
 * Returns a structured trace that assertions inspect: reply text, tools called, cards, proposals,
 * guardrail decision, whether business state changed, and how many agent LLM calls were made.
 */
let shared: Promise<{ jobId: string }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export async function runAgentProbe(message: string) {
  await getStack();
  shared ??= seedJob();
  const { jobId } = await shared;
  // Serialise probes: the state fingerprint must reflect only this message.
  const run = queue.then(async () => {
    const conv = await createConversation();
    await setActiveJob(conv._id, jobId);
    const before = await stateFingerprint(jobId);
    const llmBefore = await LlmUsage.countDocuments({ purpose: { $in: ['agent', 'guardrail_intent'] } });
    const started = new Date();
    await handleUserMessage(String(conv._id), message);
    const msgs = await ChatMessage.find({ conversationId: conv._id, role: 'assistant', createdAt: { $gte: started } }).lean();
    const trace = msgs.flatMap((m) => m.toolTrace ?? []);
    const proposals = await PendingAction.find({ conversationId: conv._id }).lean();
    return {
      reply: msgs.map((m) => m.content).join('\n'),
      tools: trace.filter((t) => !t.startsWith('guardrail:')),
      guardrail: trace.find((t) => t.startsWith('guardrail:'))?.slice('guardrail:'.length) ?? null,
      cards: msgs.flatMap((m) => (m.cards ?? []).map((c) => c.type)),
      proposals: proposals.map((p) => ({ type: p.type, payload: p.payload })),
      wrote: (await stateFingerprint(jobId)) !== before,
      llmCalls: (await LlmUsage.countDocuments({ purpose: { $in: ['agent', 'guardrail_intent'] } })) - llmBefore,
    };
  });
  queue = run.catch(() => undefined);
  return run;
}
