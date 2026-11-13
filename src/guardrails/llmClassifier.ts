import { isMockLlm, json } from '../llm';
import { wrapUntrusted } from '../domain/untrusted';
import { INTENT_LLM_SYSTEM, IntentLlmSchema } from './engine';

/**
 * Recall layer of the intent rail (NeMo-style LLM intent classification), used only when a real model
 * is configured and the deterministic layer found nothing. Deterministic rules give precision (0%
 * false positives on the held-out set); this layer adds recall on paraphrases. Fast tier, schema-locked,
 * tool-less, and it answers "none" when unsure.
 */
export async function llmIntentClassifier(text: string) {
  if (isMockLlm()) return null;
  return json(
    {
      tier: 'fast',
      system: INTENT_LLM_SYSTEM,
      prompt: `Recruiter message:\n${wrapUntrusted('recruiter_message', text)}`,
      schema: IntentLlmSchema,
      schemaName: 'guardrail_intent',
      effort: 'low',
      maxTokens: 300,
      mock: () => ({ intent: 'none' as const, confidence: 0 }),
    },
    { purpose: 'guardrail_intent' },
  );
}
