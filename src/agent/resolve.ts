import type { Types } from 'mongoose';
import { z } from 'zod';
import { Candidate, type CandidateDoc } from '../models';
import { CANDIDATE_STATUSES, parseStatus, type CandidateStatus } from '../domain/pipeline';

/**
 * Candidate reference resolution happens SERVER-SIDE, deterministically.
 * The LLM passes what the recruiter said ("Rahim", "the top 5", "everyone above 80");
 * this module turns it into concrete candidates or reports what is ambiguous/unknown.
 * It never guesses: two "Rahim"s → ambiguous, with the options listed.
 */
export const SelectorSchema = z
  .object({
    names: z.array(z.string().min(1).max(120)).max(50).optional().describe('Candidate names or first names exactly as the recruiter said them'),
    top: z.number().int().min(1).max(200).optional().describe('Take the N highest-scored candidates (within `status` if given)'),
    minScore: z.number().min(0).max(100).optional().describe('Only candidates with score >= this'),
    maxScore: z.number().min(0).max(100).optional().describe('Only candidates with score < this (e.g. "below 40" → 40)'),
    status: z.string().optional().describe('Restrict to candidates currently in this status, e.g. "Sourced", "Accepted"'),
    all: z.boolean().optional().describe('All candidates matching the other filters'),
  })
  .describe('Which candidates. Use names for specific people, or top/minScore/status/all for groups.');
export type Selector = z.infer<typeof SelectorSchema>;

export interface Unresolved {
  ref: string;
  reason: 'not_found' | 'ambiguous';
  options?: { id: string; name: string; status: string; score: number | null }[];
}

export interface Resolution {
  candidates: CandidateDoc[];
  unresolved: Unresolved[];
  description: string;
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Match one name reference against a pool. Ordered strategies; the first that yields hits wins. */
export function matchName(ref: string, pool: CandidateDoc[]): CandidateDoc[] {
  const r = norm(ref);
  if (!r) return [];
  const tokens = r.split(' ');
  const strategies: ((c: CandidateDoc) => boolean)[] = [
    (c) => norm(c.name) === r,
    (c) => tokens.every((t) => norm(c.name).split(' ').includes(t)),
    (c) => norm(c.name).split(' ')[0] === tokens[0] && tokens.length === 1,
    (c) => norm(c.name).split(' ').some((p) => p === r),
    (c) => tokens.every((t) => norm(c.name).includes(t)),
    (c) => r.length >= 4 && norm(c.name).split(' ').some((p) => p.length >= 4 && levenshtein(p, r) <= 1),
  ];
  for (const s of strategies) {
    const hits = pool.filter(s);
    if (hits.length) return hits;
  }
  return [];
}

export async function resolveCandidates(
  jobId: Types.ObjectId | string,
  sel: Selector,
  opts: { defaultStatus?: CandidateStatus } = {},
): Promise<Resolution> {
  const status = sel.status ? parseStatus(sel.status) ?? (CANDIDATE_STATUSES.includes(sel.status as CandidateStatus) ? (sel.status as CandidateStatus) : null) : null;
  const pool = await Candidate.find({ jobId }).sort({ score: -1, createdAt: 1 });
  const unresolved: Unresolved[] = [];
  const picked = new Map<string, CandidateDoc>();
  const desc: string[] = [];

  if (sel.names?.length) {
    for (const ref of sel.names) {
      const hits = matchName(ref, pool);
      if (!hits.length) unresolved.push({ ref, reason: 'not_found' });
      else if (hits.length > 1)
        unresolved.push({
          ref,
          reason: 'ambiguous',
          options: hits.slice(0, 8).map((h) => ({ id: String(h._id), name: h.name, status: h.status, score: h.score ?? null })),
        });
      else picked.set(String(hits[0]!._id), hits[0]!);
    }
    desc.push(`named: ${sel.names.join(', ')}`);
  }

  if (sel.top || sel.minScore !== undefined || sel.maxScore !== undefined || sel.all || (status && !sel.names?.length)) {
    const effectiveStatus = status ?? opts.defaultStatus ?? null;
    let group = pool.filter((c) => !effectiveStatus || c.status === effectiveStatus);
    if (sel.minScore !== undefined) group = group.filter((c) => (c.score ?? -1) >= sel.minScore!);
    if (sel.maxScore !== undefined) group = group.filter((c) => c.score !== null && c.score !== undefined && c.score < sel.maxScore!);
    if (sel.top) group = group.filter((c) => c.score !== null && c.score !== undefined).slice(0, sel.top);
    for (const c of group) picked.set(String(c._id), c);
    desc.push(
      [sel.top ? `top ${sel.top} by score` : sel.all ? 'all' : null, sel.minScore !== undefined ? `score ≥ ${sel.minScore}` : null, sel.maxScore !== undefined ? `score < ${sel.maxScore}` : null, effectiveStatus ? `in ${effectiveStatus}` : null]
        .filter(Boolean)
        .join(', '),
    );
  }
  return { candidates: [...picked.values()], unresolved, description: desc.filter(Boolean).join('; ') };
}

export function describeUnresolved(u: Unresolved[]): string {
  return u
    .map((x) =>
      x.reason === 'not_found'
        ? `No candidate matches "${x.ref}" in this job.`
        : `"${x.ref}" is ambiguous: ${x.options!.map((o) => `${o.name} (${o.status}${o.score !== null ? `, ${o.score}` : ''})`).join(', ')}. Ask which one.`,
    )
    .join(' ');
}
