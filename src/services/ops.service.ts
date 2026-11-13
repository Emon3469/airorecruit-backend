import type { Types } from 'mongoose';
import { Candidate, GuardrailEvent, LlmUsage, PendingAction, Reply, oid } from '../models';

/**
 * LLMOps / MLOps read model (GET /api/ops/metrics).
 *  - LLM:        calls, p50/p95 latency, tokens, cost, error / repair / schema-failure / fallback rates,
 *                broken down by purpose and prompt version (so a prompt change is measurable)
 *  - Guardrails: trigger counts by rail × verdict
 *  - HITL:       proposals created vs confirmed/cancelled/superseded, approval rate, time to decision,
 *                chat vs button confirmations
 *  - Model monitoring: score distribution, confidence mix, scoring failure rate, and PSI drift of
 *                this job's score distribution against all other jobs
 *  - Replies:    classification mix, mean confidence, injection and urgency rates
 */

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101];
function histogram(scores: number[]) {
  const counts = new Array(BUCKETS.length - 1).fill(0) as number[];
  for (const s of scores) {
    const i = BUCKETS.findIndex((b, idx) => idx < BUCKETS.length - 1 && s >= b && s < BUCKETS[idx + 1]!);
    if (i >= 0) counts[i]!++;
  }
  return counts;
}

/** Population Stability Index: <0.1 stable, 0.1–0.25 moderate shift, >0.25 significant drift. */
export function psi(expected: number[], actual: number[]): number | null {
  const e = expected.reduce((a, b) => a + b, 0);
  const a = actual.reduce((x, y) => x + y, 0);
  if (!e || !a) return null;
  let total = 0;
  for (let i = 0; i < expected.length; i++) {
    const pe = Math.max(expected[i]! / e, 1e-4);
    const pa = Math.max(actual[i]! / a, 1e-4);
    total += (pa - pe) * Math.log(pa / pe);
  }
  return Number(total.toFixed(4));
}

