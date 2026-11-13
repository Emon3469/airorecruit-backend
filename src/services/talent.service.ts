import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { Candidate, Job, type CandidateDoc, type JobDoc } from '../models';
import { NotFoundError } from '../lib/errors';
import { embed } from '../vector/embeddings';
import { vectorStore } from '../vector/store';
import type { SourcedRow } from './sourcing.service';

/**
 * Talent rediscovery: semantic search over candidates sourced for OTHER jobs.
 *
 * Rules (compliance + zero-hallucination):
 *  - Only professional facts are embedded (headline, skills, experience, location, company).
 *    Names, emails and phone numbers are never embedded or sent anywhere.
 *  - Unsubscribed candidates are never resurfaced (they asked not to be contacted again), and
 *    neither are hired ones. People already in the target job are skipped (same email/profile).
 *  - Search is read-only. Copying candidates into a job only happens inside a START_SOURCING run
 *    the recruiter confirmed; copies are re-scored against the new job and keep their provenance.
 */
const EXCLUDED_STATUSES = new Set(['Unsubscribed', 'Hired']);
/** Cosine threshold for a pool match (all-MiniLM-L6-v2: related roles ~0.65-0.8, unrelated engineers ~0.45). */
export const MIN_SIMILARITY = env.TALENT_MIN_SIMILARITY;

export const talentEnabled = () => env.EMBEDDINGS !== 'off';

export function candidateText(c: Pick<CandidateDoc, 'headline' | 'skills' | 'yearsExperience' | 'location' | 'currentCompany' | 'matchedSkills'>): string {
  return [
    c.headline ? `Role: ${c.headline}` : null,
    c.skills?.length ? `Skills: ${c.skills.join(', ')}` : c.matchedSkills?.length ? `Skills: ${c.matchedSkills.join(', ')}` : null,
    c.yearsExperience != null ? `Experience: ${c.yearsExperience} years` : null,
    c.location ? `Location: ${c.location}` : null,
    c.currentCompany ? `Company: ${c.currentCompany}` : null,
  ]
    .filter(Boolean)
    .join('. ');
}

export function jobText(j: Pick<JobDoc, 'title' | 'mustHaveSkills' | 'niceToHaveSkills' | 'seniority' | 'location' | 'summary'>): string {
  return [
    `Role: ${j.title}`,
    j.seniority ? `Seniority: ${j.seniority}` : null,
    j.mustHaveSkills.length ? `Skills: ${j.mustHaveSkills.join(', ')}` : null,
    j.niceToHaveSkills.length ? `Also: ${j.niceToHaveSkills.join(', ')}` : null,
    j.location ? `Location: ${j.location}` : null,
    j.summary ?? null,
  ]
    .filter(Boolean)
    .join('. ');
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Embed + upsert candidates whose professional text changed (idempotent; called by the scoring worker). */
export async function indexCandidates(ids: (Types.ObjectId | string)[]): Promise<number> {
  if (!talentEnabled() || !ids.length) return 0;
  const cands = await Candidate.find({ _id: { $in: ids } });
  const items = cands.map((c) => ({ c, text: candidateText(c) })).filter((x) => x.text.length > 10);
  if (!items.length) return 0;
  const store = vectorStore();
  const existing = await store.hashes(items.map((x) => String(x.c._id)));
  const todo = items.filter((x) => existing.get(String(x.c._id)) !== hash(x.text));
  if (!todo.length) return 0;
  const vectors = await embed(todo.map((x) => x.text));
  await store.upsert(todo.map((x, i) => ({ candidateId: String(x.c._id), jobId: String(x.c.jobId), vector: vectors[i]!, textHash: hash(x.text) })));
  return todo.length;
}

/** Best-effort wrapper used from workers: indexing must never fail a pipeline job. */
export async function indexCandidatesSafe(ids: (Types.ObjectId | string)[]) {
  try {
    return await indexCandidates(ids);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'talent index update failed');
    return 0;
  }
}

