/**
 * Guardrail layer: a TypeScript port of the NeMo Guardrails concepts (input / output / dialog /
 * retrieval / fact-check rails, systematic vs intent rails, actions) adapted to recruiting.
 *
 *  NeMo concept                         → here
 *  ----------------------------------------------------------------------------------------
 *  systematic input rail (every msg)    → secrets/PII redaction, fair-hiring scan, rate limit
 *  intent rail (`define user X`)        → canonical-utterance classifier (intents.ts) + regex triggers
 *  dialog rail (`define flow greeting`) → deterministic greeting / capabilities / farewell responses
 *  output rail                          → agent text (secrets, false "I've sent it" claims)
 *  retrieval rail                       → tool results scrubbed before they reach the tool-enabled agent
 *  fact-check rail                      → outbound emails checked against JD facts (salary, links)
 *  custom actions (@action)             → plain async functions; every trigger is a GuardrailEvent
 */
export type Verdict = 'pass' | 'warn' | 'block';

export type RailName =
  | 'secrets'
  | 'pii'
  | 'off_topic'
  | 'jailbreak'
  | 'hitl_bypass'
  | 'fairness'
  | 'privacy'
  | 'dialog'
  | 'rate_limit'
  | 'outbound'
  | 'agent_output'
  | 'retrieval'
  | 'urgency'
  | 'budget'
  | 'injection';

export type Stage = 'input' | 'output' | 'outbound' | 'retrieval' | 'jd' | 'scoring' | 'reply' | 'llm';

export interface Finding {
  rail: RailName;
  verdict: Verdict;
  /** Human-readable reason shown on cards and in the audit log. */
  reason: string;
  /** Matched fragments (already redacted where sensitive). */
  matches?: string[];
}

export function worst(findings: Finding[]): Verdict {
  if (findings.some((f) => f.verdict === 'block')) return 'block';
  if (findings.some((f) => f.verdict === 'warn')) return 'warn';
  return 'pass';
}
