import { z } from 'zod';
import { Candidate, Job } from '../models';
import { NotFoundError } from '../lib/errors';
import { heuristicScore } from '../domain/heuristics';
import { json, LlmSchemaError } from '../llm';
import { SCORING_SYSTEM } from '../llm/prompts';
import { wrapUntrusted } from '../domain/untrusted';
import { publish } from './events';
import { indexCandidatesSafe } from './talent.service';
import { scanFairness } from '../guardrails/fairness';
import { recordFindings } from '../guardrails/engine';

export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().trim().min(5).max(300),
  confidence: z.enum(['low', 'medium', 'high']),
  matchedSkills: z.array(z.string()).max(30),
  missingData: z.array(z.string()).max(10),
});
export type ScoreResult = z.infer<typeof ScoreSchema>;

/**
 * Score one candidate against the job rubric (fast model, schema-locked, tool-less).
 * Returns 'scored' or 'failed'. Never invents a score: on a persistent schema failure the
 * candidate is marked `scoring_failed` with score = null.
 * Transient provider errors are thrown so BullMQ retries with backoff.
 */
export async function scoreCandidate(candidateId: string, runId: string | null): Promise<'scored' | 'failed' | 'skipped'> {
  const cand = await Candidate.findById(candidateId);
  if (!cand) throw new NotFoundError('Candidate');
  if (runId && cand.scoredRunId && String(cand.scoredRunId) === runId) return 'skipped'; // retry after success
  const job = await Job.findById(cand.jobId);
  if (!job) throw new NotFoundError('Job');

  const facts = {
    name: cand.name,
    headline: cand.headline,
    skills: cand.skills,
    location: cand.location,
    yearsExperience: cand.yearsExperience,
    snippet: cand.snippet,
    email: cand.email,
  };
  const rubric = {
    title: job.title,
    seniority: job.seniority ?? null,
    mustHaveSkills: job.mustHaveSkills,
    niceToHaveSkills: job.niceToHaveSkills,
    location: job.location ?? null,
    remotePolicy: job.remotePolicy,
  };

  const candidateData = [
    `Name: ${cand.name}`,
    `Headline: ${cand.headline ?? 'unknown'}`,
    `Current company: ${cand.currentCompany ?? 'unknown'}`,
    `Location: ${cand.location ?? 'unknown'}`,
    `Years of experience: ${cand.yearsExperience ?? 'unknown'}`,
    `Skills: ${cand.skills.length ? cand.skills.join(', ') : 'unknown'}`,
    `Email on file: ${cand.email ? 'yes' : 'no'}`,
    `Source: ${cand.source}`,
    `Notes/snippet: ${cand.snippet ?? 'none'}`,
  ].join('\n');

  let result: ScoreResult;
  try {
    result = await json(
      {
        tier: 'fast',
        system: SCORING_SYSTEM,
        prompt: `JOB RUBRIC (trusted):\n${JSON.stringify(rubric, null, 2)}\n\nCANDIDATE:\n${wrapUntrusted(cand.source, candidateData)}\n\nScore this candidate.`,
        schema: ScoreSchema,
        schemaName: 'candidate_score',
        effort: 'low',
        maxTokens: 1500,
        mock: () => heuristicScore(rubric, facts),
      },
      { purpose: 'scoring', jobId: job._id },
    );
  } catch (err) {
    if (!(err instanceof LlmSchemaError)) throw err;
    await Candidate.updateOne(
      { _id: cand._id },
      { $set: { score: null, scoreReason: null, scoringStatus: 'failed', scoredRunId: runId, missingData: [...new Set([...cand.missingData, 'scoring_failed'])] } },
    );
    await publish('state_sync', { reason: 'scored', candidateIds: [String(cand._id)] }, { jobId: job._id });
    return 'failed';
  }

  // Missing data is computed from facts we hold, merged with what the model reported.
  const missing = new Set(result.missingData.map((m) => m.toLowerCase()));
  if (!cand.email) missing.add('email');
  if (cand.injectionFlag) missing.add('contains instructions');

  // Fair-hiring rail on the model's reasoning: a score justified by a protected characteristic is flagged.
  const fairness = scanFairness(result.reason, 'reason');
  if (fairness.verdict === 'block') {
    missing.add('fairness_review');
    result.reason = `[Flagged for review: reason referenced a protected characteristic] ${result.reason}`.slice(0, 300);
    result.confidence = 'low';
  }
  await recordFindings('scoring', fairness.findings, { jobId: job._id, candidateId: cand._id }, result.reason);

  const updated = await Candidate.findOneAndUpdate(
    { _id: cand._id, ...(runId ? { scoredRunId: { $ne: runId } } : {}) },
    {
      $set: {
        score: result.score,
        scoreReason: result.reason,
        scoreConfidence: cand.source === 'serper' && !cand.skills.length ? 'low' : result.confidence,
        matchedSkills: result.matchedSkills.slice(0, 20),
        missingData: [...missing].slice(0, 10),
        scoringStatus: 'scored',
        scoredRunId: runId,
      },
    },
    { new: true },
  );
  if (!updated) return 'skipped';
  await publish('state_sync', { reason: 'scored', candidateIds: [String(cand._id)] }, { jobId: job._id });
  // Keep the talent pool index fresh (best effort; never fails scoring).
  await indexCandidatesSafe([cand._id]);
  return 'scored';
}