export async function opsMetrics(opts: { jobId?: string; sinceHours?: number } = {}) {
  const since = new Date(Date.now() - (opts.sinceHours ?? 24 * 30) * 3600_000);
  const jobFilter = opts.jobId ? { jobId: oid(opts.jobId) } : {};

  /* ---------------- LLM */
  const usage = await LlmUsage.find({ ...jobFilter, createdAt: { $gte: since } }, { purpose: 1, model: 1, latencyMs: 1, promptTokens: 1, completionTokens: 1, costUsd: 1, status: 1, promptVersion: 1 })
    .sort({ createdAt: -1 })
    .limit(20_000)
    .lean();
  const byPurpose = new Map<string, typeof usage>();
  for (const u of usage) byPurpose.set(u.purpose, [...(byPurpose.get(u.purpose) ?? []), u]);
  const llm = [...byPurpose.entries()].map(([purpose, rows]) => {
    const lat = rows.filter((r) => r.status !== 'mock').map((r) => r.latencyMs).sort((a, b) => a - b);
    const status = rows.reduce<Record<string, number>>((m, r) => ((m[r.status ?? 'ok'] = (m[r.status ?? 'ok'] ?? 0) + 1), m), {});
    const n = rows.length;
    return {
      purpose,
      calls: n,
      models: [...new Set(rows.map((r) => r.model))],
      promptVersions: [...new Set(rows.map((r) => r.promptVersion).filter(Boolean))],
      latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
      tokens: rows.reduce((a, r) => a + r.promptTokens + r.completionTokens, 0),
      costUsd: Number(rows.reduce((a, r) => a + r.costUsd, 0).toFixed(5)),
      status,
      errorRate: n ? Number(((status.error ?? 0) / n).toFixed(3)) : 0,
      repairRate: n ? Number(((status.repaired ?? 0) / n).toFixed(3)) : 0,
      schemaFailureRate: n ? Number(((status.schema_error ?? 0) / n).toFixed(3)) : 0,
    };
  });

  /* ---------------- Guardrails */
  const gAgg = await GuardrailEvent.aggregate<{ _id: { rail: string; verdict: string; stage: string }; n: number }>([
    { $match: { ...jobFilter, createdAt: { $gte: since } } },
    { $group: { _id: { rail: '$rail', verdict: '$verdict', stage: '$stage' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  /* ---------------- HITL */
  const actions = await PendingAction.find({ ...jobFilter, createdAt: { $gte: since } }, { type: 1, status: 1, createdAt: 1, resolvedAt: 1, resolvedBy: 1, proposedBy: 1 }).lean();
  const decided = actions.filter((a) => a.resolvedAt && a.status !== 'pending');
  const ttd = decided.map((a) => a.resolvedAt!.getTime() - a.createdAt!.getTime()).sort((a, b) => a - b);
  const count = (f: (a: (typeof actions)[number]) => boolean) => actions.filter(f).length;
  const confirmed = count((a) => a.status === 'confirmed');
  const resolvedByHuman = count((a) => a.status === 'confirmed' || a.status === 'cancelled');
  const hitl = {
    proposals: actions.length,
    byStatus: actions.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}),
    byType: actions.reduce<Record<string, number>>((m, a) => ((m[a.type] = (m[a.type] ?? 0) + 1), m), {}),
    approvalRate: resolvedByHuman ? Number((confirmed / resolvedByHuman).toFixed(3)) : null,
    confirmedVia: { button: count((a) => a.status === 'confirmed' && a.resolvedBy === 'user_ui'), chat: count((a) => a.status === 'confirmed' && a.resolvedBy === 'user_chat') },
    timeToDecisionMs: { p50: percentile(ttd, 50), p95: percentile(ttd, 95) },
    /** Invariant: every confirmation has a human actor. Anything else would be a HITL breach. */
    nonHumanConfirmations: count((a) => a.status === 'confirmed' && !['user_ui', 'user_chat'].includes(a.resolvedBy ?? '')),
  };

  /* ---------------- Model monitoring (scoring) */
  const scored = await Candidate.find({ ...jobFilter, scoringStatus: { $in: ['scored', 'failed'] } }, { score: 1, scoreConfidence: 1, scoringStatus: 1, jobId: 1 }).lean();
  const scores = scored.filter((c) => typeof c.score === 'number').map((c) => c.score as number);
  let drift: { psi: number | null; interpretation: string } | null = null;
  if (opts.jobId) {
    const others = await Candidate.find({ jobId: { $ne: oid(opts.jobId) }, scoringStatus: 'scored' }, { score: 1 }).limit(20_000).lean();
    const value = psi(histogram(others.map((o) => o.score as number)), histogram(scores));
    drift = { psi: value, interpretation: value === null ? 'not enough data' : value < 0.1 ? 'stable' : value < 0.25 ? 'moderate shift' : 'significant drift' };
  }
  const scoring = {
    candidates: scored.length,
    failureRate: scored.length ? Number((scored.filter((c) => c.scoringStatus === 'failed').length / scored.length).toFixed(3)) : 0,
    mean: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    histogram: { buckets: BUCKETS.slice(0, -1).map((b) => `${b}-${b + 9}`), counts: histogram(scores) },
    confidence: scored.reduce<Record<string, number>>((m, c) => ((m[c.scoreConfidence ?? 'n/a'] = (m[c.scoreConfidence ?? 'n/a'] ?? 0) + 1), m), {}),
    drift,
  };

  /* ---------------- Replies */
  const replies = await Reply.find({ ...jobFilter, status: 'processed' }, { classification: 1, confidence: 1, injectionFlag: 1, priority: 1 }).lean();
  const replyStats = {
    processed: replies.length,
    classes: replies.reduce<Record<string, number>>((m, r) => ((m[r.classification ?? 'n/a'] = (m[r.classification ?? 'n/a'] ?? 0) + 1), m), {}),
    meanConfidence: replies.length ? Number((replies.reduce((a, r) => a + (r.confidence ?? 0), 0) / replies.length).toFixed(3)) : null,
    injectionRate: replies.length ? Number((replies.filter((r) => r.injectionFlag).length / replies.length).toFixed(3)) : 0,
    highPriority: replies.filter((r) => r.priority === 'high').length,
  };

  return {
    window: { since: since.toISOString(), jobId: opts.jobId ?? null },
    llm,
    guardrails: gAgg.map((g) => ({ ...g._id, count: g.n })),
    hitl,
    scoring,
    replies: replyStats,
  };
}

export async function guardrailEvents(filter: { jobId?: string; conversationId?: string; rail?: string; limit?: number }) {
  const q: Record<string, unknown> = {};
  if (filter.jobId) q.jobId = oid(filter.jobId);
  if (filter.conversationId) q.conversationId = oid(filter.conversationId) as Types.ObjectId;
  if (filter.rail) q.rail = filter.rail;
  return GuardrailEvent.find(q).sort({ createdAt: -1 }).limit(Math.min(filter.limit ?? 100, 500)).lean();
}