export interface PoolMatch {
  candidateId: string;
  name: string;
  headline: string | null;
  fromJobId: string;
  fromJobTitle: string;
  status: string;
  hasEmail: boolean;
  similarity: number;
  priorScore: number | null;
}

/**
 * Semantic search of the talent pool for a job (or a free-text query / a "similar to X" candidate).
 * Over-fetches from the vector store, then applies the compliance filters above.
 */
export async function searchTalentPool(opts: { jobId: string; query?: string; likeCandidateId?: string; limit?: number }): Promise<PoolMatch[]> {
  if (!talentEnabled()) return [];
  const job = await Job.findById(opts.jobId);
  if (!job) throw new NotFoundError('Job');
  let text: string;
  if (opts.likeCandidateId) {
    const like = await Candidate.findById(opts.likeCandidateId);
    if (!like) throw new NotFoundError('Candidate');
    text = candidateText(like);
  } else text = opts.query?.trim() || jobText(job);
  const [vector] = await embed([text]);
  const limit = Math.min(opts.limit ?? 10, 50);
  const hits = await vectorStore().search(vector!, { limit: limit * 4, excludeJobId: String(job._id) });
  if (!hits.length) return [];

  const cands = await Candidate.find({ _id: { $in: hits.map((h) => h.candidateId) } });
  const inJob = await Candidate.find({ jobId: job._id }, { emailLower: 1, profileUrlCanonical: 1 }).lean();
  const emails = new Set(inJob.map((c) => c.emailLower).filter(Boolean));
  const urls = new Set(inJob.map((c) => c.profileUrlCanonical).filter(Boolean));
  const jobs = new Map((await Job.find({ _id: { $in: [...new Set(cands.map((c) => String(c.jobId)))] } }, { title: 1 })).map((j) => [String(j._id), j.title]));

  // Several jobs may hold the same person: keep the best hit per email/profile.
  const seen = new Set<string>();
  const out: PoolMatch[] = [];
  for (const h of hits) {
    const c = cands.find((x) => String(x._id) === h.candidateId);
    if (!c || h.score < MIN_SIMILARITY) continue;
    if (EXCLUDED_STATUSES.has(c.status) || c.outreachStopped && c.outreachStoppedReason === 'unsubscribed') continue;
    if ((c.emailLower && emails.has(c.emailLower)) || (c.profileUrlCanonical && urls.has(c.profileUrlCanonical))) continue;
    const key = c.emailLower ?? c.profileUrlCanonical ?? String(c._id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      candidateId: String(c._id),
      name: c.name,
      headline: c.headline ?? null,
      fromJobId: String(c.jobId),
      fromJobTitle: jobs.get(String(c.jobId)) ?? 'another job',
      status: c.status,
      hasEmail: !!c.email,
      similarity: Number(h.score.toFixed(3)),
      priorScore: c.score ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Rows for the sourcing run: copies of pool matches (facts only, provenance kept). */
export async function talentPoolRows(jobId: string, limit: number): Promise<SourcedRow[]> {
  const matches = await searchTalentPool({ jobId, limit });
  if (!matches.length) return [];
  const cands = await Candidate.find({ _id: { $in: matches.map((m) => m.candidateId) } });
  return cands.map((c) => ({
    name: c.name,
    email: c.email ?? null,
    emailSource: (c.emailSource as 'csv' | 'manual' | null) ?? null,
    profileUrl: c.profileUrl ?? null,
    headline: c.headline ?? null,
    location: c.location ?? null,
    skills: c.skills ?? [],
    yearsExperience: c.yearsExperience ?? null,
    company: c.currentCompany ?? null,
    snippet: c.snippet ?? null,
    source: 'talent_pool' as const,
  }));
}

export async function reindexAll(): Promise<{ indexed: number; total: number }> {
  const ids = (await Candidate.find({}, { _id: 1 }).lean()).map((c) => c._id);
  let indexed = 0;
  for (let i = 0; i < ids.length; i += 64) indexed += await indexCandidates(ids.slice(i, i + 64));
  return { indexed, total: ids.length };
}
